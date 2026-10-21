// The agent's view of a shared folder: an inventory of every file (walked from disk, so files added
// from the app, OneDrive or Explorer appear on the next refresh) and a full-text index of the
// readable ones, split into labelled passages (page and section) for BM25 search across documents.
// Only changed files (modified time or size) are read again. The index is kept in the NoteTOO data
// folder on the PC (never in the school folder) so a restart does not re-read everything.

import { existsSync, mkdirSync, promises as fsp, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { tokens } from '../../src/ai/retrieve.js';
import { blockLabel, buildModel, outline, type DocModel } from '../../src/ai/structure.js';
import type { TextDoc } from '../../src/ai/text.js';
import { SCRATCHPAD, SUBJECT_NOTES, isIgnored, searchKey } from '../../src/fs/paths.js';
import { extOf, isReadable, readDocument, type ServerDoc } from './extract.mjs';

const MAX_FILES = 20_000;
const MAX_DEPTH = 14;
/** Bigger files are listed but not read for search. */
const MAX_INDEX_BYTES = 80 * 1024 * 1024;
const PASSAGE_CHARS = 1400;
/** 3: PDFs that failed on Windows (pdf.js data folder) are read again. */
const INDEX_VERSION = 3;
/** A folder scan is reused for this long before walking the disk again. */
const FRESH_MS = 15_000;

export interface FileInfo {
  /** '/'-separated, relative to the shared folder */
  path: string;
  size: number;
  mtime: number;
}

export interface Passage {
  label: string;
  page: number;
  text: string;
}

interface IndexedDoc {
  size: number;
  mtime: number;
  /** why the text could not be read */
  error?: string;
  type?: string;
  pages?: number;
  outline?: string;
  chars?: number;
  passages: Passage[];
}

export interface SearchHit {
  path: string;
  label: string;
  page: number;
  snippet: string;
  score: number;
}

export interface IndexProgress {
  done: number;
  total: number;
  current?: string;
}

/** Notes NoteTOO hides from file lists but the agent should know about. */
const NOTE_FILES = new Set([SUBJECT_NOTES.toLowerCase(), SCRATCHPAD.toLowerCase()]);

function hiddenName(name: string): boolean {
  if (NOTE_FILES.has(name.toLowerCase())) return false;
  return name.startsWith('.') || name.startsWith('~$') || isIgnored(name);
}

/** Passages along the document's structure, each labelled with its page and section. */
export function passagesOf(m: DocModel): Passage[] {
  const out: Passage[] = [];
  let cur: Passage | null = null;
  let lastSection = -2;
  for (const b of m.blocks) {
    const sectionStart = b.section !== lastSection;
    lastSection = b.section;
    const head = sectionStart && b.section >= 0 ? `${m.sections[b.section].title}\n` : '';
    if (cur && cur.text.length + b.text.length < PASSAGE_CHARS && !sectionStart && cur.page === b.page) {
      cur.text += '\n' + b.text;
      continue;
    }
    if (cur && cur.text.length + b.text.length < PASSAGE_CHARS / 2 && cur.page === b.page) {
      cur.text += '\n' + head + b.text;
      continue;
    }
    cur = { label: blockLabel(m, b) || m.name, page: b.page, text: (head + b.text).slice(0, PASSAGE_CHARS * 2) };
    out.push(cur);
  }
  return out;
}

/** The sentence-ish window of `text` with the most query words, about `len` characters. */
export function snippet(text: string, q: Set<string>, len = 360): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= len) return flat;
  const words = [...flat.matchAll(/\S+/g)];
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i < words.length; i++) {
    if (!tokens(words[i][0]).some((t) => q.has(t))) continue;
    let score = 0;
    const from = words[i].index!;
    for (let j = i; j < words.length && words[j].index! - from < len; j++) if (tokens(words[j][0]).some((t) => q.has(t))) score++;
    if (score > best) [best, bestAt] = [score, Math.max(0, from - 60)];
  }
  const start = flat.lastIndexOf(' ', bestAt) + 1;
  return (start > 0 ? '…' : '') + flat.slice(start, start + len).trim() + (start + len < flat.length ? '…' : '');
}

interface Postings {
  /** per passage: term -> count, and length */
  tf: Map<string, number>[];
  len: number[];
  df: Map<string, number>;
  /** passage index -> [path, passage index in its document] */
  ref: [string, number][];
  avg: number;
}

export class WorkspaceIndex {
  private files: FileInfo[] = [];
  private scannedAt = 0;
  private docs = new Map<string, IndexedDoc>();
  private postings: Postings | null = null;
  private scanning: Promise<void> | null = null;
  private indexing: Promise<void> | null = null;
  private dirty = false;
  private models = new Map<string, { key: string; doc: ServerDoc; model?: DocModel }>();
  progress: IndexProgress = { done: 0, total: 0 };

  constructor(
    readonly root: string,
    private readonly cacheFile: string | null,
  ) {
    this.load();
  }

  private load() {
    if (!this.cacheFile || !existsSync(this.cacheFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as { version?: number; docs?: Record<string, IndexedDoc> };
      if (raw.version !== INDEX_VERSION || !raw.docs) return;
      this.docs = new Map(Object.entries(raw.docs));
    } catch {
      /* a damaged cache only means reading the files again */
    }
  }

  private async save() {
    if (!this.cacheFile || !this.dirty) return;
    this.dirty = false;
    mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, root: this.root, docs: Object.fromEntries(this.docs) }));
    await fsp.rename(tmp, this.cacheFile);
  }

  /** Walks the folder (no file contents). Symbolic links are not followed. */
  async scan(force = false): Promise<FileInfo[]> {
    if (!force && Date.now() - this.scannedAt < FRESH_MS) return this.files;
    this.scanning ??= (async () => {
      const out: FileInfo[] = [];
      const walk = async (rel: string, depth: number) => {
        if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
        let dirents: import('node:fs').Dirent[];
        try {
          dirents = await fsp.readdir(path.join(this.root, ...rel.split('/').filter(Boolean)), { withFileTypes: true });
        } catch {
          return;
        }
        for (const d of dirents) {
          if (hiddenName(d.name) || d.isSymbolicLink()) continue;
          const p = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) await walk(p, depth + 1);
          else if (d.isFile() && out.length < MAX_FILES) {
            try {
              const st = await fsp.stat(path.join(this.root, ...p.split('/')));
              out.push({ path: p, size: st.size, mtime: Math.floor(st.mtimeMs) });
            } catch {
              /* vanished or locked */
            }
          }
        }
      };
      await walk('', 0);
      this.files = out;
      this.scannedAt = Date.now();
      const present = new Set(out.map((f) => f.path));
      for (const p of [...this.docs.keys()]) {
        if (present.has(p)) continue;
        this.docs.delete(p);
        this.postings = null;
        this.dirty = true;
      }
    })().finally(() => (this.scanning = null));
    await this.scanning;
    return this.files;
  }

  /** Every folder (relative path) that contains files or subfolders. */
  async folders(): Promise<string[]> {
    const set = new Set<string>();
    for (const f of await this.scan()) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  /** Marks paths changed by the agent so the next search sees them at once. */
  touched(...paths: string[]) {
    this.scannedAt = 0;
    for (const p of paths) this.models.delete(p);
  }

  /**
   * Reads new and changed files into the index. Waits at most `budgetMs` (the rest continues in the
   * background) and reports progress. Returns whether the index is complete.
   */
  async update(o: { budgetMs?: number; onProgress?: (p: IndexProgress) => void; signal?: AbortSignal } = {}): Promise<boolean> {
    const files = await this.scan();
    const todo = files.filter((f) => {
      if (!isReadable(f.path)) return false;
      const d = this.docs.get(f.path);
      return !d || d.mtime !== f.mtime || d.size !== f.size;
    });
    if (!todo.length && !this.indexing) return true;
    this.indexing ??= (async () => {
      this.progress = { done: 0, total: todo.length };
      for (const f of todo) {
        this.progress = { ...this.progress, current: f.path };
        await this.indexOne(f);
        this.progress = { ...this.progress, done: this.progress.done + 1 };
        if (this.progress.done % 25 === 0) await this.save().catch(() => {});
      }
      this.progress = { done: todo.length, total: todo.length };
      await this.save().catch(() => {});
    })().finally(() => (this.indexing = null));
    const job = this.indexing;
    const deadline = Date.now() + (o.budgetMs ?? 20_000);
    let timer: NodeJS.Timeout | undefined;
    const tick = setInterval(() => o.onProgress?.(this.progress), 1000);
    try {
      return await Promise.race([
        job.then(() => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), Math.max(0, deadline - Date.now())))),
        new Promise<boolean>((_, rej) => o.signal?.addEventListener('abort', () => rej(o.signal!.reason), { once: true })),
      ]);
    } finally {
      clearTimeout(timer);
      clearInterval(tick);
    }
  }

  private async indexOne(f: FileInfo) {
    const entry: IndexedDoc = { size: f.size, mtime: f.mtime, passages: [] };
    if (f.size > MAX_INDEX_BYTES) entry.error = 'Too large to index.';
    else {
      try {
        const { doc, model } = await this.read(f.path, f);
        if (doc.kind === 'none') entry.error = doc.reason;
        else if (model) {
          entry.type = model.type;
          entry.pages = model.pageCount;
          entry.outline = outline(model, 40);
          entry.chars = doc.pages.reduce((n, p) => n + p.length, 0);
          entry.passages = passagesOf(model);
        }
      } catch (e) {
        entry.error = `Could not be read: ${(e as Error).message}`;
      }
    }
    this.docs.set(f.path, entry);
    this.postings = null;
    this.dirty = true;
  }

  /** The document and its structure (cached per file version). */
  async read(rel: string, info?: FileInfo, signal?: AbortSignal): Promise<{ doc: ServerDoc; model?: DocModel }> {
    const full = path.join(this.root, ...rel.split('/'));
    let st: FileInfo;
    if (info) st = info;
    else {
      const s = await fsp.stat(full);
      st = { path: rel, size: s.size, mtime: Math.floor(s.mtimeMs) };
    }
    const key = `${st.mtime}|${st.size}`;
    const hit = this.models.get(rel);
    if (hit?.key === key) return hit;
    const doc = await readDocument(full, signal);
    const model = doc.kind === 'text' ? buildModel(path.basename(rel), doc as TextDoc) : undefined;
    const entry = { key, doc, model };
    this.models.delete(rel);
    this.models.set(rel, entry);
    while (this.models.size > 12) this.models.delete(this.models.keys().next().value!);
    return entry;
  }

  /** Index entry of a file, if it was read. */
  info(rel: string): Omit<IndexedDoc, 'passages'> | null {
    const d = this.docs.get(rel);
    if (!d) return null;
    const { passages: _p, ...rest } = d;
    return rest;
  }

  status(): { files: number; indexed: number; pending: number; unreadable: number } {
    const readable = this.files.filter((f) => isReadable(f.path));
    const indexed = readable.filter((f) => {
      const d = this.docs.get(f.path);
      return d && d.mtime === f.mtime && d.size === f.size;
    });
    return {
      files: this.files.length,
      indexed: indexed.length,
      pending: readable.length - indexed.length,
      unreadable: indexed.filter((f) => this.docs.get(f.path)?.error).length,
    };
  }

  private build(): Postings {
    const p: Postings = { tf: [], len: [], df: new Map(), ref: [], avg: 1 };
    for (const [file, d] of this.docs) {
      const nameWords = tokens(file.replace(/\.[^./]+$/, ''));
      d.passages.forEach((ps, i) => {
        const words = [...tokens(ps.text), ...tokens(ps.label), ...nameWords];
        const tf = new Map<string, number>();
        for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
        for (const w of tf.keys()) p.df.set(w, (p.df.get(w) ?? 0) + 1);
        p.tf.push(tf);
        p.len.push(words.length);
        p.ref.push([file, i]);
      });
    }
    p.avg = p.len.reduce((a, b) => a + b, 0) / (p.len.length || 1) || 1;
    return p;
  }

  /** BM25 over every indexed passage; at most `perFile` hits per file. */
  search(query: string, o: { limit?: number; within?: (p: string) => boolean; perFile?: number } = {}): SearchHit[] {
    this.postings ??= this.build();
    const P = this.postings;
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const N = P.tf.length || 1;
    const k1 = 1.2;
    const b = 0.75;
    const scored: [number, number][] = [];
    for (let i = 0; i < P.tf.length; i++) {
      if (o.within && !o.within(P.ref[i][0])) continue;
      let s = 0;
      let matched = 0;
      for (const w of q) {
        const f = P.tf[i].get(w);
        if (!f) continue;
        matched++;
        const df = P.df.get(w) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * P.len[i]) / P.avg));
      }
      // passages that contain more of the query's words come first
      if (s > 0) scored.push([s * (0.5 + matched / q.length), i]);
    }
    scored.sort((x, y) => y[0] - x[0]);
    const qs = new Set(q);
    const per = new Map<string, number>();
    const out: SearchHit[] = [];
    for (const [score, i] of scored) {
      const [file, pi] = P.ref[i];
      if ((per.get(file) ?? 0) >= (o.perFile ?? 3)) continue;
      per.set(file, (per.get(file) ?? 0) + 1);
      const ps = this.docs.get(file)!.passages[pi];
      out.push({ path: file, label: ps.label, page: ps.page, snippet: snippet(ps.text, qs), score: Math.round(score * 100) / 100 });
      if (out.length >= (o.limit ?? 12)) break;
    }
    return out;
  }

  /** Files whose path matches the words of `query` (accent- and case-insensitive), best first. */
  async find(o: { query?: string; folder?: string; ext?: string[]; modifiedWithinDays?: number; limit?: number }): Promise<(FileInfo & { score: number })[]> {
    const files = await this.scan();
    const words = searchKey(o.query ?? '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
    const since = o.modifiedWithinDays ? Date.now() - o.modifiedWithinDays * 86_400_000 : 0;
    const folder = o.folder?.replace(/^\/+|\/+$/g, '');
    const out: (FileInfo & { score: number })[] = [];
    for (const f of files) {
      if (folder && !(f.path === folder || f.path.startsWith(folder + '/'))) continue;
      if (o.ext?.length && !o.ext.includes(extOf(f.path))) continue;
      if (since && f.mtime < since) continue;
      let score = 0;
      if (words.length) {
        const key = searchKey(f.path);
        const name = searchKey(path.posix.basename(f.path));
        for (const w of words) {
          if (name.includes(w)) score += 2;
          else if (key.includes(w)) score += 1;
        }
        if (score < Math.max(1, words.length * 0.5)) continue;
      }
      out.push({ ...f, score });
    }
    out.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
    return out.slice(0, o.limit ?? 30);
  }
}

/** One index per shared folder, cached in the NoteTOO data folder. */
export class IndexRegistry {
  private map = new Map<string, WorkspaceIndex>();
  constructor(private readonly dataDir: string | null) {}

  get(rootId: string, rootPath: string): WorkspaceIndex {
    let ix = this.map.get(rootId);
    if (!ix || ix.root !== rootPath) {
      ix = new WorkspaceIndex(rootPath, this.dataDir ? path.join(this.dataDir, 'agent-index', `${rootId}.json`) : null);
      this.map.set(rootId, ix);
    }
    return ix;
  }
}


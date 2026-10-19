// The agent's tools: one registry for every model and provider. Each tool works on the shared
// school folder through electron/disk.mts (the trust boundary: paths are resolved there and refused
// outside the folder), declares its risk, and the server, not the model, decides what needs the
// user's approval: deleting, big reorganizations, scripts (by setting) and network access.
// Every change is journaled with a backup of the previous version, so a whole run can be undone.

import { existsSync, promises as fsp, realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as disk from '../../electron/disk.mjs';
import { formatPassages, retrieve } from '../../src/ai/retrieve.js';
import { chunkModel, fold, outline, sectionPath, type DocModel } from '../../src/ai/structure.js';
import { META_DIR, SCRATCHPAD, SUBJECT_NOTES, matchSection, sidecarDir, sidecarPath, validateName } from '../../src/fs/paths.js';
import { extOf, isReadable, readDocument } from './extract.mjs';
import type { WorkspaceIndex } from './index.mjs';
import { editXlsx, markdownToDocx, markdownToPptx, parseSheets, sheetsToXlsx } from './office.mjs';
import type { ToolSpec } from './providers.mjs';
import { runPython } from './python.mjs';

export type Risk = 'read' | 'write' | 'destructive' | 'script';

export interface AgentSettings {
  /** 'ask': every script is shown for approval; 'off': no scripts. (Scripts never run unseen: the
   *  Python guard is not a security boundary.) */
  scripts: 'ask' | 'off';
  /** a specific python.exe (else py -3 / python3 / python) */
  python: string;
  maxSteps: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { scripts: 'ask', python: '', maxSteps: 0 };

export function parseAgentSettings(raw: unknown): AgentSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AgentSettings>;
  return {
    // 'auto' (run without asking) existed before; it is no longer offered.
    scripts: r.scripts === 'off' ? 'off' : 'ask',
    python: typeof r.python === 'string' ? r.python.trim() : '',
    maxSteps: Number.isInteger(r.maxSteps) && r.maxSteps! >= 0 && r.maxSteps! <= 100 ? r.maxSteps! : 0,
  };
}

export type ChangeAction = 'created' | 'modified' | 'moved' | 'deleted' | 'folder';

export interface Change {
  action: ChangeAction;
  path: string;
  /** moved: the old path */
  from?: string;
  /** created/modified: copy of the previous version (absolute), for undo */
  backup?: string;
  /** whether a sidecar moved with it */
  sidecar?: boolean;
}

export interface ApprovalRequest {
  tool: string;
  title: string;
  /** what will happen, in plain words */
  detail: string;
  /** e.g. the script, for display */
  code?: string;
  paths?: string[];
}

export interface ToolContext {
  rootId: string;
  /** absolute path of the shared folder */
  root: string;
  index: WorkspaceIndex;
  settings: AgentSettings;
  signal: AbortSignal;
  /** characters one tool result may use */
  budget: number;
  /** what the user is looking at in the app */
  view: { openPath?: string; subject?: string; selection?: string };
  /** this run's folders (outside the school folder) */
  workDir: string;
  backupDir: string;
  /** files whose content was read this run (for the "sources" of the answer) */
  sources: Set<string>;
  /** files this run created (overwriting them needs no backup) */
  created: Set<string>;
  record(c: Change): void;
  approve(req: ApprovalRequest): Promise<boolean>;
  progress(msg: string): void;
  setPlan(steps: { title: string; status: string }[]): void;
  open(path: string): void;
}

export interface ToolResult {
  ok: boolean;
  /** what the model reads */
  content: string;
  /** one line for the user */
  summary: string;
}

export interface Tool {
  spec: ToolSpec;
  risk: Risk;
  /** a short description of the call, for the user ("Reading Maths/ch1.pdf, pages 3–5") */
  label(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** An expected failure: the message is given to the model so it can correct itself. */
export class ToolError extends Error {}

// ---------- argument helpers ----------

function str(a: Record<string, unknown>, k: string, required = true): string {
  const v = a[k];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`Missing argument "${k}".`);
    return '';
  }
  if (typeof v !== 'string') {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    throw new ToolError(`"${k}" must be a string.`);
  }
  return v;
}
function num(a: Record<string, unknown>, k: string, def: number, min: number, max: number): number {
  const v = a[k];
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`"${k}" must be a number.`);
  return Math.max(min, Math.min(max, Math.round(n)));
}
function strList(a: Record<string, unknown>, k: string): string[] {
  const v = a[k];
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return v.trim().startsWith('[') ? strList({ [k]: JSON.parse(v) }, k) : [v];
  if (!Array.isArray(v)) throw new ToolError(`"${k}" must be a list.`);
  return v.map((x) => String(x));
}
const bool = (a: Record<string, unknown>, k: string) => a[k] === true || a[k] === 'true';
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… [cut: ${s.length - n} more characters]` : s);

// ---------- paths ----------

/** A path relative to the shared folder, as the model may write it (absolute, backslashes, "./"). */
export function relPath(ctx: Pick<ToolContext, 'root'>, raw: string): string {
  let p = raw.trim().replace(/\\/g, '/').replace(/^["']|["']$/g, '');
  const rootFwd = ctx.root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (p.toLowerCase().startsWith(rootFwd.toLowerCase() + '/')) p = p.slice(rootFwd.length + 1);
  else if (p.toLowerCase() === rootFwd.toLowerCase()) p = '';
  p = p.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const segs = p.split('/').filter((s) => s && s !== '.');
  if (segs.some((s) => s === '..')) throw new ToolError(`"${raw}" leaves the school folder: use paths inside it.`);
  if (/^[a-z]:/i.test(segs[0] ?? '')) throw new ToolError(`"${raw}" is outside the school folder. Paths are relative to it, like "Maths/Cours/ch1.pdf".`);
  if (segs.some((s) => s.toLowerCase() === META_DIR.toLowerCase() || s.startsWith('.'))) throw new ToolError(`"${raw}" is a hidden or NoteTOO-internal path.`);
  return segs.join('/');
}

/** Absolute path, refused outside the folder, also through links. */
function absPath(ctx: ToolContext, rel: string): string {
  let full: string;
  try {
    full = disk.resolveIn(ctx.rootId, rel);
  } catch (e) {
    throw new ToolError((e as Error).message);
  }
  // The deepest existing ancestor must really be inside the folder (no junction or symlink out).
  let probe = full;
  while (!existsSync(probe) && probe.length > ctx.root.length) probe = path.dirname(probe);
  try {
    const real = realpathSync(probe);
    const rootReal = realpathSync(ctx.root);
    if (real !== rootReal && !real.toLowerCase().startsWith(rootReal.toLowerCase() + path.sep)) throw new ToolError(`"${rel}" leads outside the school folder.`);
  } catch (e) {
    if (e instanceof ToolError) throw e;
  }
  return full;
}

async function statRel(ctx: ToolContext, rel: string) {
  try {
    return await fsp.stat(absPath(ctx, rel));
  } catch (e) {
    if (e instanceof ToolError) throw e;
    return null;
  }
}

async function requireFile(ctx: ToolContext, rel: string) {
  const st = await statRel(ctx, rel);
  if (!st) {
    const near = await ctx.index.find({ query: path.posix.basename(rel).replace(/\.[^.]+$/, ''), limit: 5 });
    throw new ToolError(`"${rel}" does not exist.${near.length ? ` Similar files: ${near.map((f) => f.path).join(' ; ')}` : ' Use find_files to locate it.'}`);
  }
  if (!st.isFile()) throw new ToolError(`"${rel}" is a folder, not a file. Use list_folder.`);
  return st;
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new ToolError(r.message);
  return r.value;
}

/** Creates the missing folders of `rel` (a folder path). */
async function mkdirs(ctx: ToolContext, rel: string) {
  const segs = rel.split('/').filter(Boolean);
  for (let i = 1; i <= segs.length; i++) {
    const p = segs.slice(0, i).join('/');
    const st = await statRel(ctx, p);
    if (st?.isDirectory()) continue;
    if (st) throw new ToolError(`"${p}" is a file, so it cannot contain other files.`);
    const bad = validateName(segs[i - 1]);
    if (bad) throw new ToolError(`Folder name "${segs[i - 1]}": ${bad}`);
    unwrap(await disk.mkdir(ctx.rootId, p));
    ctx.record({ action: 'folder', path: p });
  }
}

/** Atomic write (temp file, then rename); `exclusive` never replaces an existing file. */
async function writeAtomic(ctx: ToolContext, rel: string, data: Uint8Array, exclusive: boolean) {
  const id = unwrap(await disk.beginWrite(ctx.rootId, rel));
  const w = await disk.writeChunk(id, data);
  if (!w.ok) {
    await disk.abortWrite(id);
    throw new ToolError(w.message);
  }
  const c = await disk.commitWrite(id, { exclusive });
  if (!c.ok) throw new ToolError(c.name === 'InvalidModificationError' ? `"${rel}" already exists.` : c.message);
}

/** Copies the current version of `rel` to this run's backup folder (once per run). */
async function backupOf(ctx: ToolContext, rel: string): Promise<string> {
  const dest = path.join(ctx.backupDir, ...rel.split('/'));
  if (!existsSync(dest)) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(absPath(ctx, rel), dest);
  }
  return dest;
}

/** Writes a file, journaling it as created or modified (with a backup of the old version). */
async function saveFile(ctx: ToolContext, rel: string, data: Uint8Array, o: { overwrite: boolean }): Promise<'created' | 'modified'> {
  const name = path.posix.basename(rel);
  const bad = validateName(name);
  if (bad && name !== SUBJECT_NOTES && name !== SCRATCHPAD) throw new ToolError(`File name "${name}": ${bad}`);
  const st = await statRel(ctx, rel);
  if (st?.isDirectory()) throw new ToolError(`"${rel}" is a folder.`);
  if (st && !o.overwrite) throw new ToolError(`"${rel}" already exists. Pass overwrite: true to replace it (the old version is kept as a backup), or choose another name.`);
  await mkdirs(ctx, path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));
  if (st) {
    const backup = ctx.created.has(rel) ? undefined : await backupOf(ctx, rel);
    await writeAtomic(ctx, rel, data, false);
    ctx.record({ action: 'modified', path: rel, backup });
    ctx.index.touched(rel);
    return 'modified';
  }
  await writeAtomic(ctx, rel, data, true);
  ctx.created.add(rel);
  ctx.record({ action: 'created', path: rel });
  ctx.index.touched(rel);
  return 'created';
}

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm', 'xml', 'yml', 'yaml', 'tex', 'log', 'ini', 'toml', 'sql']);
const isTextFile = (rel: string) => TEXT_EXT.has(extOf(rel)) || (isReadable(rel) && !['pdf', 'docx', 'pptx', 'xlsx', 'xlsm', 'xls', 'ods'].includes(extOf(rel)));

/** Re-reads a written file the way the agent would, to check it and describe it. */
async function verify(ctx: ToolContext, rel: string, note = ''): Promise<string> {
  const doc = await readDocument(absPath(ctx, rel), ctx.signal);
  if (doc.kind === 'none') return `WARNING: the file was written but cannot be read back: ${doc.reason}`;
  const chars = doc.pages.reduce((n, p) => n + p.length, 0);
  const st = await fsp.stat(absPath(ctx, rel));
  const unit = doc.format === 'slides' ? `${doc.pages.length} slide(s)` : doc.format === 'sheet' ? `${(doc.pages[0].match(/^## Sheet/gm) ?? []).length} sheet(s)` : `${(doc.pages.join('\n').match(/^#{1,6} /gm) ?? []).length} heading(s)`;
  return `Verified: "${rel}" (${fmtSize(st.size)}) reads back correctly: ${unit}, ${chars} characters of text.${note}`;
}

// ---------- reading ----------

const fileType: Record<string, string[]> = {
  pdf: ['pdf'],
  word: ['docx', 'doc', 'odt', 'rtf'],
  powerpoint: ['pptx', 'ppt', 'odp'],
  spreadsheet: ['xlsx', 'xlsm', 'xls', 'ods', 'csv'],
  text: ['txt', 'log'],
  markdown: ['md', 'markdown'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'],
  code: ['py', 'js', 'ts', 'c', 'cpp', 'h', 'java', 'cs', 'sql', 'html', 'css', 'json', 'r', 'm', 'ipynb', 'sh', 'go', 'rs', 'php'],
};

async function docFor(ctx: ToolContext, rel: string): Promise<DocModel> {
  const st = await requireFile(ctx, rel);
  const { doc, model } = await ctx.index.read(rel, { path: rel, size: st.size, mtime: Math.floor(st.mtimeMs) }, ctx.signal);
  if (doc.kind === 'none' || !model) throw new ToolError(`"${rel}" cannot be read: ${doc.kind === 'none' ? doc.reason : 'no text.'}`);
  ctx.sources.add(rel);
  return model;
}

function pageRange(spec: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(/[,;]\s*/)) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(part);
    if (!m) throw new ToolError(`"${spec}" is not a page range like "3" or "3-5".`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.max(1, a); p <= Math.min(max, b) && out.size < 60; p++) out.add(p);
  }
  return [...out];
}

function blocksText(m: DocModel, idx: number[], budget: number): string {
  let out = '';
  let lastPage = 0;
  let lastSection = -2;
  for (const i of idx) {
    const b = m.blocks[i];
    let head = '';
    if (m.paged && b.page !== lastPage) head += `\n[Page ${b.page}]\n`;
    if (b.section !== lastSection && b.section >= 0) head += `## ${sectionPath(m, b.section).join(' > ')}\n`;
    lastPage = b.page;
    lastSection = b.section;
    const piece = head + b.text + '\n';
    if (out.length + piece.length > budget) return out + `\n… [cut here: the requested part is longer than ${budget} characters; ask for fewer pages or a smaller section]`;
    out += piece;
  }
  return out.trim();
}

function docHeader(rel: string, m: DocModel, extra = ''): string {
  return `<document path="${rel}" type="${m.type}"${m.paged ? ` ${m.type === 'slides' || rel.endsWith('.pptx') ? 'slides' : 'pages'}="${m.pageCount}"` : ''}${extra}>`;
}

// ---------- the tools ----------

const tools: Tool[] = [];
const def = (t: Tool) => tools.push(t);

def({
  risk: 'read',
  spec: {
    name: 'workspace_overview',
    description:
      'Overview of the school folder: subjects and their sections (Cours, TD, TP, Exams, Other) with file counts, recently changed files, what the user has open in NoteTOO, and how far the search index is. Call it first when you need to know what exists.',
    parameters: { type: 'object', properties: {} },
  },
  label: () => 'Looking at the school folder',
  async run(_a, ctx) {
    const files = await ctx.index.scan(true);
    const subjects = new Map<string, Map<string, number>>();
    const loose: string[] = [];
    for (const f of files) {
      const segs = f.path.split('/');
      if (segs.length === 1) {
        loose.push(f.path);
        continue;
      }
      const sec = segs.length >= 3 ? (matchSection(segs[1]) ?? segs[1]) : '(directly in subject)';
      const m = subjects.get(segs[0]) ?? new Map<string, number>();
      m.set(sec, (m.get(sec) ?? 0) + 1);
      subjects.set(segs[0], m);
    }
    const recent = [...files].sort((a, b) => b.mtime - a.mtime).slice(0, 10);
    const st = ctx.index.status();
    const lines = [
      `School folder: ${path.basename(ctx.root)} — ${files.length} files in ${subjects.size} subjects.`,
      '',
      'Subjects (section: number of files):',
      ...[...subjects].sort((a, b) => a[0].localeCompare(b[0])).map(([s, secs]) => `- ${s}: ${[...secs].map(([k, n]) => `${k} ${n}`).join(', ')}`),
      ...(loose.length ? ['', `Files at the top level: ${loose.slice(0, 20).join(', ')}`] : []),
      '',
      'Recently modified:',
      ...recent.map((f) => `- ${f.path} (${fmtDate(f.mtime)})`),
      '',
      `Notes: each subject can have "<Subject>/${SUBJECT_NOTES}"; the global scratchpad is "${SCRATCHPAD}".`,
      ctx.view.openPath ? `Open in NoteTOO right now: ${ctx.view.openPath}` : ctx.view.subject ? `The user is on the page of the subject "${ctx.view.subject}".` : 'The user is on the home page.',
      `Search index: ${st.indexed} readable files indexed${st.pending ? `, ${st.pending} still being read` : ''}${st.unreadable ? `, ${st.unreadable} unreadable (scanned PDFs, old formats…)` : ''}.`,
    ];
    return { ok: true, content: lines.join('\n'), summary: `${files.length} files, ${subjects.size} subjects` };
  },
});

def({
  risk: 'read',
  spec: {
    name: 'list_folder',
    description: 'Lists the files and subfolders of a folder (with size and modified date). path "" is the top of the school folder.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'folder, e.g. "Maths/Cours"; "" for the top' }, depth: { type: 'integer', description: '1 to 3 levels (default 1)' } },
    },
  },
  label: (a) => `Listing ${a.path ? `“${a.path}”` : 'the school folder'}`,
  async run(a, ctx) {
    const rel = relPath(ctx, str(a, 'path', false));
    const depth = num(a, 'depth', 1, 1, 3);
    const st = await statRel(ctx, rel);
    if (!st?.isDirectory()) throw new ToolError(`"${rel}" is not a folder.${st ? '' : ' Use find_files to locate things.'}`);
    const out: string[] = [];
    let count = 0;
    const walk = async (p: string, d: number, indent: string) => {
      const entries = unwrap(await disk.list(ctx.rootId, p))
        .filter((e) => !e.name.startsWith('.') && !e.name.endsWith('.crswap') && !['desktop.ini', 'thumbs.db'].includes(e.name.toLowerCase()))
        .sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name, undefined, { numeric: true }) : x.kind === 'dir' ? -1 : 1));
      for (const e of entries) {
        if (++count > 400) return;
        out.push(e.kind === 'dir' ? `${indent}${e.name}/` : `${indent}${e.name}  (${fmtSize(e.size)}, ${fmtDate(e.lastModified)})`);
        if (e.kind === 'dir' && d < depth) await walk(p ? `${p}/${e.name}` : e.name, d + 1, indent + '  ');
      }
    };
    await walk(rel, 1, '');
    return {
      ok: true,
      content: `${rel || '(school folder)'}:\n${out.join('\n') || '(empty)'}${count > 400 ? '\n… more entries not shown; list a subfolder.' : ''}`,
      summary: `${Math.min(count, 400)} entries`,
    };
  },
});

def({
  risk: 'read',
  spec: {
    name: 'find_files',
    description:
      'Finds files by name/path words (accents and case ignored), optionally by type, folder and date. Use it to locate documents the user mentions ("the professor\'s PDF", "last week\'s notes").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'words of the name or folders, e.g. "management cours"' },
        folder: { type: 'string', description: 'only inside this folder, e.g. "Management"' },
        type: { type: 'string', enum: ['any', ...Object.keys(fileType)] },
        modified_within_days: { type: 'integer', description: 'only files changed in the last N days' },
        limit: { type: 'integer', description: 'default 30' },
      },
    },
  },
  label: (a) => `Finding files${a.query ? ` named “${a.query}”` : ''}${a.folder ? ` in ${a.folder}` : ''}`,
  async run(a, ctx) {
    const type = str(a, 'type', false);
    if (type && type !== 'any' && !fileType[type]) throw new ToolError(`Unknown type "${type}". Use one of: ${Object.keys(fileType).join(', ')}.`);
    const folder = a.folder ? relPath(ctx, str(a, 'folder')) : '';
    const days = a.modified_within_days ? num(a, 'modified_within_days', 0, 1, 3650) : 0;
    const hits = await ctx.index.find({ query: str(a, 'query', false), folder, ext: type && type !== 'any' ? fileType[type] : undefined, modifiedWithinDays: days, limit: num(a, 'limit', 30, 1, 100) });
    if (!hits.length) return { ok: true, content: 'No file matches. Try fewer or other words, or list_folder / search_content.', summary: 'nothing found' };
    return { ok: true, content: hits.map((f) => `- ${f.path}  (${fmtSize(f.size)}, modified ${fmtDate(f.mtime)})`).join('\n'), summary: `${hits.length} file${hits.length > 1 ? 's' : ''}` };
  },
});

def({
  risk: 'read',
  spec: {
    name: 'search_content',
    description:
      'Full-text search INSIDE all readable documents (PDF, Word, PowerPoint, spreadsheets, notes, text) at once. Returns the best passages with file, page and section. Use it to find where a topic is covered, or to answer questions across files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords, e.g. "matrice SWOT forces faiblesses"' },
        folder: { type: 'string', description: 'only inside this folder' },
        paths: { type: 'array', items: { type: 'string' }, description: 'only these files' },
        limit: { type: 'integer', description: 'default 12, max 30' },
      },
      required: ['query'],
    },
  },
  label: (a) => `Searching inside documents for “${a.query}”`,
  async run(a, ctx) {
    const query = str(a, 'query');
    const folder = a.folder ? relPath(ctx, str(a, 'folder')) : '';
    const only = new Set(strList(a, 'paths').map((p) => relPath(ctx, p)));
    const complete = await ctx.index.update({
      budgetMs: 25_000,
      signal: ctx.signal,
      onProgress: (p) => ctx.progress(`Reading files for search: ${p.done}/${p.total}${p.current ? ` (${path.posix.basename(p.current)})` : ''}`),
    });
    const hits = ctx.index.search(query, {
      limit: num(a, 'limit', 12, 1, 30),
      within: (p) => (!folder || p === folder || p.startsWith(folder + '/')) && (!only.size || only.has(p)),
    });
    const st = ctx.index.status();
    const note = complete ? '' : `\n(Note: the index is still reading files: ${st.pending} not searched yet. Results may be incomplete; search again in a moment if needed.)`;
    if (!hits.length) return { ok: true, content: `No passage matches "${query}". Try other or fewer keywords (synonyms, the language of the documents), or find_files.${note}`, summary: 'no match' };
    const content = hits.map((h, i) => `${i + 1}. ${h.path} — ${h.label}\n   ${h.snippet}`).join('\n') + note;
    return { ok: true, content: clip(content, ctx.budget), summary: `${hits.length} passages in ${new Set(hits.map((h) => h.path)).size} files` };
  },
});

def({
  risk: 'read',
  spec: {
    name: 'read_document',
    description:
      'Reads a document (PDF, docx, pptx, xlsx/csv, md, txt, code). Large documents come in parts: first call returns the outline and part 1. Read only what you need: pages ("3-5"), a section title, a query (most relevant passages), or the next part.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        pages: { type: 'string', description: 'e.g. "3" or "3-5" (PDF pages / slides)' },
        section: { type: 'string', description: 'section title or number, e.g. "2.1" or "Les fonctions"' },
        query: { type: 'string', description: 'return the passages most relevant to these words' },
        part: { type: 'integer', description: 'which part of a long document (1, 2, …)' },
      },
      required: ['path'],
    },
  },
  label: (a) => `Reading ${a.path}${a.pages ? `, pages ${a.pages}` : a.section ? `, section “${a.section}”` : a.query ? ` (looking for “${a.query}”)` : a.part ? `, part ${a.part}` : ''}`,
  async run(a, ctx) {
    const rel = relPath(ctx, str(a, 'path'));
    const m = await docFor(ctx, rel);
    const budget = ctx.budget;
    const all = m.blocks.reduce((n, b) => n + b.text.length + 1, 0);
    if (a.pages) {
      const pages = pageRange(str(a, 'pages'), m.pageCount);
      if (!pages.length) throw new ToolError(`"${rel}" has ${m.pageCount} page(s).`);
      const idx = m.blocks.flatMap((b, i) => (pages.includes(b.page) ? [i] : []));
      return { ok: true, content: `${docHeader(rel, m, ` read="pages ${str(a, 'pages')}"`)}\n${blocksText(m, idx, budget) || '(no text on these pages)'}\n</document>`, summary: `pages ${str(a, 'pages')}` };
    }
    if (a.section) {
      const want = fold(str(a, 'section')).trim();
      const si = m.sections.findIndex((s) => fold(s.title).startsWith(want) || new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(fold(s.title).replace(/^(chapitre|chapter|section|partie|part)\s+/, '')));
      const sj = si >= 0 ? si : m.sections.findIndex((s) => fold(s.title).includes(want));
      if (sj < 0) throw new ToolError(`No section "${str(a, 'section')}" in "${rel}". Its outline:\n${outline(m, 60) || '(no headings found; use pages, query or part)'}`);
      const inside = new Set([sj]);
      m.sections.forEach((s, i) => s.parent >= 0 && inside.has(s.parent) && inside.add(i));
      const idx = m.blocks.flatMap((b, i) => (inside.has(b.section) ? [i] : []));
      return { ok: true, content: `${docHeader(rel, m, ` read="section ${m.sections[sj].title}"`)}\n${blocksText(m, idx, budget)}\n</document>`, summary: `section “${m.sections[sj].title}”` };
    }
    if (a.query) {
      const ps = retrieve(m, str(a, 'query'), { budget });
      if (!ps.length) return { ok: true, content: `Nothing in "${rel}" matches "${str(a, 'query')}". Outline:\n${outline(m, 60)}`, summary: 'no matching passage' };
      return { ok: true, content: `${docHeader(rel, m, ` read="passages about ${str(a, 'query')}"`)}\n${formatPassages(m, ps)}\n</document>`, summary: `${ps.length} relevant passage${ps.length > 1 ? 's' : ''}` };
    }
    if (all <= budget) {
      return { ok: true, content: `${docHeader(rel, m, ' read="all"')}\n${blocksText(m, m.blocks.map((_, i) => i), budget)}\n</document>`, summary: `whole document (${all} characters)` };
    }
    const outlineText = outline(m, 50);
    const chunks = chunkModel(m, Math.max(2000, budget - Math.min(outlineText.length, budget / 3) - 400));
    const part = num(a, 'part', 1, 1, chunks.length);
    const c = chunks[part - 1];
    return {
      ok: true,
      content: [
        docHeader(rel, m, ` read="part ${part} of ${chunks.length}"`),
        ...(part === 1 && outlineText ? ['Outline:', outlineText, '', `Part 1 of ${chunks.length}:`] : []),
        c.text,
        '</document>',
        part < chunks.length ? `(More: part=${part + 1} of ${chunks.length}, or pages / section / query to jump to what you need.)` : '(End of document.)',
      ].join('\n'),
      summary: `part ${part} of ${chunks.length}${m.paged ? ` (pages ${c.from}–${c.to})` : ''}`,
    };
  },
});

def({
  risk: 'read',
  spec: {
    name: 'read_documents',
    description:
      'Reads SEVERAL documents in one call: for each file, the passages most relevant to `query` (or its beginning if query is empty), within one shared size limit. Best way to gather material from multiple files for a summary, comparison or revision sheet.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '2 to 8 files' },
        query: { type: 'string', description: 'topic to focus on (optional)' },
      },
      required: ['paths'],
    },
  },
  label: (a) => `Reading ${Array.isArray(a.paths) ? a.paths.length : 'several'} documents${a.query ? ` about “${a.query}”` : ''}`,
  async run(a, ctx) {
    const paths = [...new Set(strList(a, 'paths').map((p) => relPath(ctx, p)))].slice(0, 8);
    if (!paths.length) throw new ToolError('Give at least one path.');
    const query = str(a, 'query', false);
    const per = Math.max(1200, Math.floor(ctx.budget / paths.length) - 200);
    const parts: string[] = [];
    const failed: string[] = [];
    for (const rel of paths) {
      ctx.signal.throwIfAborted();
      try {
        const m = await docFor(ctx, rel);
        let body = '';
        if (query) {
          const ps = retrieve(m, query, { budget: per });
          if (ps.length) body = formatPassages(m, ps);
        }
        if (!body) {
          const ol = outline(m, 25);
          body = (ol ? `Outline:\n${ol}\n\nBeginning:\n` : '') + blocksText(m, m.blocks.map((_, i) => i), Math.max(600, per - ol.length));
        }
        parts.push(`${docHeader(rel, m)}\n${body}\n</document>`);
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        failed.push(`${rel}: ${(e as Error).message}`);
        parts.push(`<document path="${rel}" error="${(e as Error).message.replace(/"/g, "'")}"/>`);
      }
    }
    return {
      ok: failed.length < paths.length,
      content: parts.join('\n\n') + `\n(Each file was limited to about ${per} characters; use read_document for more of one file.)`,
      summary: `${paths.length - failed.length} of ${paths.length} read${failed.length ? `, ${failed.length} failed` : ''}`,
    };
  },
});

def({
  risk: 'read',
  spec: {
    name: 'get_annotations',
    description: "The user's highlights, comment pins and file comments on a file (from NoteTOO's annotations).",
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  label: (a) => `Reading annotations of ${a.path}`,
  async run(a, ctx) {
    const rel = relPath(ctx, str(a, 'path'));
    await requireFile(ctx, rel);
    let raw: { annotations?: { type?: string; page?: number; color?: string; comment?: string }[]; fileComments?: { text?: string }[] } = {};
    try {
      raw = JSON.parse(await fsp.readFile(disk.resolveIn(ctx.rootId, sidecarPath(rel)), 'utf8'));
    } catch {
      return { ok: true, content: `"${rel}" has no annotations.`, summary: 'none' };
    }
    const ann = (raw.annotations ?? []).map((x) => `- ${x.type === 'pin' ? 'Comment pin' : 'Highlight'} p. ${x.page ?? 1} (${x.color ?? ''})${x.comment ? `: ${x.comment}` : ''}`);
    const fc = (raw.fileComments ?? []).map((c) => `- File comment: ${c.text ?? ''}`);
    ctx.sources.add(rel);
    return { ok: true, content: clip([...fc, ...ann].join('\n') || 'No annotations.', ctx.budget), summary: `${ann.length + fc.length} annotation(s)` };
  },
});

def({
  risk: 'write',
  spec: {
    name: 'notes',
    description: `Reads or appends to the user's notes: a subject's notes ("<Subject>/${SUBJECT_NOTES}") or the global scratchpad (no subject). Appending adds a dated heading and never erases anything.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'append'] },
        subject: { type: 'string', description: 'subject folder name; empty = scratchpad' },
        heading: { type: 'string', description: 'title of the appended part' },
        text: { type: 'string', description: 'Markdown to append' },
      },
      required: ['action'],
    },
  },
  label: (a) => `${a.action === 'append' ? 'Adding to' : 'Reading'} ${a.subject ? `the notes of ${a.subject}` : 'the scratchpad'}`,
  async run(a, ctx) {
    const subject = a.subject ? relPath(ctx, str(a, 'subject')).split('/')[0] : '';
    if (subject && !(await statRel(ctx, subject))?.isDirectory()) throw new ToolError(`There is no subject folder "${subject}".`);
    const rel = subject ? `${subject}/${SUBJECT_NOTES}` : SCRATCHPAD;
    const full = absPath(ctx, rel);
    const cur = existsSync(full) ? await fsp.readFile(full, 'utf8') : '';
    if (str(a, 'action') !== 'append') {
      ctx.sources.add(rel);
      return { ok: true, content: cur.trim() ? clip(cur, ctx.budget) : `(${rel} is empty)`, summary: `${cur.length} characters` };
    }
    const text = str(a, 'text');
    const stamp = new Date().toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
    const block = `## ${str(a, 'heading', false) || 'Added by the NoteTOO agent'} (${stamp})\n\n${text.trim()}\n`;
    const body = cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${block}` : block;
    await saveFile(ctx, rel, Buffer.from(body, 'utf8'), { overwrite: true });
    return { ok: true, content: `Appended ${text.length} characters to ${rel}.`, summary: `appended to ${rel}` };
  },
});

def({
  risk: 'write',
  spec: {
    name: 'create_file',
    description:
      'Creates a file in the school folder from text you write. The extension decides the format: .md/.txt/.csv/.json/code are saved as is; .docx = Word document from Markdown (headings, lists, tables, bold); .pptx = PowerPoint from Markdown ("## Slide title" then "- bullets" per slide); .xlsx = Excel from Markdown tables ("## Sheet name" above each table) or CSV; cells starting with "=" are formulas. Missing folders are created. The file is read back to verify it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. "Management/Révision - chapitres 1 à 3.docx"' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', description: 'replace an existing file (its old version is backed up)' },
      },
      required: ['path', 'content'],
    },
  },
  label: (a) => `Creating ${a.path}`,
  async run(a, ctx) {
    const rel = relPath(ctx, str(a, 'path'));
    const content = str(a, 'content');
    const ext = extOf(rel);
    if (!rel.includes('.') || !ext) throw new ToolError('The path needs an extension (.md, .docx, .pptx, .xlsx, .csv, .txt…).');
    let data: Buffer;
    let note = '';
    if (ext === 'docx') data = await markdownToDocx(content);
    else if (ext === 'pptx') data = await markdownToPptx(content);
    else if (ext === 'xlsx') {
      const sheets = parseSheets(content);
      const formulas = sheets.reduce((n, s) => n + s.rows.flat().filter((c) => c.trim().startsWith('=')).length, 0);
      if (formulas) note = ` It has ${formulas} formula(s), computed when the file is opened in Excel (not shown when read back).`;
      data = await sheetsToXlsx(sheets);
    } else if (['pdf', 'doc', 'ppt', 'xls', 'odt'].includes(ext)) {
      throw new ToolError(`.${ext} files cannot be written directly. Write .docx, .pptx or .xlsx instead${ext === 'pdf' ? ', or use run_python if a PDF is really needed' : ''}.`);
    } else if (isTextFile(rel)) data = Buffer.from(content, 'utf8');
    else throw new ToolError(`.${ext} files cannot be created with this tool.`);
    const what = await saveFile(ctx, rel, data, { overwrite: bool(a, 'overwrite') });
    const check = isReadable(rel) ? await verify(ctx, rel, note) : 'Written.';
    return { ok: true, content: `${what === 'created' ? 'Created' : 'Replaced (old version backed up)'} "${rel}". ${check}`, summary: `${what} ${rel}` };
  },
});

def({
  risk: 'write',
  spec: {
    name: 'edit_file',
    description:
      'Changes an existing text file (.md, .txt, .csv, .json, code, notes): exact find/replace edits, append, prepend, or full new content. For .docx/.pptx only full new content (Markdown) is possible: the file is regenerated (its original formatting is lost; the old version is backed up). The old version is always backed up.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          description: 'exact replacements, applied in order',
          items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean' } }, required: ['find', 'replace'] },
        },
        append: { type: 'string' },
        prepend: { type: 'string' },
        content: { type: 'string', description: 'the whole new content' },
      },
      required: ['path'],
    },
  },
  label: (a) => `Editing ${a.path}`,
  async run(a, ctx) {
    const rel = relPath(ctx, str(a, 'path'));
    await requireFile(ctx, rel);
    const ext = extOf(rel);
    if (ext === 'docx' || ext === 'pptx') {
      if (typeof a.content !== 'string') throw new ToolError(`.${ext} files can only be rewritten whole: pass "content" (Markdown). Read it first with read_document.`);
      const data = ext === 'docx' ? await markdownToDocx(a.content) : await markdownToPptx(a.content);
      await saveFile(ctx, rel, data, { overwrite: true });
      return { ok: true, content: `Rewrote "${rel}" (old version backed up). ${await verify(ctx, rel)}`, summary: `rewrote ${rel}` };
    }
    if (['xlsx', 'xlsm', 'xls', 'ods'].includes(ext)) throw new ToolError('Use edit_spreadsheet for spreadsheets.');
    if (!isTextFile(rel)) throw new ToolError(`"${rel}" is not a text file this tool can edit.`);
    const before = await fsp.readFile(absPath(ctx, rel), 'utf8');
    let text = typeof a.content === 'string' ? a.content : before;
    const edits = Array.isArray(a.edits) ? (a.edits as Record<string, unknown>[]) : [];
    let n = 0;
    for (const [i, e] of edits.entries()) {
      const find = str(e, 'find');
      const replace = str(e, 'replace', false);
      if (!text.includes(find)) {
        const first = find.split('\n')[0].trim().slice(0, 40);
        const near = text.split('\n').find((l) => first && fold(l).includes(fold(first).slice(0, 20)));
        throw new ToolError(`Edit ${i + 1}: the text to find was not found exactly in "${rel}". No change was made.${near ? ` A similar line: "${near.trim().slice(0, 160)}"` : ' Read the file again and copy the text exactly.'}`);
      }
      const count = text.split(find).length - 1;
      if (count > 1 && !bool(e, 'all')) throw new ToolError(`Edit ${i + 1}: the text to find occurs ${count} times; add more context to make it unique, or set "all": true. No change was made.`);
      text = bool(e, 'all') ? text.split(find).join(replace) : text.replace(find, () => replace);
      n += count > 1 && bool(e, 'all') ? count : 1;
    }
    if (typeof a.prepend === 'string') text = a.prepend + (a.prepend.endsWith('\n') ? '' : '\n') + text;
    if (typeof a.append === 'string') text = text.replace(/\s*$/, '\n') + (text.trim() ? '\n' : '') + a.append + (a.append.endsWith('\n') ? '' : '\n');
    if (text === before) return { ok: true, content: 'Nothing changed (the new text is identical).', summary: 'no change' };
    await saveFile(ctx, rel, Buffer.from(text, 'utf8'), { overwrite: true });
    const delta = text.length - before.length;
    return {
      ok: true,
      content: `Saved "${rel}" (${n ? `${n} replacement(s), ` : ''}${delta >= 0 ? '+' : ''}${delta} characters; old version backed up). It now has ${text.split('\n').length} lines.`,
      summary: `edited ${rel}`,
    };
  },
});

def({
  risk: 'write',
  spec: {
    name: 'edit_spreadsheet',
    description: 'Changes cells of an existing .xlsx workbook (values or "=" formulas) and/or appends rows to a sheet. The old version is backed up.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string', description: 'sheet name (default: the first)' },
        cells: { type: 'object', description: 'e.g. {"B2": "14", "D10": "=AVERAGE(D2:D9)"}' },
        append_rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      },
      required: ['path'],
    },
  },
  label: (a) => `Editing spreadsheet ${a.path}`,
  async run(a, ctx) {
    const rel = relPath(ctx, str(a, 'path'));
    await requireFile(ctx, rel);
    if (extOf(rel) !== 'xlsx') throw new ToolError(extOf(rel) === 'csv' ? 'CSV files are text: use edit_file.' : 'Only .xlsx workbooks can be edited (create a new .xlsx otherwise).');
    const cells = a.cells && typeof a.cells === 'object' ? (a.cells as Record<string, string>) : {};
    const rows = Array.isArray(a.append_rows) ? (a.append_rows as unknown[][]).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r)])) : [];
    if (!Object.keys(cells).length && !rows.length) throw new ToolError('Give "cells" and/or "append_rows".');
    let res: { data: Buffer; sheet: string };
    try {
      res = await editXlsx(await fsp.readFile(absPath(ctx, rel)), { sheet: str(a, 'sheet', false) || undefined, cells, appendRows: rows });
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    await saveFile(ctx, rel, res.data, { overwrite: true });
    return { ok: true, content: `Updated sheet "${res.sheet}" of "${rel}": ${Object.keys(cells).length} cell(s), ${rows.length} row(s) appended (old version backed up).`, summary: `edited ${rel}` };
  },
});

def({
  risk: 'write',
  spec: {
    name: 'create_folder',
    description: 'Creates a folder (and missing parents). A new subject is a top-level folder; NoteTOO sections are Cours, TD, TP, Exams, Other.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  label: (a) => `Creating folder ${a.path}`,
  async run(a, ctx) {
    const rel = relPath(ctx, str(a, 'path'));
    if (!rel) throw new ToolError('Give a folder path.');
    const existed = (await statRel(ctx, rel))?.isDirectory();
    await mkdirs(ctx, rel);
    ctx.index.touched();
    return { ok: true, content: existed ? `"${rel}" already exists.` : `Created "${rel}/".`, summary: existed ? 'already there' : `created ${rel}/` };
  },
});

/** Moves a file or folder with its annotations. */
async function moveOne(ctx: ToolContext, from: string, to: string) {
  unwrap(await disk.move(ctx.rootId, from, to));
  let sidecar = false;
  for (const [a, b] of [
    [sidecarPath(from), sidecarPath(to)],
    [sidecarDir(from), sidecarDir(to)],
  ]) {
    const src = disk.resolveIn(ctx.rootId, a);
    if (!existsSync(src)) continue;
    await fsp.mkdir(path.dirname(disk.resolveIn(ctx.rootId, b)), { recursive: true });
    if ((await disk.move(ctx.rootId, a, b)).ok) sidecar = true;
  }
  ctx.record({ action: 'moved', path: to, from, sidecar });
  ctx.index.touched(from, to);
}

def({
  risk: 'write',
  spec: {
    name: 'move',
    description:
      'Moves or renames files and folders (annotations move with them). Never overwrites: a destination that exists is an error. To move into a folder keep the name: "to": "Maths/TD/ex1.pdf". Many moves or moving whole subjects asks the user first.',
    parameters: {
      type: 'object',
      properties: {
        moves: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
      },
      required: ['moves'],
    },
  },
  label: (a) => (Array.isArray(a.moves) && a.moves.length === 1 ? `Moving ${(a.moves[0] as { from?: string }).from} → ${(a.moves[0] as { to?: string }).to}` : `Moving ${Array.isArray(a.moves) ? a.moves.length : ''} items`),
  async run(a, ctx) {
    if (!Array.isArray(a.moves) || !a.moves.length) throw new ToolError('Give "moves": [{"from": …, "to": …}].');
    const moves = (a.moves as Record<string, unknown>[]).map((m) => {
      const from = relPath(ctx, str(m, 'from'));
      let to = relPath(ctx, str(m, 'to'));
      if (!from || !to) throw new ToolError('Moving the school folder itself is not possible.');
      return { from, to, intoFolder: /[\\/]\s*$/.test(str(m, 'to')) };
    });
    const resolved: { from: string; to: string }[] = [];
    for (const m of moves) {
      const st = await statRel(ctx, m.from);
      if (!st) throw new ToolError(`"${m.from}" does not exist. Nothing was moved.`);
      const dst = await statRel(ctx, m.to);
      const to = dst?.isDirectory() || m.intoFolder ? `${m.to}/${path.posix.basename(m.from)}` : m.to;
      if (to === m.from) continue;
      if (to.startsWith(m.from + '/')) throw new ToolError(`Cannot move "${m.from}" into itself.`);
      const bad = validateName(path.posix.basename(to));
      if (bad) throw new ToolError(`"${path.posix.basename(to)}": ${bad}`);
      if (st.isFile() && extOf(m.from) !== extOf(to)) throw new ToolError(`Moving "${m.from}" to "${to}" would change its extension; keep .${extOf(m.from)}.`);
      resolved.push({ from: m.from, to });
    }
    const subjects = resolved.filter((m) => !m.from.includes('/'));
    if (resolved.length > 10 || subjects.length) {
      const ok = await ctx.approve({
        tool: 'move',
        title: `Move ${resolved.length} item${resolved.length > 1 ? 's' : ''}?`,
        detail: subjects.length ? `This renames or moves whole subject folders (${subjects.map((s) => s.from).join(', ')}).` : 'This reorganizes many files. Annotations move with them; it can be undone.',
        paths: resolved.map((m) => `${m.from} → ${m.to}`),
      });
      if (!ok) return { ok: false, content: 'The user declined these moves. Nothing was moved. Ask what they prefer, or continue without moving.', summary: 'declined by you' };
    }
    const done: string[] = [];
    for (const m of resolved) {
      try {
        await mkdirs(ctx, path.posix.dirname(m.to) === '.' ? '' : path.posix.dirname(m.to));
        await moveOne(ctx, m.from, m.to);
        done.push(`${m.from} → ${m.to}`);
      } catch (e) {
        throw new ToolError(`${(e as Error).message}${done.length ? ` (${done.length} move(s) done before: ${done.join('; ')})` : ' Nothing was moved.'}`);
      }
    }
    return { ok: true, content: done.length ? `Moved:\n${done.map((d) => `- ${d}`).join('\n')}` : 'Nothing to move (already in place).', summary: `${done.length} moved` };
  },
});

def({
  risk: 'destructive',
  spec: {
    name: 'delete',
    description: 'Moves files or folders to the Recycle Bin of the PC (with their annotations). Always asks the user first. Only when the user asked for it.',
    parameters: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } }, reason: { type: 'string', description: 'why, shown to the user' } },
      required: ['paths', 'reason'],
    },
  },
  label: (a) => `Deleting ${Array.isArray(a.paths) ? a.paths.length : ''} item(s)`,
  async run(a, ctx) {
    const paths = [...new Set(strList(a, 'paths').map((p) => relPath(ctx, p)))].filter(Boolean);
    if (!paths.length) throw new ToolError('Give the paths to delete.');
    for (const p of paths) if (!(await statRel(ctx, p))) throw new ToolError(`"${p}" does not exist. Nothing was deleted.`);
    const ok = await ctx.approve({
      tool: 'delete',
      title: `Delete ${paths.length} item${paths.length > 1 ? 's' : ''}?`,
      detail: `${str(a, 'reason', false) || 'The agent wants to delete these.'} They go to the PC's Recycle Bin, with their annotations.`,
      paths,
    });
    if (!ok) return { ok: false, content: 'The user declined. Nothing was deleted.', summary: 'declined by you' };
    for (const p of paths) {
      unwrap(await disk.trash(ctx.rootId, p));
      for (const sc of [sidecarPath(p), sidecarDir(p)]) if (existsSync(disk.resolveIn(ctx.rootId, sc))) await disk.trash(ctx.rootId, sc);
      ctx.record({ action: 'deleted', path: p });
      ctx.index.touched(p);
    }
    return { ok: true, content: `Moved to the Recycle Bin: ${paths.join(', ')}`, summary: `${paths.length} deleted` };
  },
});

def({
  risk: 'script',
  spec: {
    name: 'run_python',
    description:
      'Runs a Python 3 script on the PC for what other tools cannot do: calculations, statistics, charts (matplotlib → .png), data processing (pandas), converting files, batch edits. The user sees the code and must allow it. The working directory is the school folder (use relative paths). It may write inside the school folder only (changed files are backed up); deleting, starting programs or using the network (unless allow_network) stops the script. Print results to stdout.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        purpose: { type: 'string', description: 'one sentence for the user: what the script does' },
        timeout_seconds: { type: 'integer', description: 'default 60, max 600' },
        allow_network: { type: 'boolean', description: 'only if the task needs the internet' },
      },
      required: ['code', 'purpose'],
    },
  },
  label: (a) => `Running a Python script: ${a.purpose ?? ''}`,
  async run(a, ctx) {
    if (ctx.settings.scripts === 'off') throw new ToolError('Scripts are turned off in the agent settings. Do the task with the other tools, or tell the user.');
    const code = str(a, 'code');
    const net = bool(a, 'allow_network');
    {
      const ok = await ctx.approve({
        tool: 'run_python',
        title: net ? 'Run a script WITH internet access?' : 'Run a Python script on your PC?',
        detail: `${(str(a, 'purpose', false) || 'No purpose given').replace(/[.!?\s]*$/, '.')} Read the code: it runs with your account's rights. NoteTOO's guard stops it if it writes outside your school folder, deletes, starts programs${net ? '' : ' or uses the internet'}, and backs up files it changes, but the guard is a safety net, not a sandbox.`,
        code,
      });
      if (!ok) return { ok: false, content: 'The user declined to run this script. Do it another way, or explain what is needed.', summary: 'declined by you' };
    }
    const timeout = num(a, 'timeout_seconds', 60, 5, 600);
    ctx.progress(`Running the script (up to ${timeout} s)…`);
    const runDir = path.join(ctx.workDir, `py-${Date.now().toString(36)}`);
    const before = new Set((await ctx.index.scan(true)).map((f) => f.path));
    const r = await runPython({ code, root: ctx.root, workDir: runDir, backupDir: ctx.backupDir, timeoutMs: timeout * 1000, allowNetwork: net, python: ctx.settings.python || undefined, signal: ctx.signal }).catch((e: Error) => {
      throw new ToolError(e.message);
    });
    const written = r.written.filter((p) => !p.split('/').some((s) => s.startsWith('.')) && existsSync(path.join(ctx.root, ...p.split('/'))));
    for (const p of written) {
      const backup = path.join(ctx.backupDir, ...p.split('/'));
      const existed = before.has(p) && !ctx.created.has(p);
      if (!existed) ctx.created.add(p);
      ctx.record(existed ? { action: 'modified', path: p, backup: existsSync(backup) ? backup : undefined } : { action: 'created', path: p });
    }
    ctx.index.touched(...written);
    const out = clip(r.stdout.trim(), Math.floor(ctx.budget * 0.6));
    const err = clip(r.stderr.trim(), Math.floor(ctx.budget * 0.3));
    const ok = r.exitCode === 0 && !r.timedOut;
    const content = [
      r.timedOut
        ? `The script was stopped after ${timeout} s (time limit).`
        : r.exitCode === 126 && /NoteTOO guard stopped the script/.test(r.stderr)
          ? 'The guard stopped the script because it tried something scripts may not do (see stderr). Change the script, or use the dedicated tools (delete, move…).'
          : `Exit code ${r.exitCode} (${(r.ms / 1000).toFixed(1)} s).`,
      out ? `stdout:\n${out}` : 'stdout: (empty)',
      err ? `stderr:\n${err}` : '',
      written.length ? `Files written in the school folder: ${written.join(', ')}` : 'No file of the school folder was written.',
    ]
      .filter(Boolean)
      .join('\n');
    const summary = ok
      ? `done in ${(r.ms / 1000).toFixed(1)} s${written.length ? `, ${written.length} file(s) written` : ''}`
      : r.timedOut
        ? 'stopped: time limit'
        : r.exitCode === 126
          ? 'stopped by the guard'
          : `failed (exit ${r.exitCode})`;
    return { ok, content, summary };
  },
});

def({
  risk: 'read',
  spec: {
    name: 'update_plan',
    description: 'Shows the user your plan for a multi-step task and its progress. Call it at the start of a task with 3+ steps, then again as steps are done.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['title', 'status'] },
        },
      },
      required: ['steps'],
    },
  },
  label: () => 'Updating the plan',
  async run(a, ctx) {
    if (!Array.isArray(a.steps)) throw new ToolError('"steps" must be a list of {title, status}.');
    const steps = (a.steps as Record<string, unknown>[]).slice(0, 15).map((s) => ({ title: str(s, 'title').slice(0, 160), status: ['pending', 'in_progress', 'done'].includes(String(s.status)) ? String(s.status) : 'pending' }));
    ctx.setPlan(steps);
    return { ok: true, content: 'Plan updated. Continue with the next step.', summary: `${steps.filter((s) => s.status === 'done').length}/${steps.length} done` };
  },
});

def({
  risk: 'read',
  spec: {
    name: 'open_in_app',
    description: 'Opens a file in NoteTOO for the user (e.g. the document you just created) when you finish.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  label: (a) => `Opening ${a.path} in NoteTOO`,
  async run(a, ctx) {
    const rel = relPath(ctx, str(a, 'path'));
    await requireFile(ctx, rel);
    ctx.open(rel);
    return { ok: true, content: `"${rel}" will be shown to the user.`, summary: 'will open' };
  },
});

export const TOOLS: readonly Tool[] = tools;
export const toolByName = new Map(tools.map((t) => [t.spec.name, t]));

/** Checks that the required arguments are there (types are checked by each tool). */
export function checkArgs(t: Tool, args: Record<string, unknown>): string | null {
  const schema = t.spec.parameters as { properties?: Record<string, unknown>; required?: string[] };
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (!missing.length) return null;
  return `Missing required argument${missing.length > 1 ? 's' : ''} ${missing.map((k) => `"${k}"`).join(', ')} for ${t.spec.name}. Its arguments: ${Object.keys(schema.properties ?? {}).join(', ')}.`;
}

/**
 * Undoes a run's changes, newest first. Files the run created go to the Recycle Bin, or into
 * `stashDir` (outside the school folder) where there is none. Returns what could not be undone.
 */
export async function undoChanges(rootId: string, changes: Change[], stashDir: string): Promise<{ undone: number; failed: string[] }> {
  const failed: string[] = [];
  let undone = 0;
  for (const c of [...changes].reverse()) {
    try {
      if (c.action === 'created') {
        const r = await disk.trash(rootId, c.path);
        if (!r.ok && r.name !== 'NotFoundError') {
          const dest = path.join(stashDir, ...c.path.split('/'));
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.rename(disk.resolveIn(rootId, c.path), dest).catch(async () => {
            await fsp.copyFile(disk.resolveIn(rootId, c.path), dest);
            await fsp.rm(disk.resolveIn(rootId, c.path));
          });
        }
      } else if (c.action === 'modified') {
        if (!c.backup || !existsSync(c.backup)) throw new Error('no backup');
        const data = await fsp.readFile(c.backup);
        const id = await disk.beginWrite(rootId, c.path);
        if (!id.ok) throw new Error(id.message);
        const w = await disk.writeChunk(id.value, data);
        if (!w.ok) throw new Error(w.message);
        const cm = await disk.commitWrite(id.value);
        if (!cm.ok) throw new Error(cm.message);
      } else if (c.action === 'moved') {
        const r = await disk.move(rootId, c.path, c.from!);
        if (!r.ok) throw new Error(r.message);
        if (c.sidecar) {
          for (const [a, b] of [
            [sidecarPath(c.path), sidecarPath(c.from!)],
            [sidecarDir(c.path), sidecarDir(c.from!)],
          ]) {
            if (existsSync(disk.resolveIn(rootId, a))) await disk.move(rootId, a, b);
          }
        }
      } else if (c.action === 'folder') {
        const full = disk.resolveIn(rootId, c.path);
        if (existsSync(full) && !(await fsp.readdir(full)).length) await fsp.rmdir(full);
      } else if (c.action === 'deleted') {
        throw new Error('restore it from the Recycle Bin');
      }
      undone++;
    } catch (e) {
      failed.push(`${c.path}: ${(e as Error).message}`);
    }
  }
  return { undone, failed };
}

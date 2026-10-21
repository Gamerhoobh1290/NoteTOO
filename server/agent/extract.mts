// Server-side reading of school files for the agent: the same text model as the page's
// src/ai/extract.ts (per-page text, PDF line positions for headings), but in Node.js on the PC, so
// the laptop never downloads or parses documents. Formats: PDF, Word (docx), PowerPoint (pptx),
// spreadsheets (xlsx/xls/ods/csv), Markdown, text and code. Never throws for unsupported files.

import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { PageText, TextDoc, TextSpan } from '../../src/ai/text.js';

export type ServerDoc = TextDoc | { kind: 'none'; reason: string };

const require = createRequire(import.meta.url);
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLS = 60;
const MIN_TEXT_PER_PAGE = 30;

const EXT_KIND: Record<string, 'pdf' | 'docx' | 'pptx' | 'sheet' | 'markdown' | 'text'> = {
  pdf: 'pdf', docx: 'docx', pptx: 'pptx', xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', ods: 'sheet', csv: 'sheet',
  md: 'markdown', markdown: 'markdown', txt: 'text', log: 'text', text: 'text',
};
/** Plain-text source files the agent reads as code. */
const CODE = new Set(
  ('py js mjs cjs jsx ts tsx c h cpp cc cxx hpp cs java kt go rs rb php swift r lua pl html htm xml css scss less json ' +
    'yml yaml toml ini sql sh bash ps1 bat m tex vb asm ipynb').split(' '),
);

export const extOf = (p: string) => path.extname(p).slice(1).toLowerCase();

/** Whether the agent can read this file's text (by extension). */
export function isReadable(p: string): boolean {
  const e = extOf(p);
  return e in EXT_KIND || CODE.has(e);
}

// ---------- PDF ----------

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs' as string).then((m) => m as PdfJs);
  return pdfjsPromise;
}
/**
 * A folder as pdf.js wants it: ending in "/". It refuses "C:\…\" (so on Windows every PDF failed);
 * Node.js reads "C:/…/" on Windows just as well.
 */
export const pdfDir = (dir: string) => dir.replace(/\\/g, '/').replace(/\/*$/, '/');
/** pdf.js font and character map data, read from disk in Node.js. */
const pdfAssets = () => {
  const dir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return { standardFontDataUrl: pdfDir(path.join(dir, 'standard_fonts')), cMapUrl: pdfDir(path.join(dir, 'cmaps')), cMapPacked: true };
};

async function readPdf(data: Uint8Array, signal?: AbortSignal): Promise<ServerDoc> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    return { kind: 'none', reason: `Reading PDFs needs Node.js 22.13 or later on the PC (this is ${process.versions.node}).` };
  }
  const lib = await pdfjs();
  const task = lib.getDocument({ data, useSystemFonts: false, verbosity: 0, ...pdfAssets() });
  try {
    const doc = await task.promise;
    const layout: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      let text = '';
      const spans: TextSpan[] = [];
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        if (it.str) {
          const tx = lib.Util.transform(vp.transform, it.transform);
          const fontH = Math.hypot(tx[2], tx[3]) || it.height || 10;
          const start = text.length;
          text += it.str;
          spans.push({
            start,
            end: text.length,
            rect: { x: tx[4] / vp.width, y: (tx[5] - fontH) / vp.height, w: it.width / vp.width, h: (fontH * 1.2) / vp.height },
            size: Math.round(fontH * 10) / 10,
          });
        }
        text += it.hasEOL ? '\n' : ' ';
      }
      layout.push({ page: n, text, spans });
      page.cleanup();
    }
    const chars = layout.reduce((sum, p) => sum + p.text.replace(/\s/g, '').length, 0);
    if (chars < MIN_TEXT_PER_PAGE * layout.length) {
      return { kind: 'none', reason: 'This PDF is scanned (no text layer): its text cannot be read without OCR.' };
    }
    return { kind: 'text', pages: layout.map((p) => p.text), paged: true, layout, truncated: false, format: 'pdf' };
  } catch (e) {
    if (signal?.aborted) throw e;
    const name = (e as Error).name;
    return { kind: 'none', reason: name === 'PasswordException' ? 'This PDF is password-protected.' : `This PDF could not be read (${(e as Error).message}).` };
  } finally {
    void task.destroy();
  }
}

// ---------- XML/HTML helpers ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * mammoth's HTML as Markdown-like text (headings, nested lists, tables), like the page's
 * docxHtmlToText. mammoth only produces a small, regular set of tags, so a tag scan is enough.
 */
export function docxHtmlToText(html: string): string {
  const blocks: string[] = [];
  let line: string | null = null;
  const lists: { ordered: boolean; n: number }[] = [];
  let row: string[] | null = null;
  let cellText: string | null = null;
  let table: string[] | null = null;
  const endLine = () => {
    if (line !== null && line.trim()) blocks.push(line.replace(/(\S)[ \t]+/g, '$1 ').trimEnd());
    line = null;
  };
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>|([^<]+)/gi)) {
    if (m[3] !== undefined) {
      const t = decodeEntities(m[3]).replace(/\s+/g, ' ');
      if (cellText !== null) cellText += t;
      else line = (line ?? '') + t;
      continue;
    }
    const close = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'br') {
      if (cellText !== null) cellText += ' ';
      else line = (line ?? '') + ' ';
    } else if (/^h[1-6]$/.test(tag)) {
      endLine();
      if (!close) line = `${'#'.repeat(Number(tag[1]))} `;
    } else if (tag === 'ul' || tag === 'ol') {
      endLine();
      if (close) lists.pop();
      else lists.push({ ordered: tag === 'ol', n: 0 });
    } else if (tag === 'li') {
      endLine();
      const l = lists[lists.length - 1];
      if (!close && l) line = `${'  '.repeat(lists.length - 1)}${l.ordered ? `${++l.n}.` : '-'} `;
    } else if (tag === 'p') {
      if (lists.length || cellText !== null) {
        if (close && cellText === null && line !== null) line += ' ';
        continue;
      }
      endLine();
    } else if (tag === 'table') {
      endLine();
      if (close && table) {
        if (table.length) blocks.push([table[0], `| ${table[0].split(' | ').map(() => '---').join(' | ')} |`, ...table.slice(1)].join('\n'));
        table = null;
      } else if (!close) table = [];
    } else if (tag === 'tr') {
      if (close && row && table) table.push(`| ${row.join(' | ')} |`);
      row = close ? null : [];
    } else if (tag === 'td' || tag === 'th') {
      if (close && row && cellText !== null) row.push(cellText.replace(/\s+/g, ' ').trim().replace(/\|/g, '/'));
      cellText = close ? null : '';
    }
  }
  endLine();
  // List items stay on consecutive lines; other blocks are separated by a blank line.
  return blocks.reduce((out, b, i) => (i === 0 ? b : out + (/^\s*(-|\d+\.) /.test(b) && /^\s*(-|\d+\.) /.test(blocks[i - 1]) ? '\n' : '\n\n') + b), '');
}

async function readDocx(data: Buffer): Promise<ServerDoc> {
  const mammoth = (await import('mammoth')).default;
  try {
    const res = await mammoth.convertToHtml({ buffer: data });
    return { kind: 'text', pages: [docxHtmlToText(res.value)], paged: false, truncated: false, format: 'docx' };
  } catch (e) {
    return { kind: 'none', reason: `This Word document could not be read (${(e as Error).message}).` };
  }
}

// ---------- PowerPoint ----------

/** Paragraphs of one slide's shapes; the title placeholder first. */
function slideText(xml: string): { title: string; lines: string[] } {
  let title = '';
  const lines: string[] = [];
  for (const sp of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    const isTitle = /<p:ph\b[^>]*type="(title|ctrTitle)"/.test(sp[0]);
    const paras = [...sp[0].matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((p) => {
      const lvl = Number(/<a:pPr\b[^>]*lvl="(\d)"/.exec(p[0])?.[1] ?? 0);
      const t = [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((r) => decodeEntities(r[1])).join('').trim();
      return { t, lvl };
    });
    if (isTitle && !title) title = paras.map((p) => p.t).filter(Boolean).join(' ');
    else for (const p of paras) if (p.t) lines.push(`${'  '.repeat(p.lvl)}- ${p.t}`);
  }
  // Tables: one row per line
  for (const tbl of xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/g)) {
    for (const tr of tbl[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)) {
      const cells = [...tr[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((tc) =>
        [...tc[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((r) => decodeEntities(r[1])).join(' ').trim().replace(/\|/g, '/'),
      );
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }
  return { title, lines };
}

async function readPptx(data: Buffer): Promise<ServerDoc> {
  const JSZip = (await import('jszip')).default;
  try {
    const zip = await JSZip.loadAsync(data);
    const slideNo = (n: string) => Number(/slide(\d+)\.xml$/.exec(n)?.[1] ?? 0);
    // Slide order: presentation.xml's list, through its relationships; file names as a fallback.
    let order: string[] = [];
    const pres = await zip.file('ppt/presentation.xml')?.async('string');
    const presRels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
    if (pres && presRels) {
      const target = new Map([...presRels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
      order = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
        .map((m) => target.get(m[1]))
        .filter((t): t is string => !!t)
        .map((t) => 'ppt/' + t.replace(/^\/?ppt\//, '').replace(/^\.\//, ''));
    }
    if (!order.length) order = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
    const pages: string[] = [];
    for (const [i, name] of order.entries()) {
      const xml = await zip.file(name)?.async('string');
      if (!xml) continue;
      const { title, lines } = slideText(xml);
      let notes = '';
      const rels = await zip.file(name.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'))?.async('string');
      const notesTarget = rels && /Target="\.\.\/notesSlides\/([^"]+)"/.exec(rels)?.[1];
      if (notesTarget) {
        const nx = await zip.file(`ppt/notesSlides/${notesTarget}`)?.async('string');
        if (nx) notes = slideText(nx).lines.map((l) => l.replace(/^\s*- /, '')).filter((l) => !/^\d+$/.test(l)).join(' ');
      }
      pages.push([`# Slide ${i + 1}${title ? `: ${title}` : ''}`, ...lines, ...(notes ? [`Speaker notes: ${notes}`] : [])].join('\n'));
    }
    return { kind: 'text', pages: pages.length ? pages : [''], paged: true, truncated: false, format: 'slides' };
  } catch (e) {
    return { kind: 'none', reason: `This PowerPoint file could not be read (${(e as Error).message}).` };
  }
}

// ---------- spreadsheets ----------

type Xlsx = typeof import('xlsx');
/** SheetJS, whichever way the installed version exposes itself to ESM. */
export async function sheetjs(): Promise<Xlsx> {
  const m = (await import('xlsx')) as Xlsx & { default?: Xlsx };
  return typeof m.read === 'function' ? m : m.default!;
}

async function readSheet(data: Buffer, ext: string): Promise<ServerDoc> {
  const X = await sheetjs();
  try {
    const wb = ext === 'csv' ? X.read(data.toString('utf8'), { type: 'string' }) : X.read(data, { type: 'buffer', cellDates: true, cellFormula: true });
    let truncated = false;
    const parts = wb.SheetNames.map((name) => {
      // Formulas without a computed value (files not yet opened in Excel) are shown as formulas.
      for (const [addr, c] of Object.entries(wb.Sheets[name])) {
        const cellObj = c as { f?: string; v?: unknown; w?: string };
        if (!addr.startsWith('!') && cellObj.f && cellObj.v === undefined) cellObj.w = `=${cellObj.f}`;
      }
      const rows = X.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, blankrows: false, defval: '' });
      if (rows.length > MAX_SHEET_ROWS) truncated = true;
      const body = rows
        .slice(0, MAX_SHEET_ROWS)
        .map((r) => r.slice(0, MAX_SHEET_COLS).map((c) => String(c ?? '').replace(/\s+/g, ' ')).join(' | ').replace(/( \| )+$/, ''))
        .filter((l) => l.trim())
        .join('\n');
      return `## Sheet "${name}"\n${body}`;
    });
    return { kind: 'text', pages: [parts.join('\n\n')], paged: false, truncated, format: 'sheet' };
  } catch (e) {
    return { kind: 'none', reason: `This spreadsheet could not be read (${(e as Error).message}).` };
  }
}

// ---------- entry point ----------

/** Reads a file (absolute path) for the agent. */
export async function readDocument(full: string, signal?: AbortSignal): Promise<ServerDoc> {
  const ext = extOf(full);
  const kind: (typeof EXT_KIND)[string] | 'code' | undefined = EXT_KIND[ext] ?? (CODE.has(ext) ? 'code' : undefined);
  if (!kind) {
    if (['doc', 'ppt', 'odt', 'odp', 'rtf'].includes(ext)) return { kind: 'none', reason: `Old or non-Office .${ext} files cannot be read; save it as ${ext === 'ppt' || ext === 'odp' ? '.pptx' : '.docx'} or PDF.` };
    if (/^(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(ext)) return { kind: 'none', reason: 'Images have no text the agent can read (no OCR).' };
    if (/^(mp4|webm|mov|m4v|mp3|wav|m4a|ogg|flac|aac|opus)$/.test(ext)) return { kind: 'none', reason: 'Audio and video files cannot be read.' };
    return { kind: 'none', reason: `.${ext || 'unknown'} files cannot be read as text.` };
  }
  const data = await fsp.readFile(full);
  switch (kind) {
    case 'pdf':
      return readPdf(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), signal);
    case 'docx':
      return readDocx(data);
    case 'pptx':
      return readPptx(data);
    case 'sheet':
      return readSheet(data, ext);
    default: {
      const slice = data.subarray(0, MAX_TEXT_BYTES);
      if (slice.subarray(0, 8000).includes(0)) return { kind: 'none', reason: 'This file is binary, not text.' };
      return {
        kind: 'text',
        pages: [slice.toString('utf8').replace(/\r\n?/g, '\n')],
        paged: false,
        truncated: data.length > MAX_TEXT_BYTES,
        format: kind === 'markdown' ? 'markdown' : CODE.has(ext) ? 'code' : 'text',
      };
    }
  }
}


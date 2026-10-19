// Turns a file into what the AI can read: text (per page for PDFs, with positions for
// highlights), or images for the vision model (pictures and scanned PDFs).

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { fileKind } from '../lib/fileKinds';
import { loadPdf } from '../lib/pdf';
import { readSheets } from '../lib/sheets';
import type { PageText, TextDoc, TextFormat, TextSpan } from './text';

export type { TextDoc, TextFormat };

export type AiDoc = TextDoc | { kind: 'image'; images: string[]; scanned: boolean } | { kind: 'none'; reason: string };

export interface ReadOptions {
  /** stop reading after this many characters (e.g. a short snippet for organizing) */
  maxChars?: number;
  /** pages rendered for the vision model when a PDF has no text layer */
  scanPages?: number;
  signal?: AbortSignal;
}

const MAX_IMAGE = 1024;
const MIN_TEXT_PER_PAGE = 30;

/** Downscaled JPEG data URL of an image (or canvas), on a white background. */
export async function imageDataUrl(src: Blob | HTMLCanvasElement): Promise<string> {
  let source: CanvasImageSource;
  let w: number;
  let h: number;
  let url: string | null = null;
  if (src instanceof HTMLCanvasElement) {
    source = src;
    [w, h] = [src.width, src.height];
  } else {
    url = URL.createObjectURL(src);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('This image could not be decoded.');
    }
    source = img;
    [w, h] = [img.naturalWidth || 800, img.naturalHeight || 600];
  }
  const k = Math.min(1, MAX_IMAGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (url) URL.revokeObjectURL(url);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function pdfPageText(doc: PDFDocumentProxy, n: number): Promise<PageText> {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  let text = '';
  const spans: TextSpan[] = [];
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    if (it.str) {
      const tx = pdfjs.Util.transform(vp.transform, it.transform);
      const fontH = Math.hypot(tx[2], tx[3]) || it.height || 10;
      const start = text.length;
      text += it.str;
      spans.push({
        start,
        end: text.length,
        rect: { x: tx[4] / vp.width, y: (tx[5] - fontH) / vp.height, w: (it.width * vp.scale) / vp.width, h: (fontH * 1.2) / vp.height },
        size: Math.round(fontH * 10) / 10,
      });
    }
    text += it.hasEOL ? '\n' : ' ';
  }
  // `text` must stay exactly as built: span offsets index into it.
  return { page: n, text, spans };
}

async function renderPage(doc: PDFDocumentProxy, n: number): Promise<string> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(2, MAX_IMAGE / Math.max(base.width, base.height)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvas, viewport: vp }).promise;
  return imageDataUrl(canvas);
}

async function readPdf(file: File, o: ReadOptions): Promise<AiDoc> {
  const task = loadPdf(new Uint8Array(await file.arrayBuffer()));
  try {
    const doc = await task.promise;
    const layout: PageText[] = [];
    let chars = 0;
    let truncated = false;
    for (let n = 1; n <= doc.numPages; n++) {
      o.signal?.throwIfAborted();
      const p = await pdfPageText(doc, n);
      layout.push(p);
      chars += p.text.length;
      if (o.maxChars && chars >= o.maxChars) {
        truncated = n < doc.numPages;
        break;
      }
    }
    const textChars = layout.reduce((sum, p) => sum + p.text.replace(/\s/g, '').length, 0);
    if (textChars < MIN_TEXT_PER_PAGE * layout.length) {
      // Scanned: no usable text layer. Render the first pages for a vision model.
      const images: string[] = [];
      for (let n = 1; n <= Math.min(doc.numPages, o.scanPages ?? 3); n++) {
        o.signal?.throwIfAborted();
        images.push(await renderPage(doc, n));
      }
      return { kind: 'image', images, scanned: true };
    }
    return { kind: 'text', pages: layout.map((p) => p.text), paged: true, layout, truncated, format: 'pdf' };
  } finally {
    void task.destroy();
  }
}

/**
 * A docx (as mammoth's HTML) as Markdown-like text, so its structure survives: `#` headings,
 * `-` list items, and `|` tables. Images and styling are dropped.
 */
function docxHtmlToText(html: string): string {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const out: string[] = [];
  const clean = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  for (const el of Array.from(body.children)) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${clean(el)}`);
    else if (tag === 'ul' || tag === 'ol') {
      out.push(Array.from(el.querySelectorAll(':scope > li'), (li, i) => `${tag === 'ol' ? `${i + 1}.` : '-'} ${clean(li)}`).join('\n'));
    } else if (tag === 'table') {
      const rows = Array.from(el.querySelectorAll('tr'), (tr) => `| ${Array.from(tr.children, (td) => clean(td).replace(/\|/g, '/')).join(' | ')} |`);
      if (rows.length) out.push([rows[0], `| ${rows[0].split(' | ').map(() => '---').join(' | ')} |`, ...rows.slice(1)].join('\n'));
    } else {
      const t = clean(el);
      if (t) out.push(t);
    }
  }
  return out.join('\n\n');
}

function cut(text: string, max?: number): { text: string; truncated: boolean } {
  return max && text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** Reads a file for the AI. Never throws for unsupported types (returns kind 'none'). */
export async function readForAi(file: File, o: ReadOptions = {}): Promise<AiDoc> {
  const kind = fileKind(file.name);
  switch (kind) {
    case 'pdf':
      return readPdf(file, o);
    case 'image':
      return { kind: 'image', images: [await imageDataUrl(file)], scanned: false };
    case 'docx': {
      const mammoth = (await import('mammoth')).default;
      const res = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
      const c = cut(docxHtmlToText(res.value), o.maxChars);
      return { kind: 'text', pages: [c.text], paged: false, truncated: c.truncated, format: 'docx' };
    }
    case 'sheet': {
      const sheets = await readSheets(file, o.signal);
      const text = sheets
        .map((s) => `## Sheet "${s.name}"\n` + s.rows.map((r) => r.join(' | ').replace(/( \| )+$/, '')).filter((l) => l.trim()).join('\n'))
        .join('\n\n');
      const c = cut(text, o.maxChars);
      return { kind: 'text', pages: [c.text], paged: false, truncated: c.truncated || sheets.some((s) => s.totalRows > s.rows.length), format: 'sheet' };
    }
    case 'text':
    case 'markdown':
    case 'code': {
      const max = o.maxChars ?? 2_000_000;
      const c = cut(await file.slice(0, max * 4).text(), max);
      return { kind: 'text', pages: [c.text], paged: false, truncated: c.truncated || file.size > max * 4, format: kind === 'markdown' ? 'markdown' : kind === 'code' ? 'code' : 'text' };
    }
    case 'video':
    case 'audio':
      return { kind: 'none', reason: 'Audio and video files cannot be read by the AI.' };
    default:
      return { kind: 'none', reason: 'The AI cannot read this type of file.' };
  }
}

// Pure text helpers for the AI features (unit-tested): page text with positions, finding a
// quoted passage on a PDF page, and splitting long documents into chunks.

import type { Rect } from '../fs/sidecar';

/** A run of characters of the page text and where it is drawn (normalized 0–1 page coordinates). */
export interface TextSpan {
  start: number;
  end: number;
  rect: Rect;
}
export interface PageText {
  /** 1-based */
  page: number;
  text: string;
  spans: TextSpan[];
}

/**
 * Matching form of a text: lower case, no accents, no whitespace, unified quotes/dashes and
 * ligatures, with a map back to the original index of every kept character. Models often
 * re-type quotes with different spacing, accents or apostrophes; PDFs often split words.
 */
export function matchForm(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const folded = s[i]
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[’‘`´]/g, "'")
      .replace(/[“”«»]/g, '"')
      .replace(/[‐-―−]/g, '-')
      .replace(/[\s­]/g, '');
    for (const ch of folded) {
      norm += ch;
      map.push(i);
    }
  }
  return { norm, map };
}

/** Character range [start, end) of `quote` in `text`, tolerating small differences; null if absent. */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  const t = matchForm(text);
  const q = matchForm(quote).norm.replace(/^["'.…]+|["'.…]+$/g, '').replace(/\.\.\.|…/g, '');
  if (q.length < 4) return null;
  const range = (a: number, b: number) => ({ start: t.map[a], end: t.map[b - 1] + 1 });
  const exact = t.norm.indexOf(q);
  if (exact >= 0) return range(exact, exact + q.length);
  // The model may have changed a few words: anchor on the start and/or the end of the quote.
  const k = Math.max(8, Math.min(24, Math.floor(q.length / 3)));
  if (q.length < k * 2) return null;
  const head = t.norm.indexOf(q.slice(0, k));
  const tail = t.norm.indexOf(q.slice(-k), head >= 0 ? head + k : 0);
  if (head >= 0 && tail >= 0 && tail + k - head <= q.length * 1.6) return range(head, tail + k);
  if (head >= 0) return range(head, Math.min(t.norm.length, head + q.length));
  if (tail >= 0) return range(Math.max(0, tail + k - q.length), tail + k);
  return null;
}

/** Bounding box of a quoted passage on a PDF page, or null if the passage is not on it. */
export function locateQuote(p: PageText, quote: string): Rect | null {
  const r = findQuote(p.text, quote);
  if (!r) return null;
  const hit = p.spans.filter((s) => s.end > r.start && s.start < r.end);
  if (!hit.length) return null;
  const pad = 0.004;
  const x0 = Math.max(0, Math.min(...hit.map((s) => s.rect.x)) - pad);
  const y0 = Math.max(0, Math.min(...hit.map((s) => s.rect.y)) - pad);
  const x1 = Math.min(1, Math.max(...hit.map((s) => s.rect.x + s.rect.w)) + pad);
  const y1 = Math.min(1, Math.max(...hit.map((s) => s.rect.y + s.rect.h)) + pad);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface Chunk {
  /** first and last page (1-based) in this chunk */
  from: number;
  to: number;
  text: string;
}

/**
 * Groups pages into chunks of at most `budget` characters, each page marked with
 * "[Page n]". A page longer than the budget is cut into several chunks.
 */
export function chunkPages(pages: string[], budget: number, paged: boolean): Chunk[] {
  const out: Chunk[] = [];
  let cur: Chunk | null = null;
  pages.forEach((raw, i) => {
    const n = i + 1;
    const body = raw.trim();
    if (!body) return;
    for (let off = 0; off < body.length; off += budget) {
      const piece = (paged ? `[Page ${n}]\n` : '') + body.slice(off, off + budget);
      if (cur && cur.text.length + piece.length + 2 <= budget) {
        cur.text += '\n\n' + piece;
        cur.to = n;
      } else {
        if (cur) out.push(cur);
        cur = { from: n, to: n, text: piece };
      }
    }
  });
  if (cur) out.push(cur);
  return out;
}

/** Characters of document text that fit in one request, leaving room for instructions and the answer. */
export function inputBudget(contextTokens: number): number {
  // ~3 characters per token for French/English course text (conservative).
  return Math.max(3000, Math.floor((contextTokens - 3500) * 3));
}

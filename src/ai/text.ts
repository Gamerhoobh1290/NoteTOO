// Pure text helpers for the AI features (unit-tested): page text with positions, finding a
// quoted passage, and the text budget of a request.

import type { Rect } from '../fs/geometry.js';

export type TextFormat = 'pdf' | 'markdown' | 'docx' | 'sheet' | 'text' | 'code' | 'slides';

/** A document's text, as the AI reads it (from the page's extract.ts or the server's). */
export interface TextDoc {
  kind: 'text';
  /** one entry per PDF page (or slide); a single entry for other files */
  pages: string[];
  paged: boolean;
  /** PDF only: page text with positions, for placing highlights and finding headings */
  layout?: PageText[];
  /** text was cut at `maxChars` */
  truncated: boolean;
  /** what the text came from: decides how its structure is read */
  format: TextFormat;
}

/** A run of characters of the page text and where it is drawn (normalized 0–1 page coordinates). */
export interface TextSpan {
  start: number;
  end: number;
  rect: Rect;
  /** font size in PDF points (scale 1), used to recognize headings */
  size?: number;
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

export interface Chunk {
  /** first and last page (1-based) in this chunk */
  from: number;
  to: number;
  text: string;
}

/** Characters of document text that fit in one request, leaving room for instructions and the answer. */
export function inputBudget(contextTokens: number): number {
  // ~3 characters per token for French/English course text (conservative).
  return Math.max(3000, Math.floor((contextTokens - 3500) * 3));
}

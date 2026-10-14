// Turns the model's highlight proposals into highlights worth showing (unit-tested, no AI call).
// A proposal is kept only if its quote really is in the passage the model named, it is short and
// precise, important enough, not a duplicate, not already highlighted by the user, and within a
// budget scaled to the document. Placement is one rectangle per line, on the exact characters.

import type { Rect } from '../fs/sidecar';
import { tokens } from './retrieve';
import type { DocModel } from './structure';
import { matchForm, type PageText } from './text';

export interface Candidate {
  /** block id, e.g. "b12" */
  block: string;
  quote: string;
  category: string;
  importance: number;
  why: string;
}
export interface Accepted extends Candidate {
  blockIndex: number;
  page: number;
  /** exact characters in the page text */
  start: number;
  end: number;
  /** the document's own text for the quote */
  text: string;
  /** PDF: one rectangle per line (empty for files without layout) */
  rects: Rect[];
}
export type RejectReason =
  | 'unknown passage'
  | 'not in that passage'
  | 'too short'
  | 'too long'
  | 'whole paragraph'
  | 'low importance'
  | 'example'
  | 'duplicate'
  | 'already highlighted'
  | 'over budget';

const MAX_WORDS = 40;
const RANK: Record<string, number> = { definition: 0, theorem: 0, formula: 0, property: 1, 'key-fact': 1, conclusion: 1, method: 2, warning: 2, other: 3, example: 4 };

/** Range of `quote` in `text`, ignoring case, accents, spacing and quote styles. No paraphrases. */
export function findInBlock(text: string, quote: string): { start: number; end: number } | null {
  const t = matchForm(text);
  const q = matchForm(quote).norm.replace(/^["'.…,;:]+|["'.…,;:]+$/g, '');
  if (q.length < 4) return null;
  const at = t.norm.indexOf(q);
  if (at < 0) return null;
  return { start: t.map[at], end: t.map[at + q.length - 1] + 1 };
}

/** Relative width of a character in a proportional font (good enough to cut a span). */
const charW = (c: string) => (/[iljtf.,;:'!|\s]/.test(c) ? 0.45 : /[mwMW]/.test(c) ? 1.4 : /[A-Z]/.test(c) ? 1.15 : 1);
const width = (s: string) => [...s].reduce((n, c) => n + charW(c), 0);

/** Rectangles covering characters [start, end) of a PDF page: one per line. */
export function rangeRects(p: PageText, start: number, end: number): Rect[] {
  const parts: Rect[] = [];
  for (const s of p.spans) {
    const a = Math.max(start, s.start);
    const b = Math.min(end, s.end);
    if (a >= b) continue;
    const span = p.text.slice(s.start, s.end);
    const total = width(span) || 1;
    const x0 = s.rect.x + (s.rect.w * width(span.slice(0, a - s.start))) / total;
    const x1 = s.rect.x + (s.rect.w * width(span.slice(0, b - s.start))) / total;
    parts.push({ x: x0, y: s.rect.y, w: Math.max(0.002, x1 - x0), h: s.rect.h });
  }
  parts.sort((r, q) => r.y - q.y || r.x - q.x);
  const lines: Rect[] = [];
  for (const r of parts) {
    const l = lines[lines.length - 1];
    if (l && Math.abs(l.y + l.h / 2 - (r.y + r.h / 2)) < Math.min(l.h, r.h) * 0.5) {
      const x1 = Math.max(l.x + l.w, r.x + r.w);
      const y1 = Math.max(l.y + l.h, r.y + r.h);
      l.x = Math.min(l.x, r.x);
      l.y = Math.min(l.y, r.y);
      l.w = x1 - l.x;
      l.h = y1 - l.y;
    } else lines.push({ ...r });
  }
  const pad = 0.003;
  return lines.map((r) => ({ x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), w: Math.min(1, r.w + 2 * pad), h: Math.min(1, r.h + 2 * pad) }));
}

/** Smallest rectangle containing all of them. */
export function bounds(rs: Rect[]): Rect {
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
const overlap = (a: Rect, b: Rect) => area({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) });

function similar(a: string, b: string): boolean {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (!x.size || !y.size) return false;
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / Math.min(x.size, y.size) >= 0.7;
}

/** How many highlights a document deserves: few, scaled to its length and kind. */
export function highlightBudget(m: DocModel, focused: boolean): number {
  const chars = m.blocks.reduce((n, b) => n + b.text.length, 0);
  const pages = m.paged ? m.pageCount : Math.max(1, Math.round(chars / 2500));
  const density = m.type === 'slides' ? 0.5 : m.type === 'course' ? 1 : 0.8;
  const n = Math.round(pages * density) + 2;
  return Math.max(focused ? 2 : 3, Math.min(focused ? 8 : 12, n));
}

export function selectHighlights(
  cands: Candidate[],
  m: DocModel,
  o: { budget: number; minImportance: number; allowExamples: boolean; existing: { page: number; rect: Rect }[]; layout?: PageText[] },
): { kept: Accepted[]; rejected: { cand: Candidate; reason: RejectReason }[] } {
  const rejected: { cand: Candidate; reason: RejectReason }[] = [];
  const valid: Accepted[] = [];
  const byId = new Map(m.blocks.map((b, i) => [b.id, i]));

  for (const c of cands) {
    const reject = (reason: RejectReason) => rejected.push({ cand: c, reason });
    const bi = byId.get(c.block.trim());
    if (bi === undefined) {
      reject('unknown passage');
      continue;
    }
    const b = m.blocks[bi];
    const r = findInBlock(b.text, c.quote);
    if (!r) {
      reject('not in that passage');
      continue;
    }
    const text = b.text.slice(r.start, r.end);
    const words = text.split(/\s+/).filter(Boolean).length;
    const blockWords = b.text.split(/\s+/).filter(Boolean).length;
    if (text.length < 12) reject('too short');
    else if (words > MAX_WORDS) reject('too long');
    else if (blockWords > 30 && text.length >= b.text.length * 0.85) reject('whole paragraph');
    else if (!(c.importance >= o.minImportance)) reject('low importance');
    else if (c.category === 'example' && !o.allowExamples) reject('example');
    else {
      const layout = o.layout?.[b.page - 1];
      const rects = layout ? rangeRects(layout, b.start + r.start, b.start + r.end) : [];
      if (rects.length && o.existing.some((e) => e.page === b.page && rects.reduce((n, q) => n + overlap(q, e.rect), 0) >= rects.reduce((n, q) => n + area(q), 0) * 0.3)) {
        reject('already highlighted');
        continue;
      }
      valid.push({ ...c, blockIndex: bi, page: b.page, start: b.start + r.start, end: b.start + r.end, text, rects });
    }
  }

  // Most important first; then the more fundamental kind; then reading order.
  valid.sort((a, b) => b.importance - a.importance || (RANK[a.category] ?? 3) - (RANK[b.category] ?? 3) || a.blockIndex - b.blockIndex || a.start - b.start);
  const kept: Accepted[] = [];
  const perSection = new Map<number, number>();
  const sectionCap = Math.max(2, Math.ceil(o.budget / 2));
  for (const v of valid) {
    const dup = kept.some((k) => (k.page === v.page && k.start < v.end && v.start < k.end) || similar(k.text, v.text));
    if (dup) {
      rejected.push({ cand: v, reason: 'duplicate' });
      continue;
    }
    const sec = m.blocks[v.blockIndex].section;
    if (kept.length >= o.budget || (perSection.get(sec) ?? 0) >= sectionCap) {
      rejected.push({ cand: v, reason: 'over budget' });
      continue;
    }
    kept.push(v);
    perSection.set(sec, (perSection.get(sec) ?? 0) + 1);
  }
  kept.sort((a, b) => a.page - b.page || a.start - b.start);
  return { kept, rejected };
}

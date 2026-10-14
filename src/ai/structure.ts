// A document as the AI should read it: sections (with levels and pages) and blocks (paragraphs,
// list items, tables, captions…) with exact positions in the page text, tagged when they are a
// definition, theorem, example… Built once per file version, without any AI call (unit-tested).

import type { TextDoc } from './extract';
import type { Chunk, PageText } from './text';

export type BlockKind = 'paragraph' | 'list' | 'table' | 'caption' | 'code';
export type BlockTag = 'definition' | 'theorem' | 'property' | 'formula' | 'method' | 'example' | 'exercise' | 'remark' | 'warning' | 'summary' | 'question';
export type DocType = 'course' | 'exercises' | 'exam' | 'lab' | 'slides' | 'spreadsheet' | 'code' | 'notes' | 'article' | 'other';

export interface DocBlock {
  /** stable within one file version, e.g. "b12" */
  id: string;
  kind: BlockKind;
  tag?: BlockTag;
  /** 1-based */
  page: number;
  /** [start, end) in the page text; `text` is exactly that slice */
  start: number;
  end: number;
  text: string;
  /** index in `sections`, -1 before the first heading */
  section: number;
}
export interface DocSection {
  title: string;
  /** 1 = top level */
  level: number;
  page: number;
  /** index of the enclosing section, -1 for none */
  parent: number;
}
export interface DocModel {
  name: string;
  type: DocType;
  paged: boolean;
  pageCount: number;
  sections: DocSection[];
  blocks: DocBlock[];
}

interface Line {
  page: number;
  start: number;
  end: number;
  text: string;
  size?: number;
  y?: number;
  h?: number;
}

/** Lower case, no accents: for keyword tests. */
export const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

const LIST = /^\s*([-•▪◦‣*–]|\d{1,2}[.)]|[a-z][.)])\s+\S/;
const CAPTION = /^\s*(figure|fig\.|tableau|table|schema|graphique|image)\s*\d+\s*[:.\-–]/i;
const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const NUMBERED = /^\s*((\d+\.)+\d*|\d+|[IVX]+|[A-Z])[.)]?\s+\S/;
const KEYWORD_HEADING =
  /^(chapitre|chapter|partie|part|section|annexe|appendix|introduction|conclusion|resume|summary|a retenir|exercice|exercise|probleme|problem|question)\b/;
const TAGS: [RegExp, BlockTag][] = [
  [/^(definition|def\.)\b/, 'definition'],
  [/^(theoreme|theorem|lemme|lemma|corollaire|corollary|proposition)\b/, 'theorem'],
  [/^(propriete|property|proprietes|properties|loi|law|principe|principle)\b/, 'property'],
  [/^(formule|formula|equation|relation)\b/, 'formula'],
  [/^(methode|method|demarche|procedure|algorithme|algorithm)\b/, 'method'],
  [/^(exemple|example|ex\.|par exemple|for example|e\.g\.)\b/, 'example'],
  [/^(exercice|exercise|probleme|problem)\b/, 'exercise'],
  [/^(remarque|remark|note|nb|n\.b\.)\b/, 'remark'],
  [/^(attention|warning|important|piege|caution|⚠)/, 'warning'],
  [/^(a retenir|key points?|resume|summary|en resume|in summary|conclusion|bilan|essentiel)\b/, 'summary'],
  [/^(question|q\d+)\b/, 'question'],
];

function tagOf(text: string): BlockTag | undefined {
  const t = fold(text.trimStart()).replace(/^[-•▪◦‣*–\d.)\s]+(?=[a-z])/, '');
  return TAGS.find(([re]) => re.test(t))?.[1];
}

/** Splits a page text into lines, with exact offsets, and (PDF) font size and position. */
function linesOf(text: string, page: number, layout?: PageText): Line[] {
  const out: Line[] = [];
  let at = 0;
  for (const raw of text.split('\n')) {
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    const start = at + lead;
    const line: Line = { page, start, end: start + t.length, text: t };
    if (layout && t) {
      const spans = layout.spans.filter((s) => s.end > line.start && s.start < line.end);
      if (spans.length) {
        line.size = Math.max(...spans.map((s) => s.size ?? 0)) || undefined;
        line.y = Math.min(...spans.map((s) => s.rect.y));
        line.h = Math.max(...spans.map((s) => s.rect.h));
      }
    }
    out.push(line);
    at += raw.length + 1;
  }
  return out;
}

/** Repeated page headers/footers (top or bottom band of the page, on most pages). */
function boilerplate(pages: Line[][]): Set<string> {
  const found = new Set<string>();
  if (pages.length < 2) return found;
  const count = new Map<string, number>();
  for (const lines of pages) {
    const seen = new Set<string>();
    for (const l of lines) {
      if (!l.text || l.y === undefined || (l.y > 0.12 && l.y < 0.88)) continue;
      const k = fold(l.text).replace(/\d+/g, '#');
      if (!seen.has(k)) count.set(k, (count.get(k) ?? 0) + 1);
      seen.add(k);
    }
  }
  for (const [k, n] of count) if (n >= Math.max(2, Math.ceil(pages.length * 0.6))) found.add(k);
  return found;
}

const isBoilerplate = (l: Line, bp: Set<string>) =>
  l.y !== undefined && (l.y <= 0.12 || l.y >= 0.88) && (bp.has(fold(l.text).replace(/\d+/g, '#')) || /^(page\s*)?\d+(\s*\/\s*\d+)?$/i.test(l.text));

/** Font size used by most of the text (body text). */
function bodySize(lines: Line[]): number {
  const by = new Map<number, number>();
  for (const l of lines) if (l.size) by.set(l.size, (by.get(l.size) ?? 0) + l.text.length);
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

function looksLikeHeadingText(t: string): boolean {
  return t.length >= 2 && t.length <= 110 && !/[.;,]$/.test(t) && !LIST.test(t.replace(NUMBERED, 'x '));
}

export function buildModel(name: string, doc: TextDoc): DocModel {
  const format = doc.format;
  const pages = doc.pages.map((t, i) => linesOf(t, i + 1, doc.layout?.[i]));
  const all = pages.flat();
  const bp = format === 'pdf' ? boilerplate(pages) : new Set<string>();
  const body = format === 'pdf' ? bodySize(all.filter((l) => !isBoilerplate(l, bp))) : 0;
  const headingSizes = [...new Set(all.filter((l) => l.size && l.size >= body * 1.15 && looksLikeHeadingText(l.text)).map((l) => l.size!))].sort((a, b) => b - a);
  const sizeLevel = (size: number) => Math.min(3, headingSizes.indexOf(size) + 1);

  const sections: DocSection[] = [];
  const blocks: DocBlock[] = [];
  const stack: number[] = []; // open sections by level
  const addSection = (title: string, level: number, page: number) => {
    while (stack.length && sections[stack[stack.length - 1]].level >= level) stack.pop();
    sections.push({ title, level, page, parent: stack.length ? stack[stack.length - 1] : -1 });
    stack.push(sections.length - 1);
  };

  // (assigned inside the helpers below; the cast keeps TypeScript from narrowing it to null)
  let cur = null as { kind: BlockKind; lines: Line[] } | null;
  const flush = () => {
    if (!cur) return;
    const first = cur.lines[0];
    const last = cur.lines[cur.lines.length - 1];
    const text = doc.pages[first.page - 1].slice(first.start, last.end);
    blocks.push({
      id: `b${blocks.length + 1}`,
      kind: cur.kind,
      tag: cur.kind === 'code' || cur.kind === 'table' ? undefined : tagOf(text),
      page: first.page,
      start: first.start,
      end: last.end,
      text,
      section: sections.length - 1,
    });
    cur = null;
  };
  const add = (kind: BlockKind, l: Line, join: boolean) => {
    if (cur && join && cur.kind === kind && cur.lines[0].page === l.page) cur.lines.push(l);
    else {
      flush();
      cur = { kind, lines: [l] };
    }
  };

  let fenced = false;
  let prev: Line | null = null;
  for (const lines of pages) {
    const pageMax = Math.max(0, ...lines.filter((l) => l.size).map((l) => l.size!));
    for (const l of lines) {
      const t = l.text;
      if (format === 'code') {
        if (!t) flush();
        else add('code', l, true);
        continue;
      }
      if (/^(```|~~~)/.test(t)) {
        fenced = !fenced;
        add('code', l, true);
        if (!fenced) flush();
        continue;
      }
      if (fenced) {
        add('code', l, true);
        continue;
      }
      if (!t) {
        flush();
        prev = null;
        continue;
      }
      if (format === 'pdf' && isBoilerplate(l, bp)) continue;

      // Headings
      const md = format === 'markdown' || format === 'docx' || format === 'sheet' ? MD_HEADING.exec(t) : null;
      if (md) {
        flush();
        addSection(md[2].replace(/^Sheet "(.*)"$/, 'Sheet: $1'), md[1].length, l.page);
        prev = null;
        continue;
      }
      if (format === 'pdf' && l.size && body && l.size >= body * 1.15 && looksLikeHeadingText(t)) {
        flush();
        addSection(t, sizeLevel(l.size), l.page);
        prev = null;
        continue;
      }
      const isolated = !prev && (format === 'text' || format === 'pdf');
      if (isolated && looksLikeHeadingText(t) && KEYWORD_HEADING.test(fold(t)) && t.length <= 80 && (format === 'text' || (l.size ?? 0) >= body)) {
        flush();
        addSection(t, 2, l.page);
        prev = null;
        continue;
      }
      // Slides: the biggest line at the top of a short page is its title.
      if (format === 'pdf' && l.size && l.size === pageMax && l.size > body && lines.indexOf(l) <= 1 && looksLikeHeadingText(t)) {
        flush();
        addSection(t, 1, l.page);
        prev = null;
        continue;
      }

      // Blocks
      if (t.startsWith('|') || (format === 'sheet' && t.includes(' | '))) add('table', l, true);
      else if (CAPTION.test(t)) add('caption', l, false);
      else if (LIST.test(t)) add('list', l, false);
      else {
        const gap = prev && prev.y !== undefined && l.y !== undefined && prev.h ? l.y - prev.y - prev.h > prev.h * 0.7 : false;
        const continues = !!cur && !gap && !tagOf(t) && (cur.kind === 'paragraph' || cur.kind === 'list');
        if (continues) cur!.lines.push(l);
        else add('paragraph', l, false);
      }
      prev = l;
    }
    flush();
    prev = null;
  }
  flush();

  return { name, type: guessType(name, doc, sections, blocks), paged: doc.paged, pageCount: doc.pages.length, sections, blocks };
}

function guessType(name: string, doc: TextDoc, sections: DocSection[], blocks: DocBlock[]): DocType {
  if (doc.format === 'code') return 'code';
  if (doc.format === 'sheet') return 'spreadsheet';
  const n = fold(name);
  const head = fold(doc.pages.slice(0, 2).join(' ').slice(0, 3000));
  const exercises = blocks.filter((b) => b.tag === 'exercise').length + sections.filter((s) => /^(exercice|exercise|probleme|problem)\b/.test(fold(s.title))).length;
  if (/\b(examen|exam|controle|partiel|ds\d*|interro\w*|test|epreuve|quiz)\b/.test(n) || /\b(duree|bareme|calculatrice|documents? (non )?autorises?)\b/.test(head)) return 'exam';
  if (/\b(td\d*|exercices?|exercises?|worksheet|serie)\b/.test(n) || exercises >= 3) return 'exercises';
  if (/\b(tp\d*|lab|practical|travaux pratiques)\b/.test(n)) return 'lab';
  if (doc.paged && doc.pages.length >= 4 && doc.pages.reduce((a, p) => a + p.length, 0) / doc.pages.length < 500) return 'slides';
  if (blocks.some((b) => b.tag === 'definition' || b.tag === 'theorem') || /\b(chapitre|chapter|cours|lecture|lesson)\b/.test(n + ' ' + head)) return 'course';
  if (doc.format === 'markdown') return 'notes';
  if (sections.length >= 3) return 'article';
  return 'other';
}

/** Titles from the top level down to section `i`. */
export function sectionPath(m: DocModel, i: number): string[] {
  const out: string[] = [];
  for (let s = i; s >= 0; s = m.sections[s].parent) out.unshift(m.sections[s].title);
  return out;
}

/** Indented list of section titles with their pages. */
export function outline(m: DocModel, max = 80): string {
  return m.sections
    .slice(0, max)
    .map((s) => `${'  '.repeat(s.level - 1)}${s.title}${m.paged ? ` (p. ${s.page})` : ''}`)
    .join('\n');
}

/** Short source label of a block: page and section, e.g. "p. 3 · 2.1 La phase claire". */
export function blockLabel(m: DocModel, b: DocBlock): string {
  const sec = b.section >= 0 ? m.sections[b.section].title : '';
  return [m.paged ? `p. ${b.page}` : '', sec].filter(Boolean).join(' · ');
}

/**
 * Chunks along the document's structure: blocks grouped in reading order, each section starting
 * with its heading, pages marked, a chunk never larger than `budget` characters.
 */
export function chunkModel(m: DocModel, budget: number): Chunk[] {
  const out: Chunk[] = [];
  let cur: Chunk | null = null;
  let lastSection = -2;
  let lastPage = 0;
  const shown = new Set<number>();
  const push = (piece: string, page: number) => {
    if (cur && cur.text.length + piece.length + 1 <= budget) {
      cur.text += '\n' + piece;
      cur.to = page;
    } else {
      if (cur) out.push(cur);
      cur = { from: page, to: page, text: piece.slice(0, budget) };
    }
  };
  for (const b of m.blocks) {
    let head = '';
    if (m.paged && b.page !== lastPage) head += `[Page ${b.page}]\n`;
    if (b.section !== lastSection && b.section >= 0) {
      // the section's heading, preceded by those of enclosing sections not shown yet
      const chain: number[] = [];
      for (let i = b.section; i >= 0 && !shown.has(i); i = m.sections[i].parent) chain.unshift(i);
      for (const i of chain) {
        shown.add(i);
        head += `${'#'.repeat(Math.min(4, m.sections[i].level + 1))} ${m.sections[i].title}\n`;
      }
    }
    lastSection = b.section;
    lastPage = b.page;
    push(head + b.text, b.page);
  }
  if (cur) out.push(cur);
  return out;
}

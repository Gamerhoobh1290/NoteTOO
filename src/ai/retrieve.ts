// Finds the parts of a document that matter for a question: BM25 over blocks (section titles
// count as context), explicit "page 3" / "exercice 2" references, and neighbouring blocks for
// context, within a character budget. No AI call (unit-tested).

import { blockLabel, fold, type DocModel } from './structure';

const STOP = new Set(
  (
    'le la les un une des du de d l au aux et ou en dans sur pour par avec sans ce cet cette ces se sa son ses leur leurs ' +
    'qui que quoi dont ou est sont etre a ont avoir il elle ils elles on nous vous je tu me te lui y ne pas plus tres ' +
    'comme mais donc car si quel quelle quels quelles comment pourquoi quand explique expliquer dit dire fait faire peux peut ' +
    'the an and or of to in on for by with without this that these those is are be was were it its they them we you i me ' +
    'what which who how why when where does do did can could would should will about from into than then there here ' +
    'please tell explain show document file page section'
  ).split(' '),
);

/** Search words of a text: folded, no stop words, light plural stemming. */
export function tokens(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 && /[sx]$/.test(w) ? w.slice(0, -1) : w));
}

export interface Passage {
  /** block indexes, in order */
  blocks: number[];
  page: number;
  label: string;
  text: string;
  score: number;
}

const REF = /\b(page|p\.|exercice|exercise|ex|section|chapitre|chapter|partie|part|question|q)\s*(\d+(?:\.\d+)*)/g;

/** Blocks the question points at explicitly ("page 3", "exercice 2", "section 2.1"). */
function referenced(m: DocModel, query: string): Set<number> {
  const hits = new Set<number>();
  for (const [, word, num] of fold(query).matchAll(REF)) {
    if (word === 'page' || word === 'p.') {
      m.blocks.forEach((b, i) => b.page === Number(num) && hits.add(i));
      continue;
    }
    const secs = new Set<number>();
    m.sections.forEach((s, i) => {
      const t = fold(s.title);
      if (new RegExp(`(^|\\b)${word.replace('.', '\\.')}\\w*\\s*${num.replace(/\./g, '\\.')}\\b`).test(t) || new RegExp(`^${num.replace(/\./g, '\\.')}\\b`).test(t)) secs.add(i);
    });
    // a section's sub-sections belong to it
    m.sections.forEach((s, i) => s.parent >= 0 && secs.has(s.parent) && secs.add(i));
    m.blocks.forEach((b, i) => secs.has(b.section) && hits.add(i));
  }
  return hits;
}

/**
 * The passages of `m` most relevant to `query`, in document order, at most `budget` characters.
 * Empty when nothing matches.
 */
export function retrieve(m: DocModel, query: string, o: { budget: number; also?: string }): Passage[] {
  const q = [...new Set(tokens(query + ' ' + (o.also ?? '')))];
  const docs = m.blocks.map((b) => {
    const path: string[] = [];
    for (let s = b.section; s >= 0; s = m.sections[s].parent) path.push(m.sections[s].title);
    return [...tokens(b.text), ...tokens(path.join(' '))];
  });
  const N = docs.length || 1;
  const avg = docs.reduce((n, d) => n + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const k1 = 1.2;
  const bm = 0.75;
  const refs = referenced(m, query);
  const scores = docs.map((d, i) => {
    let s = 0;
    for (const w of q) {
      const f = d.filter((x) => x === w).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - bm + (bm * d.length) / avg));
    }
    return s + (refs.has(i) ? 10 : 0);
  });

  const ranked = scores.map((s, i) => [s, i] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
  const picked = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    if (picked.has(i) || i < 0 || i >= m.blocks.length) return true;
    const len = m.blocks[i].text.length;
    if (used + len > o.budget) return false;
    picked.add(i);
    used += len;
    return true;
  };
  for (const [, i] of ranked) {
    if (!take(i)) {
      if (!picked.size) continue; // a block bigger than the budget: try the next one
      break;
    }
    // Context: the blocks just before and after, when they are in the same section.
    for (const j of [i - 1, i + 1]) if (m.blocks[j]?.section === m.blocks[i].section && scores[j] >= 0) take(j);
  }

  // Group consecutive picked blocks of the same section and page into passages.
  const out: Passage[] = [];
  for (const i of [...picked].sort((a, b) => a - b)) {
    const b = m.blocks[i];
    const last = out[out.length - 1];
    const prevIdx = last?.blocks[last.blocks.length - 1];
    if (last && prevIdx === i - 1 && m.blocks[prevIdx].section === b.section && m.blocks[prevIdx].page === b.page) {
      last.blocks.push(i);
      last.text += '\n' + b.text;
      last.score = Math.max(last.score, scores[i]);
    } else out.push({ blocks: [i], page: b.page, label: blockLabel(m, b), text: b.text, score: scores[i] });
  }
  return out;
}

/** Passages as the model reads them: each with its page/section label. */
export function formatPassages(m: DocModel, ps: Passage[]): string {
  return ps.map((p) => `[${p.label || m.name}]\n${p.text}`).join('\n\n');
}

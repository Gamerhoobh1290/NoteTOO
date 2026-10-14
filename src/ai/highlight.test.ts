import { describe, expect, it } from 'vitest';
import type { AiDoc } from './extract';
import { findInBlock, highlightBudget, rangeRects, selectHighlights, type Candidate } from './highlight';
import { buildModel } from './structure';
import type { PageText } from './text';

/** One page; each line is one pdf.js span spanning x 0.1 → 0.1 + 0.01 per char. */
function page(n: number, lines: string[], size = 11): PageText {
  let text = '';
  const spans: PageText['spans'] = [];
  lines.forEach((s, i) => {
    if (!s) {
      text += '\n';
      return;
    }
    spans.push({ start: text.length, end: text.length + s.length, rect: { x: 0.1, y: 0.1 + i * 0.03, w: s.length * 0.01, h: 0.02 }, size });
    text += s + '\n';
  });
  return { page: n, text, spans };
}
const doc = (pages: PageText[]): AiDoc & { kind: 'text' } => ({ kind: 'text', pages: pages.map((p) => p.text), paged: true, layout: pages, truncated: false, format: 'pdf' });

const p1 = page(1, [
  'La photosynthèse est la synthèse de matière organique à partir de lumière.',
  '',
  'Elle a lieu dans les chloroplastes des cellules végétales chlorophylliennes.',
  '',
  'Exemple : une feuille de chêne au soleil produit du glucose toute la journée.',
  '',
  'La phase claire produit de l’ATP et du NADPH dans les thylakoïdes, grâce à la photolyse de l’eau qui libère du dioxygène, et cette énergie chimique sera ensuite utilisée par le cycle de Calvin dans le stroma pour fixer le dioxyde de carbone et produire des sucres.',
]);
const m = buildModel('cours.pdf', doc([p1]));
const id = (needle: string) => m.blocks.find((b) => b.text.includes(needle))!.id;
const cand = (block: string, quote: string, over: Partial<Candidate> = {}): Candidate => ({ block, quote, category: 'definition', importance: 5, why: 'Key definition.', ...over });
const opts = { budget: 10, minImportance: 3, allowExamples: false, existing: [], layout: [p1] };

describe('findInBlock', () => {
  it('matches despite case, accents, spacing and quote style', () => {
    const t = 'La phase claire produit de l’ATP.';
    expect(findInBlock(t, "la phase  claire produit de l'ATP")).toEqual({ start: 0, end: t.length - 1 });
  });
  it('refuses a paraphrase', () => {
    expect(findInBlock('La phase claire produit de l’ATP.', 'La phase lumineuse fabrique de l’ATP')).toBeNull();
  });
});

describe('selectHighlights', () => {
  it('keeps an exact quote and places it in its own block only', () => {
    const r = selectHighlights([cand(id('synthèse de matière'), 'La photosynthèse est la synthèse de matière organique')], m, opts);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].rects.length).toBe(1);
  });

  it('never attaches a quote to another block, even a similar one', () => {
    const r = selectHighlights([cand(id('chloroplastes'), 'La photosynthèse est la synthèse de matière organique')], m, opts);
    expect(r.kept).toHaveLength(0);
    expect(r.rejected[0].reason).toBe('not in that passage');
  });

  it('skips low-importance and example highlights', () => {
    const r = selectHighlights(
      [cand(id('chloroplastes'), 'Elle a lieu dans les chloroplastes', { importance: 2 }), cand(id('chêne'), 'une feuille de chêne au soleil produit du glucose', { category: 'example' })],
      m,
      opts,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason).sort()).toEqual(['example', 'low importance']);
  });

  it('refuses to highlight a whole long paragraph', () => {
    const b = m.blocks.find((x) => x.text.startsWith('La phase claire'))!;
    const r = selectHighlights([cand(b.id, b.text)], m, opts);
    expect(r.rejected[0].reason).toBe('too long');
  });

  it('drops duplicates, keeping the more important one', () => {
    const b = id('synthèse de matière');
    const r = selectHighlights(
      [cand(b, 'La photosynthèse est la synthèse de matière', { importance: 4 }), cand(b, 'La photosynthèse est la synthèse de matière organique', { importance: 5 })],
      m,
      opts,
    );
    expect(r.kept.map((k) => k.importance)).toEqual([5]);
    expect(r.rejected[0].reason).toBe('duplicate');
  });

  it('respects highlights the user already made', () => {
    const existing = [{ page: 1, rect: { x: 0.05, y: 0.09, w: 0.8, h: 0.04 } }];
    const r = selectHighlights([cand(id('synthèse de matière'), 'La photosynthèse est la synthèse de matière organique')], m, { ...opts, existing });
    expect(r.rejected[0].reason).toBe('already highlighted');
  });

  it('keeps to the budget, most important first, then in reading order', () => {
    const r = selectHighlights(
      [
        cand(id('chloroplastes'), 'Elle a lieu dans les chloroplastes des cellules végétales', { importance: 3 }),
        cand(id('synthèse de matière'), 'La photosynthèse est la synthèse de matière organique', { importance: 5 }),
        cand(id('La phase claire'), 'La phase claire produit de l’ATP et du NADPH dans les thylakoïdes', { importance: 4 }),
      ],
      m,
      { ...opts, budget: 2 },
    );
    expect(r.kept.map((k) => k.importance)).toEqual([5, 4]);
    expect(r.rejected[0].reason).toBe('over budget');
  });
});

describe('rangeRects', () => {
  const p = page(1, ['abcdefghij', 'klmnopqrst']);
  it('gives one rectangle per line', () => {
    expect(rangeRects(p, 5, 16)).toHaveLength(2);
  });
  it('covers only the quoted part of a span', () => {
    const [r] = rangeRects(p, 2, 6);
    expect(r.x).toBeGreaterThan(0.11);
    expect(r.w).toBeLessThan(0.07);
  });
});

describe('highlightBudget', () => {
  it('grows with length but stays small', () => {
    expect(highlightBudget(m, false)).toBeGreaterThanOrEqual(3);
    expect(highlightBudget({ ...m, pageCount: 60 }, false)).toBe(12);
  });
});

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

  it('refuses fragments under four words (the prompt asks for 4 to 35), but keeps formulas', () => {
    const list = buildModel('l.pdf', doc([page(1, ['Les facteurs limitants sont :', '- l’intensité lumineuse ;', '- la concentration en CO2 de l’air ;', '', 'Équation bilan : 6 CO2 + 6 H2O -> C6H12O6 + 6 O2'])]));
    const at = (needle: string) => list.blocks.find((b) => b.text.includes(needle))!.id;
    const r = selectHighlights(
      [cand(at('intensité'), '- l’intensité lumineuse', { category: 'key-fact' }), cand(at('C6H12O6'), '6 CO2 + 6 H2O -> C6H12O6 + 6 O2', { category: 'formula' })],
      list,
      { ...opts, layout: undefined },
    );
    expect(r.kept.map((k) => k.category)).toEqual(['formula']);
    expect(r.rejected[0].reason).toBe('too short');
  });

  it('refuses to highlight a whole long paragraph', () => {
    const b = m.blocks.find((x) => x.text.startsWith('La phase claire'))!;
    const r = selectHighlights([cand(b.id, b.text)], m, opts);
    expect(r.rejected[0].reason).toBe('too long');
  });

  it('keeps a long one-sentence definition even though it is the whole paragraph', () => {
    const sentence = 'Definition: the Cold War was a period of geopolitical rivalry between the United States and the Soviet Union, and their allies, that never escalated into direct large-scale fighting between the two superpowers.';
    const mm = buildModel('l.pdf', doc([page(1, [sentence])]));
    const r = selectHighlights([cand(mm.blocks[0].id, sentence)], mm, { ...opts, layout: undefined });
    expect(r.kept).toHaveLength(1);
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

describe('coverage', () => {
  const md: AiDoc & { kind: 'text' } = {
    kind: 'text',
    paged: false,
    truncated: false,
    format: 'markdown',
    pages: ['# Phase claire\n\nLa photolyse de l’eau libère le dioxygène.\n\nLes thylakoïdes produisent ATP et NADPH.\n\n# Cycle de Calvin\n\nLa RuBisCO fixe le CO2 dans le stroma.\n\n# À retenir\n\nLe dioxygène vient de la photolyse de l’eau, pas du CO2.'],
  };
  const mm = buildModel('notes.md', md);
  const bid = (needle: string) => mm.blocks.find((b) => b.text.includes(needle))!.id;
  it('gives each main section its best point before a second one anywhere, and skips recaps', () => {
    const r = selectHighlights(
      [
        cand(bid('photolyse de l’eau libère'), 'La photolyse de l’eau libère le dioxygène', { importance: 5 }),
        cand(bid('thylakoïdes produisent'), 'Les thylakoïdes produisent ATP et NADPH', { importance: 5 }),
        cand(bid('RuBisCO'), 'La RuBisCO fixe le CO2 dans le stroma', { importance: 4 }),
        cand(bid('pas du CO2'), 'Le dioxygène vient de la photolyse de l’eau, pas du CO2', { importance: 5, category: 'conclusion' }),
      ],
      mm,
      { budget: 2, minImportance: 3, allowExamples: false, existing: [] },
    );
    expect(r.kept.map((k) => k.text)).toEqual(['La photolyse de l’eau libère le dioxygène', 'La RuBisCO fixe le CO2 dans le stroma']);
  });

  it('keeps at most one point from a summary section, even with budget to spare', () => {
    const recap = buildModel('r.md', { ...md, pages: [md.pages[0] + '\n\nLa RuBisCO travaille dans le stroma du chloroplaste.\n\nLes thylakoïdes fournissent ATP et NADPH au cycle.'] });
    const at = (needle: string) => recap.blocks.find((b) => b.text.includes(needle))!.id;
    const r = selectHighlights(
      [
        cand(at('RuBisCO fixe'), 'La RuBisCO fixe le CO2 dans le stroma', { importance: 5 }),
        cand(at('pas du CO2'), 'Le dioxygène vient de la photolyse de l’eau, pas du CO2', { importance: 5, category: 'conclusion' }),
        cand(at('travaille dans le stroma'), 'La RuBisCO travaille dans le stroma du chloroplaste', { importance: 5, category: 'conclusion' }),
        cand(at('fournissent ATP'), 'Les thylakoïdes fournissent ATP et NADPH au cycle', { importance: 5, category: 'conclusion' }),
      ],
      recap,
      { budget: 8, minImportance: 3, allowExamples: false, existing: [] },
    );
    expect(r.kept.map((k) => k.text)).toEqual(['La RuBisCO fixe le CO2 dans le stroma', 'Le dioxygène vient de la photolyse de l’eau, pas du CO2']);
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

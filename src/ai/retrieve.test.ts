import { describe, expect, it } from 'vitest';
import type { AiDoc } from './extract';
import { formatPassages, retrieve, tokens, type Passage } from './retrieve';
import { buildModel } from './structure';

const md = (text: string): AiDoc & { kind: 'text' } => ({ kind: 'text', pages: [text], paged: false, truncated: false, format: 'markdown' });
const paged = (pages: string[]): AiDoc & { kind: 'text' } => ({ kind: 'text', pages, paged: true, truncated: false, format: 'text' });

/** passages come in document order; the best one is the highest score */
const best = (r: Passage[]) => r.reduce((a, b) => (b.score > a.score ? b : a));

const course = buildModel(
  'photosynthese.md',
  md(
    [
      '# La photosynthèse',
      'La photosynthèse produit la matière organique des plantes.',
      '## Phase claire',
      'Elle a lieu dans les thylakoïdes et produit de l’ATP et du NADPH.',
      'La photolyse de l’eau libère du dioxygène.',
      '## Cycle de Calvin',
      'Dans le stroma, la RuBisCO fixe le CO2 sur le ribulose bisphosphate.',
      '## Facteurs limitants',
      'La lumière, la concentration en CO2 et la température limitent la photosynthèse.',
    ].join('\n\n'),
  ),
);

describe('tokens', () => {
  it('ignores accents, case, plurals and stop words', () => {
    expect(tokens('Les Thylakoïdes et le stroma')).toEqual(['thylakoide', 'stroma']);
  });
});

describe('retrieve', () => {
  it('finds the passage that answers the question, with its section', () => {
    const r = retrieve(course, 'Où se trouvent les thylakoides ?', { budget: 300 });
    expect(r[0].text).toContain('thylakoïdes');
    expect(r[0].label).toBe('Phase claire');
  });

  it('uses section titles: a question about a section gets that section', () => {
    const r = retrieve(course, 'explique le cycle de Calvin', { budget: 300 });
    expect(r.map((p) => p.label)).toContain('Cycle de Calvin');
    expect(r[0].text).toContain('RuBisCO');
  });

  it('keeps to the character budget', () => {
    const r = retrieve(course, 'photosynthèse lumière CO2 ATP stroma', { budget: 150 });
    expect(r.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(150);
    expect(r.length).toBeGreaterThan(0);
  });

  it('returns passages in document order', () => {
    const r = retrieve(course, 'température stroma thylakoïdes', { budget: 2000 });
    const order = r.map((p) => p.blocks[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('honours an explicit page reference', () => {
    const m = buildModel('cours.pdf', paged(['Intro générale sur les plantes.', 'Les mitochondries respirent.', 'Le chloroplaste capte la lumière.']));
    const r = retrieve(m, 'que dit la page 3 ?', { budget: 500 });
    expect(best(r).page).toBe(3);
  });

  it('honours an exercise / section number', () => {
    const m = buildModel('td.md', md('# Exercice 1\n\nCalculer une dérivée.\n\n# Exercice 2\n\nMontrer que la suite converge.\n\n# Exercice 3\n\nRésoudre l’équation.'));
    const r = retrieve(m, "je ne comprends pas l'exercice 2", { budget: 500 });
    expect(best(r).text).toContain('converge');
  });

  it('returns nothing when nothing matches (caller then uses the outline)', () => {
    expect(retrieve(course, 'xylophone quantique', { budget: 500 })).toEqual([]);
  });

  it('labels passages for the model', () => {
    const out = formatPassages(course, retrieve(course, 'RuBisCO', { budget: 500 }));
    expect(out).toMatch(/^\[Cycle de Calvin\]\n.*RuBisCO/);
  });
});

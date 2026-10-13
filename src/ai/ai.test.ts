import { describe, expect, it } from 'vitest';
import { stripThinking } from './client';
import { parseShowLinks } from './guide';
import { InvalidAnswer, extractJson } from './json';
import { parseProposals, planChanges } from './organize';
import { chunkPages, findQuote, locateQuote, type PageText } from './text';

describe('findQuote', () => {
  const text = 'Chapitre 1\nDéfinition : une primitive de f sur I est une fonction F dérivable telle que F’ = f.\nExemple…';

  it('finds a quote despite spacing, accents, case and apostrophes', () => {
    const r = findQuote(text, "une primitive de f sur I est une fonction F derivable telle que F' = f")!;
    expect(text.slice(r.start, r.end)).toBe('une primitive de f sur I est une fonction F dérivable telle que F’ = f');
  });

  it('tolerates a few changed words in the middle', () => {
    const r = findQuote(text, 'une primitive de f sur I est une application F dérivable telle que F’ = f')!;
    expect(text.slice(r.start, r.end)).toContain('primitive');
    expect(text.slice(r.start, r.end)).toContain('F’ = f');
  });

  it('returns null for text that is not there', () => {
    expect(findQuote(text, 'le théorème de Pythagore')).toBeNull();
    expect(findQuote(text, 'Ch')).toBeNull();
  });
});

describe('locateQuote', () => {
  // Two lines; the PDF splits words into separate items.
  const page: PageText = {
    page: 1,
    text: 'Théorème de Rolle Si f est continue\nalors il existe c',
    spans: [
      { start: 0, end: 17, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.02 } },
      { start: 18, end: 35, rect: { x: 0.42, y: 0.2, w: 0.3, h: 0.02 } },
      { start: 36, end: 52, rect: { x: 0.1, y: 0.23, w: 0.25, h: 0.02 } },
    ],
  };

  it('returns the box around the spans of the quote', () => {
    const r = locateQuote(page, 'Si f est continue alors il existe c')!;
    expect(r.x).toBeCloseTo(0.1 - 0.004);
    expect(r.y).toBeCloseTo(0.2 - 0.004);
    expect(r.x + r.w).toBeCloseTo(0.72 + 0.004);
    expect(r.y + r.h).toBeCloseTo(0.25 + 0.004);
  });

  it('returns null when the quote is not on the page', () => {
    expect(locateQuote(page, 'intégrale de Riemann')).toBeNull();
  });
});

describe('chunkPages', () => {
  it('groups pages under the budget and marks page numbers', () => {
    const chunks = chunkPages(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)], 120, true);
    expect(chunks.map((c) => [c.from, c.to])).toEqual([
      [1, 2],
      [3, 3],
    ]);
    expect(chunks[0].text).toContain('[Page 2]');
  });

  it('cuts a page longer than the budget and skips empty pages', () => {
    const chunks = chunkPages(['', 'x'.repeat(250)], 100, false);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.from === 2 && c.text.length <= 100)).toBe(true);
  });
});

describe('extractJson', () => {
  it('reads JSON wrapped in fences or text', () => {
    expect(extractJson('Sure!\n```json\n{"files": []}\n```')).toEqual({ files: [] });
  });
  it('rejects answers without JSON', () => {
    expect(() => extractJson('I cannot do that')).toThrow(InvalidAnswer);
    expect(() => extractJson('{"files": [}')).toThrow(InvalidAnswer);
  });
});

describe('stripThinking', () => {
  it('removes reasoning blocks, finished or not', () => {
    expect(stripThinking('<think>hmm</think>\nHello')).toBe('Hello');
    expect(stripThinking('<think>still thinking')).toBe('');
  });
});

describe('parseShowLinks', () => {
  it('keeps known targets and drops unknown ones', () => {
    const parts = parseShowLinks('Open it here [[show:scratchpad]] or [[show:nope]], then [[annotations]].');
    expect(parts).toEqual([
      { kind: 'text', text: 'Open it here ' },
      { kind: 'show', id: 'scratchpad' },
      { kind: 'text', text: ' or ' },
      { kind: 'text', text: ', then ' },
      { kind: 'show', id: 'annotations' },
      { kind: 'text', text: '.' },
    ]);
  });
});

describe('organize plan', () => {
  const existing = [
    { path: 'Maths', kind: 'dir' as const },
    { path: 'Maths/cours', kind: 'dir' as const },
    { path: 'Maths/TD', kind: 'dir' as const },
    { path: 'Maths/TD/TD3 - Graphes', kind: 'dir' as const },
    { path: 'Maths/scan_001.pdf', kind: 'file' as const },
    { path: 'Maths/TD/ex2.pdf', kind: 'file' as const },
    { path: 'Maths/loose.txt', kind: 'file' as const },
    { path: 'Maths/TD/TD3 - Graphes/ex1.pdf', kind: 'file' as const },
  ];
  const files = new Map([
    [1, 'Maths/scan_001.pdf'],
    [2, 'Maths/TD/ex2.pdf'],
    [3, 'Maths/loose.txt'],
  ]);

  it('reuses existing folder casing, keeps extensions and plans new folders', () => {
    const plan = planChanges(
      files,
      [
        { id: 1, target: 'maths/Cours/Intégrales - chapitre 1', reason: 'Course chapter' },
        { id: 2, target: 'Maths/td/td3 - graphes/ex2.pdf', reason: 'Same TD' },
        { id: 3, target: 'Physique/TP/notes.txt', reason: 'Physics lab' },
      ],
      existing,
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.changes).toEqual([
      { from: 'Maths/scan_001.pdf', to: 'Maths/cours/Intégrales - chapitre 1.pdf', reason: 'Course chapter', move: true, rename: true },
      { from: 'Maths/TD/ex2.pdf', to: 'Maths/TD/TD3 - Graphes/ex2.pdf', reason: 'Same TD', move: true, rename: false },
      { from: 'Maths/loose.txt', to: 'Physique/TP/notes.txt', reason: 'Physics lab', move: true, rename: true },
    ]);
    expect(plan.newFolders).toEqual(['Physique', 'Physique/TP']);
  });

  it('never targets an existing file or another planned file', () => {
    const plan = planChanges(
      files,
      [
        { id: 1, target: 'Maths/TD/TD3 - Graphes/ex1.pdf', reason: '' },
        { id: 2, target: 'Maths/TD/TD3 - Graphes/ex1.pdf', reason: '' },
      ],
      existing,
    );
    expect(plan.changes.map((c) => c.to)).toEqual(['Maths/TD/TD3 - Graphes/ex1 (1).pdf', 'Maths/TD/TD3 - Graphes/ex1 (2).pdf']);
  });

  it('rejects unsafe or malformed targets and ignores unknown ids and no-ops', () => {
    const plan = planChanges(
      files,
      [
        { id: 1, target: 'Maths/Random/x.pdf', reason: '' },
        { id: 2, target: '../evil/ex2.pdf', reason: '' },
        { id: 3, target: 'Maths/loose.txt', reason: '' },
        { id: 99, target: 'Maths/TD/z.pdf', reason: '' },
        { id: 1, target: 'Maths/TD/again.pdf', reason: '' },
      ],
      existing,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.rejected.map((r) => r.from)).toEqual(['Maths/scan_001.pdf', 'Maths/TD/ex2.pdf']);
  });

  it('validates the answer shape', () => {
    expect(parseProposals({ files: [{ id: 1, target: 'A/Cours/b.pdf', reason: 'x' }] })).toEqual([{ id: 1, target: 'A/Cours/b.pdf', reason: 'x' }]);
    expect(() => parseProposals({ files: [{ id: '1', target: 'x' }] })).toThrow(InvalidAnswer);
  });
});

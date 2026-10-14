import { describe, expect, it } from 'vitest';
import type { TextDoc } from './extract';
import { buildModel, chunkModel, outline, sectionPath } from './structure';
import type { PageText } from './text';

/** A PDF page as pdf.js gives it: one span per line, with its font size and position. */
function page(n: number, lines: ([string, number] | [string, number, number])[]): PageText {
  let text = '';
  const spans: PageText['spans'] = [];
  let y = 0.06;
  for (const [s, size, at] of lines) {
    if (s === '') {
      y += 0.03;
      continue;
    }
    spans.push({ start: text.length, end: text.length + s.length, rect: { x: 0.1, y: at ?? y, w: Math.min(0.8, s.length * 0.008), h: size / 800 }, size });
    text += s + '\n';
    y += (size * 1.5) / 800;
  }
  return { page: n, text, spans };
}
const pdf = (pages: PageText[]): TextDoc => ({ kind: 'text', pages: pages.map((p) => p.text), paged: true, layout: pages, truncated: false, format: 'pdf' });
const plain = (text: string, format: 'markdown' | 'code' | 'text' | 'docx' = 'markdown'): TextDoc => ({ kind: 'text', pages: [text], paged: false, truncated: false, format });

/** at the bottom of the page, like a real footer */
const footer = (n: number): [string, number, number] => [`Lycée Pasteur — Biologie — page ${n}`, 9, 0.95];

const course = pdf([
  page(1, [
    ['Chapitre 3 - La photosynthèse', 20],
    ['La photosynthèse permet aux plantes de produire leur matière organique à partir de lumière.', 11],
    ['1. Définition', 15],
    ['Définition : la photosynthèse est la synthèse de matière organique à partir de CO2 et d’eau,', 11],
    ['grâce à l’énergie lumineuse captée par la chlorophylle.', 11],
    ['', 0],
    ['Figure 1 : schéma d’un chloroplaste', 10],
    footer(1),
  ]),
  page(2, [
    ['2. Les deux phases', 15],
    ['2.1 La phase claire', 13],
    ['Elle a lieu dans les thylakoïdes et produit de l’ATP et du NADPH.', 11],
    ['- photolyse de l’eau', 11],
    ['- libération de dioxygène', 11],
    ['Exemple : chez les plantes C4, le CO2 est d’abord fixé sous forme de malate.', 11],
    footer(2),
  ]),
  page(3, [
    ['À retenir', 15],
    ['La photosynthèse convertit l’énergie lumineuse en énergie chimique.', 11],
    footer(3),
  ]),
]);

describe('buildModel (PDF)', () => {
  const m = buildModel('Chapitre 3 - La photosynthèse.pdf', course);

  it('finds headings from font size, with levels', () => {
    expect(m.sections.map((s) => [s.title, s.level, s.page])).toEqual([
      ['Chapitre 3 - La photosynthèse', 1, 1],
      ['1. Définition', 2, 1],
      ['2. Les deux phases', 2, 2],
      ['2.1 La phase claire', 3, 2],
      ['À retenir', 2, 3],
    ]);
    const claire = m.sections.findIndex((s) => s.title === '2.1 La phase claire');
    expect(sectionPath(m, claire)).toEqual(['Chapitre 3 - La photosynthèse', '2. Les deux phases', '2.1 La phase claire']);
  });

  it('drops page headers/footers repeated on every page', () => {
    expect(m.blocks.some((b) => b.text.includes('Lycée Pasteur'))).toBe(false);
  });

  it('joins wrapped lines into one paragraph and tags definitions, examples, captions, lists, summaries', () => {
    const def = m.blocks.find((b) => b.tag === 'definition')!;
    expect(def.text).toBe('Définition : la photosynthèse est la synthèse de matière organique à partir de CO2 et d’eau,\ngrâce à l’énergie lumineuse captée par la chlorophylle.');
    expect(m.blocks.find((b) => b.kind === 'caption')?.text).toMatch(/^Figure 1/);
    expect(m.blocks.filter((b) => b.kind === 'list').map((b) => b.text)).toEqual(['- photolyse de l’eau', '- libération de dioxygène']);
    expect(m.blocks.find((b) => b.tag === 'example')?.page).toBe(2);
    expect(m.blocks.find((b) => b.page === 3 && b.kind === 'paragraph')?.section).toBe(m.sections.findIndex((s) => s.title === 'À retenir'));
    expect(m.sections.find((s) => s.title === 'À retenir')).toBeTruthy();
  });

  it('keeps exact offsets into the page text (needed to place highlights)', () => {
    for (const b of m.blocks) expect(course.kind === 'text' && course.pages[b.page - 1].slice(b.start, b.end)).toBe(b.text);
  });

  it('finds lines from positions when pdf.js does not mark line ends', () => {
    // Title and first line come as one run of text "…photosynthèse La photosynthèse permet…".
    const title = 'Chapitre 3 - La photosynthèse';
    const body = 'La photosynthèse permet aux plantes de produire leur matière organique.';
    const p: PageText = {
      page: 1,
      text: `${title} ${body}`,
      spans: [
        { start: 0, end: title.length, rect: { x: 0.1, y: 0.06, w: 0.5, h: 0.03 }, size: 20 },
        { start: title.length + 1, end: title.length + 1 + body.length, rect: { x: 0.1, y: 0.12, w: 0.8, h: 0.015 }, size: 11 },
      ],
    };
    const mm = buildModel('c.pdf', pdf([p]));
    expect(mm.sections.map((s) => s.title)).toEqual([title]);
    expect(mm.blocks.map((b) => b.text)).toEqual([body]);
  });

  it('joins a heading wrapped on two lines, and splits paragraphs that end short of the margin', () => {
    const lines: [string, number, number, number][] = [
      // text, size, y, width
      ['Lecture 4: The Origins of the Cold War', 21, 0.06, 0.8],
      ['(1945–1953)', 21, 0.092, 0.2],
      ['At the Yalta and Potsdam conferences, the Allies disagreed over the future of', 11, 0.15, 0.8],
      ['Germany and Eastern Europe.', 11, 0.168, 0.35],
      ['In March 1946, Churchill warned that an iron curtain had descended.', 11, 0.186, 0.6],
      ['The Truman Doctrine committed the United States to support free peoples', 11, 0.204, 0.8],
      ['resisting subjugation.', 11, 0.222, 0.3],
    ];
    let text = '';
    const spans: PageText['spans'] = [];
    for (const [s, size, y, w] of lines) {
      spans.push({ start: text.length, end: text.length + s.length, rect: { x: 0.1, y, w, h: size / 700 }, size });
      text += s + ' ';
    }
    const mm = buildModel('lecture.pdf', pdf([{ page: 1, text, spans }]));
    expect(mm.sections.map((s) => s.title)).toEqual(['Lecture 4: The Origins of the Cold War (1945–1953)']);
    expect(mm.blocks.map((b) => b.text.slice(0, 12))).toEqual(['At the Yalta', 'In March 194', 'The Truman D']);
  });

  it('guesses a course', () => {
    expect(m.type).toBe('course');
  });

  it('writes an outline with pages', () => {
    expect(outline(m)).toContain('  2.1 La phase claire (p. 2)');
  });
});

describe('buildModel (text formats)', () => {
  it('reads Markdown headings, lists and tables', () => {
    const m = buildModel('notes.md', plain('# Révisions\n\nIntro.\n\n## Dérivées\n\n- règle du produit\n- règle de la chaîne\n\n| f | f\' |\n| --- | --- |\n| x² | 2x |\n'));
    expect(m.sections.map((s) => [s.title, s.level])).toEqual([
      ['Révisions', 1],
      ['Dérivées', 2],
    ]);
    expect(m.blocks.map((b) => b.kind)).toEqual(['paragraph', 'list', 'list', 'table']);
  });

  it('does not read # comments in code as headings', () => {
    const m = buildModel('tp1.py', plain('# compute the mean\ndef mean(xs):\n    return sum(xs) / len(xs)\n', 'code'));
    expect(m.sections).toHaveLength(0);
    expect(m.type).toBe('code');
  });

  it('recognizes exams and exercise sheets', () => {
    expect(buildModel('Contrôle photosynthèse.pdf', plain('Durée : 1 h. Calculatrice interdite.\n\nExercice 1 (4 points)\nExpliquer…', 'text')).type).toBe('exam');
    expect(buildModel('TD3.pdf', plain('Exercice 1\nCalculer.\n\nExercice 2\nMontrer.\n\nExercice 3\nRésoudre.', 'text')).type).toBe('exercises');
  });

  it('treats short pages with a big first line as slides', () => {
    const titles = ['Big-O notation', 'Common classes', 'Sorting costs', 'Recursion trees', 'Summary'];
    const slides = pdf(titles.map((t, i) => page(i + 1, [[t, 28], [`• first point about ${t}`, 18], [`• second point about ${t}`, 18]])));
    const m = buildModel('Complexité.pdf', slides);
    expect(m.type).toBe('slides');
    expect(m.sections.map((s) => s.title)).toEqual(titles);
  });
});

describe('chunkModel', () => {
  const m = buildModel('Chapitre 3 - La photosynthèse.pdf', course);
  it('keeps headings and page marks with the text, without footers', () => {
    const [one] = chunkModel(m, 100_000);
    expect(one.text).toContain('[Page 2]\n### 2. Les deux phases');
    expect(one.text).not.toContain('Lycée Pasteur');
  });
  it('splits along blocks within the budget', () => {
    const parts = chunkModel(m, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(200);
    expect(parts[0].from).toBe(1);
    expect(parts[parts.length - 1].to).toBe(3);
  });
});

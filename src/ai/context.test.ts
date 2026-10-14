import { describe, expect, it } from 'vitest';
import { detectIntent, highlightFocus, resolveDocs } from './context';

describe('detectIntent', () => {
  it.each([
    ['Résume ce chapitre', 'summarize'],
    ['What are the key points?', 'summarize'],
    ['Surligne les définitions importantes', 'highlight'],
    ['highlight what matters for the exam', 'highlight'],
    ['How do I highlight part of a PDF?', 'app'],
    ['Comment ajouter des fichiers à une matière ?', 'app'],
    ['Quelle est la différence entre la phase claire et le cycle de Calvin ?', 'compare'],
    ['Où le document parle-t-il de la RuBisCO ?', 'locate'],
    ['Which page explains containment?', 'locate'],
    ["Pose-moi des questions pour réviser l'examen", 'study'],
    ["Je ne comprends pas l'exercice 2, explique-moi", 'explain'],
    ['What is the Truman Doctrine?', 'explain'],
    ['Merci !', 'question'],
  ])('%s → %s', (q, intent) => {
    expect(detectIntent(q)).toBe(intent);
  });
});

describe('highlightFocus', () => {
  it('keeps what to highlight, without the command', () => {
    expect(highlightFocus('Surligne les définitions importantes')).toBe('les définitions importantes');
    expect(highlightFocus('highlight what matters for the exam')).toBe('what matters for the exam');
    expect(highlightFocus('Highlight important')).toBe('');
  });
});

describe('resolveDocs', () => {
  const index = [
    'Biologie/Cours/Chapitre 3 - La photosynthèse.pdf',
    'Biologie/Exams/Contrôle photosynthèse.pdf',
    'Maths/TD/TD3 - Graphes/ex2.pdf',
    'Physique/TD/TD3/ex2.pdf',
    'History/Lectures/The Cold War - Lecture 4.pdf',
  ];
  const base = { current: 'Biologie/Cours/Chapitre 3 - La photosynthèse.pdf', recent: [] as string[], index, lastDocs: [] as string[] };

  it('defaults to the open file', () => {
    expect(resolveDocs('Explique la phase claire', base)).toMatchObject({ paths: [base.current] });
  });

  it('finds a document named in the question', () => {
    expect(resolveDocs('Que demande le contrôle de photosynthèse ?', base).paths).toEqual(['Biologie/Exams/Contrôle photosynthèse.pdf']);
    expect(resolveDocs('Summarize the Cold War lecture', base).paths).toEqual(['History/Lectures/The Cold War - Lecture 4.pdf']);
  });

  it('asks when a name matches several files equally', () => {
    const r = resolveDocs("Aide-moi pour l'exercice du TD3", base);
    expect(r.paths).toEqual([]);
    expect(r.ambiguous?.sort()).toEqual(['Maths/TD/TD3 - Graphes/ex2.pdf', 'Physique/TD/TD3/ex2.pdf']);
  });

  it('settles it when the subject is named too', () => {
    expect(resolveDocs('Celui de Physique : que demande ex2 du TD3 ?', base).paths).toEqual(['Physique/TD/TD3/ex2.pdf']);
  });

  it('never picks a file from its subject name alone', () => {
    expect(resolveDocs('Explique la partie Physique', base).paths).toEqual([base.current]);
  });

  it('understands "the document I opened earlier"', () => {
    const r = resolveDocs("Et dans le document que j'ai ouvert tout à l'heure ?", { ...base, recent: [base.current, 'History/Lectures/The Cold War - Lecture 4.pdf'] });
    expect(r.paths).toEqual(['History/Lectures/The Cold War - Lecture 4.pdf']);
  });

  it('does not confuse "the previous definition" with a previous document', () => {
    expect(resolveDocs('Rappelle-moi la définition précédente', base).paths).toEqual([base.current]);
  });

  it('compares the open file with a named one', () => {
    expect(resolveDocs('Compare ce cours avec le contrôle de photosynthèse', base).paths).toEqual([base.current, 'Biologie/Exams/Contrôle photosynthèse.pdf']);
  });

  it('keeps the documents of the conversation for follow-ups', () => {
    const r = resolveDocs('Et la suivante ?', { ...base, current: undefined, lastDocs: ['History/Lectures/The Cold War - Lecture 4.pdf'] });
    expect(r.paths).toEqual(['History/Lectures/The Cold War - Lecture 4.pdf']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  classify,
  extName,
  isIgnored,
  joinPath,
  remapPath,
  searchKey,
  sidecarDir,
  sidecarPath,
  validateName,
  withSuffix,
} from './paths';

describe('path mirroring', () => {
  it('mirrors the relative path under .noteTOO', () => {
    expect(sidecarPath('Maths/TD/TD3/ex2.pdf')).toBe('.noteTOO/Maths/TD/TD3/ex2.pdf.annotations.json');
    expect(sidecarDir('Maths/TD')).toBe('.noteTOO/Maths/TD');
  });

  it('gives same-named files in different folders different sidecars', () => {
    expect(sidecarPath('Maths/TD/ex2.pdf')).not.toBe(sidecarPath('Physique/TD/ex2.pdf'));
  });

  it('keeps unicode and spaces untouched', () => {
    expect(sidecarPath('Économie & Société/Cours/Chapitre 1 - Intégrales.pdf')).toBe(
      '.noteTOO/Économie & Société/Cours/Chapitre 1 - Intégrales.pdf.annotations.json',
    );
  });
});

describe('path helpers', () => {
  it('joins and normalizes', () => {
    expect(joinPath('', 'a/', '/b', 'c.pdf')).toBe('a/b/c.pdf');
  });
  it('remaps descendants only', () => {
    expect(remapPath('Maths/TD/x.pdf', 'Maths/TD', 'Maths/TP')).toBe('Maths/TP/x.pdf');
    expect(remapPath('Maths/TDx/x.pdf', 'Maths/TD', 'Maths/TP')).toBe('Maths/TDx/x.pdf');
  });
  it('suffixes names before the extension', () => {
    expect(withSuffix('ex2.pdf', 1)).toBe('ex2 (1).pdf');
    expect(withSuffix('README', 2)).toBe('README (2)');
  });
  it('extracts extensions', () => {
    expect(extName('A.PDF')).toBe('pdf');
    expect(extName('.bashrc')).toBe('');
  });
  it('searches accent-insensitively', () => {
    expect(searchKey('Électricité')).toBe('electricite');
  });
});

describe('classification and ignore rules', () => {
  it('classifies files into sections, case-insensitively', () => {
    expect(classify('Maths/TD/TD3/ex2.pdf')).toEqual({ subject: 'Maths', section: 'TD' });
    expect(classify('Maths/cours/a.pdf')).toEqual({ subject: 'Maths', section: 'Cours' });
    expect(classify('Maths/Projet/a.pdf')).toEqual({ subject: 'Maths', section: 'Other' });
    expect(classify('Maths/loose.pdf')).toEqual({ subject: 'Maths', section: 'Other' });
    expect(classify('root.pdf')).toBeNull();
  });
  it('ignores app and system files', () => {
    for (const n of ['.noteTOO', '_notes.md', '_scratchpad.md', 'desktop.ini', '.DS_Store', 'Thumbs.db', 'x.pdf.crswap']) {
      expect(isIgnored(n)).toBe(true);
    }
    expect(isIgnored('notes.md')).toBe(false);
  });
  it('validates names', () => {
    expect(validateName('TD3 - Graphes')).toBeNull();
    expect(validateName('a/b')).not.toBeNull();
    expect(validateName('trailing.')).not.toBeNull();
    expect(validateName('CON')).not.toBeNull();
    expect(validateName('  ')).not.toBeNull();
  });
});

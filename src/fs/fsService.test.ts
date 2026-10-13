import { describe, expect, it } from 'vitest';
import { ConflictError, createFs } from './fsService';
import { createMemoryRoot, putFile } from './memoryFs';

async function setup() {
  const root = createMemoryRoot('School');
  const fs = createFs(root);
  await putFile(root, 'Maths/TD/TD3/ex2.pdf', 'PDF-A');
  await putFile(root, '.noteTOO/Maths/TD/TD3/ex2.pdf.annotations.json', '{"a":1}');
  await putFile(root, 'Physique/TD/ex2.pdf', 'PDF-B');
  await putFile(root, 'Maths/_notes.md', '# notes');
  await putFile(root, 'Maths/desktop.ini', 'x');
  return { root, fs };
}

describe('listing', () => {
  it('hides app and system files and reads metadata', async () => {
    const { fs } = await setup();
    expect((await fs.list('')).map((e) => e.name).sort()).toEqual(['Maths', 'Physique']);
    expect((await fs.list('Maths')).map((e) => e.name)).toEqual(['TD']);
    const [file] = await fs.walk('Maths');
    expect(file).toMatchObject({ path: 'Maths/TD/TD3/ex2.pdf', kind: 'file', size: 5 });
  });
});

describe('writeText', () => {
  it('detects external changes via lastModified', async () => {
    const { fs, root } = await setup();
    const first = await fs.writeText('Maths/_notes.md', 'v1', { expected: (await fs.stat('Maths/_notes.md'))!.lastModified });
    await putFile(root, 'Maths/_notes.md', 'changed by sync');
    await expect(fs.writeText('Maths/_notes.md', 'v2', { expected: first })).rejects.toBeInstanceOf(ConflictError);
    expect((await fs.readText('Maths/_notes.md'))?.text).toBe('changed by sync');
  });

  it('refuses to create over a file that appeared meanwhile', async () => {
    const { fs } = await setup();
    await expect(fs.writeText('Maths/_notes.md', 'x', { expected: null })).rejects.toBeInstanceOf(ConflictError);
    await fs.writeText('_scratchpad.md', 'new', { expected: null });
    expect((await fs.readText('_scratchpad.md'))?.text).toBe('new');
  });
});

describe('copyIn', () => {
  it('never overwrites on name collisions', async () => {
    const { fs } = await setup();
    const res = await fs.copyIn('Maths/TD/TD3', [new File(['new'], 'ex2.pdf'), new File(['new2'], 'ex2.pdf')]);
    expect(res.map((r) => r.saved)).toEqual(['ex2 (1).pdf', 'ex2 (2).pdf']);
    expect((await fs.readText('Maths/TD/TD3/ex2.pdf'))?.text).toBe('PDF-A');
  });
});

describe('rename / move / remove keep sidecars with their files', () => {
  it('renames a file and its sidecar', async () => {
    const { fs } = await setup();
    expect(await fs.rename('Maths/TD/TD3/ex2.pdf', 'Exercice 2 é.pdf')).toBe('Maths/TD/TD3/Exercice 2 é.pdf');
    expect(await fs.exists('Maths/TD/TD3/ex2.pdf')).toBe(false);
    expect((await fs.readText('Maths/TD/TD3/Exercice 2 é.pdf'))?.text).toBe('PDF-A');
    expect(await fs.exists('.noteTOO/Maths/TD/TD3/ex2.pdf.annotations.json')).toBe(false);
    expect((await fs.readText('.noteTOO/Maths/TD/TD3/Exercice 2 é.pdf.annotations.json'))?.text).toBe('{"a":1}');
  });

  it('refuses to rename over an existing file', async () => {
    const { fs, root } = await setup();
    await putFile(root, 'Maths/TD/TD3/other.pdf', 'x');
    await expect(fs.rename('Maths/TD/TD3/ex2.pdf', 'other.pdf')).rejects.toThrow(/already exists/);
  });

  it('moves a file between subjects with its sidecar, suffixing on collision', async () => {
    const { fs } = await setup();
    expect(await fs.move('Maths/TD/TD3/ex2.pdf', 'Physique/TD')).toBe('Physique/TD/ex2 (1).pdf');
    expect((await fs.readText('Physique/TD/ex2.pdf'))?.text).toBe('PDF-B');
    expect((await fs.readText('.noteTOO/Physique/TD/ex2 (1).pdf.annotations.json'))?.text).toBe('{"a":1}');
    expect(await fs.exists('.noteTOO/Maths/TD/TD3/ex2.pdf.annotations.json')).toBe(false);
  });

  it('renames a folder together with its sidecar folder', async () => {
    const { fs } = await setup();
    await fs.rename('Maths/TD/TD3', 'TD3 - Graphes');
    expect(await fs.exists('Maths/TD/TD3 - Graphes/ex2.pdf')).toBe(true);
    expect(await fs.exists('.noteTOO/Maths/TD/TD3 - Graphes/ex2.pdf.annotations.json')).toBe(true);
    expect(await fs.exists('.noteTOO/Maths/TD/TD3')).toBe(false);
  });

  it('cannot move a folder into itself', async () => {
    const { fs } = await setup();
    await expect(fs.move('Maths/TD', 'Maths/TD/TD3')).rejects.toThrow(/itself/);
  });

  it('removes a file and its sidecar only', async () => {
    const { fs } = await setup();
    await fs.remove('Maths/TD/TD3/ex2.pdf');
    expect(await fs.exists('Maths/TD/TD3/ex2.pdf')).toBe(false);
    expect(await fs.exists('.noteTOO/Maths/TD/TD3/ex2.pdf.annotations.json')).toBe(false);
    expect(await fs.exists('Physique/TD/ex2.pdf')).toBe(true);
  });
});

describe('subjects', () => {
  it('creates the five sections', async () => {
    const { fs } = await setup();
    await fs.createSubject('Économie');
    expect((await fs.list('Économie')).map((e) => e.name).sort()).toEqual(['Cours', 'Exams', 'Other', 'TD', 'TP']);
  });

  it('finds section folders case-insensitively without creating', async () => {
    const { fs, root } = await setup();
    await putFile(root, 'Chimie/cours/a.pdf', 'x');
    expect(await fs.sectionDir('Chimie', 'Cours', false)).toBe('Chimie/cours');
    expect(await fs.sectionDir('Chimie', 'TD', false)).toBe('Chimie/TD');
    expect(await fs.exists('Chimie/TD')).toBe(false);
  });
});

describe('permission errors', () => {
  it('reports access loss through the callback', async () => {
    const root = createMemoryRoot();
    let lost = 0;
    const fs = createFs(root, () => lost++);
    (root as unknown as { getDirectoryHandle: () => never }).getDirectoryHandle = () => {
      throw new DOMException('denied', 'NotAllowedError');
    };
    await expect(fs.list('Maths')).rejects.toThrow();
    expect(lost).toBe(1);
  });
});

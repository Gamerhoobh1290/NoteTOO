import { describe, expect, it, vi } from 'vitest';
import { createFs } from './fsService';
import { createMemoryRoot, putFile } from './memoryFs';
import { emptySidecar, loadSidecar, newId, parseSidecar, serializeSidecar, SidecarError, type Sidecar } from './sidecar';

const sample: Sidecar = {
  version: 1,
  file: 'Maths/TD/TD3/ex2.pdf',
  fileComments: [{ id: 'c1', text: 'Revoir', createdAt: '2026-01-01T00:00:00.000Z' }],
  annotations: [
    {
      id: 'a1',
      type: 'area',
      page: 2,
      rect: { x: 0.12, y: 0.3, w: 0.4, h: 0.08 },
      color: 'yellow',
      comment: 'Check this formula',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'p1',
      type: 'pin',
      page: 1,
      point: { x: 0.5, y: 0.5 },
      color: 'blue',
      comment: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

describe('parseSidecar / serializeSidecar', () => {
  it('round-trips', () => {
    expect(parseSidecar(serializeSidecar(sample), sample.file)).toEqual(sample);
  });

  it('uses the current file path, not the stored one', () => {
    expect(parseSidecar(serializeSidecar(sample), 'Maths/TP/ex2.pdf').file).toBe('Maths/TP/ex2.pdf');
  });

  it('clamps coordinates into the page', () => {
    const s = structuredClone(sample);
    const a = s.annotations[0] as { rect: { x: number; y: number; w: number; h: number } };
    a.rect = { x: -0.2, y: 0.9, w: 2, h: 0.5 };
    const r = (parseSidecar(JSON.stringify(s), s.file).annotations[0] as typeof a).rect;
    expect(r.x).toBe(0);
    expect(r.y).toBe(0.9);
    expect(r.w).toBe(1);
    expect(r.h).toBeCloseTo(0.1);
  });

  it('rejects malformed content', () => {
    expect(() => parseSidecar('{oops', 'f')).toThrow(SidecarError);
    expect(() => parseSidecar('[]', 'f')).toThrow(SidecarError);
    expect(() => parseSidecar('{"annotations":[{"id":"x","type":"area"}]}', 'f')).toThrow(SidecarError);
    expect(() => parseSidecar('{"version":2}', 'f')).toThrow(SidecarError);
  });

  it('accepts a minimal file', () => {
    expect(parseSidecar('{}', 'f')).toEqual(emptySidecar('f'));
  });

  it('keeps per-line rectangles of text highlights, next to the bounding box older versions read', () => {
    const s = structuredClone(sample);
    const rects = [
      { x: 0.1, y: 0.3, w: 0.7, h: 0.02 },
      { x: 0.1, y: 0.33, w: 0.3, h: 0.02 },
    ];
    s.annotations[0] = { ...s.annotations[0], type: 'area', rect: { x: 0.1, y: 0.3, w: 0.7, h: 0.05 }, rects } as Sidecar['annotations'][0];
    const back = parseSidecar(serializeSidecar(s), s.file);
    expect(back).toEqual(s);
    // a file written by 1.0 (no rects) still reads the same
    expect(parseSidecar(serializeSidecar(sample), sample.file).annotations[0]).not.toHaveProperty('rects');
  });
});

describe('loadSidecar', () => {
  it('returns an empty sidecar when none exists, without writing', async () => {
    const root = createMemoryRoot();
    const fs = createFs(root);
    const r = await loadSidecar(fs, 'Maths/TD/ex.pdf');
    expect(r).toEqual({ sidecar: emptySidecar('Maths/TD/ex.pdf'), lastModified: null });
    expect(await fs.exists('.noteTOO')).toBe(false);
  });

  it('loads a valid sidecar from its mirrored path', async () => {
    const root = createMemoryRoot();
    const fs = createFs(root);
    await putFile(root, '.noteTOO/Maths/TD/TD3/ex2.pdf.annotations.json', serializeSidecar(sample));
    const r = await loadSidecar(fs, 'Maths/TD/TD3/ex2.pdf');
    expect(r.sidecar).toEqual(sample);
    expect(r.lastModified).toBeGreaterThan(0);
  });

  it('backs up a broken sidecar and starts fresh', async () => {
    const root = createMemoryRoot();
    const fs = createFs(root);
    await putFile(root, '.noteTOO/Maths/a.pdf.annotations.json', '{broken');
    const r = await loadSidecar(fs, 'Maths/a.pdf');
    expect(r.sidecar).toEqual(emptySidecar('Maths/a.pdf'));
    expect(r.backup).toBe('.noteTOO/Maths/a.pdf.annotations.broken.json');
    expect((await fs.readText(r.backup!))?.text).toBe('{broken');
    expect(await fs.exists('.noteTOO/Maths/a.pdf.annotations.json')).toBe(false);

    // Concurrent loads (e.g. a view mounted twice) back up only once.
    await putFile(root, '.noteTOO/Maths/b.pdf.annotations.json', '{also broken');
    const [x, y] = await Promise.all([loadSidecar(fs, 'Maths/b.pdf'), loadSidecar(fs, 'Maths/b.pdf')]);
    expect(x.backup).toBe('.noteTOO/Maths/b.pdf.annotations.broken.json');
    expect(y).toBe(x);
    expect(await fs.exists('.noteTOO/Maths/b.pdf.annotations.broken (1).json')).toBe(false);

    // A second breakage does not overwrite the first backup.
    await putFile(root, '.noteTOO/Maths/a.pdf.annotations.json', 'nope');
    expect((await loadSidecar(fs, 'Maths/a.pdf')).backup).toBe('.noteTOO/Maths/a.pdf.annotations.broken (1).json');
  });
});

describe('newId', () => {
  it('works without crypto.randomUUID (a page from the NoteTOO server over plain http on the network)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a) });
    try {
      const ids = new Set(Array.from({ length: 50 }, newId));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

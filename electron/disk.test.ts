// The desktop backend end to end on a real temporary folder: fsService -> nativeFs handles ->
// (a bridge calling disk.cts directly, as the preload + IPC would) -> node:fs.
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../src/desktop/bridge';

const trashed: string[] = [];
vi.mock('electron', () => ({
  shell: {
    trashItem: async (p: string) => {
      trashed.push(p);
      rmSync(p, { recursive: true });
    },
  },
}));

const disk = await import('./disk.mts');
const { ConflictError, createFs } = await import('../src/fs/fsService');
const { createNativeRoot } = await import('../src/fs/nativeFs');

const bridge = {
  rootExists: async (id: string) => disk.rootExists(id),
  stat: async (id: string, p: string) => disk.stat(id, p),
  list: async (id: string, p: string) => disk.list(id, p),
  mkdir: async (id: string, p: string) => disk.mkdir(id, p),
  createFile: async (id: string, p: string) => disk.createFile(id, p),
  beginWrite: async (id: string, p: string) => disk.beginWrite(id, p),
  writeChunk: async (w: string, d: Uint8Array) => disk.writeChunk(w, d),
  commitWrite: async (w: string) => disk.commitWrite(w),
  abortWrite: async (w: string) => disk.abortWrite(w),
  trash: async (id: string, p: string) => disk.trash(id, p),
  move: async (id: string, a: string, b: string) => disk.move(id, a, b),
  sameEntry: async (id: string, a: string, b: string) => disk.sameEntry(id, a, b),
  fileUrl: (id: string, p: string) => disk.fileUrl(id, p),
} as unknown as DesktopBridge;

// getFile() streams through the notetoo-file:// protocol; route fetch straight to its handler.
vi.stubGlobal('fetch', (url: string, init?: RequestInit) => disk.serveFile(new Request(url, init)));

let dir: string;
const put = (rel: string, content: string) => {
  const full = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};
const read = (rel: string) => readFileSync(path.join(dir, ...rel.split('/')), 'utf8');

function open() {
  const info = disk.openRoot(dir);
  return { info, fs: createFs(createNativeRoot(bridge, info)) };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'notetoo-'));
  trashed.length = 0;
  put('Maths/TD/TD3/ex2.pdf', 'PDF-A');
  put('.noteTOO/Maths/TD/TD3/ex2.pdf.annotations.json', '{"a":1}');
  put('Physique/Cours/Électricité é.docx', 'DOCX');
  put('Maths/_notes.md', '# notes');
  put('Maths/desktop.ini', 'x');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('desktop backend', () => {
  it('lists folders with sizes and dates in one call per folder, hiding app/system files', async () => {
    const { fs } = open();
    expect((await fs.list('')).map((e) => e.name).sort()).toEqual(['Maths', 'Physique']);
    expect((await fs.list('Maths')).map((e) => e.name)).toEqual(['TD']);
    const files = await fs.walk('');
    expect(files.map((f) => f.path).sort()).toEqual(['Maths/TD/TD3/ex2.pdf', 'Physique/Cours/Électricité é.docx']);
    expect(files.find((f) => f.name === 'ex2.pdf')).toMatchObject({ size: 5, kind: 'file' });
    expect(files[0].lastModified).toBeGreaterThan(0);
  });

  it('reads contents and dates through the file protocol', async () => {
    const { fs } = open();
    const f = await fs.readFile('Physique/Cours/Électricité é.docx');
    expect(await f.text()).toBe('DOCX');
    expect(f.name).toBe('Électricité é.docx');
    expect(f.lastModified).toBe((await fs.stat('Physique/Cours/Électricité é.docx'))!.lastModified);
  });

  it('writes atomically, leaves no temp file, and detects changes made outside the app', async () => {
    const { fs } = open();
    const lm = await fs.writeText('Maths/_notes.md', 'v1', { expected: (await fs.stat('Maths/_notes.md'))!.lastModified });
    expect(read('Maths/_notes.md')).toBe('v1');
    expect(readdirSync(path.join(dir, 'Maths')).some((n) => n.endsWith('.crswap'))).toBe(false);
    // "OneDrive" changes the file
    put('Maths/_notes.md', 'changed by sync');
    utimesSync(path.join(dir, 'Maths/_notes.md'), new Date(), new Date(Date.now() + 5000));
    await expect(fs.writeText('Maths/_notes.md', 'v2', { expected: lm })).rejects.toBeInstanceOf(ConflictError);
    expect(read('Maths/_notes.md')).toBe('changed by sync');
    // creating requires that the file does not exist
    await fs.writeText('_scratchpad.md', 'new', { expected: null });
    expect(read('_scratchpad.md')).toBe('new');
  });

  it('exclusive commit never replaces an existing file', async () => {
    const { info } = open();
    const w = await disk.beginWrite(info.id, 'Maths/_notes.md');
    if (!w.ok) throw new Error(w.message);
    await disk.writeChunk(w.value, new TextEncoder().encode('x'));
    expect(await disk.commitWrite(w.value, { exclusive: true })).toMatchObject({ ok: false, name: 'InvalidModificationError' });
    expect(read('Maths/_notes.md')).toBe('# notes');
    expect(readdirSync(path.join(dir, 'Maths')).some((n) => n.endsWith('.crswap'))).toBe(false);

    const n = await disk.beginWrite(info.id, 'Maths/new.jpg');
    if (!n.ok) throw new Error(n.message);
    await disk.writeChunk(n.value, new TextEncoder().encode('JPG'));
    expect(await disk.commitWrite(n.value, { exclusive: true })).toMatchObject({ ok: true });
    expect(read('Maths/new.jpg')).toBe('JPG');
    expect(readdirSync(path.join(dir, 'Maths')).some((n) => n.endsWith('.crswap'))).toBe(false);
  });

  it('copies files in without overwriting, in chunks', async () => {
    const { fs } = open();
    const big = new Uint8Array(9 * 1024 * 1024).fill(7); // > one 8 MB chunk
    const res = await fs.copyIn('Maths/TD', [new File(['A'], 'ex2.pdf'), new File([big], 'video.mp4')]);
    expect(res).toEqual([
      { original: 'ex2.pdf', saved: 'ex2.pdf' },
      { original: 'video.mp4', saved: 'video.mp4' },
    ]);
    const again = await fs.copyIn('Maths/TD', [new File(['B'], 'ex2.pdf')]);
    expect(again[0].saved).toBe('ex2 (1).pdf');
    expect(read('Maths/TD/ex2.pdf')).toBe('A');
    expect((await fs.stat('Maths/TD/video.mp4'))!.size).toBe(big.length);
  });

  it('moves and renames files together with their annotations', async () => {
    const { fs } = open();
    const to = await fs.move('Maths/TD/TD3/ex2.pdf', 'Physique/TD');
    expect(to).toBe('Physique/TD/ex2.pdf');
    expect(read('Physique/TD/ex2.pdf')).toBe('PDF-A');
    expect(read('.noteTOO/Physique/TD/ex2.pdf.annotations.json')).toBe('{"a":1}');
    expect(existsSync(path.join(dir, 'Maths/TD/TD3/ex2.pdf'))).toBe(false);

    // case-only rename on Windows' case-insensitive file system
    const renamed = await fs.rename('Physique/TD/ex2.pdf', 'EX2.pdf');
    expect(renamed).toBe('Physique/TD/EX2.pdf');
    expect(readdirSync(path.join(dir, 'Physique/TD'))).toEqual(['EX2.pdf']);
    expect(read('.noteTOO/Physique/TD/EX2.pdf.annotations.json')).toBe('{"a":1}');

    // renaming onto another existing file is refused
    put('Physique/TD/other.pdf', 'O');
    await expect(fs.rename('Physique/TD/EX2.pdf', 'other.pdf')).rejects.toThrow(/already exists/);
    expect(read('Physique/TD/other.pdf')).toBe('O');
  });

  it('moves folders (with the sidecar folder) and refuses moving a folder into itself', async () => {
    const { fs } = open();
    await fs.move('Maths/TD/TD3', 'Maths/Cours');
    expect(read('Maths/Cours/TD3/ex2.pdf')).toBe('PDF-A');
    expect(read('.noteTOO/Maths/Cours/TD3/ex2.pdf.annotations.json')).toBe('{"a":1}');
    await expect(fs.move('Maths', 'Maths/Cours')).rejects.toThrow(/into itself/);
  });

  it('deletes to the Recycle Bin, with the sidecar', async () => {
    const { fs } = open();
    await fs.remove('Maths/TD/TD3/ex2.pdf');
    expect(trashed.map((p) => path.relative(dir, p).split(path.sep).join('/'))).toEqual([
      'Maths/TD/TD3/ex2.pdf',
      '.noteTOO/Maths/TD/TD3/ex2.pdf.annotations.json',
    ]);
  });

  it('creates subjects and reports missing files as NotFound', async () => {
    const { fs } = open();
    await fs.createSubject('Chimie');
    expect((await fs.list('Chimie')).map((e) => e.name).sort()).toEqual(['Cours', 'Exams', 'Other', 'TD', 'TP']);
    await expect(fs.readFile('Nope/x.pdf')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await fs.readText('Nope/x.md')).toBeNull();
  });

  it('reports the whole folder disappearing as lost access', async () => {
    const lost = vi.fn();
    const info = disk.openRoot(dir);
    const fs = createFs(createNativeRoot(bridge, info), lost);
    expect(await fs.hasPermission()).toBe(true);
    rmSync(dir, { recursive: true });
    expect(await fs.hasPermission()).toBe(false);
    await expect(fs.list('Maths')).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(lost).toHaveBeenCalled();
  });
});

describe('trust boundary', () => {
  it('refuses paths that leave the opened folder', () => {
    const { info } = open();
    for (const bad of ['../x', 'Maths/../../x', 'C:/Windows', 'a\\..\\..\\b', 'x:stream']) {
      expect(() => disk.resolveIn(info.id, bad), bad).toThrow();
    }
    expect(() => disk.resolveIn('unknown-id', 'Maths')).toThrow();
    expect(disk.resolveIn(info.id, 'Maths/TD')).toBe(path.join(dir, 'Maths', 'TD'));
  });

  it('serves byte ranges for media seeking, and never serves outside the folder', async () => {
    const { info } = open();
    const url = disk.fileUrl(info.id, 'Maths/TD/TD3/ex2.pdf');
    const r = await disk.serveFile(new Request(url, { headers: { range: 'bytes=1-3' } }));
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 1-3/5');
    expect(await r.text()).toBe('DF-');
    const tail = await disk.serveFile(new Request(url, { headers: { range: 'bytes=-2' } }));
    expect(await tail.text()).toBe('-A');
    expect((await disk.serveFile(new Request(`notetoo-file://${info.id}/..%2F..%2Fsecret`))).status).toBe(400);
    expect((await disk.serveFile(new Request(`notetoo-file://${info.id}/Maths`))).status).toBe(404);
  });
});

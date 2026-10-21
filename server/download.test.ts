// Downloads from the NoteTOO server over real HTTP: a copy of a file, folders and selections as a
// zip, and what is refused. The originals must stay on the PC untouched.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { createNoteTooServer } = await import('./app.mts');
const { ConfigStore } = await import('./config.mts');
const disk = await import('../electron/disk.mts');
const { attachment } = await import('./download.mts');

let tmp: string;
let school: string;
let base: string;
let cookie = '';
let server: http.Server;
let app: ReturnType<typeof createNoteTooServer>;
let rootId: string;

const put = (rel: string, data: string | Buffer, root = school) => {
  const full = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, data);
};

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'notetoo-dl-'));
  school = path.join(tmp, 'School');
  put('Maths/Cours/Chapitre 1 - Intégrales.pdf', Buffer.alloc(5000, 7));
  put('Maths/TD/ex1.txt', 'exercice 1');
  put('Maths/TD/Vide/.keep-hidden', 'x');
  put('Maths/_notes.md', '# notes');
  put('Maths/desktop.ini', 'junk');
  put('.noteTOO/Maths/TD/ex1.txt.annotations.json', '{}');
  put('Physique/TP/mesures.csv', '1;2');
  put('secret.txt', 'secret', tmp);
  put('dist/index.html', '<!doctype html><html><head></head><body></body></html>', tmp);
  const store = new ConfigStore(path.join(tmp, 'data'));
  store.update((c) => void (c.folders = [school]));
  app = createNoteTooServer({ store, distDir: path.join(tmp, 'dist'), trash: async (p) => rmSync(p, { recursive: true }) });
  server = http.createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: store.get().key }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  rootId = disk.openRoot(school).id;
});

afterEach(async () => {
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

const req = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers: { cookie, origin: base, ...(init.headers as Record<string, string>) } });
const fileUrl = (rel: string) => `/api/file/${rootId}/${rel.split('/').map(encodeURIComponent).join('/')}`;
const prepare = (paths: string[], name?: string) =>
  req('/api/zip/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: rootId, paths, name }) });

async function zipOf(paths: string[]) {
  const res = await prepare(paths);
  const j = (await res.json()) as { id: string; name: string; files: number; bytes: number; error?: string };
  expect(res.status, j.error).toBe(200);
  const dl = await req(`/api/zip/${j.id}`);
  expect(dl.status).toBe(200);
  expect(dl.headers.get('content-type')).toBe('application/zip');
  return { info: j, disposition: dl.headers.get('content-disposition'), zip: await JSZip.loadAsync(Buffer.from(await dl.arrayBuffer())) };
}

describe('downloads', () => {
  it('a file is sent as a download with its name, and stays on the PC', async () => {
    const res = await req(fileUrl('Maths/Cours/Chapitre 1 - Intégrales.pdf') + '?download=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(attachment('Chapitre 1 - Intégrales.pdf'));
    expect(res.headers.get('content-disposition')).toMatch(/filename\*=UTF-8''Chapitre%201%20-%20Int%C3%A9grales\.pdf/);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.alloc(5000, 7))).toBe(true);
    expect(readFileSync(path.join(school, 'Maths/Cours/Chapitre 1 - Intégrales.pdf')).length).toBe(5000);
    // without ?download it is still a preview (no attachment header)
    expect((await req(fileUrl('Maths/TD/ex1.txt'))).headers.get('content-disposition')).toBeNull();
  });

  it('a folder downloads as a zip of its files (notes included, NoteTOO internals and hidden files left out)', async () => {
    const { info, disposition, zip } = await zipOf(['Maths']);
    expect(info).toMatchObject({ name: 'Maths.zip', files: 3, bytes: 5000 + 10 + 7 });
    expect(disposition).toBe(attachment('Maths.zip'));
    expect(Object.keys(zip.files).sort()).toEqual(['Maths/', 'Maths/Cours/', 'Maths/Cours/Chapitre 1 - Intégrales.pdf', 'Maths/TD/', 'Maths/TD/Vide/', 'Maths/TD/ex1.txt', 'Maths/_notes.md']);
    expect(await zip.file('Maths/TD/ex1.txt')!.async('string')).toBe('exercice 1');
    expect((await zip.file('Maths/Cours/Chapitre 1 - Intégrales.pdf')!.async('nodebuffer')).equals(Buffer.alloc(5000, 7))).toBe(true);
    // the originals are untouched
    expect(readFileSync(path.join(school, 'Maths/TD/ex1.txt'), 'utf8')).toBe('exercice 1');
  });

  it('selected files from several folders download as one zip, relative to their common folder', async () => {
    const { info, zip } = await zipOf(['Maths/TD/ex1.txt', 'Physique/TP/mesures.csv']);
    expect(info.name).toBe('School - 2 items.zip');
    const filesOnly = (z: JSZip) => Object.keys(z.files).filter((n) => !n.endsWith('/')).sort();
    expect(filesOnly(zip)).toEqual(['Maths/TD/ex1.txt', 'Physique/TP/mesures.csv']);
    const same = await zipOf(['Maths/TD/ex1.txt', 'Maths/Cours/Chapitre 1 - Intégrales.pdf']);
    expect(filesOnly(same.zip)).toEqual(['Cours/Chapitre 1 - Intégrales.pdf', 'TD/ex1.txt']);
  });

  it('refuses what is not in the shared folder, NoteTOO internals, the whole folder and missing files', async () => {
    for (const [paths, err] of [
      [['../secret.txt'], /Invalid path/],
      [['.noteTOO/Maths'], /internal to NoteTOO/],
      [[''], /whole shared folder/],
      [['Maths/nope.pdf'], /no longer exists/],
      [[], /Nothing to download/],
    ] as [string[], RegExp][]) {
      const res = await prepare(paths);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(err);
    }
    const other = disk.openRoot(tmp).id;
    const res = await req('/api/zip/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: other, paths: ['secret.txt'] }) });
    expect(res.status).toBe(403);
  });

  it('a prepared zip can be downloaded once, only when signed in', async () => {
    const { id } = (await (await prepare(['Physique'])).json()) as { id: string };
    expect((await fetch(`${base}/api/zip/${id}`)).status).toBe(401);
    expect((await req(`/api/zip/${id}`)).status).toBe(200);
    expect((await req(`/api/zip/${id}`)).status).toBe(404);
    expect((await fetch(base + fileUrl('Maths/TD/ex1.txt') + '?download=1')).status).toBe(401);
  });

  it('builds a safe attachment header for any name', () => {
    expect(attachment('a "b".txt')).toBe(`attachment; filename="a _b_.txt"; filename*=UTF-8''a%20%22b%22.txt`);
    expect(attachment('été (1).pdf')).toBe(`attachment; filename="ete (1).pdf"; filename*=UTF-8''%C3%A9t%C3%A9%20%281%29.pdf`);
  });
});

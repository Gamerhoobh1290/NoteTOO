// Main-process disk access for the folders the user opened. This is the trust boundary: the page
// only names (folder id, relative path) pairs, and every path is resolved here and refused when it
// would leave that folder. Errors are returned as DOMException names that fsService understands.

import { createReadStream, existsSync, promises as fsp, statSync, type Stats } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { shell } from 'electron';
import type { DiskEntry, DiskErrorName, DiskMeta, DiskResult, RootInfo } from '../src/desktop/bridge.js';

class DiskError extends Error {
  constructor(
    readonly errName: DiskErrorName,
    message: string,
  ) {
    super(message);
  }
}

/** Folders opened in this session, by id. Kept for the whole session so late saves still land. */
const roots = new Map<string, string>();

export function openRoot(dir: string): RootInfo {
  const full = path.resolve(dir);
  let id = [...roots].find(([, p]) => p.toLowerCase() === full.toLowerCase())?.[0];
  if (!id) roots.set((id = randomUUID()), full);
  return { id, path: full, name: path.basename(full) || full };
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function rootExists(id: string): boolean {
  const r = roots.get(id);
  return !!r && isDirectory(r);
}

/** Absolute path of `rel` inside folder `id`; throws when it is not strictly inside it. */
export function resolveIn(id: string, rel: string, allowRoot = true): string {
  const root = roots.get(id);
  if (!root) throw new DiskError('NotAllowedError', 'This folder is not open.');
  if (typeof rel !== 'string') throw new DiskError('Error', 'Invalid path.');
  const segs = rel.split('/').filter(Boolean);
  // No "..", no drive letters or alternate data streams, no backslash tricks.
  if (segs.some((s) => s === '.' || s === '..' || /[\\:\0]/.test(s))) throw new DiskError('Error', `Invalid path "${rel}".`);
  if (!segs.length && !allowRoot) throw new DiskError('Error', 'The opened folder itself cannot be changed.');
  const full = path.resolve(root, ...segs);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) throw new DiskError('Error', `Invalid path "${rel}".`);
  return full;
}

function toMeta(st: Stats): DiskMeta {
  return st.isDirectory()
    ? { kind: 'dir', size: 0, lastModified: 0 }
    : { kind: 'file', size: st.size, lastModified: Math.floor(st.mtimeMs) };
}

const label = (p: string) => `"${path.basename(p)}"`;

function mapError(e: unknown, id: string, target: string): { name: DiskErrorName; message: string } {
  if (e instanceof DiskError) return { name: e.errName, message: e.message };
  const err = e as NodeJS.ErrnoException;
  switch (err?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      // The whole folder disappearing (renamed, drive removed) is reported as lost access.
      if (!rootExists(id)) return { name: 'NotAllowedError', message: 'The folder is no longer available.' };
      return { name: 'NotFoundError', message: `${label(target)} was not found.` };
    case 'EEXIST':
    case 'ENOTEMPTY':
      return { name: 'InvalidModificationError', message: `${label(target)} already exists.` };
    case 'EPERM':
    case 'EACCES':
    case 'EBUSY':
      return { name: 'NoModificationAllowedError', message: `${label(target)} is in use by another program or read-only.` };
    case 'ENOSPC':
      return { name: 'Error', message: 'The disk is full.' };
    case 'ENAMETOOLONG':
      return { name: 'Error', message: `The path of ${label(target)} is too long for Windows.` };
    default:
      return { name: 'Error', message: err?.message ?? String(e) };
  }
}

async function run<T>(id: string, target: string, fn: () => Promise<T>): Promise<DiskResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, ...mapError(e, id, target) };
  }
}

/** Windows briefly locks files that antivirus, the indexer or OneDrive are looking at. */
async function retryLocked<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
}

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');

export function stat(id: string, rel: string) {
  return run(id, rel, async () => {
    const full = resolveIn(id, rel);
    try {
      return toMeta(await fsp.stat(full));
    } catch (e) {
      if (isMissing(e) && rootExists(id)) return null;
      throw e;
    }
  });
}

export function list(id: string, rel: string) {
  return run(id, rel, async () => {
    const dir = resolveIn(id, rel);
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    return Promise.all(
      dirents.map(async (d): Promise<DiskEntry> => {
        try {
          return { name: d.name, ...toMeta(await fsp.stat(path.join(dir, d.name))) };
        } catch {
          // A locked or broken entry should still be listed.
          return { name: d.name, kind: d.isDirectory() ? 'dir' : 'file', size: 0, lastModified: 0 };
        }
      }),
    );
  });
}

export function mkdir(id: string, rel: string) {
  return run(id, rel, async () => {
    const full = resolveIn(id, rel);
    await fsp.mkdir(full).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    });
    return toMeta(await fsp.stat(full));
  });
}

export function createFile(id: string, rel: string) {
  return run(id, rel, async () => {
    const full = resolveIn(id, rel, false);
    await fsp.writeFile(full, '', { flag: 'wx' }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    });
    return toMeta(await fsp.stat(full));
  });
}

// ----- atomic writes: temp file next to the target, flushed, then renamed over it -----

interface WriteSession {
  root: string;
  target: string;
  temp: string;
  handle: fsp.FileHandle;
}
const writes = new Map<string, WriteSession>();

export function beginWrite(id: string, rel: string) {
  return run(id, rel, async () => {
    const target = resolveIn(id, rel, false);
    // ".crswap" is the browser's own temp suffix: NoteTOO already hides such leftovers everywhere.
    const temp = path.join(path.dirname(target), `${path.basename(target)}.${randomUUID().slice(0, 8)}.crswap`);
    const handle = await fsp.open(temp, 'wx');
    const writeId = randomUUID();
    writes.set(writeId, { root: id, target, temp, handle });
    return writeId;
  });
}

function session(writeId: string): WriteSession {
  const s = writes.get(writeId);
  if (!s) throw new DiskError('Error', 'This write was already finished.');
  return s;
}

export function writeChunk(writeId: string, data: Uint8Array) {
  const s = writes.get(writeId);
  return run(s?.root ?? '', s?.target ?? '', async () => {
    const { handle } = session(writeId);
    if (!(data instanceof Uint8Array)) throw new DiskError('Error', 'Invalid data.');
    for (let at = 0; at < data.byteLength; ) at += (await handle.write(data, at, data.byteLength - at)).bytesWritten;
  });
}

/** Puts the finished temp file in place without ever replacing an existing target. */
async function placeExclusive(temp: string, target: string) {
  try {
    // A hard link fails with EEXIST when the target exists, so there is no check-then-write race.
    await fsp.link(temp, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw e;
    // File systems without hard links (FAT/exFAT drives): check, then rename.
    if (existsSync(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    await retryLocked(() => fsp.rename(temp, target));
    return;
  }
  // The file is in place: a temp that stays locked is only a hidden leftover, not a failed write.
  await retryLocked(() => fsp.rm(temp, { force: true })).catch(() => {});
}

/** `exclusive`: fail with InvalidModificationError instead of replacing an existing file. */
export function commitWrite(writeId: string, opts?: { exclusive?: boolean } | null) {
  const s = writes.get(writeId);
  return run(s?.root ?? '', s?.target ?? '', async () => {
    const { handle, temp, target } = session(writeId);
    writes.delete(writeId);
    try {
      await handle.sync();
      await handle.close();
      if (opts?.exclusive === true) await placeExclusive(temp, target);
      else await retryLocked(() => fsp.rename(temp, target));
    } catch (e) {
      await handle.close().catch(() => {});
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw e;
    }
    return Math.floor((await fsp.stat(target)).mtimeMs);
  });
}

export async function abortWrite(writeId: string) {
  const s = writes.get(writeId);
  if (!s) return;
  writes.delete(writeId);
  await s.handle.close().catch(() => {});
  await fsp.rm(s.temp, { force: true }).catch(() => {});
}

// ----- delete, move -----

export function trash(id: string, rel: string) {
  return run(id, rel, async () => {
    const full = resolveIn(id, rel, false);
    await fsp.stat(full); // reports a missing entry as NotFound
    try {
      await shell.trashItem(full);
    } catch (e) {
      throw new DiskError('Error', `Could not move ${label(full)} to the Recycle Bin: ${(e as Error).message}`);
    }
  });
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fsp.stat(a, { bigint: true }), fsp.stat(b, { bigint: true })]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

export function sameEntry(id: string, a: string, b: string) {
  return run(id, a, async () => sameFile(resolveIn(id, a), resolveIn(id, b)));
}

export function move(id: string, from: string, to: string) {
  return run(id, from, async () => {
    const src = resolveIn(id, from, false);
    const dest = resolveIn(id, to, false);
    // Never replace anything (a case-only rename on Windows finds the same entry, which is fine).
    if (existsSync(dest) && !(await sameFile(src, dest))) throw new DiskError('InvalidModificationError', `${label(dest)} already exists.`);
    try {
      await retryLocked(() => fsp.rename(src, dest));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      // A junction to another drive inside the folder: copy, then remove the original.
      await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      await fsp.rm(src, { recursive: true });
    }
  });
}

// ----- streaming reads: notetoo-file://<folder id>/<path> -----

const TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  mov: 'video/quicktime', ogv: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json', html: 'text/plain', htm: 'text/plain',
};

export const FILE_SCHEME = 'notetoo-file';

export async function serveFile(req: Request): Promise<Response> {
  let full: string;
  try {
    const url = new URL(req.url);
    full = resolveIn(url.hostname, url.pathname.split('/').map(decodeURIComponent).join('/'), false);
  } catch {
    return new Response('Bad path', { status: 400 });
  }
  let st: Stats;
  try {
    st = await fsp.stat(full);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!st.isFile()) return new Response('Not found', { status: 404 });

  const size = st.size;
  const headers: Record<string, string> = {
    // HTML is served as plain text: a file from the folder must never run as a page.
    'content-type': TYPES[path.extname(full).slice(1).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-last-modified': String(Math.floor(st.mtimeMs)),
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'x-last-modified, content-range',
    'x-content-type-options': 'nosniff',
  };
  const body = (start: number, end: number) =>
    Readable.toWeb(createReadStream(full, { start, end })) as unknown as ReadableStream<Uint8Array>;

  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!m[1]) end = size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    }
    start = Math.max(0, start);
    return new Response(body(start, end), {
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
    });
  }
  return new Response(size ? body(0, size - 1) : null, { status: 200, headers: { ...headers, 'content-length': String(size) } });
}

export function fileUrl(id: string, rel: string): string {
  return `${FILE_SCHEME}://${id}/${rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
}

// ----- Windows integration -----

export async function openPath(id: string, rel: string): Promise<string | null> {
  try {
    return (await shell.openPath(resolveIn(id, rel))) || null;
  } catch (e) {
    return mapError(e, id, rel).message;
  }
}

export function showInFolder(id: string, rel: string): void {
  shell.showItemInFolder(resolveIn(id, rel));
}

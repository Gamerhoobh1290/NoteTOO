// The ONLY module that talks to the File System Access API.
// Everything else works with '/'-separated paths relative to the chosen root folder.

import {
  SECTIONS,
  type Section,
  baseName,
  isIgnored,
  isInside,
  joinPath,
  matchSection,
  parentPath,
  sidecarDir,
  sidecarPath,
  splitPath,
  validateName,
  withSuffix,
} from './paths';
import { desktop } from '../desktop/bridge';
import { createNativeRoot, nativeRootId, type MetadataHandle } from './nativeFs';

export interface Entry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number;
  /** ms since epoch; 0 for folders */
  lastModified: number;
}

export class ConflictError extends Error {
  constructor(public path: string) {
    super(`"${baseName(path)}" was changed on disk since it was opened.`);
    this.name = 'ConflictError';
  }
}

export function isFsSupported(): boolean {
  return !!desktop || (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function');
}

/** Shows the OS folder picker. Rejects with AbortError when the user cancels. */
export async function pickRootDirectory(): Promise<FileSystemDirectoryHandle> {
  if (desktop) {
    const picked = await desktop.pickFolder();
    if (!picked) throw new DOMException('No folder was chosen.', 'AbortError');
    return createNativeRoot(desktop, picked);
  }
  return window.showDirectoryPicker!({ id: 'notetoo-root', mode: 'readwrite' });
}

export function isAccessError(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

export function isNotFound(e: unknown): boolean {
  return (e as { name?: string })?.name === 'NotFoundError';
}

export type Fs = ReturnType<typeof createFs>;

/** Size and date without reading the contents when the handle can tell (desktop backend). */
async function fileMeta(h: FileSystemFileHandle): Promise<{ size: number; lastModified: number }> {
  return (h as Partial<MetadataHandle>).getMetadata?.() ?? h.getFile();
}

export function createFs(root: FileSystemDirectoryHandle, onAccessLost?: (e: unknown) => void) {
  const nativeId = nativeRootId(root);

  /** Wraps every public operation so a revoked permission is reported once, centrally. */
  function guarded<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (e) {
        if (isAccessError(e)) onAccessLost?.(e);
        throw e;
      }
    };
  }

  async function dirHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    let dir = root;
    for (const seg of splitPath(path)) dir = await dir.getDirectoryHandle(seg, { create });
    return dir;
  }

  async function fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    const dir = await dirHandle(parentPath(path), create);
    return dir.getFileHandle(baseName(path), { create });
  }

  async function entryHandle(path: string): Promise<FileSystemFileHandle | FileSystemDirectoryHandle> {
    if (!splitPath(path).length) return root;
    const dir = await dirHandle(parentPath(path));
    try {
      return await dir.getFileHandle(baseName(path));
    } catch (e) {
      if ((e as DOMException).name === 'TypeMismatchError') return dir.getDirectoryHandle(baseName(path));
      throw e;
    }
  }

  async function handleOrNull(path: string) {
    try {
      return await entryHandle(path);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async function toEntry(h: FileSystemHandle, path: string): Promise<Entry> {
    if (h.kind === 'directory') return { name: h.name, path, kind: 'dir', size: 0, lastModified: 0 };
    try {
      const f = await fileMeta(h as FileSystemFileHandle);
      return { name: h.name, path, kind: 'file', size: f.size, lastModified: f.lastModified };
    } catch {
      // A locked or cloud-only file should still be listed.
      return { name: h.name, path, kind: 'file', size: 0, lastModified: 0 };
    }
  }

  async function stat(path: string): Promise<Entry | null> {
    const h = await handleOrNull(path);
    return h ? toEntry(h, path) : null;
  }

  async function exists(path: string): Promise<boolean> {
    return (await handleOrNull(path)) !== null;
  }

  /** One folder level, without ignored entries. Reads metadata only, never file contents. */
  async function list(path = ''): Promise<Entry[]> {
    const dir = await dirHandle(path);
    const pending: Promise<Entry>[] = [];
    for await (const h of dir.values()) {
      if (!isIgnored(h.name)) pending.push(toEntry(h, joinPath(path, h.name)));
    }
    return Promise.all(pending);
  }

  /** All files (and folders with `dirs`) below `path`, recursively, without ignored entries. */
  async function walk(path = '', opts: { dirs?: boolean } = {}): Promise<Entry[]> {
    const out: Entry[] = [];
    const queue = [path];
    while (queue.length) {
      for (const e of await list(queue.shift()!)) {
        if (e.kind === 'dir') queue.push(e.path);
        if (e.kind === 'file' || opts.dirs) out.push(e);
      }
    }
    return out;
  }

  async function readFile(path: string): Promise<File> {
    return (await fileHandle(path)).getFile();
  }

  /** Text and its lastModified, or null when the file does not exist. */
  async function readText(path: string): Promise<{ text: string; lastModified: number } | null> {
    try {
      const f = await readFile(path);
      return { text: await f.text(), lastModified: f.lastModified };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /**
   * Writes through createWritable(): the browser writes a swap file and only replaces the
   * target on close(), so a failed write never leaves a half-written file.
   */
  async function writeBlob(path: string, data: Blob | string): Promise<number> {
    const fh = await fileHandle(path, true);
    const w = await fh.createWritable();
    try {
      await w.write(data);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
    return (await fileMeta(fh)).lastModified;
  }

  /**
   * Writes a text file (creating folders as needed) and returns the new lastModified.
   * With `expected` set, refuses with ConflictError when the file on disk no longer has
   * that lastModified (null = the file must not exist yet).
   */
  async function writeText(path: string, text: string, opts?: { expected: number | null }): Promise<number> {
    if (opts) {
      const current = (await stat(path))?.lastModified ?? null;
      if (current !== opts.expected) throw new ConflictError(path);
    }
    return writeBlob(path, text);
  }

  async function mkdir(path: string): Promise<void> {
    await dirHandle(path, true);
  }

  /** `name`, or `name (1)`, `name (2)`… whichever does not exist yet in `dir`. */
  async function uniqueName(dir: string, name: string): Promise<string> {
    if (!(await exists(joinPath(dir, name)))) return name;
    for (let n = 1; ; n++) {
      const candidate = withSuffix(name, n);
      if (!(await exists(joinPath(dir, candidate)))) return candidate;
    }
  }

  /** Copies files from the user's PC into `dir`; never overwrites. Returns the saved names. */
  async function copyIn(dir: string, files: File[]): Promise<{ original: string; saved: string }[]> {
    await mkdir(dir);
    const out = [];
    for (const f of files) {
      const err = validateName(f.name);
      const saved = await uniqueName(dir, err ? 'file' : f.name);
      await writeBlob(joinPath(dir, saved), f);
      out.push({ original: f.name, saved });
    }
    return out;
  }

  async function removeRaw(path: string, kind: 'file' | 'dir') {
    const parent = await dirHandle(parentPath(path));
    await parent.removeEntry(baseName(path), { recursive: kind === 'dir' });
  }

  async function copyRaw(src: string, dest: string): Promise<void> {
    const h = await entryHandle(src);
    if (h.kind === 'file') {
      const file = await (h as FileSystemFileHandle).getFile();
      await writeBlob(dest, file);
      const copied = await fileMeta(await fileHandle(dest));
      if (copied.size !== file.size) throw new Error(`Copy of "${h.name}" is incomplete.`);
      return;
    }
    await mkdir(dest);
    for await (const child of (h as FileSystemDirectoryHandle).values()) {
      await copyRaw(joinPath(src, child.name), joinPath(dest, child.name));
    }
  }

  /** Moves one entry (no sidecar handling). Uses native move() when available, else copy + delete. */
  async function moveRaw(src: string, dest: string): Promise<void> {
    const h = await entryHandle(src);
    const kind = h.kind === 'file' ? 'file' : 'dir';
    if (typeof h.move === 'function') {
      try {
        await h.move(await dirHandle(parentPath(dest), true), baseName(dest));
        return;
      } catch (e) {
        // The desktop backend already handles every case a move can (incl. across drives).
        if (isAccessError(e) || nativeId) throw e;
        // Not supported for this handle/location: fall back below, but only if nothing moved.
        if (!(await exists(src)) || (await exists(dest))) throw e;
      }
    }
    await copyRaw(src, dest);
    await removeRaw(src, kind);
  }

  /** Moves an entry and its annotation sidecar(s) together. */
  async function relocate(src: string, dest: string, viaTemp: boolean): Promise<void> {
    const h = await entryHandle(src);
    const pairs: [string, string][] = [[src, dest]];
    const sSrc = h.kind === 'file' ? sidecarPath(src) : sidecarDir(src);
    const sDest = h.kind === 'file' ? sidecarPath(dest) : sidecarDir(dest);
    if (await exists(sSrc)) {
      // Leftover sidecar of a file deleted outside the app: keep it, but out of the way.
      if (!viaTemp && (await exists(sDest))) {
        await moveRaw(sDest, joinPath(parentPath(sDest), await uniqueName(parentPath(sDest), baseName(sDest) + '.stale')));
      }
      pairs.push([sSrc, sDest]);
    }
    for (const [a, b] of pairs) {
      if (viaTemp) {
        const tmp = joinPath(parentPath(a), await uniqueName(parentPath(a), baseName(a) + '.notetoo-tmp'));
        await moveRaw(a, tmp);
        await moveRaw(tmp, b);
      } else {
        await moveRaw(a, b);
      }
    }
  }

  /** Renames a file or folder in place. Returns the new path. */
  async function rename(path: string, newName: string): Promise<string> {
    const err = validateName(newName);
    if (err) throw new Error(err);
    const dest = joinPath(parentPath(path), newName);
    if (dest === path) return path;
    let caseOnly = false;
    const existing = await handleOrNull(dest);
    if (existing) {
      // On Windows "a.pdf" -> "A.pdf" finds the same entry: rename through a temporary name.
      caseOnly = await existing.isSameEntry(await entryHandle(path));
      if (!caseOnly) throw new Error(`"${newName}" already exists here.`);
    }
    await relocate(path, dest, caseOnly);
    return dest;
  }

  /** Moves a file or folder into `destDir` (suffixing the name on collision). Returns the new path. */
  async function move(path: string, destDir: string): Promise<string> {
    if (parentPath(path) === destDir) return path;
    if (isInside(destDir, path)) throw new Error('A folder cannot be moved into itself.');
    await mkdir(destDir);
    const dest = joinPath(destDir, await uniqueName(destDir, baseName(path)));
    await relocate(path, dest, false);
    return dest;
  }

  /** Deletes a file or folder (recursively) and its sidecar(s). Callers must confirm first. */
  async function remove(path: string): Promise<void> {
    const h = await entryHandle(path);
    const kind = h.kind === 'file' ? 'file' : 'dir';
    await removeRaw(path, kind);
    const sidecar = kind === 'file' ? sidecarPath(path) : sidecarDir(path);
    const s = await handleOrNull(sidecar);
    if (s) await removeRaw(sidecar, s.kind === 'file' ? 'file' : 'dir');
  }

  /** Removes a single file only, without touching sidecars (used for sidecars themselves). */
  async function removeFile(path: string): Promise<void> {
    await removeRaw(path, 'file');
  }

  /** Creates a subject folder with the five section folders. */
  async function createSubject(name: string): Promise<string> {
    const err = validateName(name);
    if (err) throw new Error(err);
    if (await exists(name)) throw new Error(`"${name}" already exists.`);
    for (const s of SECTIONS) await mkdir(joinPath(name, s));
    return name;
  }

  async function createFolder(parent: string, name: string): Promise<string> {
    const err = validateName(name);
    if (err) throw new Error(err);
    const path = joinPath(parent, name);
    if (await exists(path)) throw new Error(`"${name}" already exists here.`);
    await mkdir(path);
    return path;
  }

  /** Path of a subject's section folder (matching existing folder names case-insensitively). */
  async function sectionDir(subject: string, section: Section, create: boolean): Promise<string> {
    for (const e of await list(subject)) {
      if (e.kind === 'dir' && matchSection(e.name) === section) return e.path;
    }
    const path = joinPath(subject, section);
    if (create) await mkdir(path);
    return path;
  }

  async function hasPermission(): Promise<boolean> {
    if (!root.queryPermission) return true;
    return (await root.queryPermission({ mode: 'readwrite' })) === 'granted';
  }

  /** Must be called from a user gesture (click). */
  async function requestPermission(): Promise<boolean> {
    if (!root.requestPermission) return true;
    return (await root.requestPermission({ mode: 'readwrite' })) === 'granted';
  }

  return {
    rootName: root.name,
    /** Desktop app, or a browser connected to the NoteTOO server: files read from the PC's disk. */
    desktop: nativeId && desktop
      ? {
          /** Windows integration (default app, File Explorer): only in the desktop app, on the PC itself. */
          windows: desktop.mode === 'app',
          /** The main process's id for this folder (Receive from phone writes into it). */
          rootId: nativeId,
          /** Streams from disk (audio/video) instead of reading the whole file. */
          fileUrl: (path: string) => desktop!.fileUrl(nativeId, path),
          /** Opens in the program Windows associates with the file. Resolves to an error message or null. */
          openPath: (path: string) => desktop!.openPath(nativeId, path),
          showInFolder: (path: string) => desktop!.showInFolder(nativeId, path),
        }
      : null,
    stat: guarded(stat),
    exists: guarded(exists),
    list: guarded(list),
    walk: guarded(walk),
    readFile: guarded(readFile),
    readText: guarded(readText),
    writeText: guarded(writeText),
    mkdir: guarded(mkdir),
    uniqueName: guarded(uniqueName),
    copyIn: guarded(copyIn),
    rename: guarded(rename),
    move: guarded(move),
    remove: guarded(remove),
    removeFile: guarded(removeFile),
    createSubject: guarded(createSubject),
    createFolder: guarded(createFolder),
    sectionDir: guarded(sectionDir),
    hasPermission,
    requestPermission,
  };
}

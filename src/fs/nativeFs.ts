// Desktop app: stand-ins for the File System Access handles that fsService uses, backed by the
// Electron main process (node:fs) through the preload bridge. Like memoryFs, only the members
// fsService calls are implemented, so the rest of the app is the same in the browser and on Windows.

import type { DesktopBridge, DiskMeta, DiskResult, RootInfo } from '../desktop/bridge';
import { baseName, joinPath } from './paths';

const WRITE_CHUNK = 8 * 1024 * 1024;

function unwrap<T>(r: DiskResult<T>): T {
  if (r.ok) return r.value;
  throw new DOMException(r.message, r.name === 'Error' ? 'OperationError' : r.name);
}

const notFound = (name: string) => new DOMException(`"${name}" was not found.`, 'NotFoundError');
const mismatch = (name: string) => new DOMException(`"${name}" has a different type.`, 'TypeMismatchError');

/** Size and date as of when the handle was obtained (or last written); fsService reads it instead of the contents. */
export interface MetadataHandle {
  getMetadata(): { size: number; lastModified: number };
}

/** The opened folder every handle belongs to. */
interface Root {
  bridge: DesktopBridge;
  id: string;
}

class NativeFile implements MetadataHandle {
  readonly kind = 'file';
  constructor(
    private root: Root,
    readonly path: string,
    private meta: DiskMeta,
  ) {}

  get name() {
    return baseName(this.path);
  }

  getMetadata() {
    return { size: this.meta.size, lastModified: this.meta.lastModified };
  }

  /** Streams the contents from disk into a Blob (no copy through IPC). */
  async getFile(): Promise<File> {
    const res = await fetch(this.root.bridge.fileUrl(this.root.id, this.path));
    if (res.status === 404) throw notFound(this.name);
    if (!res.ok) throw new DOMException(`"${this.name}" could not be read (${res.status}).`, 'NotReadableError');
    const lastModified = Number(res.headers.get('x-last-modified')) || this.meta.lastModified;
    const blob = await res.blob();
    return new File([blob], this.name, { lastModified, type: blob.type });
  }

  /** Same contract as the browser's: data lands in a temporary file that replaces this one on close(). */
  async createWritable() {
    const { bridge, id: root } = this.root;
    const id = unwrap(await bridge.beginWrite(root, this.path));
    let size = 0;
    return {
      write: async (chunk: unknown) => {
        const c = chunk as { type?: string; data?: string | Blob };
        const data = c && typeof c === 'object' && c.type === 'write' ? c.data! : (chunk as string | Blob);
        const blob = typeof data === 'string' ? new Blob([data]) : data;
        // Sliced so a large file (e.g. a lecture video) never has to fit in memory at once.
        for (let at = 0; at < blob.size; at += WRITE_CHUNK) {
          unwrap(await bridge.writeChunk(id, new Uint8Array(await blob.slice(at, at + WRITE_CHUNK).arrayBuffer())));
        }
        size += blob.size;
      },
      close: async () => {
        this.meta = { kind: 'file', size, lastModified: unwrap(await bridge.commitWrite(id)) };
      },
      abort: async () => bridge.abortWrite(id),
    };
  }

  async move(dest: NativeDir, newName?: string) {
    unwrap(await this.root.bridge.move(this.root.id, this.path, joinPath(dest.path, newName ?? this.name)));
  }

  async isSameEntry(other: unknown) {
    return other instanceof NativeFile && unwrap(await this.root.bridge.sameEntry(this.root.id, this.path, other.path));
  }
}

export class NativeDir {
  readonly kind = 'directory';
  constructor(
    readonly root: Root,
    readonly path: string,
    readonly name: string,
  ) {}

  private child(name: string) {
    return joinPath(this.path, name);
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}) {
    const { bridge, id } = this.root;
    const path = this.child(name);
    const meta = opts.create ? unwrap(await bridge.mkdir(id, path)) : unwrap(await bridge.stat(id, path));
    if (!meta) throw notFound(name);
    if (meta.kind !== 'dir') throw mismatch(name);
    return new NativeDir(this.root, path, name);
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}) {
    const { bridge, id } = this.root;
    const path = this.child(name);
    let meta = unwrap(await bridge.stat(id, path));
    if (!meta && opts.create) meta = unwrap(await bridge.createFile(id, path));
    if (!meta) throw notFound(name);
    if (meta.kind !== 'file') throw mismatch(name);
    return new NativeFile(this.root, path, meta);
  }

  /** Deleting goes to the Recycle Bin, so a deleted file can still be restored from Windows. */
  async removeEntry(name: string) {
    unwrap(await this.root.bridge.trash(this.root.id, this.child(name)));
  }

  /** One IPC call per folder: names, kinds, sizes and dates together. */
  async *values() {
    for (const e of unwrap(await this.root.bridge.list(this.root.id, this.path))) {
      const path = this.child(e.name);
      yield e.kind === 'dir' ? new NativeDir(this.root, path, e.name) : new NativeFile(this.root, path, e);
    }
  }

  async move(dest: NativeDir, newName?: string) {
    unwrap(await this.root.bridge.move(this.root.id, this.path, joinPath(dest.path, newName ?? this.name)));
  }

  async isSameEntry(other: unknown) {
    return other instanceof NativeDir && unwrap(await this.root.bridge.sameEntry(this.root.id, this.path, other.path));
  }

  /** "Permission" here means the folder still exists (it may have been renamed, or on a removed drive). */
  async queryPermission() {
    return ((await this.root.bridge.rootExists(this.root.id)) ? 'granted' : 'denied') as PermissionState;
  }
  async requestPermission() {
    return this.queryPermission();
  }
}

/** A root directory usable wherever fsService expects a FileSystemDirectoryHandle. */
export function createNativeRoot(bridge: DesktopBridge, info: RootInfo): FileSystemDirectoryHandle {
  return new NativeDir({ bridge, id: info.id }, '', info.name) as unknown as FileSystemDirectoryHandle;
}

/** The opened folder's id when `root` comes from the desktop backend, else null. */
export function nativeRootId(root: FileSystemDirectoryHandle): string | null {
  const r = root as unknown;
  return r instanceof NativeDir ? r.root.id : null;
}

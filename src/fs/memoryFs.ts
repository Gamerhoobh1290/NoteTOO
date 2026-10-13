// In-memory stand-in for the File System Access handles that fsService uses.
// Used by unit tests and by the dev-only `?sample` mode; never by real folders.

let clock = 0;
function tick(): number {
  clock = Math.max(Date.now(), clock + 1);
  return clock;
}

function notFound(name: string) {
  return new DOMException(`"${name}" was not found.`, 'NotFoundError');
}

type Node = MemFile | MemDir;

class MemFile {
  readonly kind = 'file';
  constructor(
    public name: string,
    public parent: MemDir,
    public data: Blob = new Blob([]),
    public lastModified: number = tick(),
  ) {}

  private assertAttached() {
    if (this.parent.children.get(this.name) !== this) throw notFound(this.name);
  }

  async getFile(): Promise<File> {
    this.assertAttached();
    return new File([this.data], this.name, { lastModified: this.lastModified });
  }

  async createWritable() {
    this.assertAttached();
    const chunks: BlobPart[] = [];
    return {
      write: async (chunk: unknown) => {
        const c = chunk as { type?: string; data?: BlobPart };
        chunks.push(c && typeof c === 'object' && c.type === 'write' ? c.data! : (chunk as BlobPart));
      },
      close: async () => {
        this.data = new Blob(chunks);
        this.lastModified = tick();
      },
      abort: async () => {},
    };
  }

  async isSameEntry(other: unknown) {
    return other === this;
  }
  async queryPermission() {
    return 'granted' as PermissionState;
  }
  async requestPermission() {
    return 'granted' as PermissionState;
  }
}

export class MemDir {
  readonly kind = 'directory';
  readonly children = new Map<string, Node>();
  constructor(public name: string) {}

  private get(name: string, kind: Node['kind'], create?: boolean): Node {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== kind) throw new DOMException(`"${name}" has a different type.`, 'TypeMismatchError');
      return existing;
    }
    if (!create) throw notFound(name);
    const node = kind === 'file' ? new MemFile(name, this) : new MemDir(name);
    this.children.set(name, node);
    return node;
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}) {
    return this.get(name, 'directory', opts.create) as MemDir;
  }
  async getFileHandle(name: string, opts: { create?: boolean } = {}) {
    return this.get(name, 'file', opts.create) as MemFile;
  }
  async removeEntry(name: string, opts: { recursive?: boolean } = {}) {
    const node = this.children.get(name);
    if (!node) throw notFound(name);
    if (node.kind === 'directory' && node.children.size && !opts.recursive) {
      throw new DOMException('Directory is not empty.', 'InvalidModificationError');
    }
    this.children.delete(name);
  }
  async *values() {
    yield* [...this.children.values()];
  }
  async *entries() {
    for (const n of [...this.children.values()]) yield [n.name, n] as const;
  }
  async isSameEntry(other: unknown) {
    return other === this;
  }
  async queryPermission() {
    return 'granted' as PermissionState;
  }
  async requestPermission() {
    return 'granted' as PermissionState;
  }
}

/** A root directory usable wherever fsService expects a FileSystemDirectoryHandle. */
export function createMemoryRoot(name = 'root'): FileSystemDirectoryHandle {
  return new MemDir(name) as unknown as FileSystemDirectoryHandle;
}

/** Test/dev helper: put a file at a '/'-separated path, creating folders. */
export async function putFile(
  root: FileSystemDirectoryHandle,
  path: string,
  content: BlobPart,
  lastModified?: number,
): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  let dir = root as unknown as MemDir;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  file.data = new Blob([content]);
  file.lastModified = lastModified ?? tick();
}

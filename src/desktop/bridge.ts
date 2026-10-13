// Contract between the Electron preload script (electron/preload.cts) and the renderer.
// In a plain browser `desktop` is null and the app uses the File System Access API instead.
// Disk calls name the opened folder by its id (so edits still saving after a switch go to the
// folder they belong to) and a '/'-separated path inside it; the main process resolves them and
// refuses anything outside that folder.

export interface RootInfo {
  /** session id of this opened folder, passed to every disk call */
  id: string;
  /** absolute path, for display (start screen, title) */
  path: string;
  name: string;
}

export interface DiskMeta {
  kind: 'file' | 'dir';
  size: number;
  /** ms since epoch (integer); 0 for folders */
  lastModified: number;
}

export interface DiskEntry extends DiskMeta {
  name: string;
}

/** Error codes mapped to the DOMException names fsService understands. */
export type DiskErrorName =
  | 'NotFoundError'
  | 'TypeMismatchError'
  | 'NotAllowedError'
  | 'InvalidModificationError'
  | 'NoModificationAllowedError'
  | 'Error';

export type DiskResult<T> = { ok: true; value: T } | { ok: false; name: DiskErrorName; message: string };

export type ThemeSource = 'system' | 'light' | 'dark';

export interface DesktopBridge {
  // ----- the opened folder -----
  /** Native folder dialog; opens the chosen folder (null when cancelled). */
  pickFolder(): Promise<RootInfo | null>;
  /** Reopens a folder from the recent list (null when it no longer exists). */
  openRecent(path: string): Promise<RootInfo | null>;
  /** The folder that was open when the app last closed, if it still exists. */
  lastFolder(): Promise<RootInfo | null>;
  recentFolders(): Promise<string[]>;
  forgetRecent(path: string): Promise<string[]>;
  /** Forgets the folder as "last opened", so the next launch shows the start screen. */
  closeFolder(): Promise<void>;
  rootExists(root: string): Promise<boolean>;

  // ----- disk operations on the opened folder -----
  stat(root: string, path: string): Promise<DiskResult<DiskMeta | null>>;
  list(root: string, path: string): Promise<DiskResult<DiskEntry[]>>;
  /** Creates one folder level (no error when it already exists as a folder). */
  mkdir(root: string, path: string): Promise<DiskResult<DiskMeta>>;
  /** Creates an empty file when missing. */
  createFile(root: string, path: string): Promise<DiskResult<DiskMeta>>;
  /**
   * Atomic write in chunks: data goes to a temporary file, which replaces the target only on
   * commit, so a failed write never leaves a half-written file. Commit returns the new lastModified.
   */
  beginWrite(root: string, path: string): Promise<DiskResult<string>>;
  writeChunk(id: string, data: Uint8Array): Promise<DiskResult<void>>;
  commitWrite(id: string): Promise<DiskResult<number>>;
  abortWrite(id: string): Promise<void>;
  /** Moves to the Recycle Bin. */
  trash(root: string, path: string): Promise<DiskResult<void>>;
  /** Rename/move; refuses to replace an existing entry. */
  move(root: string, from: string, to: string): Promise<DiskResult<void>>;
  sameEntry(root: string, a: string, b: string): Promise<DiskResult<boolean>>;
  /** URL that streams the file from disk (with range requests, for audio/video). */
  fileUrl(root: string, path: string): string;

  // ----- Windows integration -----
  openPath(root: string, path: string): Promise<string | null>;
  showInFolder(root: string, path: string): Promise<void>;
  getTheme(): Promise<ThemeSource>;
  setTheme(theme: ThemeSource): Promise<void>;

  /**
   * A folder was passed on the command line or picked from the taskbar jump list while running.
   * It is added to the recent list; the page saves pending edits, then opens it with openRecent.
   */
  onOpenFolderRequest(handler: (path: string) => void): () => void;
  /** Before the window closes, the main process asks the page to save; reply whether all is saved. */
  onCloseRequest(handler: () => Promise<boolean>): () => void;
}

declare global {
  interface Window {
    notetoo?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | null = (typeof window !== 'undefined' && window.notetoo) || null;

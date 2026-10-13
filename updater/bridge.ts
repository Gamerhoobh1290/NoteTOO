// Contract between the updater's main process (updater/main.mts) and its page (updater/src/).

export type Phase =
  | 'detecting' // looking for the installed NoteTOO
  | 'not-installed'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'confirm-close' // downloaded and verified; NoteTOO is open and must be closed first
  | 'closing'
  | 'installing'
  | 'done'
  | 'error';

export interface UpdaterState {
  phase: Phase;
  updaterVersion: string;
  installed: { version: string; dir: string } | null;
  latest: { version: string; notes: string; releasedAt: string; size: number } | null;
  /** bytes, while downloading */
  progress?: { done: number; total: number };
  /** ISO time of the last successful check */
  checkedAt?: string;
  /** for 'installing': the step being done */
  step?: string;
  error?: { title: string; detail: string; retry: 'check' | 'download' | 'install' | 'detect' };
}

export interface UpdaterBridge {
  getState(): Promise<UpdaterState>;
  onState(handler: (s: UpdaterState) => void): () => void;
  check(): Promise<void>;
  /** download, verify, then install (asks to close NoteTOO if it is open) */
  update(): Promise<void>;
  /** close NoteTOO (it saves first), then install */
  closeAndInstall(): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  openNoteToo(): Promise<void>;
  openReleasesPage(): Promise<void>;
}

declare global {
  interface Window {
    updater: UpdaterBridge;
  }
}

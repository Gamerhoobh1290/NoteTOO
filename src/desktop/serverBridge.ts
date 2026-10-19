// Browser connected to the NoteTOO server (server/) on the PC that has the files: the same
// DesktopBridge as the desktop app, carried over HTTP. Every disk call runs on that PC, inside the
// folders it shares; nothing is kept in this browser. The server marks the pages it serves with
// <meta name="notetoo-server">, so the same build still runs as the desktop app or a plain web page.
//
// The connection state (online / unreachable / signed out) is shown by ConnectionBanner: a failed
// call starts checking the server again until it answers, so a sleeping laptop or a restarted
// server recovers on its own (pending edits show Retry meanwhile).

import type { DesktopBridge, DiskResult, ReceiveState, RootInfo } from './bridge.js';

export type Connection = 'online' | 'offline' | 'signed-out';

let connection: Connection = 'online';
const listeners = new Set<() => void>();
let checking: ReturnType<typeof setTimeout> | null = null;

function setConnection(c: Connection) {
  if (c === connection) return;
  connection = c;
  listeners.forEach((l) => l());
  if (c !== 'online') scheduleCheck(1000);
}

/** Polls the server (backing off to every 10 s) until it answers again. */
function scheduleCheck(delay: number) {
  if (checking) return;
  checking = setTimeout(async () => {
    checking = null;
    try {
      const res = await fetch('/api/ping', { cache: 'no-store' });
      if (res.ok) return setConnection('online');
      connection = res.status === 401 ? 'signed-out' : 'offline';
      listeners.forEach((l) => l());
    } catch {
      /* still unreachable */
    }
    scheduleCheck(Math.min(delay * 2, 10_000));
  }, delay);
}

export const getConnection = () => connection;
export function subscribeConnection(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Checks right away (e.g. the laptop woke up or the tab came back). */
export function checkConnectionNow() {
  if (connection === 'online') return;
  if (checking) clearTimeout(checking);
  checking = null;
  scheduleCheck(0);
}

const UNREACHABLE = "Can't reach NoteTOO on your PC. Check that the PC is on and the NoteTOO server is running; NoteTOO reconnects on its own.";
const SIGNED_OUT = 'You were signed out of NoteTOO. Sign in again (link at the top of the page), then try again.';

async function request(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') throw e;
    setConnection('offline');
    throw new DOMException(UNREACHABLE, 'NetworkError');
  }
  if (res.status === 401) {
    setConnection('signed-out');
    throw new DOMException(SIGNED_OUT, 'OperationError');
  }
  setConnection('online');
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new DOMException(j?.error ?? `The NoteTOO server answered with an error (${res.status}).`, 'OperationError');
  }
  return res;
}

/** Calls a server handler (the HTTP twin of the desktop app's IPC channels). */
export async function serverCall<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await request(`/api/rpc/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  return ((await res.json()) as { value: T }).value;
}

const NOT_HERE: ReceiveState = {
  running: false,
  urls: [],
  key: null,
  files: [],
  error: 'Receive from phone is only available in the NoteTOO desktop app.',
};

export function connectServerBridge(): DesktopBridge | null {
  if (typeof document === 'undefined' || !document.querySelector('meta[name="notetoo-server"]')) return null;

  // Back from sleep or another tab: don't wait for the next poll.
  window.addEventListener('online', checkConnectionNow);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkConnectionNow());

  const call = serverCall;
  return {
    mode: 'server',
    // The folders are the ones the server shares (set up on the PC); there is no folder dialog.
    pickFolder: async () => null,
    openRecent: (p) => call<RootInfo | null>('folder:open-recent', p),
    lastFolder: () => call<RootInfo | null>('folder:last'),
    recentFolders: () => call<string[]>('folder:recent'),
    forgetRecent: () => call<string[]>('folder:recent'),
    closeFolder: () => call<void>('folder:close'),
    rootExists: (root) => call<boolean>('folder:exists', root),

    stat: (root, p) => call('disk:stat', root, p),
    list: (root, p) => call('disk:list', root, p),
    mkdir: (root, p) => call('disk:mkdir', root, p),
    createFile: (root, p) => call('disk:create-file', root, p),
    beginWrite: (root, p) => call('disk:begin-write', root, p),
    writeChunk: async (id, data) => {
      const res = await request(`/api/write/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: data as Uint8Array<ArrayBuffer>,
      });
      return (await res.json()) as DiskResult<void>;
    },
    commitWrite: (id) => call('disk:commit-write', id),
    abortWrite: (id) => call('disk:abort-write', id),
    trash: (root, p) => call('disk:trash', root, p),
    move: (root, from, to) => call('disk:move', root, from, to),
    sameEntry: (root, a, b) => call('disk:same-entry', root, a, b),
    fileUrl: (root, p) => `/api/file/${root}/${p.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,

    openPath: async () => 'Files can only be opened in other programs on the PC itself.',
    showInFolder: async () => {},
    getTheme: async () => 'system',
    setTheme: async () => {},

    receiveStart: async () => NOT_HERE,
    receiveStop: async () => NOT_HERE,
    receiveState: async () => NOT_HERE,
    receiveNewKey: async () => NOT_HERE,
    onReceiveState: () => () => {},

    onOpenFolderRequest: () => () => {},
    // A browser tab cannot be held open: the beforeunload guard in useDiskDoc warns instead.
    onCloseRequest: () => () => {},
  };
}

// Sandboxed preload: exposes the narrow `window.notetoo` bridge (see src/desktop/bridge.ts).
// No Node.js reaches the page; every call goes through IPC to the main process, which checks it.

import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../src/desktop/bridge';

const FILE_SCHEME = 'notetoo-file'; // = disk.FILE_SCHEME (a sandboxed preload can only require 'electron')
const invoke = ipcRenderer.invoke.bind(ipcRenderer);

const bridge: DesktopBridge = {
  pickFolder: () => invoke('folder:pick'),
  openRecent: (p) => invoke('folder:open-recent', p),
  lastFolder: () => invoke('folder:last'),
  recentFolders: () => invoke('folder:recent'),
  forgetRecent: (p) => invoke('folder:forget', p),
  closeFolder: () => invoke('folder:close'),
  rootExists: (root) => invoke('folder:exists', root),

  stat: (root, p) => invoke('disk:stat', root, p),
  list: (root, p) => invoke('disk:list', root, p),
  mkdir: (root, p) => invoke('disk:mkdir', root, p),
  createFile: (root, p) => invoke('disk:create-file', root, p),
  beginWrite: (root, p) => invoke('disk:begin-write', root, p),
  writeChunk: (id, data) => invoke('disk:write-chunk', id, data),
  commitWrite: (id) => invoke('disk:commit-write', id),
  abortWrite: (id) => invoke('disk:abort-write', id),
  trash: (root, p) => invoke('disk:trash', root, p),
  move: (root, from, to) => invoke('disk:move', root, from, to),
  sameEntry: (root, a, b) => invoke('disk:same-entry', root, a, b),
  fileUrl: (root, p) => `${FILE_SCHEME}://${root}/${p.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,

  openPath: (root, p) => invoke('shell:open-path', root, p),
  showInFolder: (root, p) => invoke('shell:show-in-folder', root, p),
  getTheme: () => invoke('theme:get'),
  setTheme: (t) => invoke('theme:set', t),

  onOpenFolderRequest: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, p: string) => handler(p);
    ipcRenderer.on('app:open-folder-request', listener);
    return () => void ipcRenderer.removeListener('app:open-folder-request', listener);
  },
  onCloseRequest: (handler) => {
    const listener = async () => {
      let saved = false;
      try {
        saved = await handler();
      } finally {
        ipcRenderer.send('app:close-reply', saved);
      }
    };
    ipcRenderer.on('app:close-request', listener);
    return () => void ipcRenderer.removeListener('app:close-request', listener);
  },
};

contextBridge.exposeInMainWorld('notetoo', bridge);

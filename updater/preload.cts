// Sandboxed preload: the updater page only gets these calls (contract: updater/bridge.ts).
import { contextBridge, ipcRenderer } from 'electron';
import type { UpdaterBridge, UpdaterState } from './bridge';

const invoke = ipcRenderer.invoke.bind(ipcRenderer);

const bridge: UpdaterBridge = {
  getState: () => invoke('updater:get-state'),
  onState: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, s: UpdaterState) => handler(s);
    ipcRenderer.on('updater:state', listener);
    return () => void ipcRenderer.removeListener('updater:state', listener);
  },
  check: () => invoke('updater:check'),
  update: () => invoke('updater:update'),
  closeAndInstall: () => invoke('updater:close-and-install'),
  cancel: () => invoke('updater:cancel'),
  retry: () => invoke('updater:retry'),
  openNoteToo: () => invoke('updater:open-notetoo'),
  openReleasesPage: () => invoke('updater:open-releases'),
};

contextBridge.exposeInMainWorld('updater', bridge);

// NoteTOO Updater: Electron main process. Holds the update state machine and pushes every
// change to the page. Network, disk and processes are only touched here; the page is sandboxed.
// Nothing runs in the background: the updater does its work while its window is open.

import { app, BrowserWindow, ipcMain, nativeTheme, net, shell, type IpcMainInvokeEvent } from 'electron';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { UpdaterState } from './bridge.js';
import { TrustError, compareVersions, downloadVerified, stoppedByInstaller, type Install, type Manifest, verifyManifest } from './core.mjs';
import { FEED_URL, RELEASES_PAGE } from './feed.mjs';
import { RELEASE_PUBLIC_KEY } from './releaseKey.mjs';
import { closeGracefully, findInstall, launch, runInstaller, runningPids } from './system.mjs';

const HERE = import.meta.dirname; // out/updater
const DIST = path.join(HERE, '..', '..', 'dist-updater');
const DEV_URL = process.env.NOTETOO_UPDATER_DEV_URL;
/** Test feeds (e.g. a local server) still have to be signed with the release key. */
const FEED = process.env.NOTETOO_UPDATE_FEED || FEED_URL;
/** No spaces: keeps the installer's command line simple. */
const DOWNLOADS = path.join(process.env.LOCALAPPDATA || tmpdir(), 'notetoo-updater', 'downloads');

const COLORS = {
  light: { chrome: '#fbfbf9', symbol: '#19191c', bg: '#f4f4f1' },
  dark: { chrome: '#161619', symbol: '#ececef', bg: '#121214' },
};
const TITLEBAR_HEIGHT = 44;

let win: BrowserWindow | null = null;
let install: Install | null = null;
let manifest: Manifest | null = null;
let installer: string | null = null;
let busy: AbortController | null = null;
let state: UpdaterState = { phase: 'detecting', updaterVersion: app.getVersion(), installed: null, latest: null };

function set(p: Partial<UpdaterState>) {
  state = { ...state, ...p };
  if (p.phase && p.phase !== 'error') state.error = undefined;
  if (p.phase && p.phase !== 'downloading') state.progress = undefined;
  win?.webContents.send('updater:state', state);
}

function fail(title: string, detail: string, retry: NonNullable<UpdaterState['error']>['retry']) {
  set({ phase: 'error', error: { title, detail, retry } });
}

/** What went wrong, in words a user can act on. */
function networkProblem(e: unknown): string {
  if (!net.isOnline()) return 'This PC is offline. Connect to the internet and try again.';
  if (e instanceof Error && e.name === 'TimeoutError') return 'GitHub did not answer in time. Check your connection and try again.';
  return `Could not reach GitHub (${e instanceof Error ? e.message : String(e)}).`;
}

async function detect() {
  set({ phase: 'detecting' });
  try {
    install = await findInstall();
  } catch (e) {
    return fail('Could not look for NoteTOO', String(e instanceof Error ? e.message : e), 'detect');
  }
  set({ installed: install && { version: install.version, dir: install.dir }, phase: install ? 'idle' : 'not-installed' });
  if (install) await check();
}

async function fetchBytes(url: string, signal: AbortSignal): Promise<Buffer> {
  const res = await net.fetch(url, { signal, cache: 'no-store' });
  if (res.status === 404) throw Object.assign(new Error('not published'), { notFound: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function check() {
  if (!install) return;
  set({ phase: 'checking' });
  const signal = AbortSignal.timeout(20_000);
  let bytes: Buffer;
  let sig: Buffer;
  try {
    [bytes, sig] = await Promise.all([fetchBytes(FEED, signal), fetchBytes(FEED + '.sig', signal)]);
  } catch (e) {
    if ((e as { notFound?: boolean }).notFound) return fail('No release found', 'No NoteTOO release has been published yet.', 'check');
    return fail('Could not check for updates', networkProblem(e), 'check');
  }
  try {
    manifest = verifyManifest(bytes, sig.toString('utf8'), RELEASE_PUBLIC_KEY);
  } catch (e) {
    manifest = null;
    return fail('Update refused', e instanceof TrustError ? e.message : String(e), 'check');
  }
  const newer = compareVersions(manifest.version, install.version) > 0;
  set({
    phase: newer ? 'available' : 'up-to-date',
    checkedAt: new Date().toISOString(),
    latest: { version: manifest.version, notes: manifest.notes, releasedAt: manifest.releasedAt, size: manifest.size },
  });
}

async function update() {
  if (!manifest || !install || busy) return;
  if (stoppedByInstaller(app.getPath('exe'), install.dir)) {
    return fail(
      'NoteTOO Updater is in the wrong folder',
      `NoteTOO Updater is installed in "${path.dirname(app.getPath('exe'))}", whose path begins with NoteTOO's folder "${install.dir}", so NoteTOO's installer would close the updater midway. Reinstall NoteTOO Updater in its default folder, then try again. Nothing was changed.`,
      'detect',
    );
  }
  const ac = new AbortController();
  busy = ac;
  set({ phase: 'downloading', progress: { done: 0, total: manifest.size } });
  let last = 0;
  try {
    installer = await downloadVerified(manifest, DOWNLOADS, {
      fetchImpl: (url, init) => net.fetch(url, { ...init, cache: 'no-store' }),
      signal: ac.signal,
      onProgress: (done) => {
        const now = Date.now();
        if (now - last > 120 || done === manifest!.size) {
          last = now;
          if (done === manifest!.size) set({ phase: 'verifying' });
          else set({ progress: { done, total: manifest!.size } });
        }
      },
    });
  } catch (e) {
    if (ac.signal.aborted) set({ phase: 'available' });
    else if (e instanceof TrustError) fail('Download rejected', e.message, 'download');
    else fail('Download interrupted', `${networkProblem(e)} What was already downloaded is kept; retrying continues from there.`, 'download');
    return;
  } finally {
    busy = null;
  }
  if ((await runningPids(install.exe)).length) set({ phase: 'confirm-close' });
  else await installNow();
}

async function closeAndInstall() {
  if (!install || state.phase !== 'confirm-close') return;
  set({ phase: 'closing' });
  if (!(await closeGracefully(install.exe))) {
    return fail(
      'NoteTOO is still open',
      'NoteTOO did not close. It may be asking about changes it could not save. Switch to NoteTOO, deal with its message, then try again. Nothing was installed.',
      'install',
    );
  }
  await installNow();
}

async function installNow() {
  if (!install || !manifest || !installer) return;
  const target = manifest.version;
  set({ phase: 'installing', step: `Installing NoteTOO ${target}…` });
  let code: number;
  try {
    code = await runInstaller(installer, install.dir);
  } catch (e) {
    return fail('Installation failed', `${e instanceof Error ? e.message : e} Your notes and settings are not affected.`, 'install');
  }
  set({ step: 'Checking the installation…' });
  const now = await findInstall().catch(() => null);
  if (code !== 0 || !now || now.version !== target) {
    install = now ?? install;
    set({ installed: install && { version: install.version, dir: install.dir } });
    return fail(
      'Installation failed',
      `The installer stopped (code ${code}). ${now ? `NoteTOO ${now.version} is still installed` : 'NoteTOO could not be found afterwards'}. Your notes, annotations and settings are stored outside the program folder and are not affected.`,
      'install',
    );
  }
  install = now;
  // Installed and checked: the downloaded installer is no longer needed.
  await rm(installer, { force: true }).catch(() => {});
  installer = null;
  set({ phase: 'done', installed: { version: now.version, dir: now.dir }, step: undefined });
}

function retry() {
  const r = state.error?.retry;
  if (r === 'detect') return detect();
  if (r === 'check') return check();
  if (r === 'download') return update();
  if (r === 'install') return installer && install ? (async () => ((await runningPids(install!.exe)).length ? set({ phase: 'confirm-close' }) : installNow()))() : update();
}

// ---------- window and IPC ----------

const PAGE_URL = () => (DEV_URL ? DEV_URL : pathToFileURL(path.join(DIST, 'index.html')).toString());

function trusted(e: IpcMainInvokeEvent) {
  const url = e.senderFrame?.url ?? '';
  return DEV_URL ? url.startsWith(DEV_URL) : url === PAGE_URL();
}

function handle(channel: string, fn: () => unknown) {
  ipcMain.handle(channel, async (e) => {
    if (!trusted(e)) throw new Error('Refused: untrusted sender.');
    await fn();
  });
}

function palette() {
  return nativeTheme.shouldUseDarkColors ? COLORS.dark : COLORS.light;
}

function createWindow() {
  const c = palette();
  win = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 460,
    minHeight: 560,
    show: false,
    title: 'NoteTOO Updater',
    backgroundColor: c.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.chrome, symbolColor: c.symbol, height: TITLEBAR_HEIGHT },
    maximizable: false,
    icon: app.isPackaged ? undefined : path.join(HERE, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', () => busy?.abort());
  win.on('closed', () => (win = null));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  nativeTheme.on('updated', () => {
    const p = palette();
    win?.setBackgroundColor(p.bg);
    win?.setTitleBarOverlay({ color: p.chrome, symbolColor: p.symbol, height: TITLEBAR_HEIGHT });
  });
  void win.loadURL(PAGE_URL());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.notetoo.updater');
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  void app.whenReady().then(() => {
    ipcMain.handle('updater:get-state', (e) => {
      if (!trusted(e)) throw new Error('Refused: untrusted sender.');
      return state;
    });
    handle('updater:check', () => (state.phase === 'checking' || busy ? undefined : check()));
    handle('updater:update', update);
    handle('updater:close-and-install', closeAndInstall);
    // Cancels a download (kept for resuming), or "not now" when asked to close NoteTOO.
    handle('updater:cancel', () => (state.phase === 'confirm-close' ? set({ phase: 'available' }) : busy?.abort()));
    handle('updater:retry', retry);
    handle('updater:open-notetoo', () => install && launch(install.exe));
    handle('updater:open-releases', () => shell.openExternal(RELEASES_PAGE));
    createWindow();
    void detect();
  });
  app.on('window-all-closed', () => app.quit());
}

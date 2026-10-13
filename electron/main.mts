// NoteTOO desktop: Electron main process. Owns the window, the native folder dialog, the app's
// own settings (window size, recent folders, theme; in %APPDATA%\NoteTOO, never in the school
// folder) and the disk backend in disk.mts.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as disk from './disk.mjs';
import type { RootInfo, ThemeSource } from '../src/desktop/bridge.js';

const APP_ID = 'com.notetoo.desktop';
/** Set by `npm run desktop:dev`: load the Vite dev server instead of the built files. */
const DEV_URL = process.env.NOTETOO_DEV_URL;
/** Compiled to out/electron/, next to the app's dist/ and build/ folders. */
const HERE = import.meta.dirname;
const APP_DIR = path.join(HERE, '..', '..');
const DIST = path.join(APP_DIR, 'dist');
const APP_ORIGIN = 'app://notetoo';
const TITLEBAR_HEIGHT = 52; // matches .shell's first grid row in styles.css

// Matches --chrome / --text / --bg in styles.css, so the caption buttons blend into the top bar.
const COLORS = {
  light: { chrome: '#fbfbf9', symbol: '#19191c', bg: '#f4f4f1' },
  dark: { chrome: '#161619', symbol: '#ececef', bg: '#121214' },
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  { scheme: disk.FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------- settings (%APPDATA%\NoteTOO\settings.json) ----------

interface Settings {
  last: string | null;
  recent: string[];
  theme: ThemeSource;
  window: { x?: number; y?: number; width: number; height: number; maximized: boolean };
}
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const MAX_RECENT = 8;

function loadSettings(): Settings {
  const base: Settings = { last: null, recent: [], theme: 'system', window: { width: 1280, height: 820, maximized: false } };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE(), 'utf8')) as Partial<Settings>;
    return {
      last: typeof raw.last === 'string' ? raw.last : null,
      recent: Array.isArray(raw.recent) ? raw.recent.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT) : [],
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
      window: { ...base.window, ...(typeof raw.window === 'object' ? raw.window : {}) },
    };
  } catch {
    return base; // first run, or a damaged file: start over (it holds no user data)
  }
}

let settings: Settings;
function saveSettings() {
  try {
    const file = SETTINGS_FILE();
    writeFileSync(file + '.tmp', JSON.stringify(settings, null, 2));
    renameSync(file + '.tmp', file);
  } catch (e) {
    console.error('Could not save settings:', e);
  }
}

// ---------- folders ----------

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function rememberFolder(dir: string) {
  settings.recent = [dir, ...settings.recent.filter((p) => !samePath(p, dir))].slice(0, MAX_RECENT);
  saveSettings();
  updateJumpList();
}

function openFolder(dir: string): RootInfo {
  const info = disk.openRoot(dir);
  settings.last = info.path;
  rememberFolder(info.path);
  return info;
}

/** Taskbar jump list: right-click NoteTOO in the taskbar to reopen a recent folder. */
function updateJumpList() {
  if (!app.isPackaged) return;
  try {
    app.setJumpList([
      {
        type: 'custom',
        name: 'Recent folders',
        items: settings.recent.filter(disk.isDirectory).map((p) => ({
          type: 'task' as const,
          title: path.basename(p) || p,
          description: p,
          program: process.execPath,
          // A trailing backslash would escape the closing quote ("D:\" -> D:" ).
          args: `"${p.endsWith('\\') ? p + '.' : p}"`,
          iconPath: process.execPath,
          iconIndex: 0,
        })),
      },
    ]);
  } catch (e) {
    console.error('Could not update the jump list:', e);
  }
}

/** First argument that is an existing folder (from the jump list, or "Open with NoteTOO"). */
function folderFromArgs(argv: string[]): string | null {
  // Skip the executable, switches, and (in development) the app's own folder given as `electron .`.
  return (
    argv
      .slice(1)
      .filter((a) => !a.startsWith('-'))
      .map((a) => path.resolve(a))
      .find((p) => !samePath(p, app.getAppPath()) && disk.isDirectory(p)) ?? null
  );
}
let pendingFolder: string | null = null;

// ---------- window ----------

let win: BrowserWindow | null = null;

function palette() {
  return nativeTheme.shouldUseDarkColors ? COLORS.dark : COLORS.light;
}

function applyThemeToWindow() {
  if (!win) return;
  const c = palette();
  win.setBackgroundColor(c.bg);
  win.setTitleBarOverlay({ color: c.chrome, symbolColor: c.symbol, height: TITLEBAR_HEIGHT });
}

/** Restores the last size/position, unless that position is no longer on any screen. */
function initialBounds() {
  const w = settings.window;
  const bounds = { width: Math.max(w.width, 720), height: Math.max(w.height, 480), x: w.x, y: w.y };
  if (bounds.x === undefined || bounds.y === undefined) return bounds;
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x! < a.x + a.width - 100 && bounds.x! + bounds.width > a.x + 100 && bounds.y! >= a.y - 10 && bounds.y! < a.y + a.height - 60,
  );
  return visible ? bounds : { width: bounds.width, height: bounds.height };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  settings.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
  saveSettings();
}

let allowClose = false;
let closeInFlight = false;

/** Asks the page to save pending edits; resolves whether everything is on disk. */
function pageSaved(w: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), 10_000);
    const onReply = (e: Electron.IpcMainEvent, saved: unknown) => {
      if (e.sender === w.webContents) done(saved === true);
    };
    function done(saved: boolean) {
      clearTimeout(timer);
      ipcMain.removeListener('app:close-reply', onReply);
      resolve(saved);
    }
    ipcMain.on('app:close-reply', onReply);
    w.webContents.send('app:close-request');
  });
}

async function closeSafely(w: BrowserWindow) {
  if (closeInFlight) return;
  closeInFlight = true;
  try {
    if (!(await pageSaved(w))) {
      const { response } = await dialog.showMessageBox(w, {
        type: 'warning',
        title: 'NoteTOO',
        message: 'Some changes could not be saved.',
        detail: 'A note or annotations could not be written to your folder (NoteTOO shows the error). If you close now, those changes are lost.',
        buttons: ['Keep NoteTOO open', 'Close without saving'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return;
    }
    allowClose = true;
    w.close();
  } finally {
    closeInFlight = false;
  }
}

function createWindow() {
  const c = palette();
  const bounds = initialBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'NoteTOO',
    backgroundColor: c.bg,
    // Native Windows 11 caption buttons (with Snap Layouts) drawn over our own top bar.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.chrome, symbolColor: c.symbol, height: TITLEBAR_HEIGHT },
    icon: app.isPackaged ? undefined : path.join(APP_DIR, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (settings.window.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());

  win.on('close', (e) => {
    saveWindowState();
    if (allowClose) return;
    e.preventDefault();
    void closeSafely(win!);
  });
  win.on('closed', () => (win = null));
  // The page's beforeunload guard is only for the browser version; closing is handled above.
  win.webContents.on('will-prevent-unload', (e) => {
    if (allowClose) e.preventDefault();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !win) return;
    allowClose = false;
    void dialog
      .showMessageBox(win, { type: 'error', title: 'NoteTOO', message: 'NoteTOO stopped unexpectedly.', detail: 'Edits saved before this are safe on disk.', buttons: ['Reload'], noLink: true })
      .then(() => win?.webContents.reload());
  });

  // Right-click on text: cut/copy/paste and spelling suggestions (the app draws its own menus elsewhere).
  win.webContents.on('context-menu', (_e, p) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.isEditable) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => win?.webContents.replaceMisspelling(s) });
      if (p.misspelledWord) {
        items.push({ label: 'Add to dictionary', click: () => win?.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
      }
      items.push(
        { role: 'undo', enabled: p.editFlags.canUndo },
        { role: 'redo', enabled: p.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: p.editFlags.canCut },
        { role: 'copy', enabled: p.editFlags.canCopy },
        { role: 'paste', enabled: p.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' },
      );
    } else if (p.selectionText.trim()) {
      items.push({ role: 'copy' }, { role: 'selectAll' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win! });
  });

  void (DEV_URL ? win.loadURL(DEV_URL) : win.loadURL(`${APP_ORIGIN}/index.html`));
}

// ---------- application menu (hidden; provides the standard accelerators) ----------

function setMenu() {
  const dev: Electron.MenuItemConstructorOptions[] = app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'View',
        submenu: [
          { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
          { role: 'zoomIn', accelerator: 'CommandOrControl+Plus', visible: false },
          { role: 'zoomOut' },
          { role: 'resetZoom' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          ...dev,
        ],
      },
    ]),
  );
}

// ---------- IPC ----------

function trusted(e: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  return url.startsWith(APP_ORIGIN + '/') || (!!DEV_URL && url.startsWith(DEV_URL));
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('Refused: untrusted sender.');
    return fn(...(args as A));
  });
}

function registerIpc() {
  handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open your school folder',
      buttonLabel: 'Open folder',
      defaultPath: settings.last ?? settings.recent[0] ?? app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths[0] ? null : openFolder(r.filePaths[0]);
  });
  // Only folders already in the recent list (the page cannot open arbitrary paths).
  handle('folder:open-recent', (p: string) => {
    const known = settings.recent.find((r) => samePath(r, String(p)));
    return known && disk.isDirectory(known) ? openFolder(known) : null;
  });
  handle('folder:last', () => {
    const candidate = pendingFolder ?? settings.last;
    pendingFolder = null;
    return candidate && disk.isDirectory(candidate) ? openFolder(candidate) : null;
  });
  handle('folder:recent', () => settings.recent);
  handle('folder:forget', (p: string) => {
    settings.recent = settings.recent.filter((r) => !samePath(r, String(p)));
    if (settings.last && samePath(settings.last, String(p))) settings.last = null;
    saveSettings();
    updateJumpList();
    return settings.recent;
  });
  handle('folder:close', () => {
    settings.last = null;
    saveSettings();
  });
  handle('folder:exists', (id: string) => disk.rootExists(id));

  handle('disk:stat', disk.stat);
  handle('disk:list', disk.list);
  handle('disk:mkdir', disk.mkdir);
  handle('disk:create-file', disk.createFile);
  handle('disk:begin-write', disk.beginWrite);
  handle('disk:write-chunk', disk.writeChunk);
  handle('disk:commit-write', disk.commitWrite);
  handle('disk:abort-write', disk.abortWrite);
  handle('disk:trash', disk.trash);
  handle('disk:move', disk.move);
  handle('disk:same-entry', disk.sameEntry);

  handle('shell:open-path', disk.openPath);
  handle('shell:show-in-folder', disk.showInFolder);

  handle('theme:get', () => settings.theme);
  handle('theme:set', (t: ThemeSource) => {
    settings.theme = t === 'light' || t === 'dark' ? t : 'system';
    nativeTheme.themeSource = settings.theme;
    saveSettings();
  });
}

// ---------- protocols ----------

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' blob: data: ${disk.FILE_SCHEME}:`,
  `media-src 'self' blob: ${disk.FILE_SCHEME}:`,
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  // The AI assistant talks to the server the user configures (Ollama on this PC, or a provider).
  `connect-src 'self' blob: data: ${disk.FILE_SCHEME}: http: https:`,
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
].join('; ');

function registerProtocols() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname);
    const full = path.resolve(DIST, '.' + (rel === '/' ? '/index.html' : rel));
    if (url.host !== 'notetoo' || !full.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    try {
      const res = await net.fetch(pathToFileURL(full).toString());
      if (!full.endsWith('.html')) return res;
      const headers = new Headers(res.headers);
      headers.set('content-security-policy', CSP);
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  protocol.handle(disk.FILE_SCHEME, disk.serveFile);
}

function hardenSessions() {
  // Only what the app uses: copying AI answers, and full screen for videos.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));
  app.on('web-contents-created', (_e, wc) => {
    const external = (url: string) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    };
    // Links in notes and AI answers open in the default browser; nothing opens inside the app.
    wc.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (url.startsWith(APP_ORIGIN + '/') || (DEV_URL && url.startsWith(DEV_URL))) return;
      e.preventDefault();
      external(url);
    });
  });
}

// ---------- startup ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const dir = folderFromArgs(argv);
    if (dir) {
      rememberFolder(dir);
      win.webContents.send('app:open-folder-request', path.resolve(dir));
    }
  });

  void app.whenReady().then(() => {
    settings = loadSettings();
    nativeTheme.themeSource = settings.theme;
    nativeTheme.on('updated', applyThemeToWindow);
    pendingFolder = folderFromArgs(process.argv);
    registerProtocols();
    hardenSessions();
    registerIpc();
    setMenu();
    updateJumpList();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}

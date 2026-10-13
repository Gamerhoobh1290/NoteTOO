// App-wide state (in memory only) and the user-facing file operations.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { desktop, type RootInfo } from '../desktop/bridge';
import { createFs, isAccessError, isFsSupported, isNotFound, pickRootDirectory, type Entry, type Fs } from '../fs/fsService';
import { createNativeRoot } from '../fs/nativeFs';
import { SECTIONS, type Section, baseName, isInside, joinPath, parentPath, remapPath, splitPath, validateName } from '../fs/paths';
import { NARROW, choiceDialog, confirmDialog, errorMessage, promptDialog, toast } from '../lib/ui';
import { flushAllDocs } from './useDiskDoc';

export type View =
  | { kind: 'home' }
  | { kind: 'subject'; subject: string }
  | { kind: 'file'; path: string }
  | { kind: 'notes'; subject: string }
  | { kind: 'organize' };

export type SortKey = 'name' | 'date' | 'type';
/** 'starting': the desktop app is reopening the last folder. */
export type Phase = 'unsupported' | 'starting' | 'closed' | 'open' | 'lost';

/** Desktop app: deleting moves to the Recycle Bin. In the browser it is permanent. */
function deleteOutcome(plural: boolean): string {
  const [its, it] = plural ? ['their', 'them'] : ['its', 'it'];
  return desktop
    ? `moved to the Recycle Bin, together with ${its} annotations. You can restore ${it} from there.`
    : `permanently deleted from your folder, together with ${its} annotations. This cannot be undone from NoteTOO.`;
}

export interface Panels {
  sidebar: boolean;
  annotations: boolean;
  scratchpad: boolean;
  ai: boolean;
}

/** Tree expansion key of a section node (sections may not exist as folders yet). */
export const sectionKey = (subject: string, section: Section) => `§${subject}/${section}`;

function remapKey(key: string, from: string, to: string): string {
  return key.startsWith('§') ? '§' + remapPath(key.slice(1), from, to) : remapPath(key, from, to);
}

function useAppState() {
  const [phase, setPhase] = useState<Phase>(() => (desktop ? 'starting' : isFsSupported() ? 'closed' : 'unsupported'));
  const [recent, setRecent] = useState<string[]>([]);
  const [fs, setFs] = useState<Fs | null>(null);
  const [dirs, setDirs] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>({ kind: 'home' });
  const [sort, setSort] = useState<SortKey>('name');
  const [panels, setPanels] = useState<Panels>(() => ({
    sidebar: true,
    annotations: !window.matchMedia(NARROW).matches,
    scratchpad: false,
    ai: false,
  }));
  const [query, setQuery] = useState('');
  const [filterSubject, setFilterSubject] = useState('');
  const [filterSection, setFilterSection] = useState<Section | ''>('');
  const [index, setIndex] = useState<Entry[] | null>(null);
  const [rev, setRev] = useState(0);
  const [selection, setSelection] = useState<string[]>([]);

  const fsRef = useRef<Fs | null>(null);
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const indexPromise = useRef<Promise<Entry[]> | null>(null);

  const loadDir = useCallback(async (path: string) => {
    const f = fsRef.current;
    if (!f) return;
    try {
      const entries = await f.list(path);
      if (fsRef.current === f) setDirs((d) => ({ ...d, [path]: entries }));
    } catch (e) {
      if (isNotFound(e) || (e as DOMException).name === 'TypeMismatchError') {
        setDirs((d) => {
          const next = { ...d };
          delete next[path];
          return next;
        });
      } else if (!isAccessError(e)) {
        toast(`Could not read "${path || f.rootName}": ${errorMessage(e)}`, 'error');
      }
    }
  }, []);

  /** Re-reads every loaded folder and invalidates derived data. */
  const refresh = useCallback(async () => {
    indexPromise.current = null;
    setIndex(null);
    await Promise.all(Object.keys(dirsRef.current).map(loadDir));
    setRev((r) => r + 1);
  }, [loadDir]);

  /** Full name index (files and folders) for search and pickers; built on demand. */
  const ensureIndex = useCallback(async (): Promise<Entry[]> => {
    const f = fsRef.current;
    if (!f) return [];
    if (!indexPromise.current) {
      const p = f.walk('', { dirs: true });
      indexPromise.current = p;
      p.then((idx) => indexPromise.current === p && setIndex(idx)).catch((e) => {
        if (indexPromise.current === p) indexPromise.current = null;
        if (!isAccessError(e)) toast(`Could not scan the folder: ${errorMessage(e)}`, 'error');
      });
    }
    return indexPromise.current;
  }, []);

  const start = useCallback(
    async (handle: FileSystemDirectoryHandle) => {
      const f = createFs(handle, () => setPhase('lost'));
      fsRef.current = f;
      indexPromise.current = null;
      setFs(f);
      setDirs({});
      setExpanded({});
      setIndex(null);
      setView({ kind: 'home' });
      setPhase('open');
      // Desktop app: the main process lists the folder just opened first.
      if (desktop) void desktop.recentFolders().then(setRecent);
      await loadDir('');
    },
    [loadDir],
  );

  const openFolder = useCallback(async () => {
    try {
      const handle = await pickRootDirectory();
      await flushAllDocs();
      await start(handle);
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') toast(errorMessage(e), 'error');
    }
  }, [start]);

  /** Desktop app: opens a folder from the recent list (start screen, taskbar jump list). */
  const openRecent = useCallback(
    async (path: string) => {
      if (!desktop) return;
      try {
        await flushAllDocs();
        const info = await desktop.openRecent(path);
        if (info) return await start(createNativeRoot(desktop, info));
        toast(`"${path}" no longer exists. It was removed from the recent folders.`, 'error');
        setRecent(await desktop.forgetRecent(path));
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    },
    [start],
  );

  const forgetRecent = useCallback(async (path: string) => {
    if (desktop) setRecent(await desktop.forgetRecent(path));
  }, []);

  const openSample = useCallback(async () => {
    if (!import.meta.env.DEV) return;
    try {
      const { loadSampleRoot } = await import('../fs/devSample');
      await start(await loadSampleRoot());
    } catch (e) {
      toast(`Sample folder: ${errorMessage(e)}`, 'error');
    }
  }, [start]);

  const reconnect = useCallback(async () => {
    const f = fsRef.current;
    if (!f) return;
    try {
      if (await f.requestPermission()) {
        setPhase('open');
        await refresh();
      } else {
        toast(desktop ? 'The folder is still not available.' : 'Permission was not granted.', 'error');
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }, [refresh]);

  const closeFolder = useCallback(async () => {
    await flushAllDocs();
    fsRef.current = null;
    setFs(null);
    setDirs({});
    setIndex(null);
    setPhase(isFsSupported() ? 'closed' : 'unsupported');
    if (desktop) {
      await desktop.closeFolder();
      setRecent(await desktop.recentFolders());
    }
  }, []);

  // Desktop app: reopen the folder from last time (or one passed on the command line).
  const launched = useRef(false);
  useEffect(() => {
    if (!desktop || launched.current) return;
    launched.current = true;
    const bridge = desktop;
    void (async () => {
      let last: RootInfo | null = null;
      try {
        last = await bridge.lastFolder();
        setRecent(await bridge.recentFolders());
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
      if (last) await start(createNativeRoot(bridge, last));
      else setPhase('closed');
    })();
  }, [start]);

  // Desktop app: a folder picked from the taskbar jump list while NoteTOO is running.
  const openRecentRef = useRef(openRecent);
  openRecentRef.current = openRecent;
  useEffect(() => desktop?.onOpenFolderRequest((path) => void openRecentRef.current(path)), []);

  // The window/taskbar title names the open folder.
  const rootName = fs?.rootName;
  useEffect(() => {
    document.title = rootName && phase !== 'closed' ? `${rootName} – NoteTOO` : 'NoteTOO';
  }, [rootName, phase]);

  // Re-scan when the window regains focus (sync or manual edits may have changed things).
  useEffect(() => {
    if (phase !== 'open') return;
    let last = 0;
    const onFocus = async () => {
      const f = fsRef.current;
      if (!f || Date.now() - last < 1500) return;
      last = Date.now();
      try {
        if (!(await f.hasPermission())) return setPhase('lost');
      } catch {
        return setPhase('lost');
      }
      await refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [phase, refresh]);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  /** Expands/collapses a tree node; loads the folder at `loadPath` when opening. */
  const toggle = useCallback(
    (key: string, open?: boolean, loadPath?: string) => {
      const next = open ?? !expandedRef.current[key];
      expandedRef.current = { ...expandedRef.current, [key]: next };
      setExpanded(expandedRef.current);
      if (next && loadPath !== undefined) void loadDir(loadPath);
    },
    [loadDir],
  );

  const remapEverywhere = useCallback((from: string, to: string) => {
    setView((v) =>
      v.kind === 'file'
        ? { ...v, path: remapPath(v.path, from, to) }
        : v.kind === 'subject' || v.kind === 'notes'
          ? { ...v, subject: remapPath(v.subject, from, to) }
          : v,
    );
    setExpanded((x) => Object.fromEntries(Object.entries(x).map(([k, val]) => [remapKey(k, from, to), val])));
    setFilterSubject((s) => (s ? remapPath(s, from, to) : s));
    setSelection((sel) => sel.map((p) => remapPath(p, from, to)));
    // Keep loaded listings under their new paths so expanded folders stay filled; refresh re-reads them.
    dirsRef.current = Object.fromEntries(
      Object.entries(dirsRef.current).map(([k, list]) => [
        remapPath(k, from, to),
        list.map((e) => ({ ...e, path: remapPath(e.path, from, to) })),
      ]),
    );
    setDirs(dirsRef.current);
  }, []);

  /** Runs a file operation, reports errors, then re-scans (`after` runs before the re-scan). */
  const run = useCallback(
    async <T,>(label: string, op: (f: Fs) => Promise<T>, after?: (result: T) => void): Promise<T | undefined> => {
      const f = fsRef.current;
      if (!f) return;
      try {
        const result = await op(f);
        after?.(result);
        return result;
      } catch (e) {
        if (!isAccessError(e)) toast(`${label}: ${errorMessage(e)}`, 'error');
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const createSubject = useCallback(async () => {
    const name = await promptDialog({ title: 'New subject', label: 'Subject name', confirmLabel: 'Create', validate: validateName });
    if (!name) return;
    const created = await run('Create subject', (f) => f.createSubject(name.trim()));
    if (created) {
      toggle(created, true, created);
      setView({ kind: 'subject', subject: created });
    }
  }, [run, toggle]);

  const createFolder = useCallback(
    async (parent: string, expandKey?: string) => {
      const name = await promptDialog({ title: 'New folder', label: `Folder name (in ${parent})`, confirmLabel: 'Create', validate: validateName });
      if (!name) return;
      const created = await run('Create folder', (f) => f.createFolder(parent, name.trim()));
      if (created) {
        toggle(expandKey ?? parent, true, parent);
        toggle(created, true, created);
      }
    },
    [run, toggle],
  );

  const addFiles = useCallback(
    async (dir: string, files: File[]) => {
      if (!files.length) return;
      const res = await run('Add files', (f) => f.copyIn(dir, files));
      if (!res) return;
      const renamed = res.filter((r) => r.original !== r.saved);
      toast(
        `Added ${res.length} file${res.length > 1 ? 's' : ''} to ${dir}.` +
          (renamed.length ? ` Renamed to avoid overwriting: ${renamed.map((r) => r.saved).join(', ')}` : ''),
      );
      void loadDir(dir);
    },
    [run, loadDir],
  );

  const renameEntry = useCallback(
    async (entry: Pick<Entry, 'path' | 'kind'>) => {
      const old = baseName(entry.path);
      const dot = old.lastIndexOf('.');
      const name = await promptDialog({
        title: `Rename ${entry.kind === 'dir' ? 'folder' : 'file'}`,
        label: 'New name',
        initial: old,
        selectEnd: entry.kind === 'file' && dot > 0 ? dot : undefined,
        confirmLabel: 'Rename',
        validate: validateName,
      });
      if (!name || name === old) return;
      await flushAllDocs();
      await run('Rename', (f) => f.rename(entry.path, name.trim()), (to) => remapEverywhere(entry.path, to));
    },
    [run, remapEverywhere],
  );

  /** Moves files back to where they were (the Undo of a move). */
  const undoMoves = useCallback(
    async (moved: { from: string; to: string }[]) => {
      await flushAllDocs();
      await run('Undo', async (f) => {
        for (const m of [...moved].reverse()) {
          let back = await f.move(m.to, parentPath(m.from));
          if (baseName(back) !== baseName(m.from) && !(await f.exists(m.from))) back = await f.rename(back, baseName(m.from));
          remapEverywhere(m.to, back);
        }
      });
      toast(moved.length === 1 ? `Moved "${baseName(moved[0].from)}" back.` : `Moved ${moved.length} files back.`);
    },
    [run, remapEverywhere],
  );

  /** Moves files/folders into `destDir` (with their annotations), then offers Undo. */
  const moveEntries = useCallback(
    async (paths: string[], destDir: string) => {
      const todo = paths.filter((p) => parentPath(p) !== destDir && !isInside(destDir, p));
      if (!todo.length) return;
      await flushAllDocs();
      const moved: { from: string; to: string }[] = [];
      await run('Move', async (f) => {
        for (const p of todo) {
          const to = await f.move(p, destDir);
          moved.push({ from: p, to });
          remapEverywhere(p, to);
        }
      });
      setSelection([]);
      if (!moved.length) return;
      const renamed = moved.filter((m) => baseName(m.from) !== baseName(m.to));
      const what = moved.length === 1 ? `"${baseName(moved[0].from)}"` : `${moved.length} files`;
      toast(
        `Moved ${what} to ${destDir.split('/').join(' › ')}.` +
          (renamed.length ? ` Renamed to avoid overwriting: ${renamed.map((m) => baseName(m.to)).join(', ')}.` : ''),
        'info',
        { label: 'Undo', run: () => undoMoves(moved) },
      );
    },
    [run, remapEverywhere, undoMoves],
  );

  /**
   * Moves and/or renames files to exact new paths (creating folders as needed), with their
   * annotations, then offers one Undo for the whole batch. Used by the AI organizer.
   */
  const relocateFiles = useCallback(
    async (changes: { from: string; to: string }[]) => {
      if (!changes.length) return 0;
      await flushAllDocs();
      const moved: { from: string; to: string }[] = [];
      const failed: string[] = [];
      await run('Organize', async (f) => {
        for (const c of changes) {
          try {
            let at = c.from;
            if (parentPath(c.from) !== parentPath(c.to)) {
              await f.mkdir(parentPath(c.to));
              at = await f.move(c.from, parentPath(c.to));
            }
            if (baseName(at) !== baseName(c.to)) {
              try {
                at = await f.rename(at, baseName(c.to));
              } catch {
                // Name taken meanwhile: keep the file where it is, under its current name.
              }
            }
            if (at !== c.from) {
              moved.push({ from: c.from, to: at });
              remapEverywhere(c.from, at);
            }
          } catch (e) {
            if (isAccessError(e)) throw e;
            failed.push(`${baseName(c.from)} (${errorMessage(e)})`);
          }
        }
      });
      if (failed.length) toast(`Could not reorganize: ${failed.join(', ')}`, 'error');
      if (moved.length) {
        // Longer than usual: the user may want to look around before deciding to undo a batch.
        toast(`Reorganized ${moved.length} file${moved.length > 1 ? 's' : ''}.`, 'info', { label: 'Undo all', run: () => undoMoves(moved) }, 20000);
      }
      return moved.length;
    },
    [run, remapEverywhere, undoMoves],
  );

  /** Lets the user pick a destination folder (keyboard-friendly alternative to drag and drop). */
  const moveEntryPrompt = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      const all = await ensureIndex();
      const subjects = (dirsRef.current[''] ?? []).filter((e) => e.kind === 'dir').map((e) => e.name);
      const targets = new Set<string>();
      for (const s of subjects) for (const sec of SECTIONS) targets.add(joinPath(s, sec));
      for (const e of all) if (e.kind === 'dir' && splitPath(e.path).length >= 2) targets.add(e.path);
      const options = [...targets]
        .filter((t) => !paths.every((p) => parentPath(p) === t) && !paths.some((p) => isInside(t, p)))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((t) => ({ value: t, label: t.split('/').join(' › ') }));
      const title = paths.length === 1 ? `Move "${baseName(paths[0])}"` : `Move ${paths.length} files`;
      const dest = await choiceDialog({ title, label: 'Destination folder', options, confirmLabel: 'Move' });
      if (dest) await moveEntries(paths, dest);
    },
    [ensureIndex, moveEntries],
  );

  /** Deletes several selected files after one confirmation that names them. */
  const deleteFiles = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      const names = paths.map((p) => `"${baseName(p)}"`);
      const ok = await confirmDialog({
        title: `Delete ${paths.length} file${paths.length > 1 ? 's' : ''}?`,
        message: `${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''} will be ${deleteOutcome(paths.length > 1)}`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await flushAllDocs();
      let deleted = 0;
      await run('Delete', async (f) => {
        for (const p of paths) {
          await f.remove(p);
          deleted++;
        }
      });
      setSelection([]);
      setView((v) => (v.kind === 'file' && paths.includes(v.path) ? { kind: 'subject', subject: splitPath(v.path)[0] } : v));
      if (deleted) toast(`Deleted ${deleted} file${deleted > 1 ? 's' : ''}.`);
    },
    [run],
  );

  // ----- multi-select (files only; in memory) -----
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const anchor = useRef<string | null>(null);
  /** toggle: Ctrl/Cmd-click · range: Shift-click within `order` (the list's paths, top to bottom) · clear */
  const select = useCallback((mode: 'toggle' | 'range' | 'clear', path?: string, order: string[] = []) => {
    const cur = selectionRef.current;
    if (mode === 'clear' || !path) return setSelection([]);
    if (mode === 'toggle') {
      anchor.current = path;
      return setSelection(cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]);
    }
    const from = anchor.current && order.includes(anchor.current) ? anchor.current : path;
    const [i, j] = [order.indexOf(from), order.indexOf(path)].sort((a, b) => a - b);
    setSelection([...new Set([...cur, ...order.slice(i, j + 1)])]);
  }, []);
  /** What a drag of `path` carries: the whole selection if the row is part of it. */
  const dragPathsFor = useCallback((path: string) => (selectionRef.current.includes(path) ? selectionRef.current : [path]), []);

  const deleteEntry = useCallback(
    async (entry: Pick<Entry, 'path' | 'kind'>) => {
      const f = fsRef.current;
      if (!f) return;
      let detail = '';
      if (entry.kind === 'dir') {
        try {
          const n = (await f.walk(entry.path)).length;
          detail = n ? ` and the ${n} file${n > 1 ? 's' : ''} inside it` : ' (it is empty)';
        } catch {
          /* counted best-effort */
        }
      }
      const ok = await confirmDialog({
        title: `Delete ${entry.kind === 'dir' ? 'folder' : 'file'}?`,
        message: `"${entry.path}"${detail} will be ${deleteOutcome(false)}`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await flushAllDocs();
      const done = await run('Delete', (fs) => fs.remove(entry.path).then(() => true));
      if (!done) return;
      setView((v) => {
        const p = v.kind === 'file' ? v.path : v.kind === 'home' || v.kind === 'organize' ? '' : v.subject;
        if (!p || !(p === entry.path || p.startsWith(entry.path + '/'))) return v;
        const subject = splitPath(entry.path)[0];
        return splitPath(entry.path).length > 1 ? { kind: 'subject', subject } : { kind: 'home' };
      });
      setSelection((sel) => sel.filter((p) => !isInside(p, entry.path)));
      toast(`Deleted "${baseName(entry.path)}".`);
    },
    [run],
  );

  /** Desktop app: hands a file to its Windows program, or a folder to File Explorer. */
  const openInWindows = useCallback(async (path: string) => {
    const err = await fsRef.current?.desktop?.openPath(path);
    if (err) toast(`Could not open "${baseName(path) || fsRef.current?.rootName}": ${err}`, 'error');
  }, []);
  /** Desktop app: opens File Explorer with the item selected. */
  const showInExplorer = useCallback((path: string) => {
    fsRef.current?.desktop?.showInFolder(path).catch((e) => toast(errorMessage(e), 'error'));
  }, []);

  return {
    phase, fs, dirs, expanded, view, sort, panels, query, filterSubject, filterSection, index, rev,
    setView, setSort, setQuery, setFilterSubject, setFilterSection,
    setPanels: useCallback((p: Partial<Panels>) => setPanels((x) => ({ ...x, ...p })), []),
    loadDir, refresh, ensureIndex, toggle,
    openFolder, openSample, reconnect, closeFolder, recent, openRecent, forgetRecent,
    createSubject, createFolder, addFiles, renameEntry, moveEntries, moveEntryPrompt, deleteEntry, deleteFiles, relocateFiles,
    selection, select, dragPathsFor, openInWindows, showInExplorer,
  };
}

export type App = ReturnType<typeof useAppState>;
const AppContext = createContext<App | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  return <AppContext.Provider value={useAppState()}>{children}</AppContext.Provider>;
}

export function useApp(): App {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside AppProvider');
  return ctx;
}

/** Sorts entries: folders first, then by the chosen key. */
export function sortEntries(entries: Entry[], sort: SortKey): Entry[] {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const ext = (n: string) => (n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : '');
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    if (sort === 'date' && a.kind === 'file') return b.lastModified - a.lastModified || coll.compare(a.name, b.name);
    if (sort === 'type' && a.kind === 'file') return coll.compare(ext(a.name), ext(b.name)) || coll.compare(a.name, b.name);
    return coll.compare(a.name, b.name);
  });
}

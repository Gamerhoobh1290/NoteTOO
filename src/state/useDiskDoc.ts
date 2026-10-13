// A document backed by one file on disk: load, debounced auto-save, conflict detection.
// Used for annotation sidecars and markdown notes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { desktop } from '../desktop/bridge';
import { ConflictError, type Fs } from '../fs/fsService';
import { baseName, joinPath, parentPath } from '../fs/paths';
import { errorMessage, toast } from '../lib/ui';

export type SaveStatus = 'loading' | 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

export interface Loaded<T> {
  value: T;
  /** null when the file does not exist yet */
  lastModified: number | null;
  notice?: string;
}

interface Session<T> {
  fs: Fs;
  path: string;
  value: T | null;
  lastModified: number | null;
  dirty: boolean;
  writing: boolean;
  conflict: boolean;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  chain: Promise<void>;
}

const SAVE_DELAY = 700;
const dirtySessions = new Set<Session<unknown>>();
const flushers = new Set<() => Promise<void>>();

/** Writes all pending edits now (call before renaming/moving/deleting files). */
export async function flushAllDocs(): Promise<void> {
  await Promise.all([...flushers].map((f) => f()));
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (dirtySessions.size) e.preventDefault();
  });
}

// Desktop app: closing the window first saves everything (including documents just left, whose
// last write may still be running), then tells the main process whether anything is left unsaved.
desktop?.onCloseRequest(async () => {
  await flushAllDocs();
  await Promise.all([...dirtySessions].map((s) => s.chain));
  return dirtySessions.size === 0;
});

function conflictCopyName(name: string): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}h${p2(d.getMinutes())}`;
  const i = name.lastIndexOf('.');
  return i > 0 ? `${name.slice(0, i)} (unsaved ${stamp})${name.slice(i)}` : `${name} (unsaved ${stamp})`;
}

export function useDiskDoc<T>(opts: {
  fs: Fs;
  path: string;
  load: () => Promise<Loaded<T>>;
  serialize: (value: T) => string;
}) {
  const { fs, path } = opts;
  const [value, setValue] = useState<T | null>(null);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Session<T> | null>(null);
  const loadRef = useRef(opts.load);
  const serializeRef = useRef(opts.serialize);
  loadRef.current = opts.load;
  serializeRef.current = opts.serialize;

  const loadInto = useCallback(async (s: Session<T>) => {
    setStatus('loading');
    try {
      const r = await loadRef.current();
      if (r.notice) toast(r.notice); // e.g. a broken file was backed up: report it even if the view moved on
      if (s.closed) return;
      Object.assign(s, { value: r.value, lastModified: r.lastModified, dirty: false, conflict: false });
      dirtySessions.delete(s as Session<unknown>);
      setValue(r.value);
      setError(null);
      setStatus('idle');
    } catch (e) {
      if (s.closed) return;
      setError(errorMessage(e));
      setStatus('error');
    }
  }, []);

  /** Last resort when a closed document cannot be saved: keep the text next to the original. */
  const saveCopy = useCallback(async (s: Session<T>, text: string) => {
    const dir = parentPath(s.path);
    try {
      const name = await s.fs.uniqueName(dir, conflictCopyName(baseName(s.path)));
      await s.fs.writeText(joinPath(dir, name), text);
      dirtySessions.delete(s as Session<unknown>);
      toast(`"${baseName(s.path)}" changed on disk, so your edits were saved as "${name}".`, 'error');
    } catch (e) {
      toast(`Could not save "${baseName(s.path)}": ${errorMessage(e)}`, 'error');
    }
  }, []);

  const write = useCallback(
    async (s: Session<T>) => {
      if (!s.dirty || s.value === null) return;
      if (s.conflict && !s.closed) return;
      const text = serializeRef.current(s.value);
      if (s.conflict) return saveCopy(s, text);
      s.dirty = false;
      s.writing = true;
      if (!s.closed) setStatus('saving');
      try {
        s.lastModified = await s.fs.writeText(s.path, text, { expected: s.lastModified });
        if (!s.dirty) dirtySessions.delete(s as Session<unknown>);
        if (!s.closed) setStatus(s.dirty ? 'pending' : 'saved');
      } catch (e) {
        s.dirty = true;
        if (e instanceof ConflictError) s.conflict = true;
        if (s.closed) return saveCopy(s, text);
        setError(errorMessage(e));
        setStatus(e instanceof ConflictError ? 'conflict' : 'error');
      } finally {
        s.writing = false;
      }
    },
    [saveCopy],
  );

  const enqueue = useCallback(
    (s: Session<T>) => {
      clearTimeout(s.timer);
      s.chain = s.chain.then(() => write(s));
      return s.chain;
    },
    [write],
  );

  useEffect(() => {
    const s: Session<T> = {
      fs, path, value: null, lastModified: null, dirty: false, writing: false, conflict: false, closed: false,
      chain: Promise.resolve(),
    };
    session.current = s;
    setValue(null);
    setError(null);
    void loadInto(s);
    const flush = () => (s.dirty ? enqueue(s) : s.chain);
    flushers.add(flush);

    // Pick up changes made outside the app (e.g. drive sync) when nothing is pending.
    const onFocus = async () => {
      if (s.dirty || s.writing || s.conflict || s.value === null) return;
      try {
        const lm = (await s.fs.stat(s.path))?.lastModified ?? null;
        if (!s.closed && !s.dirty && !s.writing && lm !== s.lastModified) void loadInto(s);
      } catch {
        /* reported by the app's access handling */
      }
    };
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('focus', onFocus);
      flushers.delete(flush);
      s.closed = true;
      if (s.dirty) void enqueue(s);
    };
  }, [fs, path, loadInto, enqueue]);

  const update = useCallback((fn: (v: T) => T) => {
    const s = session.current;
    if (!s || s.value === null) return;
    s.value = fn(s.value);
    s.dirty = true;
    dirtySessions.add(s as Session<unknown>);
    setValue(s.value);
    if (s.conflict) return;
    setStatus('pending');
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void enqueue(s), SAVE_DELAY);
  }, [enqueue]);

  /** After a conflict: take the disk version, or write ours over it. */
  const resolve = useCallback(
    async (choice: 'reload' | 'overwrite') => {
      const s = session.current;
      if (!s) return;
      if (choice === 'reload') return loadInto(s);
      try {
        s.lastModified = (await s.fs.stat(s.path))?.lastModified ?? null;
        s.conflict = false;
        s.dirty = true;
        await enqueue(s);
      } catch (e) {
        setError(errorMessage(e));
        setStatus('error');
      }
    },
    [loadInto, enqueue],
  );

  const retry = useCallback(() => {
    const s = session.current;
    if (!s) return;
    if (s.value === null) void loadInto(s);
    else void enqueue(s);
  }, [loadInto, enqueue]);

  return { value, status, error, update, resolve, retry };
}

export type DiskDoc<T> = ReturnType<typeof useDiskDoc<T>>;

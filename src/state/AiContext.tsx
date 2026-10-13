// AI assistant state (in memory only): the conversation, the running task, highlight
// suggestions waiting for review, and the organize review. Nothing here touches disk except
// "Save to notes" and applying an organize plan, both on explicit user action.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { AiError, type ChatMessage } from '../ai/client';
import type { AiDoc, ReadOptions } from '../ai/extract';
import { planChanges, type Plan, type Proposal } from '../ai/organize';
import { notesFor, placeOf } from '../ai/place';
import { getAiSettings, isConfigured, type AiSettings } from '../ai/settings';
import * as tasks from '../ai/tasks';
import type { KeyPoint } from '../ai/tasks';
import { inputBudget } from '../ai/text';
import { ConflictError, type Fs } from '../fs/fsService';
import { SCRATCHPAD, baseName, classify, isInside, splitPath } from '../fs/paths';
import { newId, type Rect } from '../fs/sidecar';
import { fileKind, formatSize } from '../lib/fileKinds';
import { confirmDialog, errorMessage, toast } from '../lib/ui';
import { useApp } from './AppContext';
import { flushAllDocs } from './useDiskDoc';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** assistant only */
  status?: 'streaming' | 'done' | 'error' | 'stopped';
  /** heading shown above an answer, e.g. "Summary · ex2.pdf" */
  title?: string;
  /** where "Save to notes" appends the answer */
  notesPath?: string;
  keyPoints?: { path: string; points: (KeyPoint & { id: string })[] };
  /** open AI settings from an error */
  settingsHint?: boolean;
}

export interface Suggestion {
  id: string;
  page: number;
  rect: Rect;
  why: string;
  quote: string;
}

export interface OrganizeState {
  /** '' = whole folder, else a subject */
  scope: string;
  status: 'scanning' | 'review' | 'error';
  progress: string;
  error?: string;
  plan?: Plan;
  /** indexes of plan.changes the user kept checked */
  selected: Set<number>;
  /** user-edited destinations, by change index */
  edits: Record<number, string>;
  skipped: number;
}

interface Busy {
  label: string;
  progress: string;
  ac: AbortController;
}

/** Appends text to a markdown note, never overwriting a concurrent change. */
async function appendToNote(fs: Fs, path: string, text: string) {
  await flushAllDocs();
  for (let attempt = 0; ; attempt++) {
    const cur = await fs.readText(path);
    const body = cur && cur.text.trim() ? `${cur.text.replace(/\s+$/, '')}\n\n${text}\n` : `${text}\n`;
    try {
      await fs.writeText(path, body, { expected: cur?.lastModified ?? null });
      break;
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= 2) throw e;
    }
  }
  // Open note editors reload changes from disk when the window regains focus.
  window.dispatchEvent(new Event('focus'));
}

const MAX_ORGANIZE_FILES = 400;

/** File reading pulls in pdf.js, mammoth and SheetJS: load it on first AI use, not at startup. */
const readForAi = async (file: File, o: ReadOptions) => (await import('../ai/extract')).readForAi(file, o);

function useAiState() {
  const app = useApp();
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [busy, setBusyState] = useState<Busy | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion[]>>({});
  const [focusSuggestion, setFocusSuggestion] = useState<{ path: string; id: string; n: number } | null>(null);
  const [organize, setOrganize] = useState<OrganizeState | null>(null);
  const busyRef = useRef<Busy | null>(null);
  const docCache = useRef<{ key: string; doc: AiDoc } | null>(null);
  const appRef = useRef(app);
  appRef.current = app;

  const setBusy = (b: Busy | null) => {
    busyRef.current = b;
    setBusyState(b);
  };

  const patchMessage = (id: string, p: Partial<AiMessage>) => setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...p } : m)));

  /** Starts a task: checks settings, offers to stop a running one. Returns null to abort. */
  const begin = useCallback(async (label: string): Promise<{ s: AiSettings; ac: AbortController } | null> => {
    const s = getAiSettings();
    if (!isConfigured(s)) {
      setSettingsOpen(true);
      return null;
    }
    const running = busyRef.current;
    if (running) {
      const ok = await confirmDialog({
        title: 'Stop the current AI task?',
        message: `"${running.label}" is still running. Only one AI task runs at a time.`,
        confirmLabel: 'Stop it and continue',
      });
      if (!ok) return null;
      running.ac.abort();
    }
    const ac = new AbortController();
    setBusy({ label, progress: '', ac });
    return { s, ac };
  }, []);

  const end = (ac: AbortController) => {
    if (busyRef.current?.ac === ac) setBusy(null);
  };

  const ctxFor = (s: AiSettings, ac: AbortController, onToken: (t: string) => void = () => {}): tasks.TaskCtx => ({
    s,
    signal: ac.signal,
    onToken,
    progress: (progress) => {
      if (busyRef.current?.ac === ac) setBusy({ ...busyRef.current, progress });
    },
  });

  /** Reads a file for the AI, reusing the last read while the file is unchanged. */
  const docFor = useCallback(async (path: string, signal: AbortSignal): Promise<AiDoc> => {
    const fs = appRef.current.fs!;
    const file = await fs.readFile(path);
    const key = `${path}|${file.lastModified}|${file.size}`;
    if (docCache.current?.key === key) return docCache.current.doc;
    const doc = await readForAi(file, { signal });
    docCache.current = { key, doc };
    return doc;
  }, []);

  /** Runs an answer-producing task as a new assistant message (streamed). */
  const runAnswer = useCallback(
    async (
      label: string,
      msg: Pick<AiMessage, 'title' | 'notesPath'>,
      work: (ctx: tasks.TaskCtx) => Promise<string | { text: string; keyPoints?: AiMessage['keyPoints'] }>,
      userText?: string,
    ) => {
      const started = await begin(label);
      if (!started) return;
      const { s, ac } = started;
      appRef.current.setPanels({ ai: true, scratchpad: false });
      const id = newId();
      setMessages((ms) => [
        ...ms,
        ...(userText ? [{ id: newId(), role: 'user' as const, text: userText }] : []),
        { id, role: 'assistant', text: '', status: 'streaming', ...msg },
      ]);
      try {
        const res = await work(ctxFor(s, ac, (text) => patchMessage(id, { text })));
        const out = typeof res === 'string' ? { text: res } : res;
        patchMessage(id, { ...out, status: 'done' });
      } catch (e) {
        if (ac.signal.aborted) patchMessage(id, { status: 'stopped' });
        else
          patchMessage(id, {
            status: 'error',
            text: e instanceof AiError ? e.message : `Something went wrong: ${errorMessage(e)}`,
            settingsHint: e instanceof AiError && ['unreachable', 'auth', 'model'].includes(e.kind),
          });
      } finally {
        end(ac);
      }
    },
    [begin, docFor],
  );

  const summarize = useCallback(
    (path: string) =>
      runAnswer('Summarize', { title: `Summary · ${baseName(path)}`, notesPath: notesFor(classify(path)?.subject) }, async (ctx) =>
        tasks.summarize(ctx, baseName(path), await docFor(path, ctx.signal)),
      ),
    [runAnswer, docFor],
  );

  const explain = useCallback(
    (path: string, passage?: string) =>
      runAnswer(
        'Explain',
        { title: `${passage ? 'Passage explained' : 'Explanation'} · ${baseName(path)}`, notesPath: notesFor(classify(path)?.subject) },
        async (ctx) => {
          const doc = await docFor(path, ctx.signal);
          return passage ? tasks.explainPassage(ctx, baseName(path), doc, passage) : tasks.explain(ctx, baseName(path), doc);
        },
        passage ? `Explain: “${passage.length > 220 ? passage.slice(0, 220) + '…' : passage}”` : undefined,
      ),
    [runAnswer, docFor],
  );

  const highlight = useCallback(
    (path: string) =>
      runAnswer('Highlight important', { title: `Key points · ${baseName(path)}`, notesPath: notesFor(classify(path)?.subject) }, async (ctx) => {
        const doc = await docFor(path, ctx.signal);
        const points = (await tasks.findHighlights(ctx, baseName(path), doc)).map((p) => ({ ...p, id: newId() }));
        const placed = points.filter((p) => p.rect);
        if (placed.length) {
          setSuggestions((all) => ({
            ...all,
            [path]: placed.map((p) => ({ id: p.id, page: p.page, rect: p.rect!, why: p.why, quote: p.quote })),
          }));
          appRef.current.setPanels({ annotations: true });
        }
        const list = points.map((p) => `- **“${p.quote}”**${p.rect ? ` (p. ${p.page})` : ''}: ${p.why}`).join('\n');
        const intro = placed.length
          ? `Suggested ${placed.length} highlight${placed.length > 1 ? 's' : ''} (purple, dashed). Keep or discard them in the annotations panel.`
          : `Key points of this file:`;
        return { text: `${intro}\n\n${list}`, keyPoints: { path, points } };
      }),
    [runAnswer, docFor],
  );

  const ask = useCallback(
    (question: string) => {
      const place = placeOf(appRef.current.view);
      const history: ChatMessage[] = [
        ...messages.filter((m) => m.status !== 'error' && m.text).map((m) => ({ role: m.role, content: m.text })),
        { role: 'user', content: question },
      ];
      return runAnswer(
        'Answer',
        { notesPath: notesFor(place.subject) },
        async (ctx) => {
          let file: { name: string; doc: AiDoc } | null = null;
          if (place.kind === 'file' && place.path && fileKind(place.label) !== 'other') {
            try {
              file = { name: place.label, doc: await docFor(place.path, ctx.signal) };
            } catch {
              /* answer without the file */
            }
          }
          const where =
            place.kind === 'file' ? `viewing the file "${place.path}"` : place.kind === 'subject' ? `on the page of the subject "${place.subject}"` : 'on the home page (list of subjects)';
          return tasks.answer(ctx, history, where, file);
        },
        question,
      );
    },
    [messages, runAnswer, docFor],
  );

  const stop = useCallback(() => busyRef.current?.ac.abort(), []);
  const clear = useCallback(() => {
    busyRef.current?.ac.abort();
    setMessages([]);
  }, []);

  const saveToNotes = useCallback(async (m: AiMessage) => {
    const fs = appRef.current.fs;
    if (!fs || !m.notesPath) return;
    const stamp = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const heading = `## ${m.title ?? 'AI answer'} (${stamp})`;
    try {
      await appendToNote(fs, m.notesPath, `${heading}\n\n${m.text.trim()}`);
      toast(`Saved to ${m.notesPath === SCRATCHPAD ? 'the scratchpad' : m.notesPath}.`, 'info', {
        label: 'Open',
        run: () => {
          const subject = splitPath(m.notesPath!).length > 1 ? splitPath(m.notesPath!)[0] : null;
          if (subject) appRef.current.setView({ kind: 'notes', subject });
          else appRef.current.setPanels({ scratchpad: true, ai: false });
        },
      });
    } catch (e) {
      toast(`Could not save to notes: ${errorMessage(e)}`, 'error');
    }
  }, []);

  // ----- highlight suggestions -----
  const resolveSuggestion = useCallback((path: string, id: string) => {
    setSuggestions((all) => {
      const left = (all[path] ?? []).filter((x) => x.id !== id);
      const next = { ...all, [path]: left };
      if (!left.length) delete next[path];
      return next;
    });
  }, []);
  const clearSuggestions = useCallback((path: string) => {
    setSuggestions((all) => {
      const next = { ...all };
      delete next[path];
      return next;
    });
  }, []);
  const showSuggestion = useCallback((path: string, id: string) => {
    setFocusSuggestion((f) => ({ path, id, n: (f?.n ?? 0) + 1 }));
  }, []);

  // ----- organize -----
  const startOrganize = useCallback(
    async (scope: string) => {
      const started = await begin(scope ? `Organize ${scope}` : 'Organize everything');
      if (!started) return;
      const { s, ac } = started;
      const a = appRef.current;
      const fs = a.fs!;
      a.setView({ kind: 'organize' });
      const st: OrganizeState = { scope, status: 'scanning', progress: 'Listing files…', selected: new Set(), edits: {}, skipped: 0 };
      setOrganize(st);
      const progress = (p: string) => {
        setOrganize((o) => (o && o.scope === scope ? { ...o, progress: p } : o));
        if (busyRef.current?.ac === ac) setBusy({ ...busyRef.current, progress: p });
      };
      try {
        await a.refresh();
        const all = await a.ensureIndex();
        const inScope = all.filter((e) => e.kind === 'file' && (!scope || isInside(e.path, scope)));
        const files = inScope.slice(0, MAX_ORGANIZE_FILES);
        if (!files.length) throw new AiError(scope ? `"${scope}" has no files to organize.` : 'There are no files to organize.');
        const folders = all
          .filter((e) => e.kind === 'dir')
          .map((e) => e.path)
          .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
          .slice(0, 400);

        const cards: tasks.FileCard[] = [];
        for (const [i, f] of files.entries()) {
          ac.signal.throwIfAborted();
          progress(`Reading files ${i + 1}/${files.length}…`);
          let excerpt = '';
          try {
            const doc = await readForAi(await fs.readFile(f.path), { maxChars: 1200, scanPages: 1, signal: ac.signal });
            if (doc.kind === 'text') excerpt = doc.pages.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
            else if (doc.kind === 'image' && s.visionModel) {
              progress(`Looking at ${baseName(f.path)} (${i + 1}/${files.length})…`);
              excerpt = `[image] ${await tasks.describeImage(s, doc.images, ac.signal)}`;
            }
          } catch (e) {
            if (ac.signal.aborted) throw e;
          }
          cards.push({ id: i + 1, path: f.path, size: formatSize(f.size), excerpt: excerpt.replace(/\|/g, '/') });
        }

        // Batch the cards so each request fits the model's context.
        const room = inputBudget(s.contextTokens) - folders.join('\n').length - 2500;
        const per = Math.max(1500, room);
        const batches: tasks.FileCard[][] = [[]];
        let used = 0;
        for (const c of cards) {
          const len = c.path.length + c.excerpt.length + 30;
          if (used + len > per && batches[batches.length - 1].length) {
            batches.push([]);
            used = 0;
          }
          batches[batches.length - 1].push(c);
          used += len;
        }
        const proposals: Proposal[] = [];
        const ctx = ctxFor(s, ac);
        for (const b of batches) {
          const label = batches.length > 1 ? `Thinking about files ${b[0].id}–${b[b.length - 1].id} of ${cards.length}…` : 'Thinking…';
          progress(label);
          proposals.push(
            ...(await tasks.proposeOrganization(
              { ...ctx, progress },
              { folders, cards: b, scope: scope ? `only the subject "${scope}"` : 'the whole folder', batch: label },
            )),
          );
        }
        const plan = planChanges(new Map(cards.map((c) => [c.id, c.path])), proposals, all);
        setOrganize({
          ...st,
          status: 'review',
          progress: '',
          plan,
          selected: new Set(plan.changes.map((_, i) => i)),
          skipped: inScope.length - files.length,
        });
      } catch (e) {
        setOrganize(
          ac.signal.aborted
            ? null
            : { ...st, status: 'error', progress: '', error: e instanceof AiError ? e.message : `Something went wrong: ${errorMessage(e)}` },
        );
        if (ac.signal.aborted) appRef.current.setView(scope ? { kind: 'subject', subject: scope } : { kind: 'home' });
      } finally {
        end(ac);
      }
    },
    [begin],
  );

  const applyOrganize = useCallback(async () => {
    const o = organize;
    if (!o?.plan) return;
    const changes = o.plan.changes
      .map((c, i) => ({ from: c.from, to: (o.edits[i] ?? c.to).trim() }))
      .filter((_, i) => o.selected.has(i));
    const n = await appRef.current.relocateFiles(changes);
    if (n || !changes.length) {
      setOrganize(null);
      appRef.current.setView(o.scope ? { kind: 'subject', subject: o.scope } : { kind: 'home' });
    }
  }, [organize]);

  const closeOrganize = useCallback(() => {
    const o = organize;
    if (o?.status === 'scanning') busyRef.current?.ac.abort();
    setOrganize(null);
    appRef.current.setView(o?.scope ? { kind: 'subject', subject: o.scope } : { kind: 'home' });
  }, [organize]);

  return {
    messages, busy, settingsOpen, setSettingsOpen,
    summarize, explain, highlight, ask, stop, clear, saveToNotes,
    suggestions, resolveSuggestion, clearSuggestions, focusSuggestion, showSuggestion,
    organize, setOrganize, startOrganize, applyOrganize, closeOrganize,
  };
}

export type Ai = ReturnType<typeof useAiState>;
const AiContext = createContext<Ai | null>(null);

export function AiProvider({ children }: { children: ReactNode }) {
  return <AiContext.Provider value={useAiState()}>{children}</AiContext.Provider>;
}

export function useAi(): Ai {
  const ctx = useContext(AiContext);
  if (!ctx) throw new Error('useAi outside AiProvider');
  return ctx;
}

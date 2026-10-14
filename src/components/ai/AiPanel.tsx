import { useEffect, useRef, useState } from 'react';
import { ArrowUp, BookOpenText, Copy, Highlighter, ListTree, NotebookPen, Settings, Sparkles, Square, Trash2, Wand2, X } from 'lucide-react';
import { SHOW_TARGETS, parseShowLinks } from '../../ai/guide';
import { PRESETS, isConfigured, presetOf, useAiSettings } from '../../ai/settings';
import { SCRATCHPAD } from '../../fs/paths';
import { fileKind } from '../../lib/fileKinds';
import { revealText, spotlight } from '../../lib/reveal';
import { toast } from '../../lib/ui';
import { useApp } from '../../state/AppContext';
import { placeOf } from '../../ai/place';
import { useAi, type AiMessage } from '../../state/AiContext';
import { Spinner, cls } from '../common';
import Markdown from '../Markdown';

const EXAMPLES = ['How do I highlight part of a PDF?', 'How do I add files to a subject?', 'Where are my notes saved?'];

/** Opens the place a "Show me" button points to and outlines the control. */
function useShowMe() {
  const app = useApp();
  return (id: string) => {
    const t = SHOW_TARGETS[id];
    if (!t) return;
    const v = app.view;
    const place = placeOf(v);
    if (t.needs === 'home' && v.kind !== 'home') app.setView({ kind: 'home' });
    if (t.needs === 'subject' && v.kind !== 'subject') {
      const subject = place.subject ?? (app.dirs[''] ?? []).find((e) => e.kind === 'dir')?.path;
      if (!subject) return toast('Create a subject first: it is on the home page.');
      app.setView({ kind: 'subject', subject });
    }
    if (t.needs === 'viewer' && !(v.kind === 'file' && ['pdf', 'image'].includes(fileKind(place.label)))) {
      return toast(`The ${t.label.toLowerCase()} is in the toolbar of an open PDF or image. Open one, then click again.`);
    }
    if (id === 'sidebar' || id === 'search') app.setPanels({ sidebar: true });
    setTimeout(() => {
      if (!spotlight(t.selector)) toast(`Could not find the ${t.label.toLowerCase()} on this screen.`);
    }, 180);
  };
}

export function AiPanel() {
  const app = useApp();
  const ai = useAi();
  const settings = useAiSettings();
  const place = placeOf(app.view);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const close = () => app.setPanels({ ai: false });

  const last = ai.messages[ai.messages.length - 1];
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [last?.text, ai.messages.length]);
  useEffect(() => inputRef.current?.focus(), []);

  const send = () => {
    const q = draft.trim();
    if (!q) return;
    setDraft('');
    void ai.ask(q);
  };

  const kind = place.kind === 'file' ? fileKind(place.label) : null;
  const readable = kind !== null && !['video', 'audio', 'other'].includes(kind);
  const textual = readable && kind !== 'image';

  return (
    <aside
      className="scratchpad ai-panel"
      aria-label="AI assistant"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !ai.busy) close();
      }}
    >
      <div className="ai-head">
        <Sparkles size={17} className="ai-mark" aria-hidden />
        <h2>AI assistant</h2>
        <button className="ai-status" data-tour="ai-settings" title="AI settings" onClick={() => ai.setSettingsOpen(true)}>
          <span className={cls('ai-dot', isConfigured(settings) && 'on')} aria-hidden />
          {isConfigured(settings) ? (
            <span className="ai-status-text">
              {settings.textModel} · {PRESETS[presetOf(settings)].label.replace(' (this PC)', '')}
            </span>
          ) : (
            <span className="ai-status-text">Not set up</span>
          )}
          <Settings size={13} aria-hidden />
        </button>
        <button className="icon-btn small" aria-label="Clear conversation" title="Clear conversation" onClick={ai.clear} disabled={!ai.messages.length}>
          <Trash2 size={14} />
        </button>
        <button className="icon-btn small" aria-label="Close AI panel" title="Close (Esc / Alt+4)" onClick={close}>
          <X size={15} />
        </button>
      </div>

      <div className="ai-context">
        <span className="muted">About:</span> <strong title={place.path ?? place.label}>{place.label}</strong>
      </div>
      <div className="ai-actions" data-tour="ai-actions">
        {place.kind === 'file' && place.path ? (
          <>
            <button className="btn small" disabled={!readable} onClick={() => ai.summarize(place.path!)} title={readable ? 'Summarize this file' : 'The AI cannot read this type of file'}>
              <BookOpenText size={14} /> Summarize
            </button>
            <button className="btn small" disabled={!readable} onClick={() => ai.explain(place.path!)} title={readable ? 'Explain this file' : 'The AI cannot read this type of file'}>
              <Wand2 size={14} /> Explain
            </button>
            <button
              className="btn small"
              disabled={!textual}
              onClick={() => ai.highlight(place.path!)}
              title={textual ? 'Find the most important passages' : 'Highlights need a file with text'}
            >
              <Highlighter size={14} /> Highlight important
            </button>
          </>
        ) : (
          <button className="btn small" onClick={() => ai.startOrganize(place.subject ?? '')}>
            <ListTree size={14} /> {place.subject ? 'Organize this subject' : 'Organize everything'}
          </button>
        )}
      </div>

      <div className="ai-messages" ref={listRef} aria-live="polite">
        {!ai.messages.length && (
          <div className="ai-empty">
            {!isConfigured(settings) ? (
              <>
                <p>Connect a model to start: Ollama on this PC, OpenRouter, or any OpenAI-compatible server.</p>
                <button className="btn primary small" onClick={() => ai.setSettingsOpen(true)}>
                  <Settings size={14} /> Set up AI
                </button>
              </>
            ) : (
              <>
                <p className="muted">
                  Ask about the open file, or about how to use NoteTOO. Select text in a file to explain just that passage.
                </p>
                <div className="ai-examples">
                  {EXAMPLES.map((q) => (
                    <button key={q} className="chip" onClick={() => void ai.ask(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {ai.messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
      </div>

      {ai.busy && (
        <div className="ai-busy" role="status">
          <span className="ai-busy-text">{ai.busy.progress || `${ai.busy.label}…`}</span>
          <button className="btn small" onClick={ai.stop}>
            <Square size={12} /> Stop
          </button>
        </div>
      )}

      <form
        className="ai-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          rows={2}
          placeholder={place.kind === 'file' ? `Ask about ${place.label}…` : 'Ask anything about NoteTOO…'}
          aria-label="Message to the AI"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="icon-btn ai-send" type="submit" aria-label="Send" title="Send (Enter)" disabled={!draft.trim()}>
          <ArrowUp size={17} />
        </button>
      </form>
    </aside>
  );
}

function Message({ m }: { m: AiMessage }) {
  const app = useApp();
  const ai = useAi();
  const showMe = useShowMe();

  if (m.role === 'user') return <div className="ai-msg user">{m.text}</div>;

  const jump = (point: NonNullable<AiMessage['keyPoints']>['points'][number]) => {
    const path = m.keyPoints!.path;
    const v = app.view;
    if (!(v.kind === 'file' && v.path === path)) app.setView({ kind: 'file', path });
    if (point.rect) ai.showSuggestion(path, point.id);
    else setTimeout(() => !revealText(point.quote) && toast('Could not find this passage on screen.'), v.kind === 'file' && v.path === path ? 0 : 600);
  };

  const body = m.keyPoints ? m.text.split('\n\n')[0] : m.text;
  return (
    <div className={cls('ai-msg assistant', m.status === 'error' && 'error')}>
      {m.title && <div className="ai-msg-title">{m.title}</div>}
      {m.status === 'streaming' && !m.text ? (
        <Spinner label="Working…" />
      ) : m.status === 'error' ? (
        <>
          <p>{m.text}</p>
          {m.settingsHint && (
            <button className="btn small" onClick={() => ai.setSettingsOpen(true)}>
              <Settings size={14} /> AI settings
            </button>
          )}
        </>
      ) : (
        parseShowLinks(body).map((p, i) =>
          p.kind === 'text' ? (
            <Markdown key={i} text={p.text} />
          ) : (
            <button key={i} className="btn small show-me" onClick={() => showMe(p.id)}>
              Show me: {SHOW_TARGETS[p.id].label}
            </button>
          ),
        )
      )}
      {m.keyPoints && m.status === 'done' && (
        <ol className="ai-points">
          {m.keyPoints.points.map((p) => (
            <li key={p.id}>
              <button className="ai-point" onClick={() => jump(p)} title="Show in the file">
                <span className="ai-quote">
                  “{p.quote}”{p.rect && <span className="muted"> · p. {p.page}</span>}
                </span>
                <span className="ai-why">{p.why}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {m.status === 'done' && !!m.sources?.length && (
        <p className="ai-sources" title={m.sources.join('\n')}>
          Based on {m.sources.map((s) => `“${s}”`).join(', ')}
        </p>
      )}
      {m.status === 'stopped' && <p className="muted hint">Stopped.</p>}
      {m.status === 'done' && m.text && (
        <div className="ai-msg-actions">
          <button
            className="link-btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(m.text);
                toast('Copied.');
              } catch {
                toast('Could not copy to the clipboard.', 'error');
              }
            }}
          >
            <Copy size={13} /> Copy
          </button>
          {m.notesPath && (
            <button className="link-btn" onClick={() => ai.saveToNotes(m)} title={`Append to ${m.notesPath}`}>
              <NotebookPen size={13} /> Save to {m.notesPath === SCRATCHPAD ? 'scratchpad' : 'notes'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

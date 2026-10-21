import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp, Ban, Bot, BookOpenText, Check, ChevronDown, ChevronRight, CircleDot, Copy, ExternalLink, Highlighter, ListTree, NotebookPen, Settings,
  ShieldCheck, ShieldQuestion, ShieldX, Sparkles, Square, Trash2, Undo2, Wand2, WifiOff, X,
} from 'lucide-react';
import { agentAvailable } from '../../ai/agentClient';
import { costLine, visibleChanges, type AgentView, type TimelineItem } from '../../ai/agentView';
import { SHOW_TARGETS, parseShowLinks } from '../../ai/guide';
import { PRESETS, isConfigured, isLocalNetwork, isProfileReady, presetOf, useAiSettings } from '../../ai/settings';
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
const AGENT_EXAMPLES = [
  'What subjects and files do I have?',
  'Find where SWOT analysis is explained in my courses',
  'Make a revision sheet (Word) from my latest course and my notes',
  'Create a 10-question quiz from my last two lessons',
];

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
        {agentAvailable && (
          <button
            className={cls('chip agent-toggle', ai.agentMode && 'on')}
            aria-pressed={ai.agentMode}
            title={
              ai.agentMode
                ? 'Agent on: requests are done on your PC with your whole school folder (finds and reads files, creates and changes documents). Click to only chat about the open file.'
                : 'Agent off: answers about the open file only. Click to let the AI work with your whole school folder.'
            }
            onClick={() => ai.setAgentMode(!ai.agentMode)}
          >
            <Bot size={13} aria-hidden /> Agent
          </button>
        )}
        <button className="icon-btn small" aria-label="Clear conversation" title="Clear conversation" onClick={ai.clear} disabled={!ai.messages.length}>
          <Trash2 size={14} />
        </button>
        <button className="icon-btn small" aria-label="Close AI panel" title="Close (Esc / Alt+4)" onClick={close}>
          <X size={15} />
        </button>
      </div>

      <div className="ai-context">
        {ai.agentMode && agentAvailable ? (
          <>
            <span className="muted">Works with:</span> <strong>your whole school folder</strong>
            {place.kind !== 'home' && (
              <>
                {' '}
                <span className="muted">· open:</span> <span title={place.path ?? place.label}>{place.label}</span>
              </>
            )}
          </>
        ) : (
          <>
            <span className="muted">About:</span> <strong title={place.path ?? place.label}>{place.label}</strong>
          </>
        )}
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
                  {ai.agentMode && agentAvailable
                    ? 'Ask for anything about your school files: the agent finds and reads them on your PC, creates or changes documents, and shows each step. No need to open the files first.'
                    : 'Ask about the open file, or about how to use NoteTOO. Select text in a file to explain just that passage.'}
                </p>
                <div className="ai-examples">
                  {(ai.agentMode && agentAvailable ? AGENT_EXAMPLES : EXAMPLES).map((q) => (
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

      {ai.agentMode && agentAvailable && isConfigured(settings) && (
        <div className="seg agent-approvals" role="radiogroup" aria-label="Who allows the agent's actions">
          {(
            [
              ['ask', 'Ask me', 'Deleting, big reorganizations and scripts wait for your Allow / Don’t allow.'],
              ['auto', 'Auto', 'A reviewer model allows actions that match your request and blocks the others; it asks you when unsure. Scripts, deleting folders and deleting more than 10 files still ask you. Everything can be undone.'],
            ] as const
          ).map(([mode, label, title]) => (
            <button key={mode} type="button" role="radio" aria-checked={ai.agentApprovals === mode} className={cls(ai.agentApprovals === mode && 'on')} title={title} onClick={() => ai.setAgentApprovals(mode)}>
              {mode === 'auto' ? <ShieldCheck size={12} aria-hidden /> : <ShieldQuestion size={12} aria-hidden />} {label}
            </button>
          ))}
        </div>
      )}

      {ai.agentMode && agentAvailable && isConfigured(settings) && isProfileReady(settings.second) && (
        <div className="seg agent-model" role="radiogroup" aria-label="Model for the agent">
          {(['main', 'second'] as const).map((which) => {
            const m = which === 'main' ? settings : settings.second!;
            const where = isLocalNetwork(m.baseUrl) ? 'on your PC' : 'online';
            return (
              <button
                key={which}
                type="button"
                role="radio"
                aria-checked={ai.agentModel === which}
                className={cls(ai.agentModel === which && 'on')}
                title={`${m.textModel} (${where})${where === 'online' ? ': the passages it reads are sent to this provider' : ': nothing leaves your PC'}`}
                onClick={() => ai.setAgentModel(which)}
              >
                {m.textModel.split('/').pop()} <span className="muted">· {where}</span>
              </button>
            );
          })}
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
          placeholder={
            ai.agentMode && agentAvailable
              ? 'Ask the agent: find, summarize, create, organize…'
              : place.kind === 'file'
                ? `Ask about ${place.label}…`
                : 'Ask anything about NoteTOO…'
          }
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
  if (m.agent) return <AgentMessage m={m} />;

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
      {m.status === 'done' && m.text && <MessageActions m={m} />}
    </div>
  );
}

function MessageActions({ m }: { m: AiMessage }) {
  const ai = useAi();
  return (
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
  );
}

const ACTION_LABEL = { created: 'Created', modified: 'Changed', moved: 'Moved', deleted: 'Deleted', folder: 'New folder' } as const;

function StepIcon({ status }: { status: string }) {
  if (status === 'running' || status === 'in_progress') return <span className="spinner-dot" aria-label="running" />;
  if (status === 'done') return <Check size={13} className="agent-ok" aria-label="done" />;
  if (status === 'declined') return <Ban size={13} className="muted" aria-label="declined" />;
  if (status === 'error') return <X size={13} className="agent-bad" aria-label="failed" />;
  return <CircleDot size={11} className="muted" aria-label="to do" />;
}

/** An agent task: what it does step by step, what it needs approved, what it changed, its answer. */
function AgentMessage({ m }: { m: AiMessage }) {
  const app = useApp();
  const ai = useAi();
  const settings = useAiSettings();
  const v = m.agent as AgentView;
  const running = v.status === 'starting' || v.status === 'running' || v.status === 'waiting';
  const steps = v.timeline.filter((t): t is Extract<TimelineItem, { kind: 'step' }> => t.kind === 'step');
  const [showSteps, setShowSteps] = useState(true);
  const collapsed = !running && !showSteps;
  const files = visibleChanges(v);
  const open = (path: string) => app.setView({ kind: 'file', path });
  const failed = steps.filter((s) => s.status === 'error').length;

  return (
    <div className={cls('ai-msg assistant agent-msg', v.status === 'error' && 'error')}>
      <div className="agent-head">
        <Bot size={14} aria-hidden />
        <span>
          Agent{v.model ? ` · ${v.model}` : ''}
          {v.local !== undefined && <span className="muted">{v.local ? ' · on your PC' : ' · online API'}</span>}
          {v.tools === 'prompted' && <span className="muted" title={v.note}> · tools via prompt</span>}
        </span>
      </div>

      {v.plan.length > 0 && (
        <ol className="agent-plan" aria-label="Plan">
          {v.plan.map((p, i) => (
            <li key={i} className={cls(p.status === 'done' && 'done')}>
              <StepIcon status={p.status === 'pending' ? 'todo' : p.status} /> {p.title}
            </li>
          ))}
        </ol>
      )}

      {steps.length > 0 && (
        <div className="agent-steps">
          {!running && (
            <button className="link-btn agent-steps-toggle" onClick={() => setShowSteps(!showSteps)} aria-expanded={!collapsed}>
              {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />} {steps.length} step{steps.length > 1 ? 's' : ''}
              {failed ? ` · ${failed} failed` : ''}
            </button>
          )}
          {!collapsed && (
            <ul>
              {v.timeline.map((t, i) =>
                t.kind === 'note' ? (
                  <li key={i} className="agent-note">
                    {t.text}
                  </li>
                ) : t.kind === 'review' ? (
                  <li key={i} className={cls('agent-review', t.decision)}>
                    {t.decision === 'allow' ? <ShieldCheck size={13} aria-hidden /> : t.decision === 'block' ? <ShieldX size={13} aria-hidden /> : <ShieldQuestion size={13} aria-hidden />}
                    <span className="agent-step-text">
                      {t.decision === 'allow' ? 'Auto mode allowed' : t.decision === 'block' ? 'Auto mode blocked' : 'Auto mode asks you'}: {t.title.replace(/\?$/, '')}
                      <span className="muted"> — {t.reason}</span>
                    </span>
                  </li>
                ) : (
                  <li key={t.id} className={cls('agent-step', t.status)}>
                    <StepIcon status={t.status} />
                    <span className="agent-step-text">
                      {t.label}
                      {t.summary && <span className="muted"> — {t.summary}</span>}
                      {t.error && <span className="agent-bad"> — {t.error}</span>}
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      )}

      {v.approvals.map((a) => (
        <div key={a.id} className={cls('agent-approval', a.state)} role={a.state === 'pending' ? 'alertdialog' : undefined} aria-label={a.request.title}>
          <div className="agent-approval-title">
            <ShieldQuestion size={15} aria-hidden /> {a.request.title}
          </div>
          {a.request.auto && <p className="agent-auto-note">{a.request.auto}</p>}
          <p>{a.request.detail}</p>
          {a.request.paths && a.request.paths.length > 0 && (
            <ul className="agent-paths">
              {a.request.paths.slice(0, 30).map((p) => (
                <li key={p}>{p}</li>
              ))}
              {a.request.paths.length > 30 && <li className="muted">…and {a.request.paths.length - 30} more</li>}
            </ul>
          )}
          {a.request.code && <pre className="agent-code">{a.request.code}</pre>}
          {a.state === 'pending' || a.state === 'sending' ? (
            <div className="row-actions">
              <button className="btn small primary" disabled={a.state === 'sending'} onClick={() => ai.answerApproval(m.id, a.id, true)}>
                Allow
              </button>
              <button className="btn small" disabled={a.state === 'sending'} onClick={() => ai.answerApproval(m.id, a.id, false)}>
                Don’t allow
              </button>
            </div>
          ) : (
            <p className="muted hint">{a.state === 'approved' ? 'Allowed.' : 'Not allowed.'}</p>
          )}
        </div>
      ))}

      {v.offline && running && (
        <p className="agent-offline">
          <WifiOff size={13} aria-hidden /> Connection to your PC lost. Reconnecting… the task continues on the PC.
        </p>
      )}

      {running && v.draft && (
        <div className="agent-draft">
          <Markdown text={v.draft} />
        </div>
      )}
      {running && !v.approvals.some((a) => a.state === 'pending') && <Spinner label={v.statusText || 'Working…'} />}

      {files.length > 0 && (
        <div className="agent-files">
          <div className="agent-files-title">Files {v.undo && v.undo !== 'running' ? '(undone)' : ''}</div>
          <ul>
            {files.map((f, i) => (
              <li key={i}>
                <span className={cls('agent-badge', f.action)}>{ACTION_LABEL[f.action]}</span>
                <span className="agent-file-path" title={f.from ? `${f.from} → ${f.path}` : f.path}>
                  {f.from ? `${f.from} → ` : ''}
                  {f.path}
                </span>
                {f.action !== 'deleted' && !(v.undo && v.undo !== 'running') && (
                  <button className="link-btn" onClick={() => open(f.path)} title="Open in NoteTOO">
                    <ExternalLink size={12} /> Open
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {v.final !== undefined && (
        <div className="agent-final">
          <Markdown text={v.final} />
        </div>
      )}
      {v.error && <p className="agent-error">{v.error}</p>}
      {m.settingsHint && (
        <button className="btn small" onClick={() => ai.setSettingsOpen(true)}>
          <Settings size={14} /> AI settings
        </button>
      )}
      {v.status === 'stopped' && <p className="muted hint">Stopped.</p>}

      {!running && v.sources.length > 0 && (
        <p className="ai-sources agent-sources">
          Sources:{' '}
          {v.sources.map((s, i) => (
            <span key={s}>
              {i > 0 && ', '}
              <button className="link-btn" onClick={() => open(s)} title={s}>
                {s.split('/').pop()}
              </button>
            </span>
          ))}
        </p>
      )}

      {!running && files.some((f) => f.action !== 'deleted' && f.action !== 'folder') && (
        <div className="agent-undo">
          {v.undo === undefined ? (
            <button className="link-btn" onClick={() => ai.undoAgent(m.id)} title="Put everything back as it was before this task">
              <Undo2 size={13} /> Undo these changes
            </button>
          ) : v.undo === 'running' ? (
            <span className="muted hint">Undoing…</span>
          ) : (
            <span className="muted hint">
              Undone ({v.undo.undone} change{v.undo.undone === 1 ? '' : 's'}){v.undo.failed.length ? `; not undone: ${v.undo.failed.map((f) => f.replace(/\.+$/, '')).join('; ')}` : ''}.
            </span>
          )}
        </div>
      )}
      {v.usage && (
        <p className="agent-cost" title="Tokens the model read and wrote for this task, and their price (as the provider reports it, or from the prices in AI settings)">
          {costLine(v.usage, settings?.currency ?? 'USD', settings?.perUsd ?? 1)}
        </p>
      )}
      {m.status === 'done' && v.final && <MessageActions m={{ ...m, text: v.final }} />}
    </div>
  );
}

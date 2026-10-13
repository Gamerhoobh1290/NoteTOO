import { useRef, useState } from 'react';
import { Bold, Heading, Italic, List, ListChecks } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { useDiskDoc } from '../../state/useDiskDoc';
import { ConflictBanner, SaveIndicator } from '../SaveStatus';
import { Spinner, cls } from '../common';
import Markdown from '../Markdown';

type Mode = 'write' | 'split' | 'preview';
type Edit = { text: string; start: number; end: number };
const asIs = (s: string) => s;

/** Wraps the selection in a marker (e.g. ** for bold). */
function wrap(marker: string, placeholder: string) {
  return (text: string, s: number, e: number): Edit => {
    const sel = text.slice(s, e) || placeholder;
    return { text: text.slice(0, s) + marker + sel + marker + text.slice(e), start: s + marker.length, end: s + marker.length + sel.length };
  };
}

/** Adds (or removes, if all lines have it) a prefix on every selected line. */
function prefixLines(prefix: string) {
  return (text: string, s: number, e: number): Edit => {
    const from = text.lastIndexOf('\n', s - 1) + 1;
    const toIdx = text.indexOf('\n', e);
    const to = toIdx === -1 ? text.length : toIdx;
    const lines = text.slice(from, to).split('\n');
    const all = lines.every((l) => l.startsWith(prefix));
    const next = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l)).join('\n');
    return { text: text.slice(0, from) + next + text.slice(to), start: from, end: from + next.length };
  };
}

export function NoteEditor({ path, title, compact = false }: { path: string; title: string; compact?: boolean }) {
  const fs = useApp().fs!;
  const doc = useDiskDoc<string>({
    fs,
    path,
    serialize: asIs,
    load: async () => {
      const r = await fs.readText(path);
      return { value: r?.text ?? '', lastModified: r?.lastModified ?? null };
    },
  });
  const [mode, setMode] = useState<Mode>(compact ? 'write' : 'split');
  const ta = useRef<HTMLTextAreaElement>(null);

  const apply = (fn: (text: string, s: number, e: number) => Edit) => {
    const el = ta.current;
    if (!el || doc.value === null) return;
    const r = fn(el.value, el.selectionStart, el.selectionEnd);
    doc.update(() => r.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.start, r.end);
    });
  };

  const tools: [string, typeof Bold, () => void][] = [
    ['Bold (Ctrl+B)', Bold, () => apply(wrap('**', 'bold'))],
    ['Italic (Ctrl+I)', Italic, () => apply(wrap('_', 'italic'))],
    ['Heading', Heading, () => apply(prefixLines('## '))],
    ['Bulleted list', List, () => apply(prefixLines('- '))],
    ['Checklist', ListChecks, () => apply(prefixLines('- [ ] '))],
  ];

  return (
    <div className="notes">
      <div className="fileview-head">
        <div className="fileview-titles">
          <span className="crumbs">{path}</span>
          <h1 className="fileview-title">{title}</h1>
        </div>
        <SaveIndicator doc={doc} />
      </div>
      <div className="toolbar">
        <div className="tool-group">
          {tools.map(([label, Icon, run]) => (
            <button key={label} className="icon-btn" title={label} aria-label={label} onClick={run} disabled={mode === 'preview'}>
              <Icon size={17} />
            </button>
          ))}
        </div>
        <div className="seg" role="tablist" aria-label="Editor view" style={{ marginLeft: 'auto' }}>
          {(['write', 'split', 'preview'] as Mode[]).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {m === 'write' ? 'Write' : m === 'split' ? 'Split' : 'Preview'}
            </button>
          ))}
        </div>
      </div>
      <ConflictBanner doc={doc} what="This note" />
      {doc.value === null ? (
        doc.status === 'error' ? (
          <div className="empty">
            <p>Could not open the note: {doc.error}</p>
            <button className="btn" onClick={doc.retry}>
              Retry
            </button>
          </div>
        ) : (
          <Spinner />
        )
      ) : (
        <div className={cls('notes-editor', mode === 'split' && 'split')}>
          {mode !== 'preview' && (
            <textarea
              ref={ta}
              aria-label={title}
              spellCheck
              placeholder={'Write in Markdown…\n\n# Heading\n- list item\n- [ ] to do\n**bold** _italic_'}
              value={doc.value}
              onChange={(e) => doc.update(() => e.target.value)}
              onKeyDown={(e) => {
                if (!(e.ctrlKey || e.metaKey)) return;
                if (e.key.toLowerCase() === 'b') {
                  e.preventDefault();
                  apply(wrap('**', 'bold'));
                } else if (e.key.toLowerCase() === 'i') {
                  e.preventDefault();
                  apply(wrap('_', 'italic'));
                }
              }}
            />
          )}
          {mode !== 'write' && (
            <div className="notes-preview">{doc.value.trim() ? <Markdown text={doc.value} /> : <p className="muted">Nothing written yet.</p>}</div>
          )}
        </div>
      )}
    </div>
  );
}

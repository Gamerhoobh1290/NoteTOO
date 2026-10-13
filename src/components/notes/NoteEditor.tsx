import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bold, Heading, Italic, List, ListChecks, Table } from 'lucide-react';
import { deleteTable, insertTable, parseBlocks, serializeBlocks, type Block } from '../../notes/blocks';
import { useApp } from '../../state/AppContext';
import { useDiskDoc } from '../../state/useDiskDoc';
import { ConflictBanner, SaveIndicator } from '../SaveStatus';
import { Spinner, cls } from '../common';
import Markdown from '../Markdown';
import { NoteTable } from './NoteTable';

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

const PLACEHOLDER = 'Write in Markdown…\n\n# Heading\n- list item\n- [ ] to do\n**bold** _italic_';
const PICK_ROWS = 8;
const PICK_COLS = 6;

/** Rows × columns grid for a new table (rows include the header row). */
function TablePicker({ onPick, onClose }: { onPick: (rows: number, cols: number) => void; onClose: () => void }) {
  const [at, setAt] = useState({ r: 3, c: 3 });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>(`[data-rc="${at.r}:${at.c}"]`)?.focus();
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  const move = (r: number, c: number) => {
    const next = { r: Math.max(1, Math.min(PICK_ROWS, r)), c: Math.max(1, Math.min(PICK_COLS, c)) };
    setAt(next);
    box.current?.querySelector<HTMLButtonElement>(`[data-rc="${next.r}:${next.c}"]`)?.focus();
  };
  return (
    <div
      className="table-picker"
      ref={box}
      role="dialog"
      aria-label="Insert table"
      onKeyDown={(e) => {
        const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        if (d[e.key]) {
          e.preventDefault();
          move(at.r + d[e.key][0], at.c + d[e.key][1]);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="table-picker-grid" style={{ gridTemplateColumns: `repeat(${PICK_COLS}, 20px)` }}>
        {Array.from({ length: PICK_ROWS }, (_, r) =>
          Array.from({ length: PICK_COLS }, (_, c) => (
            <button
              key={`${r}:${c}`}
              data-rc={`${r + 1}:${c + 1}`}
              className={cls('table-picker-cell', r < at.r && c < at.c && 'on')}
              aria-label={`${r + 1} row${r ? 's' : ''} including the header, ${c + 1} column${c ? 's' : ''}`}
              tabIndex={r + 1 === at.r && c + 1 === at.c ? 0 : -1}
              onMouseEnter={() => setAt({ r: r + 1, c: c + 1 })}
              onFocus={() => setAt({ r: r + 1, c: c + 1 })}
              onClick={() => onPick(r + 1, c + 1)}
            />
          )),
        )}
      </div>
      <p className="table-picker-label">
        {at.r} × {at.c} <span className="muted">(rows include the header)</span>
      </p>
    </div>
  );
}

/** Textarea that grows with its content (used between tables). */
function GrowingTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { taRef: (el: HTMLTextAreaElement | null) => void }) {
  const { taRef, ...rest } = props;
  const el = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const t = el.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  });
  return (
    <textarea
      {...rest}
      rows={1}
      ref={(t) => {
        el.current = t;
        taRef(t);
      }}
    />
  );
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
  const [picker, setPicker] = useState(false);
  const blocks = useMemo(() => (doc.value === null ? [] : parseBlocks(doc.value)), [doc.value]);
  const hasTables = blocks.some((b) => b.kind === 'table');
  /** textareas by block index, and the one the toolbar acts on */
  const areas = useRef(new Map<number, HTMLTextAreaElement>());
  const current = useRef<{ index: number; caret: number }>({ index: 0, caret: 0 });
  const editorBox = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);

  useLayoutEffect(() => {
    const sel = focusAfter.current;
    if (!sel) return;
    focusAfter.current = null;
    const el = editorBox.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  });

  const setBlocks = (next: Block[]) => doc.update(() => serializeBlocks(next));
  const setText = (index: number, text: string) => setBlocks(blocks.map((b, i) => (i === index ? { kind: 'text', text } : b)));

  /** The text block the toolbar acts on: the focused one, else the last one. */
  const target = (): { index: number; el: HTMLTextAreaElement } | null => {
    const focused = [...areas.current.entries()].find(([, el]) => el === document.activeElement);
    if (focused) return { index: focused[0], el: focused[1] };
    const i = areas.current.has(current.current.index) ? current.current.index : Math.max(-1, ...areas.current.keys());
    const el = areas.current.get(i);
    return el ? { index: i, el } : null;
  };

  const apply = (fn: (text: string, s: number, e: number) => Edit) => {
    const t = target();
    if (!t || doc.value === null) return;
    const r = fn(t.el.value, t.el.selectionStart, t.el.selectionEnd);
    setText(t.index, r.text);
    requestAnimationFrame(() => {
      t.el.focus();
      t.el.setSelectionRange(r.start, r.end);
    });
  };

  /** Where the table goes: the caret when the table button was pressed (focus then moves to the picker). */
  const insertAt = useRef<{ index: number; caret: number } | null>(null);
  const openPicker = () => {
    const t = target();
    insertAt.current = t
      ? { index: t.index, caret: t.el === document.activeElement ? t.el.selectionStart : current.current.index === t.index ? current.current.caret : t.el.value.length }
      : null;
    setPicker((p) => !p);
  };

  const addTable = (rows: number, cols: number) => {
    setPicker(false);
    if (doc.value === null) return;
    const at = insertAt.current;
    const index = at ? at.index : blocks.length - 1;
    const caret = at ? at.caret : 0;
    const next = blocks.length ? insertTable(blocks, Math.max(0, index), caret, rows, cols) : insertTable([{ kind: 'text', text: '' }], 0, 0, rows, cols);
    const tableIndex = next.findIndex((b, i) => b.kind === 'table' && !blocks.includes(b) && i >= Math.max(0, index));
    focusAfter.current = `[data-block="${tableIndex}"] [data-cell="${rows > 1 ? '1:0' : '0:0'}"]`;
    setBlocks(next);
  };

  /** Starts a text block where there is none yet (before a leading table, between two tables, after the last). */
  const addTextAt = (index: number) => {
    const next = [...blocks];
    next.splice(index, 0, { kind: 'text', text: '' });
    focusAfter.current = `[data-block="${index}"] textarea`;
    setBlocks(next);
  };

  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() === 'b') {
      e.preventDefault();
      apply(wrap('**', 'bold'));
    } else if (e.key.toLowerCase() === 'i') {
      e.preventDefault();
      apply(wrap('_', 'italic'));
    }
  };
  const remember = (index: number) => (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    current.current = { index, caret: e.currentTarget.selectionStart };
  };

  const tools: [string, typeof Bold, () => void][] = [
    ['Bold (Ctrl+B)', Bold, () => apply(wrap('**', 'bold'))],
    ['Italic (Ctrl+I)', Italic, () => apply(wrap('_', 'italic'))],
    ['Heading', Heading, () => apply(prefixLines('## '))],
    ['Bulleted list', List, () => apply(prefixLines('- '))],
    ['Checklist', ListChecks, () => apply(prefixLines('- [ ] '))],
  ];

  let tableNo = 0;
  const gap = (index: number, where: string) => (
    <button key={`gap-${index}`} className="note-gap" onClick={() => addTextAt(index)}>
      Click to write {where}
    </button>
  );

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
            <button key={label} className="icon-btn" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={run} disabled={mode === 'preview'}>
              <Icon size={17} />
            </button>
          ))}
          <span className="table-picker-anchor">
            <button
              className={cls('icon-btn', picker && 'active')}
              title="Insert table"
              aria-label="Insert table"
              aria-expanded={picker}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openPicker}
              disabled={mode === 'preview' || doc.value === null}
            >
              <Table size={17} />
            </button>
            {picker && <TablePicker onPick={addTable} onClose={() => setPicker(false)} />}
          </span>
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
          {mode !== 'preview' &&
            (!hasTables ? (
              <textarea
                ref={(el) => {
                  areas.current.clear();
                  if (el) areas.current.set(0, el);
                }}
                aria-label={title}
                spellCheck
                placeholder={PLACEHOLDER}
                value={doc.value}
                onChange={(e) => {
                  current.current = { index: 0, caret: e.target.selectionStart };
                  doc.update(() => e.target.value);
                }}
                onSelect={remember(0)}
                onKeyDown={keys}
              />
            ) : (
              <div className="note-blocks" ref={editorBox}>
                {blocks.map((b, i) => {
                  const out = [];
                  if (b.kind === 'table' && (i === 0 || blocks[i - 1].kind === 'table')) out.push(gap(i, i === 0 ? 'above the table' : 'between the tables'));
                  if (b.kind === 'text') {
                    out.push(
                      <div key={i} data-block={i} className={cls('note-text', i === blocks.length - 1 && 'last')}>
                        <GrowingTextarea
                          taRef={(el) => {
                            if (el) areas.current.set(i, el);
                            else areas.current.delete(i);
                          }}
                          aria-label={`${title}, text`}
                          spellCheck
                          placeholder={i === blocks.length - 1 ? 'Keep writing…' : ''}
                          value={b.text}
                          onChange={(e) => {
                            current.current = { index: i, caret: e.target.selectionStart };
                            setText(i, e.target.value);
                          }}
                          onSelect={remember(i)}
                          onKeyDown={keys}
                        />
                      </div>,
                    );
                  } else {
                    tableNo++;
                    out.push(
                      <div key={i} data-block={i}>
                        <NoteTable
                          table={b}
                          label={`Table ${tableNo}`}
                          onChange={(t) => setBlocks(blocks.map((x, j) => (j === i ? t : x)))}
                          onDelete={() => setBlocks(deleteTable(blocks, i))}
                        />
                      </div>,
                    );
                  }
                  if (b.kind === 'table' && i === blocks.length - 1) out.push(gap(i + 1, 'below the table'));
                  return out;
                })}
              </div>
            ))}
          {mode !== 'write' && (
            <div className="notes-preview">{doc.value.trim() ? <Markdown text={doc.value} /> : <p className="muted">Nothing written yet.</p>}</div>
          )}
        </div>
      )}
    </div>
  );
}

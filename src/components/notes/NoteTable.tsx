import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, Trash2 } from 'lucide-react';
import type { TableBlock } from '../../notes/blocks';
import { confirmDialog } from '../../lib/ui';

const MIN_W = 56;
const edited = (t: TableBlock, p: Partial<TableBlock>): TableBlock => ({ ...t, ...p, raw: undefined });

/** A Markdown table in the note editor: type in cells, add/remove rows and columns, resize columns. */
export function NoteTable({ table, onChange, onDelete, label }: { table: TableBlock; onChange: (t: TableBlock) => void; onDelete: () => void; label: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ r: number; c: number }>({ r: 1, c: 0 });
  /** live widths while a column border is dragged */
  const [dragWidths, setDragWidths] = useState<number[] | null>(null);
  const focusNext = useRef<{ r: number; c: number } | null>(null);
  const cols = table.rows[0].length;
  const widths = dragWidths ?? table.widths;

  useLayoutEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    const el = root.current?.querySelector<HTMLInputElement>(`[data-cell="${f.r}:${f.c}"]`);
    el?.focus();
    el?.select();
  });

  const go = (r: number, c: number, next: TableBlock = table) => {
    const rr = Math.max(0, Math.min(next.rows.length - 1, r));
    const cc = Math.max(0, Math.min(next.rows[0].length - 1, c));
    focusNext.current = { r: rr, c: cc };
    setActive({ r: rr, c: cc });
  };
  const change = (next: TableBlock, focus?: { r: number; c: number }) => {
    onChange(next);
    if (focus) go(focus.r, focus.c, next);
  };

  const setCell = (r: number, c: number, v: string) => change(edited(table, { rows: table.rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)) }));
  const addRow = (at: number) => {
    const rows = [...table.rows];
    rows.splice(Math.max(1, at), 0, Array<string>(cols).fill(''));
    change(edited(table, { rows }), { r: Math.max(1, at), c: active.c });
  };
  const deleteRow = () => {
    if (active.r === 0) return;
    const rows = table.rows.filter((_, i) => i !== active.r);
    change(edited(table, { rows }), { r: Math.min(active.r, rows.length - 1), c: active.c });
  };
  const addCol = (at: number) => {
    const ins = <T,>(arr: T[], v: T) => [...arr.slice(0, at), v, ...arr.slice(at)];
    change(
      edited(table, {
        rows: table.rows.map((row, i) => ins(row, i === 0 ? `Column ${cols + 1}` : '')),
        align: ins(table.align, null),
        widths: table.widths && ins(table.widths, 140),
      }),
      { r: active.r, c: at },
    );
  };
  const deleteCol = () => {
    if (cols <= 1) return;
    const del = <T,>(arr: T[]) => arr.filter((_, j) => j !== active.c);
    change(edited(table, { rows: table.rows.map(del), align: del(table.align), widths: table.widths && del(table.widths) }), { r: active.r, c: Math.min(active.c, cols - 2) });
  };
  const removeTable = async () => {
    const hasContent = table.rows.slice(1).some((row) => row.some((x) => x.trim()));
    if (
      hasContent &&
      !(await confirmDialog({
        title: 'Delete this table?',
        message: `The table and its ${table.rows.length - 1} row${table.rows.length === 2 ? '' : 's'} are removed from the note.`,
        confirmLabel: 'Delete table',
        danger: true,
      }))
    )
      return;
    onDelete();
  };

  const onCellKey = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (r === table.rows.length - 1) {
        const rows = [...table.rows, Array<string>(cols).fill('')];
        change(edited(table, { rows }), { r: r + 1, c });
      } else go(r + 1, c);
    } else if ((e.key === 'Enter' && e.shiftKey) || e.key === 'ArrowUp') {
      e.preventDefault();
      go(r - 1, c);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(r + 1, c);
    }
  };

  /** Current column widths in px (measured when the table has none saved yet). */
  const measured = (): number[] => {
    if (table.widths) return table.widths;
    const ths = root.current?.querySelectorAll('th') ?? [];
    return Array.from(ths, (th) => Math.round(th.getBoundingClientRect().width));
  };
  const startResize = (e: PointerEvent<HTMLSpanElement>, c: number) => {
    e.preventDefault();
    const start = measured();
    const x0 = e.clientX;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let cur = start;
    const move = (ev: globalThis.PointerEvent) => {
      cur = start.map((w, j) => (j === c ? Math.max(MIN_W, Math.round(w + ev.clientX - x0)) : w));
      setDragWidths(cur);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDragWidths(null);
      if (cur !== start) onChange(edited(table, { widths: cur }));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const resizeKey = (e: KeyboardEvent<HTMLSpanElement>, c: number) => {
    const d = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
    if (!d) return;
    e.preventDefault();
    const w = measured();
    onChange(edited(table, { widths: w.map((x, j) => (j === c ? Math.max(MIN_W, x + d) : x)) }));
  };

  const tools: [string, typeof Trash2, () => void, boolean?][] = [
    ['Insert row above', BetweenHorizontalStart, () => addRow(active.r)],
    ['Insert row below', BetweenHorizontalEnd, () => addRow(active.r + 1)],
    ['Insert column left', BetweenVerticalStart, () => addCol(active.c)],
    ['Insert column right', BetweenVerticalEnd, () => addCol(active.c + 1)],
  ];

  return (
    <div className="note-table" ref={root}>
      <div className="note-table-tools" role="toolbar" aria-label={`${label} tools`}>
        {tools.map(([name, Icon, run]) => (
          <button key={name} className="icon-btn small" title={name} aria-label={name} onMouseDown={(e) => e.preventDefault()} onClick={run}>
            <Icon size={15} />
          </button>
        ))}
        <span className="note-table-sep" />
        <button className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={deleteRow} disabled={active.r === 0} title={active.r === 0 ? 'The header row cannot be deleted' : undefined}>
          Delete row
        </button>
        <button className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={deleteCol} disabled={cols <= 1}>
          Delete column
        </button>
        <button className="icon-btn small danger-hover" title="Delete table" aria-label="Delete table" onClick={() => void removeTable()} style={{ marginLeft: 'auto' }}>
          <Trash2 size={15} />
        </button>
      </div>
      <div className="note-table-scroll">
        <table aria-label={label} style={widths ? { width: widths.reduce((a, b) => a + b, 0) } : undefined} className={widths ? 'sized' : undefined}>
          <colgroup>
            {table.rows[0].map((_, c) => (
              <col key={c} style={widths ? { width: widths[c] } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {table.rows[0].map((v, c) => (
                <th key={c}>
                  <input
                    data-cell={`0:${c}`}
                    value={v}
                    aria-label={`Header, column ${c + 1}`}
                    spellCheck
                    onFocus={() => setActive({ r: 0, c })}
                    onChange={(e) => setCell(0, c, e.target.value)}
                    onKeyDown={(e) => onCellKey(e, 0, c)}
                  />
                  <span
                    className="col-resize"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize column ${c + 1}`}
                    aria-valuenow={widths?.[c]}
                    tabIndex={0}
                    onPointerDown={(e) => startResize(e, c)}
                    onKeyDown={(e) => resizeKey(e, c)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(1).map((row, i) => (
              <tr key={i}>
                {row.map((v, c) => (
                  <td key={c} className={active.r === i + 1 && active.c === c ? 'on' : undefined}>
                    <input
                      data-cell={`${i + 1}:${c}`}
                      value={v}
                      aria-label={`Row ${i + 1}, ${table.rows[0][c] || `column ${c + 1}`}`}
                      spellCheck
                      style={{ textAlign: table.align[c] ?? undefined }}
                      onFocus={() => setActive({ r: i + 1, c })}
                      onChange={(e) => setCell(i + 1, c, e.target.value)}
                      onKeyDown={(e) => onCellKey(e, i + 1, c)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

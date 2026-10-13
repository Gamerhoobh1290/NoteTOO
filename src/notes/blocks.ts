// Notes as blocks for the editor: runs of Markdown text and tables. Files stay plain Markdown:
// a table is a GitHub-flavored Markdown table, optionally preceded by
// `<!-- notetoo-table widths=120,200 -->` (column widths in px; hidden in Markdown previews).
// Text outside tables, and tables that were not edited, are written back byte for byte.

export type Align = 'left' | 'center' | 'right' | null;

export interface TextBlock {
  kind: 'text';
  text: string;
}
export interface TableBlock {
  kind: 'table';
  /** rows[0] is the header row; every row has the same number of cells */
  rows: string[][];
  align: Align[];
  widths?: number[];
  /** a blank line before / after the table in the file (part of the separator, not of the text) */
  before: boolean;
  after: boolean;
  /** the table's original lines (with its widths comment); cleared once the table is edited */
  raw?: string[];
}
export type Block = TextBlock | TableBlock;

const WIDTHS = /^\s*<!--\s*notetoo-table\s+widths=([\d,\s]+)-->\s*$/;
const FENCE = /^\s*(```|~~~)/;
const DELIM_CELL = /^\s*(:?)-+(:?)\s*$/;

/** Cells of a table row: split on unescaped pipes, outer pipes optional. */
function splitRow(line: string): string[] {
  let s = line.replace(/\r$/, '').trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function delimiterAlign(line: string, columns: number): Align[] | null {
  if (!line.includes('-')) return null;
  const cells = splitRow(line);
  if (cells.length !== columns) return null;
  const align: Align[] = [];
  for (const c of cells) {
    const m = DELIM_CELL.exec(c);
    if (!m) return null;
    align.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return align;
}

const isRowLine = (line: string | undefined) => line !== undefined && line.includes('|') && line.trim() !== '';

export function parseBlocks(md: string): Block[] {
  const lines = md.split('\n');
  const blocks: Block[] = [];
  let text: string[] = [];
  let fenced = false;
  const flush = () => {
    if (text.length) blocks.push({ kind: 'text', text: text.join('\n') });
    text = [];
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (FENCE.test(line)) {
      fenced = !fenced;
      text.push(line);
      i++;
      continue;
    }
    const header = !fenced && isRowLine(line) ? splitRow(line) : null;
    const align = header && i + 1 < lines.length ? delimiterAlign(lines[i + 1], header.length) : null;
    if (!header || !align) {
      text.push(line);
      i++;
      continue;
    }
    const raw: string[] = [];
    let widths: number[] | undefined;
    const prev = text[text.length - 1];
    const wm = prev !== undefined ? WIDTHS.exec(prev) : null;
    if (wm) {
      widths = wm[1].split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);
      if (widths.length !== header.length) widths = undefined;
      raw.push(text.pop()!);
    }
    let before = false;
    if (text.length && text[text.length - 1].trim() === '') {
      before = true;
      text.pop();
    }
    flush();
    raw.push(lines[i], lines[i + 1]);
    const rows = [header];
    i += 2;
    while (i < lines.length && isRowLine(lines[i]) && !FENCE.test(lines[i])) {
      const cells = splitRow(lines[i]);
      rows.push(header.map((_, c) => cells[c] ?? ''));
      raw.push(lines[i]);
      i++;
    }
    let after = false;
    if (i < lines.length && lines[i].trim() === '') {
      after = true;
      i++;
    }
    blocks.push({ kind: 'table', rows, align, widths, before, after, raw });
  }
  flush();
  return blocks;
}

const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const DELIM: Record<string, string> = { left: ':--', center: ':-:', right: '--:', null: '---' };

function tableLines(t: TableBlock): string[] {
  if (t.raw) return t.raw;
  const row = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [
    ...(t.widths?.length ? [`<!-- notetoo-table widths=${t.widths.map((w) => Math.round(w)).join(',')} -->`] : []),
    row(t.rows[0]),
    `| ${t.align.map((a) => DELIM[String(a)]).join(' | ')} |`,
    ...t.rows.slice(1).map(row),
  ];
}

export function serializeBlocks(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'text') out.push(...b.text.split('\n'));
    else {
      if (b.before) out.push('');
      out.push(...tableLines(b));
      if (b.after) out.push('');
    }
  }
  return out.join('\n');
}

/** A new table: `rows` counts the header row. */
export function emptyTable(rows: number, cols: number): TableBlock {
  return {
    kind: 'table',
    rows: [Array.from({ length: cols }, (_, c) => `Column ${c + 1}`), ...Array.from({ length: Math.max(0, rows - 1) }, () => Array<string>(cols).fill(''))],
    align: Array<Align>(cols).fill(null),
    before: true,
    after: true,
  };
}

/** Inserts a new table at `caret` in the text block `index`, splitting that text in two. */
export function insertTable(blocks: Block[], index: number, caret: number, rows: number, cols: number): Block[] {
  const b = blocks[index];
  const text = b?.kind === 'text' ? b.text : '';
  const head = text.slice(0, caret).replace(/\n$/, '');
  const tail = text.slice(caret).replace(/^\n/, '');
  const table = emptyTable(rows, cols);
  const out: Block[] = blocks.slice(0, index);
  if (head || caret > 0) out.push({ kind: 'text', text: head });
  table.before = out.length > 0;
  out.push(table, { kind: 'text', text: tail }, ...blocks.slice(index + 1));
  return out;
}

/** Removes table `index`, joining the text before and after it with one blank line. */
export function deleteTable(blocks: Block[], index: number): Block[] {
  const prev = blocks[index - 1];
  const next = blocks[index + 1];
  const out = blocks.slice(0, Math.max(0, index - 1));
  const parts = [prev?.kind === 'text' ? prev.text : null, next?.kind === 'text' ? next.text : null].filter((t): t is string => t !== null);
  if (prev && prev.kind !== 'text') out.push(prev);
  const joined = parts.filter((p) => p !== '').join('\n\n');
  if (parts.length || !out.length) out.push({ kind: 'text', text: joined });
  if (next && next.kind !== 'text') out.push(next);
  out.push(...blocks.slice(index + 2));
  return out;
}

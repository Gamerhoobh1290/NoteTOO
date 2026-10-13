import { describe, expect, it } from 'vitest';
import { deleteTable, emptyTable, insertTable, parseBlocks, serializeBlocks, type TableBlock } from './blocks';

const roundTrip = (md: string) => serializeBlocks(parseBlocks(md));

describe('parseBlocks / serializeBlocks', () => {
  it.each([
    ['empty', ''],
    ['plain text', '# Title\n\nSome text\n- item\n'],
    ['a table between paragraphs', 'Intro\n\n| A | B |\n| --- | :-: |\n| 1 | 2 |\n\nAfter\n'],
    ['a hand-formatted table (kept byte for byte until edited)', '|A|B|\n|-|-|\n|1|2|\n'],
    ['a table at the start and end, no trailing newline', '| A |\n| --- |\n| x |'],
    ['two tables in a row', '| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |\n'],
    ['CRLF text', 'line one\r\nline two\r\n'],
    ['a widths comment', 'x\n\n<!-- notetoo-table widths=120,200 -->\n| A | B |\n| --- | --- |\n| 1 | 2 |\n'],
    ['trailing blank lines', '| A |\n| --- |\n| x |\n\n\n'],
  ])('round-trips %s exactly', (_name, md) => {
    expect(roundTrip(md)).toBe(md);
  });

  it('reads cells, alignment, escaped pipes and widths', () => {
    const blocks = parseBlocks('Intro\n\n<!-- notetoo-table widths=90,160 -->\n| Name | Value |\n|:--|--:|\n| a \\| b | 2 |\n\nEnd');
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'table', 'text']);
    const t = blocks[1] as TableBlock;
    expect(t.rows).toEqual([
      ['Name', 'Value'],
      ['a | b', '2'],
    ]);
    expect(t.align).toEqual(['left', 'right']);
    expect(t.widths).toEqual([90, 160]);
    expect(blocks[0]).toEqual({ kind: 'text', text: 'Intro' });
    expect(blocks[2]).toEqual({ kind: 'text', text: 'End' });
  });

  it('pads short rows and drops extra cells, like GitHub', () => {
    const t = parseBlocks('| A | B |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |')[0] as TableBlock;
    expect(t.rows).toEqual([
      ['A', 'B'],
      ['1', ''],
      ['1', '2'],
    ]);
  });

  it('ignores tables inside code fences', () => {
    const md = '```\n| A | B |\n| --- | --- |\n```\n';
    expect(parseBlocks(md).map((b) => b.kind)).toEqual(['text']);
  });

  it('does not treat a lone line with pipes as a table', () => {
    expect(parseBlocks('a | b\nc | d').map((b) => b.kind)).toEqual(['text']);
  });

  it('writes an edited table as a clean GFM table, escaping pipes', () => {
    const blocks = parseBlocks('|A|B|\n|-|-|\n|1|2|\n');
    const t = blocks[0] as TableBlock;
    const edited: TableBlock = { ...t, raw: undefined, rows: [['A', 'B'], ['x|y', '2']], widths: [100, 140] };
    expect(serializeBlocks([edited, ...blocks.slice(1)])).toBe(
      '<!-- notetoo-table widths=100,140 -->\n| A | B |\n| --- | --- |\n| x\\|y | 2 |\n',
    );
  });

  it('keeps an edited table readable by GitHub-flavored Markdown (re-parses to the same content)', () => {
    const t: TableBlock = { ...emptyTable(3, 2), rows: [['h1', 'h2'], ['a', 'b'], ['c', 'd']] };
    const back = parseBlocks(serializeBlocks([{ kind: 'text', text: 'x' }, t]))[1] as TableBlock;
    expect(back.rows).toEqual(t.rows);
  });
});

describe('insertTable', () => {
  it('splits the text at the caret with blank lines around the table', () => {
    const blocks = insertTable(parseBlocks('before\nafter'), 0, 'before\n'.length, 2, 2);
    expect(serializeBlocks(blocks)).toBe('before\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\nafter');
  });
  it('at the very start does not add a leading blank line', () => {
    const md = serializeBlocks(insertTable(parseBlocks('text'), 0, 0, 1, 1));
    expect(md.startsWith('| Column 1 |')).toBe(true);
    expect(md.endsWith('\n\ntext')).toBe(true);
  });
  it('always leaves a text block after the table to keep writing in', () => {
    const blocks = insertTable(parseBlocks('end'), 0, 3, 1, 2);
    expect(blocks.at(-1)).toEqual({ kind: 'text', text: '' });
  });
});

describe('deleteTable', () => {
  it('removes the table and joins the text around it with one blank line', () => {
    const blocks = parseBlocks('a\n\n| A |\n| --- |\n| 1 |\n\nb');
    expect(serializeBlocks(deleteTable(blocks, 1))).toBe('a\n\nb');
  });
  it('removes a table that is the whole note', () => {
    expect(serializeBlocks(deleteTable(parseBlocks('| A |\n| --- |\n| 1 |\n'), 0))).toBe('');
  });
});

// Office files written by the agent, from the Markdown a model writes best:
//  - Word (.docx): headings, paragraphs with bold/italic/code, bullet and numbered lists, tables,
//    quotes, code blocks.
//  - PowerPoint (.pptx): one slide per "#"/"##" heading or "---" separator, a title and bullets
//    (nested by indentation), 16:9, text shrunk to fit.
//  - Excel (.xlsx): Markdown tables or CSV, one sheet per table ("## Sheet name" names it);
//    numbers stay numbers and "=…" cells become formulas.
// Plain OOXML packages built with JSZip/SheetJS: no Office needed on the PC.

import JSZip from 'jszip';
import { sheetjs } from './extract.mjs';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// ---------- Markdown blocks ----------

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'li'; ordered: boolean; level: number; text: string; list: number }
  | { t: 'table'; rows: string[][] }
  | { t: 'code'; text: string }
  | { t: 'quote'; text: string }
  | { t: 'hr' };

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
export const splitRow = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  let list = 0;
  let inList = false;
  const flush = () => {
    if (para.length) out.push({ t: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push({ t: 'code', text: body.join('\n') });
      inList = false;
      continue;
    }
    if (!line.trim()) {
      flush();
      // a blank line between items keeps the same list
      if (inList && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1] ?? '')) inList = false;
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      out.push({ t: 'h', level: h[1].length, text: h[2] });
      inList = false;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ t: 'hr' });
      inList = false;
      continue;
    }
    if (isTableRow(line)) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && isTableRow(lines[i]); i++) if (!isSeparator(lines[i])) rows.push(splitRow(lines[i]));
      i--;
      out.push({ t: 'table', rows });
      inList = false;
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const level = Math.min(4, Math.floor(li[1].replace(/\t/g, '  ').length / 2));
      const prev = out[out.length - 1];
      // a new list, or a top-level switch between bullets and numbers
      if (!inList || (level === 0 && prev?.t === 'li' && prev.ordered !== ordered && prev.level === 0)) list++;
      inList = true;
      out.push({ t: 'li', ordered, level, text: li[3].replace(/^\[( |x|X)\]\s+/, (_m, x: string) => (x === ' ' ? '☐ ' : '☑ ')), list });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      const prev = out[out.length - 1];
      if (prev?.t === 'quote') prev.text += ' ' + q[1];
      else out.push({ t: 'quote', text: q[1] });
      inList = false;
      continue;
    }
    // continuation of a list item
    if (inList && /^\s{2,}\S/.test(line) && out[out.length - 1]?.t === 'li') {
      (out[out.length - 1] as { text: string }).text += ' ' + line.trim();
      continue;
    }
    inList = false;
    para.push(line.trim());
  }
  flush();
  return out;
}

interface Run {
  text: string;
  b?: boolean;
  i?: boolean;
  code?: boolean;
}

/** **bold**, *italic* / _italic_, `code`, [text](url) -> runs. */
export function inlineRuns(s: string): Run[] {
  const out: Run[] = [];
  const re = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)(?<!\s)\3(?![\w*])|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ text: s.slice(last, m.index) });
    if (m[2] !== undefined) out.push(...inlineRuns(m[2]).map((r) => ({ ...r, b: true })));
    else if (m[4] !== undefined) out.push(...inlineRuns(m[4]).map((r) => ({ ...r, i: true })));
    else if (m[5] !== undefined) out.push({ text: m[5], code: true });
    else out.push({ text: `${m[6]} (${m[7]})` });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.filter((r) => r.text);
}

// ---------- Word ----------

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function wRuns(text: string, base: { b?: boolean; size?: number } = {}): string {
  return inlineRuns(text)
    .map((r) => {
      const props = [
        r.b || base.b ? '<w:b/>' : '',
        r.i ? '<w:i/>' : '',
        r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : '',
        base.size ? `<w:sz w:val="${base.size}"/>` : '',
      ].join('');
      return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
    })
    .join('');
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="44"/></w:rPr></w:style>
${[1, 2, 3, 4, 5, 6]
  .map(
    (n) =>
      `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${n <= 2 ? '2F5496' : '1F3864'}"/><w:sz w:val="${[36, 30, 26, 24, 22, 22][n - 1]}"/></w:rPr></w:style>`,
  )
  .join('\n')}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="567"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="A5A5A5"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

function numbering(lists: { id: number; ordered: boolean }[]): string {
  const lvls = (ordered: boolean) =>
    Array.from({ length: 5 }, (_, l) =>
      ordered
        ? `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter'][l]}"/><w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + l * 360}" w:hanging="360"/></w:pPr></w:lvl>`
        : `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${['•', '◦', '▪', '•', '◦'][l]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + l * 360}" w:hanging="360"/></w:pPr></w:lvl>`,
    ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W_NS}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls(false)}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls(true)}</w:abstractNum>
${lists.map((l) => `<w:num w:numId="${l.id}"><w:abstractNumId w:val="${l.ordered ? 1 : 0}"/>${l.ordered ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : ''}</w:num>`).join('\n')}
</w:numbering>`;
}

const xmlDate = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const coreXml = (title: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>NoteTOO</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${xmlDate()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${xmlDate()}</dcterms:modified></cp:coreProperties>`;

/** A Word document from Markdown. */
export async function markdownToDocx(md: string, title = ''): Promise<Buffer> {
  const blocks = parseMarkdown(md);
  const lists = new Map<number, { id: number; ordered: boolean }>();
  const body: string[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'h':
        body.push(`<w:p><w:pPr><w:pStyle w:val="${b.level === 1 && body.length === 0 ? 'Title' : `Heading${Math.min(6, b.level)}`}"/></w:pPr>${wRuns(b.text)}</w:p>`);
        break;
      case 'p':
        body.push(`<w:p>${wRuns(b.text)}</w:p>`);
        break;
      case 'li': {
        if (!lists.has(b.list)) lists.set(b.list, { id: lists.size + 1, ordered: b.ordered });
        const id = lists.get(b.list)!.id;
        body.push(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${b.level}"/><w:numId w:val="${id}"/></w:numPr></w:pPr>${wRuns(b.text)}</w:p>`);
        break;
      }
      case 'quote':
        body.push(`<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>${wRuns(b.text)}</w:p>`);
        break;
      case 'code':
        for (const l of b.text.split('\n')) body.push(`<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`);
        break;
      case 'hr':
        body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>');
        break;
      case 'table': {
        const cols = Math.max(...b.rows.map((r) => r.length));
        const w = Math.floor(9360 / cols);
        const rows = b.rows.map(
          (r, ri) =>
            `<w:tr>${ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: cols }, (_, ci) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="DEEAF6"/>' : ''}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${wRuns(r[ci] ?? '', ri === 0 ? { b: true } : {})}</w:p></w:tc>`).join('')}</w:tr>`,
        );
        body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl><w:p/>`);
        break;
      }
    }
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${body.join('\n')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
  );
  zip.file('word/document.xml', doc);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/numbering.xml', numbering([...lists.values()]));
  zip.file('docProps/core.xml', coreXml(title || (blocks.find((b) => b.t === 'h') as { text?: string } | undefined)?.text || 'NoteTOO'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- PowerPoint ----------

export interface Slide {
  title: string;
  /** level 0–2; `bullet` false for plain lines */
  items: { text: string; level: number; bullet: boolean }[];
}

const MAX_ITEMS = 9;

/** Slides from Markdown: "#"/"##" headings or "---" start a slide; long slides continue on the next. */
export function parseSlides(md: string): Slide[] {
  const slides: Slide[] = [];
  let cur: Slide | null = null;
  const start = (title: string) => {
    cur = { title, items: [] };
    slides.push(cur);
  };
  for (const b of parseMarkdown(md)) {
    if (b.t === 'hr') {
      cur = null;
      continue;
    }
    if (b.t === 'h' && b.level <= 2) {
      start(b.text);
      continue;
    }
    if (!cur) start('');
    const s = cur!;
    if (b.t === 'h') s.items.push({ text: `**${b.text}**`, level: 0, bullet: false });
    else if (b.t === 'li') s.items.push({ text: b.text, level: Math.min(2, b.level), bullet: true });
    else if (b.t === 'table') for (const r of b.rows) s.items.push({ text: r.join('  |  '), level: 0, bullet: false });
    else if (b.t === 'code') for (const l of b.text.split('\n')) s.items.push({ text: '`' + l + '`', level: 0, bullet: false });
    else if (b.t === 'p' || b.t === 'quote') s.items.push({ text: b.text, level: 0, bullet: false });
  }
  // Split slides that are too long to read.
  const out: Slide[] = [];
  for (const s of slides) {
    if (s.items.length <= MAX_ITEMS) out.push(s);
    else for (let i = 0; i < s.items.length; i += MAX_ITEMS) out.push({ title: i ? `${s.title} (cont.)` : s.title, items: s.items.slice(i, i + MAX_ITEMS) });
  }
  return out.length ? out : [{ title: 'Untitled', items: [] }];
}

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const TITLE_XFRM = '<a:xfrm><a:off x="609600" y="365125"/><a:ext cx="10972800" cy="1143000"/></a:xfrm>';
const BODY_XFRM = '<a:xfrm><a:off x="609600" y="1600200"/><a:ext cx="10972800" cy="4800600"/></a:xfrm>';

function aRuns(text: string, size?: number): string {
  const runs = inlineRuns(text);
  return (runs.length ? runs : [{ text: '' }])
    .map((r) => `<a:r><a:rPr lang="fr-FR"${size ? ` sz="${size}"` : ''}${r.b ? ' b="1"' : ''}${r.i ? ' i="1"' : ''} dirty="0">${r.code ? '<a:latin typeface="Consolas"/>' : ''}</a:rPr><a:t>${esc(r.text)}</a:t></a:r>`)
    .join('');
}

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="NoteTOO"><a:themeElements>
<a:clrScheme name="NoteTOO"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="EEF1F6"/></a:lt2><a:accent1><a:srgbClr val="6D4AD6"/></a:accent1><a:accent2><a:srgbClr val="2F7DD1"/></a:accent2><a:accent3><a:srgbClr val="2BA673"/></a:accent3><a:accent4><a:srgbClr val="E0A100"/></a:accent4><a:accent5><a:srgbClr val="D9534F"/></a:accent5><a:accent6><a:srgbClr val="5B6B7F"/></a:accent6><a:hlink><a:srgbClr val="2F7DD1"/></a:hlink><a:folHlink><a:srgbClr val="6D4AD6"/></a:folHlink></a:clrScheme>
<a:fontScheme name="NoteTOO"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="NoteTOO"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const lvlPr = (l: number, size: number) =>
  `<a:lvl${l + 1}pPr marL="${342900 + l * 400050}" indent="-342900"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="${['•', '–', '•'][l]}"/><a:defRPr sz="${size}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl${l + 1}pPr>`;

const MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${P_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${TITLE_XFRM}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR"/><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${BODY_XFRM}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR"/><a:t>Text</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3600" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${lvlPr(0, 2400)}${lvlPr(1, 2000)}${lvlPr(2, 1800)}</p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${P_NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR"/><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR"/><a:t>Text</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

function slideXml(s: Slide, first: boolean): string {
  const paras = s.items.length
    ? s.items
        .map((it) =>
          it.bullet
            ? `<a:p><a:pPr lvl="${it.level}"/>${aRuns(it.text)}</a:p>`
            : `<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr>${aRuns(it.text)}</a:p>`,
        )
        .join('')
    : '<a:p><a:endParaRPr lang="fr-FR"/></a:p>';
  // A first slide with only a title (and maybe a subtitle) is a title slide: bigger, centered.
  const titleSlide = first && s.items.length <= 2 && s.items.every((i) => !i.bullet);
  const titleXfrm = titleSlide ? '<a:xfrm><a:off x="609600" y="2130425"/><a:ext cx="10972800" cy="1470025"/></a:xfrm>' : TITLE_XFRM;
  const bodyXfrm = titleSlide ? '<a:xfrm><a:off x="1828800" y="3886200"/><a:ext cx="8534400" cy="1752600"/></a:xfrm>' : BODY_XFRM;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${P_NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${titleXfrm}</p:spPr><p:txBody><a:bodyPr${titleSlide ? ' anchor="ctr"' : ''}><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p>${titleSlide ? '<a:pPr algn="ctr"/>' : ''}${aRuns(s.title, titleSlide ? 4400 : undefined)}</a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${bodyXfrm}</p:spPr><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${titleSlide ? paras.replace(/<a:pPr marL="0" indent="0">/g, '<a:pPr marL="0" indent="0" algn="ctr">') : paras}</p:txBody></p:sp>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/** A PowerPoint deck from Markdown slides. */
export async function markdownToPptx(md: string, title = ''): Promise<Buffer> {
  const slides = parseSlides(md);
  const zip = new JSZip();
  const rel = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const rels = (...r: string[]) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r.join('')}</Relationships>`;
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`,
  );
  zip.file(
    '_rels/.rels',
    rels(rel('rId1', 'officeDocument', 'ppt/presentation.xml'), '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'),
  );
  zip.file('docProps/core.xml', coreXml(title || slides[0].title || 'NoteTOO'));
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${P_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels(
      rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
      rel('rId2', 'theme', 'theme/theme1.xml'),
      rel('rId3', 'presProps', 'presProps.xml'),
      rel('rId4', 'viewProps', 'viewProps.xml'),
      rel('rId5', 'tableStyles', 'tableStyles.xml'),
      ...slides.map((_, i) => rel(`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`)),
    ),
  );
  zip.file('ppt/presProps.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentationPr ${P_NS}/>`);
  zip.file('ppt/viewProps.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:viewPr ${P_NS}><p:normalViewPr/><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>`);
  zip.file('ppt/tableStyles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>');
  zip.file('ppt/theme/theme1.xml', THEME);
  zip.file('ppt/slideMasters/slideMaster1.xml', MASTER);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'), rel('rId2', 'theme', '../theme/theme1.xml')));
  zip.file('ppt/slideLayouts/slideLayout1.xml', LAYOUT);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')));
  slides.forEach((s, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(s, i === 0));
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')));
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- Excel ----------

export interface SheetRows {
  name: string;
  rows: string[][];
}

/** Sheets from Markdown tables ("## Name" before a table names its sheet) or from CSV text. */
export function parseSheets(content: string): SheetRows[] {
  const blocks = parseMarkdown(content);
  const tables: SheetRows[] = [];
  let name = '';
  for (const b of blocks) {
    if (b.t === 'h') name = b.text;
    if (b.t === 'table') {
      tables.push({ name: name || `Sheet${tables.length + 1}`, rows: b.rows });
      name = '';
    }
  }
  if (tables.length) return tables;
  // CSV (comma, semicolon or tab separated)
  const lines = content.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  const sep = [';', '\t', ','].sort((a, b) => (lines[0]?.split(b).length ?? 0) - (lines[0]?.split(a).length ?? 0))[0];
  const parseLine = (l: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) {
        if (c === '"' && l[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) (out.push(cur), (cur = ''));
      else cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  return [{ name: 'Sheet1', rows: lines.map(parseLine) }];
}

/** A cell value: numbers (also "12,5" and "15 %") stay numbers, "=…" is a formula. */
function cell(v: string): { t: 'n'; v: number; z?: string } | { t: 's'; v: string } | { t: 'n'; f: string } {
  const s = v.trim();
  if (s.startsWith('=') && s.length > 1) return { t: 'n', f: s.slice(1) };
  const pct = /^(-?\d+(?:[.,]\d+)?)\s*%$/.exec(s);
  if (pct) return { t: 'n', v: Number(pct[1].replace(',', '.')) / 100, z: '0%' };
  if (/^-?\d{1,15}([.,]\d+)?$/.test(s) && !/^0\d/.test(s)) return { t: 'n', v: Number(s.replace(',', '.')) };
  return { t: 's', v: s };
}

export async function sheetsToXlsx(sheets: SheetRows[]): Promise<Buffer> {
  const X = await sheetjs();
  const wb = X.utils.book_new();
  const used = new Set<string>();
  for (const sh of sheets) {
    const ws: Record<string, unknown> = {};
    let maxC = 0;
    sh.rows.forEach((r, ri) => {
      r.forEach((v, ci) => {
        if (v === '') return;
        ws[X.utils.encode_cell({ r: ri, c: ci })] = cell(v);
        maxC = Math.max(maxC, ci);
      });
    });
    ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, sh.rows.length - 1), c: maxC } });
    ws['!cols'] = Array.from({ length: maxC + 1 }, (_, c) => ({ wch: Math.min(60, Math.max(8, ...sh.rows.map((r) => (r[c] ?? '').length + 2))) }));
    let name = sh.name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    X.utils.book_append_sheet(wb, ws as import('xlsx').WorkSheet, name);
  }
  return X.write(wb, { type: 'buffer', bookType: 'xlsx', bookSST: true }) as Buffer;
}

/** Updates cells of an existing workbook: `cells` like {"B2": "12", "C5": "=SUM(C2:C4)"}, rows appended. */
export async function editXlsx(data: Buffer, o: { sheet?: string; cells?: Record<string, string>; appendRows?: string[][] }): Promise<{ data: Buffer; sheet: string }> {
  const X = await sheetjs();
  const wb = X.read(data, { type: 'buffer', cellFormula: true, cellStyles: true });
  const name = o.sheet ? wb.SheetNames.find((n) => n.toLowerCase() === o.sheet!.toLowerCase()) : wb.SheetNames[0];
  if (!name) throw new Error(`There is no sheet named "${o.sheet}". Sheets: ${wb.SheetNames.join(', ')}.`);
  const ws = wb.Sheets[name];
  const range = X.utils.decode_range(ws['!ref'] ?? 'A1:A1');
  const put = (addr: string, v: string) => {
    const a = X.utils.decode_cell(addr.toUpperCase());
    if (a.r < 0 || a.c < 0 || Number.isNaN(a.r)) throw new Error(`"${addr}" is not a cell address like B2.`);
    (ws as Record<string, unknown>)[X.utils.encode_cell(a)] = cell(v);
    range.e.r = Math.max(range.e.r, a.r);
    range.e.c = Math.max(range.e.c, a.c);
  };
  for (const [addr, v] of Object.entries(o.cells ?? {})) put(addr, String(v));
  let next = ws['!ref'] ? range.e.r + 1 : 0;
  for (const r of o.appendRows ?? []) {
    r.forEach((v, c) => v !== '' && put(X.utils.encode_cell({ r: next, c }), String(v)));
    next++;
  }
  ws['!ref'] = X.utils.encode_range(range);
  return { data: X.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, sheet: name };
}

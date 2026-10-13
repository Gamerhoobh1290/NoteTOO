import { extName } from '../fs/paths';

export type FileKind = 'pdf' | 'image' | 'docx' | 'sheet' | 'video' | 'audio' | 'markdown' | 'text' | 'code' | 'other';

/** extension -> highlight.js language */
export const CODE_LANGS: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
  r: 'r', lua: 'lua', pl: 'perl', html: 'xml', htm: 'xml', xml: 'xml', css: 'css', scss: 'scss', less: 'less',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql', sh: 'bash', bash: 'bash',
  ps1: 'powershell', bat: 'dos', makefile: 'makefile', m: 'matlab', tex: 'latex', vb: 'vbnet', asm: 's',
};

const KINDS: Record<string, FileKind> = {
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image', bmp: 'image', avif: 'image', ico: 'image',
  docx: 'docx',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', ods: 'sheet', csv: 'sheet',
  mp4: 'video', webm: 'video', m4v: 'video', ogv: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', flac: 'audio', aac: 'audio', opus: 'audio',
  md: 'markdown', markdown: 'markdown',
  txt: 'text', log: 'text', text: 'text',
};

export function fileKind(name: string): FileKind {
  const ext = extName(name);
  return KINDS[ext] ?? (CODE_LANGS[ext] ? 'code' : 'other');
}

/** Area highlights and pins are available for these kinds. */
export function supportsAreas(kind: FileKind): boolean {
  return kind === 'pdf' || kind === 'image';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function formatDate(ms: number | string): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) || d.getTime() <= 0 ? '—' : dateFmt.format(d);
}

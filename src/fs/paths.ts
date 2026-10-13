// Pure path rules: no File System Access API here, so everything is unit-testable.
// All paths are '/'-separated and relative to the chosen root folder.

export const META_DIR = '.noteTOO';
export const SUBJECT_NOTES = '_notes.md';
export const SCRATCHPAD = '_scratchpad.md';
export const SIDECAR_SUFFIX = '.annotations.json';

export const SECTIONS = ['Cours', 'TD', 'TP', 'Exams', 'Other'] as const;
export type Section = (typeof SECTIONS)[number];

const IGNORED = new Set(
  [META_DIR, SUBJECT_NOTES, SCRATCHPAD, 'desktop.ini', '.DS_Store', 'Thumbs.db'].map((n) => n.toLowerCase()),
);

/** Entries hidden from every file list. `.crswap` are Chrome's in-progress write files. */
export function isIgnored(name: string): boolean {
  const n = name.toLowerCase();
  return IGNORED.has(n) || n.endsWith('.crswap');
}

export function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function joinPath(...parts: string[]): string {
  return parts.flatMap(splitPath).join('/');
}

export function parentPath(path: string): string {
  return splitPath(path).slice(0, -1).join('/');
}

export function baseName(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? '';
}

/** Lower-case extension without the dot ('' when there is none). */
export function extName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function isInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor + '/');
}

/** Replace the `from` prefix of `path` with `to` (for rename/move of a file or any ancestor). */
export function remapPath(path: string, from: string, to: string): string {
  return isInside(path, from) ? to + path.slice(from.length) : path;
}

/** Sidecar for a file: `.noteTOO/<relative path>.annotations.json`. */
export function sidecarPath(filePath: string): string {
  return joinPath(META_DIR, filePath) + SIDECAR_SUFFIX;
}

/** Folder holding the sidecars of everything inside `dirPath`. */
export function sidecarDir(dirPath: string): string {
  return joinPath(META_DIR, dirPath);
}

export function brokenBackupPath(sidecar: string): string {
  return sidecar.replace(/\.json$/, '.broken.json');
}

export function matchSection(name: string): Section | null {
  return SECTIONS.find((s) => s.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * Which subject/section a file belongs to. Files in a non-standard folder or directly
 * in the subject folder count as "Other". Returns null for root-level files.
 */
export function classify(path: string): { subject: string; section: Section } | null {
  const parts = splitPath(path);
  if (parts.length < 2) return null;
  const section = parts.length >= 3 ? matchSection(parts[1]) : null;
  return { subject: parts[0], section: section ?? 'Other' };
}

/** `name (n).ext`, used to avoid overwriting on name collisions. */
export function withSuffix(name: string, n: number): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? `${name.slice(0, i)} (${n})${name.slice(i)}` : `${name} (${n})`;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Returns an error message, or null when the name is valid on Windows/macOS/Linux. */
export function validateName(name: string): string | null {
  if (!name.trim()) return 'Name cannot be empty.';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return 'Name cannot contain \\ / : * ? " < > |';
  if (/[. ]$/.test(name)) return 'Name cannot end with a dot or a space.';
  if (name === '.' || name === '..' || RESERVED.test(name)) return 'This name is reserved by Windows.';
  if (isIgnored(name)) return 'This name is reserved by NoteTOO.';
  if (name.length > 200) return 'Name is too long.';
  return null;
}

/** Case- and accent-insensitive form for searching ("Électricité" matches "electricite"). */
export function searchKey(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

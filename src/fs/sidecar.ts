// Annotation sidecar format: `.noteTOO/<file path>.annotations.json`.

import type { Fs } from './fsService';
import type { Rect } from './geometry';
import { baseName, brokenBackupPath, parentPath, sidecarPath } from './paths';

export const COLORS = ['yellow', 'green', 'pink', 'blue'] as const;
/** Highlights kept from AI suggestions; not offered in the user's color pickers. */
export const AI_COLOR = 'purple';
export type Color = (typeof COLORS)[number] | typeof AI_COLOR;
const ALL_COLORS: readonly string[] = [...COLORS, AI_COLOR];

export type { Rect };
export interface Point {
  x: number;
  y: number;
}

interface AnnotationBase {
  id: string;
  /** 1-based page number; always 1 for images */
  page: number;
  color: Color;
  comment: string;
  createdAt: string;
  updatedAt: string;
}
export interface AreaAnnotation extends AnnotationBase {
  type: 'area';
  /** normalized 0-1, relative to the page/image; the bounding box when `rects` is set */
  rect: Rect;
  /** text highlights: one rectangle per line (optional; older versions only read `rect`) */
  rects?: Rect[];
}
export interface PinAnnotation extends AnnotationBase {
  type: 'pin';
  /** normalized 0-1, relative to the page/image */
  point: Point;
}
export type Annotation = AreaAnnotation | PinAnnotation;

export interface FileComment {
  id: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Sidecar {
  version: 1;
  file: string;
  fileComments: FileComment[];
  annotations: Annotation[];
}

export class SidecarError extends Error {}

export function emptySidecar(file: string): Sidecar {
  return { version: 1, file, fileComments: [], annotations: [] };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SidecarError(`${what} must be a number`);
  return v;
}
function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new SidecarError(`${what} must be a string`);
  return v;
}

function parseRect(r: unknown): Rect {
  if (!isObj(r)) throw new SidecarError('rect is not an object');
  const x = clamp01(num(r.x, 'rect.x'));
  const y = clamp01(num(r.y, 'rect.y'));
  return { x, y, w: Math.min(1 - x, clamp01(num(r.w, 'rect.w'))), h: Math.min(1 - y, clamp01(num(r.h, 'rect.h'))) };
}

function parseAnnotation(a: unknown, i: number): Annotation {
  if (!isObj(a)) throw new SidecarError(`annotation ${i} is not an object`);
  const createdAt = str(a.createdAt ?? new Date(0).toISOString(), 'createdAt');
  const base: AnnotationBase = {
    id: str(a.id, 'id'),
    page: Math.max(1, Math.round(num(a.page ?? 1, 'page'))),
    color: ALL_COLORS.includes(a.color as string) ? (a.color as Color) : 'yellow',
    comment: typeof a.comment === 'string' ? a.comment : '',
    createdAt,
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : createdAt,
  };
  if (a.type === 'area') {
    if (!isObj(a.rect)) throw new SidecarError(`annotation ${i} has no rect`);
    const rects = Array.isArray(a.rects) ? a.rects.slice(0, 50).map(parseRect) : [];
    return { ...base, type: 'area', rect: parseRect(a.rect), ...(rects.length ? { rects } : {}) };
  }
  if (a.type === 'pin') {
    if (!isObj(a.point)) throw new SidecarError(`annotation ${i} has no point`);
    return { ...base, type: 'pin', point: { x: clamp01(num(a.point.x, 'point.x')), y: clamp01(num(a.point.y, 'point.y')) } };
  }
  throw new SidecarError(`annotation ${i} has unknown type`);
}

/** Validates sidecar JSON. Throws SidecarError when it is malformed. */
export function parseSidecar(text: string, file: string): Sidecar {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SidecarError('not valid JSON');
  }
  if (!isObj(raw)) throw new SidecarError('not an object');
  if (raw.version !== undefined && raw.version !== 1) throw new SidecarError(`unsupported version ${String(raw.version)}`);
  const comments = raw.fileComments ?? [];
  const annotations = raw.annotations ?? [];
  if (!Array.isArray(comments) || !Array.isArray(annotations)) throw new SidecarError('lists are malformed');
  return {
    version: 1,
    file, // the sidecar's location is authoritative, not the stored field
    fileComments: comments.map((c, i) => {
      if (!isObj(c)) throw new SidecarError(`comment ${i} is not an object`);
      return {
        id: str(c.id, 'id'),
        text: str(c.text, 'text'),
        createdAt: str(c.createdAt ?? new Date(0).toISOString(), 'createdAt'),
        ...(typeof c.updatedAt === 'string' ? { updatedAt: c.updatedAt } : {}),
      };
    }),
    annotations: annotations.map(parseAnnotation),
  };
}

export function serializeSidecar(s: Sidecar): string {
  return JSON.stringify(s, null, 2) + '\n';
}

export interface LoadedSidecar {
  sidecar: Sidecar;
  /** lastModified of the sidecar on disk, null when it does not exist */
  lastModified: number | null;
  /** set when a malformed sidecar was backed up */
  backup?: string;
}

const inflight = new WeakMap<Fs, Map<string, Promise<LoadedSidecar>>>();

/**
 * Reads a file's sidecar. A malformed one is backed up as `*.broken.json` and replaced by an
 * empty one. Concurrent loads of the same sidecar share one read, so a backup happens once.
 */
export function loadSidecar(fs: Fs, filePath: string): Promise<LoadedSidecar> {
  let byPath = inflight.get(fs);
  if (!byPath) inflight.set(fs, (byPath = new Map()));
  const pending = byPath.get(filePath);
  if (pending) return pending;
  const p = readSidecar(fs, filePath).finally(() => byPath.delete(filePath));
  byPath.set(filePath, p);
  return p;
}

async function readSidecar(fs: Fs, filePath: string): Promise<LoadedSidecar> {
  const path = sidecarPath(filePath);
  const found = await fs.readText(path);
  if (!found) return { sidecar: emptySidecar(filePath), lastModified: null };
  try {
    return { sidecar: parseSidecar(found.text, filePath), lastModified: found.lastModified };
  } catch (e) {
    if (!(e instanceof SidecarError)) throw e;
    const dir = parentPath(path);
    const backup = `${dir}/${await fs.uniqueName(dir, baseName(brokenBackupPath(path)))}`;
    await fs.writeText(backup, found.text);
    await fs.removeFile(path);
    return { sidecar: emptySidecar(filePath), lastModified: null, backup };
  }
}

export function newId(): string {
  // randomUUID needs a secure context: a page from the NoteTOO server over plain http:// on the
  // local network is not one, but getRandomValues works everywhere.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

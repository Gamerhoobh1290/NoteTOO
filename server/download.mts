// Downloads for a browser connected to the NoteTOO server: a copy of a file, or of folders and
// selected files as one .zip, saved on the computer that asked (e.g. the laptop). The originals stay
// where they are on the PC; nothing is moved or changed.
//
// A zip is prepared in two steps so that problems (missing files, too big) are reported in the app
// instead of as a failed download: `prepare` checks the paths inside the shared folder and lists the
// files, then the browser downloads the prepared zip by its id, streamed from disk.

import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fsp, realpathSync } from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';
import JSZip from 'jszip';
import * as disk from '../electron/disk.mjs';
import { META_DIR, isIgnored, SCRATCHPAD, SUBJECT_NOTES } from '../src/fs/paths.js';

/** The zip format NoteTOO writes has no 64-bit extension: stay well under 4 GB. */
export const MAX_ZIP_BYTES = 3.5 * 1024 ** 3;
export const MAX_ZIP_FILES = 20_000;
/** A prepared zip must be downloaded within this time. */
const PREPARED_MS = 10 * 60_000;

/** Already compressed formats are stored as they are (faster, and no smaller anyway). */
const STORED = new Set(
  'pdf docx xlsx pptx xlsm odt ods odp zip 7z rar gz png jpg jpeg gif webp avif heic mp4 mov m4v webm mkv avi mp3 m4a aac ogg oga opus flac wav'.split(' '),
);

export class DownloadError extends Error {}

interface Prepared {
  root: string;
  name: string;
  /** zip entry name -> absolute path */
  files: [string, string][];
  bytes: number;
  at: number;
}

/** Names hidden from NoteTOO's file lists, except the user's notes. */
const skip = (name: string) => name.startsWith('.') || name.startsWith('~$') || (isIgnored(name) && name !== SUBJECT_NOTES && name !== SCRATCHPAD);

/** "attachment" header with the file name in plain ASCII and in full (RFC 6266 / 5987). */
export function attachment(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export function createDownloads() {
  const prepared = new Map<string, Prepared>();
  const sweep = () => {
    for (const [id, p] of prepared) if (Date.now() - p.at > PREPARED_MS) prepared.delete(id);
  };

  /** Lists the files of `paths` (files or folders of the shared folder `rootId`) for a zip. */
  async function prepare(rootId: string, rootPath: string, rawPaths: unknown, rawName: unknown): Promise<{ id: string; name: string; files: number; bytes: number }> {
    sweep();
    if (!Array.isArray(rawPaths) || !rawPaths.length || rawPaths.length > 5000 || rawPaths.some((p) => typeof p !== 'string')) throw new DownloadError('Nothing to download.');
    const rels = [...new Set((rawPaths as string[]).map((p) => p.split('/').filter(Boolean).join('/')))];
    if (rels.some((p) => p.split('/').some((s) => s.toLowerCase() === META_DIR.toLowerCase()))) throw new DownloadError('That folder is internal to NoteTOO.');
    const rootReal = realpathSync(rootPath);
    // Entry names are relative to the folder that contains all the items.
    const parents = rels.map((p) => p.split('/').slice(0, -1));
    const common: string[] = [];
    for (let i = 0; parents.every((p) => p[i] !== undefined && p[i] === parents[0][i]); i++) common.push(parents[0][i]);
    const files: [string, string][] = [];
    let bytes = 0;
    const add = async (rel: string) => {
      let full: string;
      try {
        full = disk.resolveIn(rootId, rel, false);
      } catch (e) {
        throw new DownloadError((e as Error).message);
      }
      const st = await fsp.lstat(full).catch(() => null);
      if (!st) throw new DownloadError(`"${rel}" no longer exists.`);
      if (st.isSymbolicLink()) return;
      const real = realpathSync(full);
      if (!real.startsWith(rootReal + path.sep)) throw new DownloadError(`"${rel}" leads outside the shared folder.`);
      const entry = rel.split('/').slice(common.length).join('/');
      if (st.isDirectory()) {
        for (const d of await fsp.readdir(full, { withFileTypes: true })) if (!skip(d.name)) await add(`${rel}/${d.name}`);
        if (!files.some(([n]) => n.startsWith(entry + '/'))) files.push([entry + '/', '']); // keep empty folders
        return;
      }
      if (!st.isFile()) return;
      files.push([entry, full]);
      bytes += st.size;
      if (files.length > MAX_ZIP_FILES) throw new DownloadError(`More than ${MAX_ZIP_FILES} files: download smaller folders.`);
      if (bytes > MAX_ZIP_BYTES) throw new DownloadError('More than 3.5 GB: download smaller folders, or the big files one by one.');
    };
    for (const rel of rels) {
      if (!rel) throw new DownloadError('The whole shared folder cannot be downloaded at once: download its subjects.');
      await add(rel);
    }
    const base = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : rels.length === 1 ? path.posix.basename(rels[0]) : `${path.posix.basename(rootPath)} - ${rels.length} items`;
    const name = (base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').slice(0, 150).trim() || 'NoteTOO') + '.zip';
    const id = randomUUID();
    prepared.set(id, { root: rootId, name, files, bytes, at: Date.now() });
    return { id, name, files: files.filter(([, f]) => f).length, bytes };
  }

  /** Streams a prepared zip; the files are read from disk as they are added. */
  function send(id: string, res: http.ServerResponse, headers: Record<string, string>): boolean {
    const p = prepared.get(id);
    if (!p) return false;
    prepared.delete(id);
    const zip = new JSZip();
    for (const [entry, full] of p.files) {
      if (!full) zip.folder(entry);
      else {
        const ext = path.extname(full).slice(1).toLowerCase();
        zip.file(entry, createReadStream(full), { binary: true, compression: STORED.has(ext) ? 'STORE' : 'DEFLATE' });
      }
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/zip', 'content-disposition': attachment(p.name), 'cache-control': 'no-store' });
    const stream = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compressionOptions: { level: 6 } });
    stream.on('error', () => res.destroy());
    res.on('close', () => (stream as unknown as { destroy?: () => void }).destroy?.());
    stream.pipe(res);
    return true;
  }

  return { prepare, send, sweep };
}

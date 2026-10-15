// "Receive from phone": a small HTTP server on the LAN that lets a phone upload original photos and
// videos into the opened folder. It runs only while the user has it switched on (main.mts owns its
// lifecycle). Every API request needs the access key; files are streamed through disk.mts's temp-file
// writes and never replace an existing file. Plain HTTP: the key keeps strangers out, but the traffic
// is not encrypted (the dialog says so).

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import * as path from 'node:path';
import * as disk from './disk.mjs';
import { isIgnored, validateName, withSuffix } from '../src/fs/paths.js';
import type { ReceivedFile } from '../src/desktop/bridge.js';

export const INBOX = 'Inbox';
const KEY_HEADER = 'x-notetoo-key';
const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const KEY_LENGTH = 12; // 60 bits; with the lockout below, guessing is hopeless
const MAX_FILE_SIZE = 4 * 1024 ** 3;
const FREE_SPACE_RESERVE = 1024 ** 3;
const MAX_ACTIVE_UPLOADS = 3;
const MAX_FOLDERS = 3000;
const MAX_FOLDER_DEPTH = 6;
const MAX_NAME = 150;

// ---------- access key ----------

export function makeKey(): string {
  let k = '';
  for (let i = 0; i < KEY_LENGTH; i++) k += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  return k;
}

/** Typed keys: any case, spaces and dashes allowed, O read as 0 and I/L as 1. */
export function normalizeKey(s: string): string {
  return s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Constant-time comparison (fixed-length digests, so the length of the guess leaks nothing either). */
export function keyMatches(given: unknown, key: string): boolean {
  if (typeof given !== 'string' || given.length > 64) return false;
  const a = createHash('sha256').update(normalizeKey(given)).digest();
  const b = createHash('sha256').update(key).digest();
  return timingSafeEqual(a, b);
}

/** Wrong keys per client address; after `max` of them the address is refused for `ms`. */
export class Lockout {
  private clients = new Map<string, { fails: number; until: number }>();
  constructor(
    private max = 10,
    private ms = 10 * 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Milliseconds left on this client's lock (0 when not locked). */
  blocked(ip: string): number {
    const c = this.clients.get(ip);
    if (!c?.until) return 0;
    const left = c.until - this.now();
    if (left > 0) return left;
    this.clients.delete(ip);
    return 0;
  }

  fail(ip: string) {
    const c = this.clients.get(ip) ?? { fails: 0, until: 0 };
    if (++c.fails >= this.max) c.until = this.now() + this.ms;
    this.clients.set(ip, c);
  }

  ok(ip: string) {
    this.clients.delete(ip);
  }
}

// ---------- names and addresses ----------

/** A safe file name from whatever the phone sent: last path segment, no Windows-forbidden characters. */
export function sanitizeFileName(raw: string): string {
  let name = (String(raw).split(/[\\/]/).pop() ?? '').normalize('NFC');
  // Invisible bidi/format characters can disguise an extension ("photo‮gpj.exe" shows as "photoexe.jpg").
  name = name.replace(/[​-‏‪-‮⁠-⁩﻿]/g, '');
  name = name.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME - ext.length).replace(/[\s.]+$/, '') + ext;
  }
  if (!name) return 'file';
  if (validateName(name)) name = '_' + name; // CON, NUL…, and names NoteTOO keeps for itself
  return validateName(name) ? 'file' : name;
}

const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
// Windows often names virtual adapters "Ethernet 7", so the MAC prefix is the reliable tell:
// VirtualBox, VMware, Hyper-V/WSL, Parallels, Docker.
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d|00:1c:42|02:42:)/i;
const isVirtual = (iface: string, mac: string) => VIRTUAL_MAC.test(mac) || /vEthernet|VirtualBox|VMware|WSL|Hyper-V|vbox|docker/i.test(iface);
const isWireless = (iface: string) => /wi-?fi|wlan|wireless/i.test(iface);

/** Private IPv4 addresses of this PC: Wi-Fi first (the phone is on Wi-Fi), virtual adapters last. */
export function lanAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const found: { address: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if ((i.family !== 'IPv4' && (i.family as unknown) !== 4) || i.internal || !isPrivate(i.address)) continue;
      const kind = isVirtual(name, i.mac) ? 2 : isWireless(name) ? 0 : 1;
      const range = i.address.startsWith('192.168.') ? 0 : i.address.startsWith('10.') ? 1 : 2;
      found.push({ address: i.address, rank: kind * 3 + range });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.address);
}

// ---------- the server ----------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const HERE = import.meta.dirname;
/** Next to this module in the source tree; under <app>/electron/ once compiled to out/electron/. */
function appFile(...candidates: string[][]): string | null {
  return candidates.map((c) => path.join(HERE, ...c)).find(existsSync) ?? null;
}

function loadPage(): { html: Buffer; csp: string } {
  const file = appFile(['receive-page.html'], ['..', '..', 'electron', 'receive-page.html']);
  if (!file) throw new Error('The phone page is missing from this installation.');
  // Browsers hash inline blocks after turning CRLF into LF (a Git checkout on Windows may add CR).
  const html = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const live = html.replace(/<!--[\s\S]*?-->/g, ''); // tag names mentioned in comments are not blocks
  const hashes = (tag: string) =>
    [...live.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
  const csp = [
    "default-src 'none'",
    `script-src ${hashes('script')}`,
    `style-src ${hashes('style')}`,
    "img-src 'self' blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html: Buffer.from(html), csp };
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};

function send(res: http.ServerResponse, status: number, body: Buffer | string, headers: Record<string, string> = {}) {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}
const sendJson = (res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', ...headers });

const isWithin = (p: string, root: string) => {
  const rel = path.relative(root, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

const sizeLabel = (n: number) => `${Math.round(n / 1024 ** 3)} GB`;

/**
 * Mark of the Web, as browsers add to downloads: Windows then warns before running a received
 * program and Office opens documents in Protected View. Pictures and videos open as usual.
 * Not possible on drives without NTFS streams (FAT/exFAT); the file is kept either way.
 */
async function markFromNetwork(full: string) {
  if (process.platform !== 'win32') return;
  await fsp.writeFile(`${full}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => {});
}

export interface ReceiverOptions {
  /** the opened folder (disk.openRoot id) */
  rootId: string;
  /** addresses to listen on; the same port on each */
  hosts: string[];
  /** preferred port (e.g. last time's, so a Home Screen bookmark keeps working); 0 or busy = random */
  port?: number;
  maxFileSize?: number;
  onFile(file: ReceivedFile): void;
}

export interface Receiver {
  port: number;
  urls: string[];
  key: string;
  /** Replaces the key; the old one stops working immediately. */
  newKey(): string;
  /** Stops listening and drops open connections (unfinished uploads are discarded). */
  close(): Promise<void>;
}

export async function startReceiver(o: ReceiverOptions): Promise<Receiver> {
  const rootFull = disk.resolveIn(o.rootId, '');
  const page = loadPage();
  const iconFile = appFile(['..', 'build', 'icon.png'], ['..', '..', 'build', 'icon.png']);
  const icon = iconFile ? readFileSync(iconFile) : null;
  const manifest = JSON.stringify({
    name: 'NoteTOO – send to PC',
    short_name: 'NoteTOO',
    start_url: '/',
    display: 'standalone',
    background_color: '#f4f4f1',
    theme_color: '#f4f4f1',
    icons: icon ? [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] : [],
  });
  const maxFileSize = o.maxFileSize ?? MAX_FILE_SIZE;
  const lockout = new Lockout();
  let key = makeKey();
  let allowedHosts = new Set<string>();
  let activeUploads = 0;
  /** Bytes announced by uploads in progress, so parallel uploads cannot together fill the disk. */
  let inFlightBytes = 0;
  /** Lower-cased target paths of uploads in progress, so parallel uploads never pick the same name. */
  const reserved = new Set<string>();

  async function destination(raw: string): Promise<{ rel: string; full: string }> {
    const rel = raw.split('/').filter(Boolean).join('/') || INBOX;
    const invalid = new HttpError(400, 'This folder cannot receive files.');
    if (rel.split('/').some((s) => s.startsWith('.') || validateName(s) !== null)) throw invalid;
    let full: string;
    try {
      full = disk.resolveIn(o.rootId, rel, false);
    } catch {
      throw invalid;
    }
    if (rel === INBOX) {
      await fsp.mkdir(full).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      });
    }
    const st = await fsp.lstat(full).catch(() => null);
    if (!st?.isDirectory()) {
      if (rel === INBOX && st) throw new HttpError(409, `Cannot create the ${INBOX} folder: a file named "${INBOX}" is in the way.`);
      throw new HttpError(404, 'This folder no longer exists. Reload the list.');
    }
    // Junctions or links further up must not lead out of the opened folder.
    const [real, realRoot] = await Promise.all([fsp.realpath(full), fsp.realpath(rootFull)]);
    if (!isWithin(real, realRoot)) throw invalid;
    return { rel, full };
  }

  /** First free `name`, `name (1)`… (one directory read; the exclusive commit catches later races). */
  async function reserveName(dirFull: string, name: string): Promise<{ name: string; key: string }> {
    const taken = new Set((await fsp.readdir(dirFull)).map((n) => n.toLowerCase()));
    for (let n = 0; n < 10_000; n++) {
      const candidate = n ? withSuffix(name, n) : name;
      const k = path.join(dirFull, candidate).toLowerCase();
      if (!taken.has(candidate.toLowerCase()) && !reserved.has(k)) {
        reserved.add(k);
        return { name: candidate, key: k };
      }
    }
    throw new HttpError(409, 'Too many files with this name in this folder.');
  }

  async function upload(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const length = req.headers['content-length'];
    if (req.headers['transfer-encoding'] || !length || !/^\d+$/.test(length)) throw new HttpError(411, 'The upload needs a Content-Length.');
    const size = Number(length);
    if (size > maxFileSize) throw new HttpError(413, `Files larger than ${sizeLabel(maxFileSize)} are not accepted.`);
    if (activeUploads >= MAX_ACTIVE_UPLOADS) throw Object.assign(new HttpError(503, 'Busy with other files. Try again.'), { retryAfter: 2 });
    activeUploads++;
    try {
      const dest = await destination(url.searchParams.get('dir') ?? '');
      const { bavail, bsize } = await fsp.statfs(dest.full);
      if (size > bavail * bsize - inFlightBytes - FREE_SPACE_RESERVE) throw new HttpError(507, 'Not enough free space on the PC.');
      const picked = await reserveName(dest.full, sanitizeFileName(url.searchParams.get('name') ?? ''));
      inFlightBytes += size;
      try {
        const rel = `${dest.rel}/${picked.name}`;
        const begun = await disk.beginWrite(o.rootId, rel);
        if (!begun.ok) throw new HttpError(500, begun.message);
        let committed = false;
        try {
          let got = 0;
          // Chunk by chunk, waiting for each write: the file is never held in memory.
          for await (const chunk of req as AsyncIterable<Buffer>) {
            got += chunk.length;
            const w = await disk.writeChunk(begun.value, chunk);
            if (!w.ok) throw new HttpError(500, w.message);
          }
          if (got !== size) throw new HttpError(400, 'The upload was incomplete.');
          const c = await disk.commitWrite(begun.value, { exclusive: true });
          if (!c.ok) throw new HttpError(c.name === 'InvalidModificationError' ? 409 : 500, c.message);
          committed = true;
        } finally {
          if (!committed) await disk.abortWrite(begun.value);
        }
        await markFromNetwork(path.join(dest.full, picked.name));
        o.onFile({ path: rel, size, at: Date.now() });
        sendJson(res, 201, { path: rel, name: picked.name, size });
      } finally {
        reserved.delete(picked.key);
        inFlightBytes -= size;
      }
    } finally {
      activeUploads--;
    }
  }

  async function listFolders(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string, depth: number) => {
      if (depth > MAX_FOLDER_DEPTH) return;
      const dirents = await fsp.readdir(path.join(rootFull, ...rel.split('/').filter(Boolean)), { withFileTypes: true }).catch(() => []);
      // isDirectory() is false for links and junctions: they are skipped.
      const dirs = dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !isIgnored(d.name))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
      for (const name of dirs) {
        if (out.length >= MAX_FOLDERS) return;
        const r = rel ? `${rel}/${name}` : name;
        out.push(r);
        await walk(r, depth + 1);
      }
    };
    await walk('', 1);
    return out;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    // DNS rebinding: a page on another name resolving to this PC still sends its own Host.
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) return send(res, 421, 'Wrong address.');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';

    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'Method not allowed.');
      if (url.pathname === '/') return send(res, 200, page.html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': page.csp });
      if (url.pathname === '/manifest.webmanifest') return send(res, 200, manifest, { 'content-type': 'application/manifest+json' });
      if (url.pathname === '/icon.png' && icon) return send(res, 200, icon, { 'content-type': 'image/png' });
      return send(res, 404, 'Not found.');
    }

    // No CORS headers anywhere, and the key travels in a custom header that cross-site pages cannot send.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: 'Refused.' });
    const ip = req.socket.remoteAddress ?? '';
    const locked = lockout.blocked(ip);
    if (locked) {
      const minutes = Math.ceil(locked / 60_000);
      return sendJson(res, 429, { error: `Too many wrong keys. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.` }, { 'retry-after': String(Math.ceil(locked / 1000)) });
    }
    if (!keyMatches(req.headers[KEY_HEADER], key)) {
      lockout.fail(ip);
      return sendJson(res, 401, { error: 'Wrong or expired key.' });
    }
    lockout.ok(ip);

    if (url.pathname === '/api/folders' && method === 'GET') {
      return sendJson(res, 200, { root: path.basename(rootFull), inbox: INBOX, folders: await listFolders() });
    }
    if (url.pathname === '/api/upload' && method === 'POST') return upload(req, res, url);
    return sendJson(res, 404, { error: 'Not found.' });
  }

  /** Requests being handled; close() waits for them so interrupted uploads remove their temp files. */
  const inFlight = new Set<Promise<void>>();
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const done = route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      const retry = (e as { retryAfter?: number }).retryAfter;
      // Refused before reading the body: close the connection rather than receive the rest of the file.
      const headers: Record<string, string> = req.complete ? {} : { connection: 'close' };
      if (retry) headers['retry-after'] = String(retry);
      if (!res.destroyed) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Could not save the file on the PC.' }, headers);
    });
    inFlight.add(done);
    void done.finally(() => inFlight.delete(done));
  };

  const servers: http.Server[] = [];
  const listen = (server: http.Server, port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  const make = () => {
    const s = http.createServer({ requestTimeout: 2 * 60 * 60_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, handler);
    s.setTimeout(30_000); // no data for 30 s: the socket is destroyed (slow clients, half-open connections)
    s.maxConnections = 32;
    s.on('error', () => {}); // after listening, errors only concern single connections
    return s;
  };

  let port = 0;
  const bound: string[] = [];
  for (const host of o.hosts) {
    const s = make();
    try {
      if (!port) {
        port = await listen(s, o.port ?? 0, host).catch((e) => {
          if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && o.port) return listen(s, 0, host);
          throw e;
        });
      } else {
        await listen(s, port, host);
      }
      servers.push(s);
      bound.push(host);
    } catch {
      s.close();
    }
  }
  if (!servers.length) throw new Error('Could not start the server on this network.');
  allowedHosts = new Set(bound.map((h) => `${h}:${port}`));

  return {
    port,
    urls: bound.map((h) => `http://${h}:${port}`),
    get key() {
      return key;
    },
    newKey() {
      return (key = makeKey());
    },
    async close() {
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections();
            }),
        ),
      );
      await Promise.allSettled([...inFlight]);
    },
  };
}

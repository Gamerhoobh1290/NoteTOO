// The NoteTOO server: serves the NoteTOO web app to browsers on your network (or your Tailscale
// network) and does all the work on this PC. Disk access goes through electron/disk.mts, the same
// trust boundary as the desktop app, limited to the folders shared in server.json; AI requests are
// forwarded to the AI server set up in NoteTOO (by default Ollama on this PC) and streamed back.
//
// Security: every request needs a signed session cookie (from the access key, on /login), except the
// sign-in page itself. Requests are answered only from private, link-local and Tailscale addresses,
// only for this PC's names (DNS rebinding), and state-changing ones only from this origin (no CORS
// anywhere). Plain HTTP on the local network; use Tailscale (encrypted) from anywhere else.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import * as disk from '../electron/disk.mjs';
import { Lockout, keyMatches } from '../electron/receive.mjs';
import type { RootInfo } from '../src/desktop/bridge.js';
import { samePath, type ConfigStore } from './config.mjs';
import { aiCertificates, describeNetError, isLinkLocal, noLinkLocal } from './net.mjs';
import { AgentUnavailable, createAgentService } from './agent/service.mjs';
import { undoRun, type AgentEvent } from './agent/runner.mjs';
import { DownloadError, attachment, createDownloads } from './download.mjs';

export { isLinkLocal };

const COOKIE = 'notetoo_session';
const SESSION_DAYS = 30;
const DAY = 24 * 60 * 60_000;
const MAX_JSON = 2 * 1024 * 1024;
/** Above the page's 8 MB write chunks. */
const MAX_CHUNK = 16 * 1024 * 1024;
/** AI requests carry images as data: URLs. */
const MAX_AI_BODY = 64 * 1024 * 1024;
/** A write left unfinished this long (browser closed, connection lost) is abandoned. */
const WRITE_IDLE_MS = 15 * 60_000;
/** The only AI endpoints the page uses (src/ai/client.ts): Ollama's and OpenAI-compatible ones. */
const AI_PATHS = new Set(['/api/chat', '/api/tags', '/chat/completions', '/models']);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};

// Same as the desktop app's (electron/main.mts), except that the page only talks to this server:
// AI requests are forwarded by it.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', map: 'application/json', svg: 'image/svg+xml', png: 'image/png',
  ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', wasm: 'application/wasm',
  bcmap: 'application/octet-stream', pfb: 'application/octet-stream', icc: 'application/vnd.iccprofile', txt: 'text/plain',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: Buffer | string, headers: Record<string, string> = {}) {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { 'cache-control': 'no-store', ...SECURITY_HEADERS, 'content-length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}
const sendJson = (res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', ...headers });

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'Request too large.');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await readBody(req, MAX_JSON)).toString('utf8'));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Invalid request.');
  }
}

// ---------- who may connect ----------

/** Loopback, private (RFC 1918), link-local, Tailscale (100.64.0.0/10) and IPv6 unique-local addresses. */
export function isPrivateAddress(raw: string | undefined): boolean {
  const a = (raw ?? '').replace(/^::ffff:/i, '').toLowerCase();
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number);
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

const isLoopback = (a: string | undefined) => /^(::ffff:)?127\.|^::1$/i.test(a ?? '');

/** Host header without the port (IPv6 in brackets kept as is). */
function hostOf(h: string): string {
  const s = h.trim().toLowerCase();
  if (s.startsWith('[')) return s.slice(0, s.indexOf(']') + 1);
  return s.replace(/:\d+$/, '');
}

// ---------- session cookies ----------

const sign = (secret: string, exp: number) => createHmac('sha256', secret).update(`notetoo-session.${exp}`).digest('base64url');

export function sessionCookie(secret: string, now = Date.now()): { value: string; exp: number } {
  const exp = now + SESSION_DAYS * DAY;
  return { value: `${exp}.${sign(secret, exp)}`, exp };
}

/** Expiry of a valid session cookie, else 0. */
export function sessionExpiry(secret: string, cookieHeader: string | undefined, now = Date.now()): number {
  const raw = (cookieHeader ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) ?? '';
  const m = /^(\d{1,15})\.([\w-]{43})$/.exec(raw);
  if (!m) return 0;
  const exp = Number(m[1]);
  const a = Buffer.from(m[2]);
  const b = Buffer.from(sign(secret, exp));
  return exp > now && a.length === b.length && timingSafeEqual(a, b) ? exp : 0;
}

// ---------- the sign-in page ----------

const HERE = import.meta.dirname;
/** Next to this module in the source tree, or under <app>/server/ once compiled to out/server/. */
function appFile(...candidates: string[][]): string | null {
  return candidates.map((c) => path.join(HERE, ...c)).find(existsSync) ?? null;
}

function loginPage(): { html: Buffer; csp: string } {
  const file = appFile(['login.html'], ['..', '..', 'server', 'login.html']);
  if (!file) throw new Error('server/login.html is missing.');
  // Browsers hash inline blocks after turning CRLF into LF (a Git checkout on Windows may add CR).
  const html = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const hash = (tag: string) =>
    [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
  const csp = [
    "default-src 'none'",
    `script-src ${hash('script')}`,
    `style-src ${hash('style')}`,
    "img-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html: Buffer.from(html), csp };
}

// ---------- the server ----------

export interface ServerOptions {
  store: ConfigStore;
  /** the built web app (vite build output) */
  distDir: string;
  /** Moves an absolute path to the Recycle Bin. */
  trash: (full: string) => Promise<void>;
}

export interface NoteTooServer {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  /** Abandons unfinished writes (their temp files are removed). */
  close(): Promise<void>;
}

export function createNoteTooServer(o: ServerOptions): NoteTooServer {
  const { store } = o;
  disk.setTrash(o.trash);
  const login = loginPage();
  const icon = (() => {
    const f = appFile(['..', 'build', 'icon.png'], ['..', '..', 'build', 'icon.png']);
    return f ? readFileSync(f) : null;
  })();
  const distDir = path.resolve(o.distDir);
  const lockout = new Lockout();
  const myNames = new Set(['localhost', hostname().toLowerCase(), `${hostname().toLowerCase()}.local`]);

  /** The shared folders that exist, the last opened first (the page shows the first as the open one). */
  function shared(): string[] {
    const c = store.get();
    const list = c.folders.filter(disk.isDirectory);
    const last = c.last ? list.find((p) => samePath(p, c.last!)) : undefined;
    return last ? [last, ...list.filter((p) => p !== last)] : list;
  }

  /** Root ids of the shared folders: only these can be used, even if one was opened before being removed. */
  function sharedIds(): Set<string> {
    return new Set(store.get().folders.map((p) => disk.openRoot(p).id));
  }

  function open(p: string): RootInfo | null {
    const known = shared().find((s) => samePath(s, p));
    if (!known) return null;
    store.update((c) => void (c.last = known));
    return disk.openRoot(known);
  }

  const requireRoot = (id: unknown) => {
    if (typeof id !== 'string' || !sharedIds().has(id)) throw new HttpError(403, 'This folder is not shared by the NoteTOO server.');
  };

  /** Absolute path of a shared folder by id (and registered with disk.mts). */
  const rootPath = (id: unknown): string => {
    requireRoot(id);
    const p = store.get().folders.find((f) => disk.openRoot(f).id === id);
    if (!p || !disk.rootExists(id as string)) throw new HttpError(404, 'This folder is no longer available on the PC.');
    return p;
  };

  const agent = createAgentService(store);
  const downloads = createDownloads();

  /** Unfinished writes and when they were last used (see WRITE_IDLE_MS). */
  const writes = new Map<string, number>();
  const sweeper = setInterval(() => {
    for (const [id, at] of writes) {
      if (Date.now() - at > WRITE_IDLE_MS) {
        writes.delete(id);
        void disk.abortWrite(id);
      }
    }
  }, 60_000);
  sweeper.unref();

  type Handler = (...args: unknown[]) => unknown;
  const onRoot =
    (fn: (...args: never[]) => unknown): Handler =>
    (...args) => {
      requireRoot(args[0]);
      return (fn as Handler)(...args);
    };
  // The HTTP twins of the desktop app's IPC channels (electron/main.mts).
  const rpc: Record<string, Handler> = {
    'folder:open-recent': (p) => open(String(p)),
    'folder:last': () => {
      const last = store.get().last;
      return last ? open(last) : null;
    },
    'folder:recent': () => shared(),
    'folder:close': () => void store.update((c) => void (c.last = null)),
    'folder:exists': (id) => typeof id === 'string' && sharedIds().has(id) && disk.rootExists(id),

    'disk:stat': onRoot(disk.stat),
    'disk:list': onRoot(disk.list),
    'disk:mkdir': onRoot(disk.mkdir),
    'disk:create-file': onRoot(disk.createFile),
    'disk:begin-write': onRoot(async (root: string, p: string) => {
      const r = await disk.beginWrite(root, p);
      if (r.ok) writes.set(r.value, Date.now());
      return r;
    }),
    'disk:commit-write': (id) => {
      writes.delete(String(id));
      return disk.commitWrite(String(id));
    },
    'disk:abort-write': (id) => {
      writes.delete(String(id));
      return disk.abortWrite(String(id));
    },
    'disk:trash': onRoot(disk.trash),
    'disk:move': onRoot(disk.move),
    'disk:same-entry': onRoot(disk.sameEntry),

    'agent:get-settings': () => agent.settings(),
    'agent:set-settings': (s) => agent.setSettings(s),
    'agent:status': (id) => agent.status(id as string, rootPath(id)),
    'agent:check-model': (arg) => {
      const a = (arg && typeof arg === 'object' ? arg : {}) as { settings?: unknown; model?: unknown };
      return agent.checkModel(a.settings, a.model === 'second' ? 'second' : 'main');
    },

    'ai:get-settings': () => store.get().ai,
    'ai:set-settings': (s) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new HttpError(400, 'Invalid settings.');
      store.update((c) => void (c.ai = s as Record<string, unknown>));
    },
  };

  /** Host names this server answers to (DNS rebinding: another site resolving to this PC keeps its own name). */
  function hostAllowed(host: string): boolean {
    const h = hostOf(host);
    return isIP(h.replace(/^\[|\]$/g, '')) !== 0 || myNames.has(h) || h.endsWith('.ts.net') || store.get().hosts.includes(h);
  }

  /** Behind `tailscale serve` (a proxy on this PC), the browser's address and scheme come in headers. */
  function client(req: http.IncomingMessage) {
    const proxied = isLoopback(req.socket.remoteAddress);
    // The last entry is the one the proxy added; earlier ones come from the browser and can be made up.
    const fwd = (name: string) => (proxied ? String(req.headers[name] ?? '').split(',').pop()!.trim() : '');
    return {
      ip: fwd('x-forwarded-for') || (req.socket.remoteAddress ?? ''),
      host: fwd('x-forwarded-host') || (req.headers.host ?? ''),
      https: fwd('x-forwarded-proto') === 'https',
    };
  }

  function setCookie(res: http.ServerResponse, value: string, maxAgeSec: number, secure: boolean) {
    res.setHeader('set-cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
  }

  async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse, ip: string, secure: boolean) {
    const locked = lockout.blocked(ip);
    if (locked) {
      const minutes = Math.ceil(locked / 60_000);
      return sendJson(res, 429, { error: `Too many wrong keys. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.` }, { 'retry-after': String(Math.ceil(locked / 1000)) });
    }
    const body = (await readJson(req)) as { key?: unknown } | null;
    const c = store.get();
    if (!keyMatches(body?.key, c.key)) {
      lockout.fail(ip);
      return sendJson(res, 401, { error: 'Wrong access key.' });
    }
    lockout.ok(ip);
    setCookie(res, sessionCookie(c.secret).value, SESSION_DAYS * 24 * 3600, secure);
    sendJson(res, 200, { ok: true });
  }

  /** Streams a file of a shared folder, with range requests (audio/video seeking); `download` saves a copy. */
  async function serveFile(req: http.IncomingMessage, res: http.ServerResponse, rest: string, download = false) {
    const slash = rest.indexOf('/');
    const id = slash < 0 ? rest : rest.slice(0, slash);
    requireRoot(id);
    const range = req.headers.range;
    const r = await disk.serveFile(new Request(`${disk.FILE_SCHEME}://${id}/${slash < 0 ? '' : rest.slice(slash + 1)}`, { headers: range ? { range } : {} }));
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (!k.startsWith('access-control-')) headers[k] = v;
    });
    if (download && r.status === 200) {
      let name = '';
      try {
        name = decodeURIComponent(rest.slice(rest.lastIndexOf('/') + 1));
      } catch {
        /* keep the browser's default name */
      }
      if (name) headers['content-disposition'] = attachment(name);
    }
    // A file from the folder must never run as a page of this site (SVG, HTML served as text…).
    res.writeHead(r.status, { ...SECURITY_HEADERS, ...headers, 'content-security-policy': "sandbox; default-src 'none'" });
    if (req.method === 'HEAD' || !r.body) {
      await r.body?.cancel();
      return void res.end();
    }
    const body = Readable.fromWeb(r.body as import('node:stream/web').ReadableStream);
    res.on('close', () => body.destroy());
    body.on('error', () => res.destroy());
    body.pipe(res);
  }

  /** Forwards an AI request to the AI server (as set up in NoteTOO) and streams the answer back. */
  function proxyAi(req: http.IncomingMessage, res: http.ServerResponse, sub: string) {
    // The address comes from the page so "Test connection" can try settings before they are saved. It
    // is limited to signed-in browsers, plain http(s) server addresses and the AI endpoints above.
    if (!AI_PATHS.has(sub)) throw new HttpError(400, 'Not an AI request.');
    const invalid = new HttpError(400, 'Invalid AI server address. Check it in AI settings.');
    let baseUrl: URL;
    try {
      baseUrl = new URL(String(req.headers['x-notetoo-ai-base'] ?? ''));
    } catch {
      throw invalid;
    }
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash ||
      // Link-local: cloud metadata services and the like, never an AI server. IP addresses are checked
      // here (they are not looked up); names are checked once resolved (noLinkLocal).
      isLinkLocal(baseUrl.hostname)
    ) {
      throw invalid;
    }
    const base = baseUrl.origin + baseUrl.pathname.replace(/\/+$/, '');
    const target = new URL(baseUrl.pathname.replace(/\/+$/, '') + sub, baseUrl.origin);
    const headers: Record<string, string> = {};
    for (const h of ['content-type', 'authorization', 'x-title']) if (req.headers[h]) headers[h] = String(req.headers[h]);
    if (req.headers['content-length']) headers['content-length'] = String(req.headers['content-length']);
    if (Number(headers['content-length'] ?? 0) > MAX_AI_BODY) throw new HttpError(413, 'Request too large.');

    const ca = target.protocol === 'https:' ? aiCertificates() : undefined;
    const up = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers, lookup: noLinkLocal, ...(ca ? { ca } : {}) }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, {
        ...SECURITY_HEADERS,
        'content-type': upRes.headers['content-type'] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      // Tokens are sent on as they arrive, so the answer streams to the browser.
      res.flushHeaders();
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
    up.on('error', (e: NodeJS.ErrnoException) => {
      console.error(`[ai] ${req.method} ${target.href} failed: ${e.code ?? ''} ${e.message}`);
      if (!res.headersSent) sendJson(res, 502, { error: `Can't reach the AI server at ${base}: ${describeNetError(e)}` }, { 'x-notetoo-ai-unreachable': '1' });
      else res.destroy();
    });
    // The browser stopped (Stop button, closed tab, lost connection): stop the model too.
    res.on('close', () => up.destroy());
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if ((size += chunk.length) > MAX_AI_BODY) {
        up.destroy();
        req.destroy();
      }
    });
    req.pipe(up);
  }

  // ---------- the agent (server/agent/) ----------

  async function startRun(req: http.IncomingMessage, res: http.ServerResponse) {
    const b = (await readJson(req)) as { root?: unknown; message?: unknown; history?: unknown; view?: unknown; model?: unknown } | null;
    const message = typeof b?.message === 'string' ? b.message.trim() : '';
    if (!message || message.length > 20_000) throw new HttpError(400, 'Invalid request.');
    const root = rootPath(b?.root);
    const history = (Array.isArray(b?.history) ? b.history : [])
      .filter((h): h is { role: 'user' | 'assistant'; content: string } => !!h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .slice(-20);
    const v = (b?.view && typeof b.view === 'object' ? b.view : {}) as Record<string, unknown>;
    const text = (x: unknown, max: number) => (typeof x === 'string' && x ? x.slice(0, max) : undefined);
    try {
      const r = agent.start({
        rootId: b!.root as string,
        rootPath: root,
        message,
        history,
        view: { openPath: text(v.openPath, 1000), subject: text(v.subject, 300), selection: text(v.selection, 4000) },
        model: b?.model === 'second' ? 'second' : 'main',
      });
      sendJson(res, 200, { id: r.id });
    } catch (e) {
      if (e instanceof AgentUnavailable) throw new HttpError(409, e.message);
      throw e;
    }
  }

  async function agentRun(req: http.IncomingMessage, res: http.ServerResponse, id: string, action: string, url: URL) {
    const r = agent.get(id);
    if (!r) return sendJson(res, 404, { error: 'This agent task is no longer on the PC (NoteTOO was restarted, or it is too old).' });
    if (action === 'events') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0) || 0;
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      let ended = false;
      const write = (e: AgentEvent) => {
        if (ended) return;
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        if (e.type === 'end') {
          ended = true;
          // Undo events can still follow: the page reconnects for those only when it asks to undo.
          setImmediate(() => res.end());
        }
      };
      const unsubscribe = r.subscribe(after, write);
      // Already over (and its end already seen): nothing more will come.
      if (r.finishedAt && !ended) {
        unsubscribe();
        return void res.end();
      }
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      res.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (action === 'stop') {
      r.stop();
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'approve') {
      const b = (await readJson(req)) as { id?: unknown; approved?: unknown } | null;
      return sendJson(res, 200, { ok: typeof b?.id === 'string' && r.approve(b.id, b.approved === true) });
    }
    // undo
    if (!r.finishedAt) throw new HttpError(409, 'Wait for the task to finish (or stop it) before undoing it.');
    return sendJson(res, 200, await undoRun(r));
  }

  async function serveStatic(res: http.ServerResponse, pathname: string) {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad path.');
    }
    if (rel === '/') rel = '/index.html';
    const full = path.resolve(distDir, '.' + rel);
    if (!full.startsWith(distDir + path.sep)) return send(res, 404, 'Not found.');
    let data: Buffer;
    try {
      data = await fsp.readFile(full);
    } catch {
      return send(res, 404, rel === '/index.html' ? 'The web app is not built. Run `npm run build` (NoteTOO-Server.cmd does it).' : 'Not found.');
    }
    const ext = path.extname(full).slice(1).toLowerCase();
    const headers: Record<string, string> = { 'content-type': TYPES[ext] ?? 'application/octet-stream' };
    if (ext === 'html') {
      // Tells the page to use the server (src/desktop/serverBridge.ts).
      data = Buffer.from(data.toString('utf8').replace('<head>', '<head>\n    <meta name="notetoo-server" content="1" />'));
      headers['content-security-policy'] = APP_CSP;
    } else if (rel.startsWith('/assets/')) {
      headers['cache-control'] = 'private, max-age=31536000, immutable'; // file names change with their contents
    } else {
      headers['cache-control'] = 'no-cache';
    }
    send(res, 200, data, headers); // Node.js leaves the body out for HEAD
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!isPrivateAddress(req.socket.remoteAddress)) return void req.socket.destroy();
    const c = client(req);
    if (!hostAllowed(c.host)) return send(res, 421, 'Wrong address.');
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const method = req.method ?? 'GET';
    const reading = method === 'GET' || method === 'HEAD';

    // No CORS headers anywhere, and changes only from pages of this server.
    const origin = req.headers.origin;
    if (!reading && origin !== undefined) {
      let same = false;
      try {
        same = new URL(origin).host === c.host.toLowerCase();
      } catch {
        /* "null" or garbage */
      }
      if (!same) return sendJson(res, 403, { error: 'Refused.' });
    }

    if (p === '/login' && reading) return send(res, 200, login.html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': login.csp });
    if (p === '/icon.png' && reading && icon) return send(res, 200, icon, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
    if (p === '/api/login' && method === 'POST') return handleLogin(req, res, c.ip, c.https);

    const cfg = store.get();
    const exp = sessionExpiry(cfg.secret, req.headers.cookie);
    if (!exp) {
      if (p.startsWith('/api/')) return sendJson(res, 401, { error: 'Signed out.' });
      if (!reading) return send(res, 405, 'Method not allowed.');
      return send(res, 302, '', { location: `/login?next=${encodeURIComponent(p + url.search)}` });
    }
    // Sliding sessions: a browser used at least every few weeks stays signed in.
    if (exp - Date.now() < (SESSION_DAYS / 2) * DAY) setCookie(res, sessionCookie(cfg.secret).value, SESSION_DAYS * 24 * 3600, c.https);

    if (p === '/api/logout' && method === 'POST') {
      setCookie(res, '', 0, c.https);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/ping') return sendJson(res, 200, { ok: true });
    if (p.startsWith('/api/rpc/') && method === 'POST') {
      const fn = rpc[p.slice('/api/rpc/'.length)];
      if (!fn) return sendJson(res, 404, { error: 'Not found.' });
      const args = await readJson(req);
      if (!Array.isArray(args) || args.length > 4) throw new HttpError(400, 'Invalid request.');
      return sendJson(res, 200, { value: (await fn(...args)) ?? null });
    }
    if (p.startsWith('/api/write/') && method === 'PUT') {
      const id = decodeURIComponent(p.slice('/api/write/'.length));
      if (!writes.has(id)) return sendJson(res, 200, { ok: false, name: 'Error', message: 'This write was already finished.' });
      writes.set(id, Date.now());
      const data = await readBody(req, MAX_CHUNK);
      const r = await disk.writeChunk(id, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      writes.set(id, Date.now());
      return sendJson(res, 200, r);
    }
    if (p.startsWith('/api/file/') && reading) return serveFile(req, res, p.slice('/api/file/'.length), url.searchParams.has('download'));
    if (p === '/api/zip/prepare' && method === 'POST') {
      const b = (await readJson(req)) as { root?: unknown; paths?: unknown; name?: unknown } | null;
      try {
        return sendJson(res, 200, await downloads.prepare(b?.root as string, rootPath(b?.root), b?.paths, b?.name));
      } catch (e) {
        if (e instanceof DownloadError) throw new HttpError(400, e.message);
        throw e;
      }
    }
    const zip = /^\/api\/zip\/([0-9a-f-]{36})$/.exec(p);
    if (zip && reading) {
      if (!downloads.send(zip[1], res, SECURITY_HEADERS)) send(res, 404, 'This download has expired. Start it again from NoteTOO.', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    if (p === '/api/agent/runs' && method === 'POST') return startRun(req, res);
    const run = /^\/api\/agent\/runs\/([0-9a-f-]{36})\/(events|stop|approve|undo)$/.exec(p);
    if (run) return agentRun(req, res, run[1], run[2], url);
    if (p.startsWith('/api/ai/') && (method === 'POST' || method === 'GET')) return proxyAi(req, res, p.slice('/api/ai'.length));
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
    if (!reading) return send(res, 405, 'Method not allowed.');
    return serveStatic(res, p);
  }

  return {
    handler: (req, res) => {
      route(req, res).catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (!(e instanceof HttpError)) console.error(e);
        if (res.headersSent) return void res.destroy();
        sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Something went wrong on the NoteTOO server.' }, req.complete ? {} : { connection: 'close' });
      });
    },
    async close() {
      clearInterval(sweeper);
      agent.stopAll();
      await Promise.all([...writes.keys()].map((id) => disk.abortWrite(id)));
      writes.clear();
    },
  };
}

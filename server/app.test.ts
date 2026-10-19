// The NoteTOO server end to end over real HTTP, on temporary folders: sign-in, the trust boundary
// (shared folders only, host and origin checks), disk calls, file streaming, the AI proxy, and the
// page's own code path (fsService -> nativeFs -> serverBridge -> HTTP -> disk.mts).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createNoteTooServer, isLinkLocal, isPrivateAddress, sessionCookie, sessionExpiry } = await import('./app.mts');
const { ConfigStore } = await import('./config.mts');
const disk = await import('../electron/disk.mts');

let tmp: string;
let school: string;
let other: string;
let store: InstanceType<typeof ConfigStore>;
let server: http.Server;
let app: ReturnType<typeof createNoteTooServer>;
let base: string;
let cookie = '';
const trashed: string[] = [];

const put = (root: string, rel: string, content: string) => {
  const full = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'notetoo-server-'));
  school = path.join(tmp, 'School');
  other = path.join(tmp, 'Private');
  put(school, 'Maths/TD/ex1.pdf', '0123456789');
  put(school, 'Maths/_notes.md', '# Maths');
  put(other, 'secret.txt', 'secret');
  put(tmp, 'dist/index.html', '<!doctype html><html><head><title>NoteTOO</title></head><body></body></html>');
  put(tmp, 'dist/assets/app-123.js', 'console.log(1)');
  store = new ConfigStore(path.join(tmp, 'data'));
  store.update((c) => void (c.folders = [school]));
  trashed.length = 0;
  app = createNoteTooServer({
    store,
    distDir: path.join(tmp, 'dist'),
    trash: async (p) => {
      trashed.push(p);
      rmSync(p, { recursive: true });
    },
  });
  ({ server, url: base } = await listen(app.handler));
  cookie = '';
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

function req(p: string, init: RequestInit = {}) {
  return fetch(base + p, { redirect: 'manual', ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } });
}
async function signIn() {
  const res = await req('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: store.get().key }) });
  expect(res.status).toBe(200);
  cookie = res.headers.get('set-cookie')!.split(';')[0];
}
async function rpc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await req(`/api/rpc/${channel}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  if (!res.ok) throw Object.assign(new Error((await res.json()).error), { status: res.status });
  return (await res.json()).value as T;
}

describe('sign-in', () => {
  it('sends signed-out browsers to the sign-in page and refuses the API', async () => {
    const page = await req('/');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/login?next=%2F');
    expect((await req('/api/ping')).status).toBe(401);
    const login = await req('/login');
    expect(login.status).toBe(200);
    expect(login.headers.get('content-security-policy')).toMatch(/script-src 'sha256-/);
  });

  it('accepts the key (any case, with dashes), and the session cookie is HttpOnly and SameSite=Strict', async () => {
    const typed = store.get().key.toLowerCase().replace(/(.{4})(?!$)/g, '$1-');
    const res = await req('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: typed }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    cookie = res.headers.get('set-cookie')!.split(';')[0];
    expect((await req('/api/ping')).status).toBe(200);
  });

  it('locks a client out after 10 wrong keys', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await req('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"nope"}' })).status).toBe(401);
    }
    const locked = await req('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: store.get().key }) });
    expect(locked.status).toBe(429);
  });

  it('behind a proxy on this PC, uses the address the proxy added, not one the browser made up', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await req('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.${i}, 100.64.0.7` },
        body: '{"key":"nope"}',
      });
      expect(res.status).toBe(401);
    }
    const locked = await req('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.99, 100.64.0.7' },
      body: JSON.stringify({ key: store.get().key }),
    });
    expect(locked.status).toBe(429);
  });

  it('refuses forged or expired cookies, and a new key signs everyone out', async () => {
    const { secret } = store.get();
    const good = sessionCookie(secret, 1000);
    expect(sessionExpiry(secret, `notetoo_session=${good.value}`, 2000)).toBe(good.exp);
    expect(sessionExpiry(secret, `notetoo_session=${good.value}`, good.exp + 1)).toBe(0);
    expect(sessionExpiry(secret, `notetoo_session=${good.value.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}`, 2000)).toBe(0);
    expect(sessionExpiry('x'.repeat(64), `notetoo_session=${good.value}`, 2000)).toBe(0);

    await signIn();
    store.update((c) => void (c.secret = 'y'.repeat(64)));
    expect((await req('/api/ping')).status).toBe(401);
  });
});

describe('trust boundary', () => {
  it('answers only to this PC’s names and to requests from its own pages', async () => {
    await signIn();
    // fetch() can't set Host.
    const withHost = (host: string) =>
      new Promise<number>((resolve, reject) => {
        http.get(`${base}/api/ping`, { headers: { host, cookie } }, (r) => resolve(r.resume().statusCode!)).on('error', reject);
      });
    expect(await withHost('evil.example')).toBe(421);
    expect(await withHost('pc.tail1234.ts.net')).toBe(200);
    const cross = await req('/api/rpc/folder:recent', { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '[]' });
    expect(cross.status).toBe(403);
    expect(cross.headers.get('access-control-allow-origin')).toBeNull();
    expect((await req('/api/rpc/folder:recent', { method: 'POST', headers: { origin: base }, body: '[]' })).status).toBe(200);
  });

  it('only opens the shared folders, and stops serving a folder once it is no longer shared', async () => {
    await signIn();
    expect(await rpc('folder:recent')).toEqual([school]);
    expect(await rpc('folder:open-recent', other)).toBeNull();
    const otherId = disk.openRoot(other).id;
    await expect(rpc('disk:list', otherId, '')).rejects.toMatchObject({ status: 403 });
    expect((await req(`/api/file/${otherId}/secret.txt`)).status).toBe(403);

    const info = await rpc<{ id: string; name: string }>('folder:open-recent', school);
    expect(info.name).toBe('School');
    expect(await rpc('folder:last')).toEqual(info);
    const bad = await rpc<{ ok: boolean }>('disk:stat', info.id, '../Private/secret.txt');
    expect(bad.ok).toBe(false);

    store.update((c) => void (c.folders = []));
    await expect(rpc('disk:list', info.id, '')).rejects.toMatchObject({ status: 403 });
    expect(await rpc('folder:exists', info.id)).toBe(false);
  });

  it('accepts private, link-local and Tailscale addresses only', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.20.1.1', '100.101.102.103', '169.254.3.4', 'fd7a:115c:a1e0::1', 'fe80::1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '100.128.0.1', '172.32.0.1', '2001:db8::1', '', undefined]) expect(isPrivateAddress(a), String(a)).toBe(false);
    // AI requests never go to link-local addresses, also when a host name resolves to one.
    for (const a of ['169.254.169.254', '::ffff:169.254.169.254', '[::ffff:a9fe:a9fe]', 'fe80::1', '[fe80::1]']) expect(isLinkLocal(a), a).toBe(true);
    for (const a of ['127.0.0.1', '192.168.1.5', '::1', 'fd7a:115c:a1e0::1']) expect(isLinkLocal(a), a).toBe(false);
  });
});

describe('the web app and files', () => {
  it('serves the app marked for server mode, with a strict CSP', async () => {
    await signIn();
    const page = await req('/');
    expect(await page.text()).toContain('<meta name="notetoo-server" content="1" />');
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self' blob: data:");
    const asset = await req('/assets/app-123.js');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await req('/..%2F..%2Fdata/server.json')).status).toBe(404);
  });

  it('streams files with ranges, sandboxed, and writes atomically', async () => {
    await signIn();
    const { id } = await rpc<{ id: string }>('folder:open-recent', school);
    const part = await req(`/api/file/${id}/Maths/TD/ex1.pdf`, { headers: { range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('234');
    expect(part.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(part.headers.get('access-control-allow-origin')).toBeNull();

    const w = await rpc<{ ok: true; value: string }>('disk:begin-write', id, 'Maths/new.md');
    const chunk = await req(`/api/write/${w.value}`, { method: 'PUT', body: new TextEncoder().encode('hello') });
    expect(await chunk.json()).toEqual({ ok: true });
    expect(existsSync(path.join(school, 'Maths', 'new.md'))).toBe(false);
    expect((await rpc<{ ok: boolean }>('disk:commit-write', w.value)).ok).toBe(true);
    expect(readFileSync(path.join(school, 'Maths', 'new.md'), 'utf8')).toBe('hello');
  });
});

describe('the page’s own code path', () => {
  it('reads, writes, renames and deletes through serverBridge, and detects conflicts', async () => {
    await signIn();
    // A browser page served by the server: same-origin fetches carry the session cookie.
    const realFetch = fetch;
    vi.stubGlobal('document', { querySelector: () => ({}), addEventListener: () => {}, visibilityState: 'visible' });
    vi.stubGlobal('window', { addEventListener: () => {} });
    vi.stubGlobal('fetch', (u: string, init: RequestInit = {}) =>
      realFetch(base + u, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } }),
    );
    const { connectServerBridge } = await import('../src/desktop/serverBridge');
    const { createNativeRoot } = await import('../src/fs/nativeFs');
    const { ConflictError, createFs } = await import('../src/fs/fsService');
    const bridge = connectServerBridge()!;
    expect(bridge.mode).toBe('server');

    const info = (await bridge.lastFolder()) ?? (await bridge.openRecent(school))!;
    const fs = createFs(createNativeRoot(bridge, info));
    expect((await fs.list('Maths')).map((e) => e.name).sort()).toEqual(['TD']); // _notes.md is hidden
    const notes = await fs.readText('Maths/_notes.md');
    expect(notes?.text).toBe('# Maths');

    const at = await fs.writeText('Maths/_notes.md', '# Maths\nedited on the laptop', { expected: notes!.lastModified });
    expect(readFileSync(path.join(school, 'Maths', '_notes.md'), 'utf8')).toBe('# Maths\nedited on the laptop');
    // Edited on the PC meanwhile (or by a sync app): the laptop's next save is a conflict.
    writeFileSync(path.join(school, 'Maths', '_notes.md'), 'edited on the PC');
    utimesSync(path.join(school, 'Maths', '_notes.md'), new Date(), new Date(at + 5000));
    await expect(fs.writeText('Maths/_notes.md', 'stale', { expected: at })).rejects.toBeInstanceOf(ConflictError);

    await fs.rename('Maths/TD/ex1.pdf', 'ex1 renamed.pdf');
    expect(existsSync(path.join(school, 'Maths', 'TD', 'ex1 renamed.pdf'))).toBe(true);
    expect(await (await fs.readFile('Maths/TD/ex1 renamed.pdf')).text()).toBe('0123456789');
    await fs.remove('Maths/TD/ex1 renamed.pdf');
    expect(trashed).toEqual([path.join(school, 'Maths', 'TD', 'ex1 renamed.pdf')]);
  });
});

describe('AI proxy', () => {
  it('streams the AI server’s answer as it comes, and only for AI endpoints', async () => {
    await signIn();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let seen: { url?: string; auth?: string; body?: string } = {};
    const upstream = await listen(async (q, s) => {
      let body = '';
      for await (const c of q) body += c;
      seen = { url: q.url, auth: q.headers.authorization, body };
      s.writeHead(200, { 'content-type': 'application/x-ndjson' });
      s.write('{"message":{"content":"Hel"}}\n');
      await gate;
      s.end('{"message":{"content":"lo"}}\n');
    });
    try {
      const res = await req('/api/ai/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-notetoo-ai-base': upstream.url, authorization: 'Bearer k' },
        body: '{"model":"m"}',
      });
      expect(res.status).toBe(200);
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      // The first token arrives while the model is still "thinking" about the rest.
      expect((await reader.read()).value).toContain('Hel');
      release();
      let rest = '';
      for (let r = await reader.read(); !r.done; r = await reader.read()) rest += r.value;
      expect(rest).toContain('lo');
      expect(seen).toEqual({ url: '/api/chat', auth: 'Bearer k', body: '{"model":"m"}' });

      const notAi = await req('/api/ai/admin', { method: 'POST', headers: { 'x-notetoo-ai-base': upstream.url } });
      expect(notAi.status).toBe(400);
      for (const bad of ['file:///C:/x', 'http://user:pw@127.0.0.1:9', 'http://127.0.0.1:9/?x=1', 'http://169.254.169.254', 'http://[::ffff:169.254.169.254]', 'http://2852039166', 'not a url']) {
        expect((await req('/api/ai/api/tags', { headers: { 'x-notetoo-ai-base': bad } })).status, bad).toBe(400);
      }
    } finally {
      upstream.server.closeAllConnections();
      upstream.server.close();
    }
    const down = await req('/api/ai/api/tags', { headers: { 'x-notetoo-ai-base': 'http://127.0.0.1:9' } });
    expect(down.status).toBe(502);
    expect(down.headers.get('x-notetoo-ai-unreachable')).toBe('1');
  });

  it('keeps the AI settings on the PC', async () => {
    await signIn();
    expect(await rpc('ai:get-settings')).toBeNull();
    await rpc('ai:set-settings', { provider: 'ollama', baseUrl: 'http://localhost:11434', textModel: 'qwen3.5:9b' });
    expect(JSON.parse(readFileSync(store.file, 'utf8')).ai.textModel).toBe('qwen3.5:9b');
    expect(await rpc('ai:get-settings')).toMatchObject({ textModel: 'qwen3.5:9b' });
  });
});

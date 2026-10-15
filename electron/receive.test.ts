// "Receive from phone": the LAN upload server end to end on a real temporary folder and real sockets
// (bound to 127.0.0.1 here; the app binds to the LAN addresses only).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: {} }));

const disk = await import('./disk.mts');
const { Lockout, keyMatches, lanAddresses, makeKey, normalizeKey, sanitizeFileName, startReceiver } = await import('./receive.mts');
type Receiver = Awaited<ReturnType<typeof startReceiver>>;

describe('access key', () => {
  it('is 12 Crockford base32 characters, different every time', () => {
    const a = makeKey();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(makeKey()).not.toBe(a);
  });

  it('accepts the key typed loosely: lower case, dashes, spaces, O for 0 and I/L for 1', () => {
    expect(normalizeKey(' ab0c-1d1e fghj ')).toBe('AB0C1D1EFGHJ');
    expect(normalizeKey('abOc-Idle-fghj')).toBe('AB0C1D1EFGHJ');
    expect(keyMatches('ab0c-1d1e-fghj', 'AB0C1D1EFGHJ')).toBe(true);
  });

  it('rejects wrong, shorter, longer, empty and non-string keys', () => {
    const key = 'AB0C1D1EFGHJ';
    for (const bad of ['AB0C1D1EFGHK', 'AB0C1D1EFGH', 'AB0C1D1EFGHJJ', '', undefined, null, 42, ['AB0C1D1EFGHJ']]) {
      expect(keyMatches(bad, key), String(bad)).toBe(false);
    }
  });
});

describe('lockout', () => {
  it('blocks a client after 10 failures until the lock expires; success clears the count', () => {
    let now = 1_000;
    const l = new Lockout(10, 600_000, () => now);
    for (let i = 0; i < 9; i++) l.fail('1.2.3.4');
    expect(l.blocked('1.2.3.4')).toBe(0);
    l.ok('1.2.3.4');
    for (let i = 0; i < 9; i++) l.fail('1.2.3.4');
    expect(l.blocked('1.2.3.4')).toBe(0);
    l.fail('1.2.3.4');
    expect(l.blocked('1.2.3.4')).toBe(600_000);
    expect(l.blocked('5.6.7.8')).toBe(0);
    now += 600_000;
    expect(l.blocked('1.2.3.4')).toBe(0);
  });
});

describe('file names from the phone', () => {
  it.each([
    ['IMG_0001.HEIC', 'IMG_0001.HEIC'],
    ['../../x.jpg', 'x.jpg'],
    ['a\\b.png', 'b.png'],
    ['C:\\Windows\\evil.exe', 'evil.exe'],
    ['CON.jpg', '_CON.jpg'],
    ['nul', '_nul'],
    ['desktop.ini', '_desktop.ini'],
    ['_notes.md', '__notes.md'],
    ['a:b?.heic', 'a_b_.heic'],
    ['x"<y>|z*.mov', 'x__y__z_.mov'],
    ['tab\there.jpg', 'tab_here.jpg'],
    [' .x. ', 'x'],
    ['..', 'file'],
    ['', 'file'],
    ['Élève photo.jpg', 'Élève photo.jpg'],
    ['photo‮gpj.exe', 'photogpj.exe'], // right-to-left override would display as "photoexe.jpg"
    ['a‏b⁦c﻿.png', 'abc.png'],
  ])('%j -> %j', (raw, expected) => {
    expect(sanitizeFileName(raw)).toBe(expected);
  });

  it('caps long names at 150 characters and keeps the extension', () => {
    const name = sanitizeFileName('a'.repeat(300) + '.jpeg');
    expect(name.length).toBeLessThanOrEqual(150);
    expect(name.endsWith('.jpeg')).toBe(true);
  });
});

describe('LAN addresses', () => {
  const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null });
  it('keeps private IPv4, drops loopback, public and IPv6, and puts virtual adapters last', () => {
    const ifaces = {
      'vEthernet (WSL)': [v4('172.20.16.1')],
      'Wi-Fi': [v4('192.168.1.20'), { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 1 }],
      Ethernet: [v4('10.0.0.5')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      Public: [v4('8.8.8.8')],
      Odd: [v4('172.32.0.1')],
    };
    expect(lanAddresses(ifaces as never)).toEqual(['192.168.1.20', '10.0.0.5', '172.20.16.1']);
  });

  it('recognizes virtual adapters by their MAC prefix, whatever Windows names them, and prefers Wi-Fi', () => {
    const at = (address: string, mac: string) => [{ address, family: 'IPv4', internal: false, netmask: '', mac, cidr: null }];
    const ifaces = {
      'Ethernet 7': at('192.168.56.1', '0a:00:27:00:00:15'), // VirtualBox host-only
      'Ethernet 3': at('192.168.80.1', '00:50:56:c0:00:08'), // VMware
      Ethernet: at('192.168.0.10', '3c:7c:3f:aa:bb:cc'),
      'Wi-Fi': at('192.168.1.69', 'd8:44:89:e7:28:49'),
    };
    expect(lanAddresses(ifaces as never)).toEqual(['192.168.1.69', '192.168.0.10', '192.168.56.1', '192.168.80.1']);
  });
});

// ---------- the server ----------

let dir: string;
let rootId: string;
let rx: Receiver | null = null;
const received: string[] = [];

const put = (rel: string, content: string | Buffer) => {
  const full = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};
const tempLeft = (rel: string) => existsSync(path.join(dir, rel)) && readdirSync(path.join(dir, rel)).some((n) => n.endsWith('.crswap'));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'notetoo-rx-'));
  put('Maths/TD/TD3/ex.pdf', 'PDF');
  put('Maths/Cours/c.pdf', 'C');
  put('Physique/TP/t.txt', 'T');
  put('.noteTOO/Maths/x.annotations.json', '{}');
  put('.git/config', 'x');
  rootId = disk.openRoot(dir).id;
  received.length = 0;
});
afterEach(async () => {
  await rx?.close();
  rx = null;
  rmSync(dir, { recursive: true, force: true });
});

async function start(opts: { maxFileSize?: number } = {}) {
  rx = await startReceiver({ rootId, hosts: ['127.0.0.1'], onFile: (f) => received.push(f.path), ...opts });
  return rx;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => any;
}
function request(
  p: string,
  o: { method?: string; key?: string | null; host?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${rx!.port}`, ...o.headers };
    if (o.key !== null) headers['x-notetoo-key'] = o.key ?? rx!.key;
    if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
    const req = http.request({ host: '127.0.0.1', port: rx!.port, path: p, method: o.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end(o.body);
  });
}
const upload = (dirRel: string, name: string, body: Buffer | string, o: Parameters<typeof request>[1] = {}) =>
  request(`/api/upload?dir=${encodeURIComponent(dirRel)}&name=${encodeURIComponent(name)}`, { method: 'POST', body, ...o });

describe('receiver', () => {
  it('serves the phone page without a key, with a strict CSP and no CORS', async () => {
    await start();
    const r = await request('/', { key: null });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('<html');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await request('/nope', { key: null })).status).toBe(404);
  });

  it("allows exactly the page's inline script and style by hash, as a browser parses them", async () => {
    await start();
    const r = await request('/', { key: null });
    expect(r.body).not.toContain('\r'); // the HTML parser turns CRLF into LF before hashing
    const live = r.body.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of ['script', 'style']) {
      const blocks = [...live.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
      expect(blocks.length, tag).toBeGreaterThan(0);
      const directive = r.headers['content-security-policy']!.split(';').find((d) => d.trim().startsWith(`${tag}-src`))!;
      for (const b of blocks) expect(directive).toContain(`'sha256-${createHash('sha256').update(b).digest('base64')}'`);
    }
  });

  it('requires the key on every API route', async () => {
    await start();
    for (const key of [null, 'WRONGWRONGWR']) {
      expect((await request('/api/folders', { key })).status).toBe(401);
      expect((await upload('', 'a.jpg', 'A', { key })).status).toBe(401);
    }
    expect(existsSync(path.join(dir, 'Inbox'))).toBe(false);
    expect((await request('/api/folders')).status).toBe(200);
  });

  it('locks a client out after 10 wrong keys, even with the right key', async () => {
    await start();
    for (let i = 0; i < 10; i++) expect((await request('/api/folders', { key: 'WRONGWRONGWR' })).status).toBe(401);
    const r = await request('/api/folders');
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('refuses another Host header (DNS rebinding) and cross-site origins', async () => {
    await start();
    expect((await request('/api/folders', { host: 'evil.example' })).status).toBe(421);
    expect((await request('/', { host: `localhost:${rx!.port}`, key: null })).status).toBe(421);
    expect((await request('/api/folders', { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await request('/api/folders', { headers: { origin: `http://127.0.0.1:${rx!.port}` } })).status).toBe(200);
  });

  it('a new key replaces the old one', async () => {
    await start();
    const old = rx!.key;
    const fresh = rx!.newKey();
    expect(fresh).not.toBe(old);
    expect((await request('/api/folders', { key: old })).status).toBe(401);
    expect((await request('/api/folders', { key: fresh })).status).toBe(200);
  });

  it('lists the folders of the opened folder, without NoteTOO data, dot-folders or links', async () => {
    mkdirSync(path.join(dir, 'Outside-target'));
    const outside = mkdtempSync(path.join(tmpdir(), 'notetoo-outside-'));
    try {
      symlinkSync(outside, path.join(dir, 'Maths', 'link'), 'junction');
      await start();
      const r = (await request('/api/folders')).json();
      expect(r.inbox).toBe('Inbox');
      expect(r.folders).toEqual(['Maths', 'Maths/Cours', 'Maths/TD', 'Maths/TD/TD3', 'Outside-target', 'Physique', 'Physique/TP']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('streams a 12 MB upload to disk byte for byte', async () => {
    await start();
    const data = randomBytes(12 * 1024 * 1024);
    const r = await upload('Maths/TD', 'IMG_0001.HEIC', data);
    expect(r.status).toBe(201);
    expect(r.json()).toMatchObject({ path: 'Maths/TD/IMG_0001.HEIC', name: 'IMG_0001.HEIC', size: data.length });
    const onDisk = readFileSync(path.join(dir, 'Maths', 'TD', 'IMG_0001.HEIC'));
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    expect(tempLeft('Maths/TD')).toBe(false);
    expect(received).toEqual(['Maths/TD/IMG_0001.HEIC']);
  });

  it.runIf(process.platform === 'win32')('marks received files as coming from the network (Mark of the Web)', async () => {
    await start();
    await upload('Maths', 'x.pdf', 'X');
    expect(readFileSync(path.join(dir, 'Maths', 'x.pdf') + ':Zone.Identifier', 'utf8')).toMatch(/ZoneId=3/);
  });

  it('never overwrites: the same name gets a (1) suffix', async () => {
    await start();
    put('Maths/TD/image.jpg', 'ORIGINAL');
    const r = await upload('Maths/TD', 'image.jpg', 'NEW');
    expect(r.json().path).toBe('Maths/TD/image (1).jpg');
    expect(readFileSync(path.join(dir, 'Maths/TD/image.jpg'), 'utf8')).toBe('ORIGINAL');
    expect(readFileSync(path.join(dir, 'Maths/TD/image (1).jpg'), 'utf8')).toBe('NEW');
  });

  it('two uploads with the same name at the same time make two files', async () => {
    await start();
    const [a, b] = await Promise.all([upload('', 'image.jpg', 'A'.repeat(300_000)), upload('', 'image.jpg', 'B'.repeat(300_000))]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.json().path, b.json().path].sort()).toEqual(['Inbox/image (1).jpg', 'Inbox/image.jpg']);
    const contents = ['image.jpg', 'image (1).jpg'].map((n) => readFileSync(path.join(dir, 'Inbox', n), 'utf8')[0]).sort();
    expect(contents).toEqual(['A', 'B']);
  });

  it('puts files in Inbox (created when missing) when no folder is chosen', async () => {
    await start();
    const r = await upload('', 'a.jpg', 'A');
    expect(r.json().path).toBe('Inbox/a.jpg');
    expect(readFileSync(path.join(dir, 'Inbox', 'a.jpg'), 'utf8')).toBe('A');
  });

  it('sanitizes the file name before saving', async () => {
    await start();
    const r = await upload('Maths', '..\\..\\CON.jpg', 'A');
    expect(r.json().path).toBe('Maths/_CON.jpg');
  });

  it.each(['../x', '..', 'Maths/../../x', 'C:/Windows', 'C:\\Windows', '/etc', '.noteTOO', '.noteTOO/Maths', '.git', 'Nope', 'Maths/TD/TD3/ex.pdf', 'Maths/link'])(
    'refuses destination %j and writes nothing',
    async (bad) => {
      const outside = mkdtempSync(path.join(tmpdir(), 'notetoo-outside-'));
      try {
        symlinkSync(outside, path.join(dir, 'Maths', 'link'), 'junction');
        await start();
        const r = await upload(bad, 'evil.jpg', 'X');
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        expect(readdirSync(outside)).toEqual([]);
        expect(existsSync(path.join(dir, 'Nope'))).toBe(false);
        expect(existsSync(path.join(dir, 'Inbox'))).toBe(false);
        expect(received).toEqual([]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('refuses a folder reached through a junction that leads outside', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'notetoo-outside-'));
    try {
      mkdirSync(path.join(outside, 'sub'));
      symlinkSync(outside, path.join(dir, 'Maths', 'link'), 'junction');
      await start();
      expect((await upload('Maths/link/sub', 'evil.jpg', 'X')).status).toBe(400);
      expect(readdirSync(path.join(outside, 'sub'))).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses files over the size limit before writing anything', async () => {
    await start({ maxFileSize: 1000 });
    const r = await upload('Maths', 'big.mov', Buffer.alloc(1001));
    expect(r.status).toBe(413);
    expect(existsSync(path.join(dir, 'Maths', 'big.mov'))).toBe(false);
    expect(tempLeft('Maths')).toBe(false);
  });

  it('requires a Content-Length (no chunked uploads)', async () => {
    await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: rx!.port, path: '/api/upload?dir=Maths&name=a.jpg', method: 'POST', headers: { host: `127.0.0.1:${rx!.port}`, 'x-notetoo-key': rx!.key, 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      req.end('abc');
    });
    expect(status).toBe(411);
  });

  it('an upload cut off half-way leaves no file and no temp file', async () => {
    await start();
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: rx!.port,
        path: '/api/upload?dir=Maths&name=cut.jpg',
        method: 'POST',
        headers: { host: `127.0.0.1:${rx!.port}`, 'x-notetoo-key': rx!.key, 'content-length': '1000000' },
      });
      req.on('error', () => resolve());
      req.write(Buffer.alloc(200_000));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await vi.waitFor(() => expect(tempLeft('Maths')).toBe(false), { timeout: 3000 });
    expect(existsSync(path.join(dir, 'Maths', 'cut.jpg'))).toBe(false);
    expect(received).toEqual([]);
  });

  it('close() waits until an upload it interrupted has removed its temp file', async () => {
    await start();
    const req = http.request({
      host: '127.0.0.1',
      port: rx!.port,
      path: '/api/upload?dir=Maths&name=big.mov',
      method: 'POST',
      headers: { host: `127.0.0.1:${rx!.port}`, 'x-notetoo-key': rx!.key, 'content-length': '50000000' },
    });
    req.on('error', () => {});
    req.write(Buffer.alloc(2_000_000));
    await vi.waitFor(() => expect(tempLeft('Maths')).toBe(true));
    await rx!.close();
    rx = null;
    expect(tempLeft('Maths')).toBe(false);
    expect(existsSync(path.join(dir, 'Maths', 'big.mov'))).toBe(false);
  });

  it('an Inbox that is a file gives a clear error', async () => {
    put('Inbox', 'not a folder');
    await start();
    const r = await upload('', 'a.jpg', 'A');
    expect(r.status).toBe(409);
    expect(r.json().error).toMatch(/file named "Inbox"/);
  });

  it('stops listening when closed', async () => {
    await start();
    const port = rx!.port;
    await rx!.close();
    rx = null;
    await expect(
      new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/' }, resolve).on('error', reject)),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

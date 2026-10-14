// The updater's trust and version logic: manifest signature + validation, version order,
// install detection output parsing, and resumable, hash-checked downloads (on a real temp folder).
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const core = await import('./core.mts');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');

const manifest = (over: Record<string, unknown> = {}) => ({
  app: 'NoteTOO',
  version: '1.1.0',
  releasedAt: '2026-10-14T10:00:00.000Z',
  notes: 'Tables in the Scratchpad.',
  url: 'https://github.com/Gamerhoobh1290/notetoo-releases/releases/download/v1.1.0/NoteTOO-Setup-1.1.0.exe',
  size: 10,
  sha256: 'a'.repeat(64),
  ...over,
});
const signed = (m: object, key = privateKey) => {
  const bytes = Buffer.from(JSON.stringify(m, null, 2));
  return { bytes, sig: sign(null, bytes, key).toString('base64') };
};

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(core.compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(core.compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(core.compareVersions('0.9.0', '1.0.0')).toBe(-1);
  });
  it('rejects anything that is not x.y.z', () => {
    expect(() => core.compareVersions('1.0', '1.0.0')).toThrow();
    expect(() => core.compareVersions('1.0.0-beta', '1.0.0')).toThrow();
  });
});

describe('verifyManifest', () => {
  it('accepts a correctly signed, valid manifest', () => {
    const { bytes, sig } = signed(manifest());
    expect(core.verifyManifest(bytes, sig, PUB).version).toBe('1.1.0');
  });
  it('refuses a manifest signed with another key', () => {
    const { bytes, sig } = signed(manifest(), other.privateKey);
    expect(() => core.verifyManifest(bytes, sig, PUB)).toThrow(/signature/i);
  });
  it('refuses a manifest changed after signing', () => {
    const { bytes, sig } = signed(manifest());
    const tampered = Buffer.from(bytes.toString().replace('1.1.0', '9.9.9'));
    expect(() => core.verifyManifest(tampered, sig, PUB)).toThrow(/signature/i);
  });
  it('refuses a garbage signature', () => {
    const { bytes } = signed(manifest());
    expect(() => core.verifyManifest(bytes, 'not base64 at all!!', PUB)).toThrow(/signature/i);
  });
  it.each([
    ['another app', { app: 'Other' }],
    ['a bad version', { version: 'latest' }],
    ['plain http', { url: 'http://example.com/NoteTOO-Setup-1.1.0.exe' }],
    ['a non-exe download', { url: 'https://example.com/NoteTOO-Setup-1.1.0.zip' }],
    ['a bad hash', { sha256: 'xyz' }],
    ['a bad size', { size: -1 }],
  ])('refuses a signed manifest with %s', (_name, over) => {
    const { bytes, sig } = signed(manifest(over));
    expect(() => core.verifyManifest(bytes, sig, PUB)).toThrow();
  });
});

describe('pickInstall', () => {
  it('finds NoteTOO among uninstall entries, ignoring the updater itself', () => {
    const entries = [
      { DisplayName: 'NoteTOO Updater 1.0.0', DisplayVersion: '1.0.0', InstallLocation: 'C:\\U' },
      { DisplayName: 'NoteTOO 1.0.0', DisplayVersion: '1.0.0', InstallLocation: 'C:\\Apps\\notetoo' },
      { DisplayName: 'Something else', DisplayVersion: '3.0.0', InstallLocation: 'C:\\X' },
    ];
    expect(core.pickInstall(entries, () => true)).toEqual({ version: '1.0.0', dir: 'C:\\Apps\\notetoo', exe: path.join('C:\\Apps\\notetoo', 'NoteTOO.exe') });
  });
  it('ignores an entry whose program is gone', () => {
    expect(core.pickInstall([{ DisplayName: 'NoteTOO 1.0.0', DisplayVersion: '1.0.0', InstallLocation: 'C:\\gone' }], () => false)).toBeNull();
  });
  it('finds the folder from the uninstaller when InstallLocation is missing (per-user NSIS)', () => {
    const entry = {
      DisplayName: 'NoteTOO 1.0.0',
      DisplayVersion: '1.0.0',
      InstallLocation: '',
      UninstallString: '"C:\\Users\\A\\AppData\\Local\\Programs\\NoteTOO\\Uninstall NoteTOO.exe" /currentuser',
    };
    const dir = 'C:\\Users\\A\\AppData\\Local\\Programs\\NoteTOO';
    expect(core.pickInstall(entry, () => true)).toEqual({ version: '1.0.0', dir, exe: path.join(dir, 'NoteTOO.exe') });
  });
  it('accepts a single object (PowerShell returns one entry unwrapped)', () => {
    expect(core.pickInstall({ DisplayName: 'NoteTOO 1.2.3', DisplayVersion: '1.2.3', InstallLocation: 'D:\\n' }, () => true)?.version).toBe('1.2.3');
  });
});

describe('stoppedByInstaller', () => {
  const dir = 'C:\\Users\\A\\AppData\\Local\\Programs\\NoteTOO';
  it('matches the way the NSIS installer does: a plain, case-insensitive prefix', () => {
    expect(core.stoppedByInstaller('C:\\Users\\A\\AppData\\Local\\Programs\\NoteTOO Updater\\NoteTOO Updater.exe', dir)).toBe(true);
    expect(core.stoppedByInstaller('c:\\users\\a\\appdata\\local\\programs\\notetoo-updater\\x.exe', dir)).toBe(true);
  });
  it('is safe in the default updater folder', () => {
    expect(core.stoppedByInstaller('C:\\Users\\A\\AppData\\Local\\Programs\\Updater for NoteTOO\\NoteTOO Updater.exe', dir)).toBe(false);
  });
});

describe('downloadVerified', () => {
  let dir: string;
  const body = Buffer.from('installer bytes, pretend this is an exe');
  const sha = createHash('sha256').update(body).digest('hex');
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'notetoo-upd-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake server that honours Range requests, optionally cutting the connection after `cut` bytes. */
  const server = (o: { cut?: number; ignoreRange?: boolean; data?: Buffer } = {}) => {
    const data = o.data ?? body;
    const calls: (string | null)[] = [];
    const fetchImpl = async (_url: string, init?: { headers?: Record<string, string> }) => {
      const range = init?.headers?.Range ?? null;
      calls.push(range);
      const from = range && !o.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      let chunk = data.subarray(from);
      const cut = o.cut;
      if (cut !== undefined && calls.length === 1) chunk = chunk.subarray(0, cut);
      const failNow = cut !== undefined && calls.length === 1;
      // The chunk is delivered first; the connection then closes or "resets" once it was read.
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(chunk));
        },
        pull(c) {
          if (failNow) c.error(new Error('connection reset'));
          else c.close();
        },
      });
      return new Response(stream, { status: from ? 206 : 200, headers: { 'content-length': String(chunk.length) } });
    };
    return { fetchImpl, calls };
  };

  it('downloads, checks the hash and reports progress', async () => {
    const { fetchImpl } = server();
    const seen: number[] = [];
    const file = await core.downloadVerified({ url: 'https://x/a.exe', size: body.length, sha256: sha }, dir, { fetchImpl, onProgress: (n) => seen.push(n) });
    expect(readFileSync(file)).toEqual(body);
    expect(seen.at(-1)).toBe(body.length);
  });

  it('resumes an interrupted download with a Range request', async () => {
    const { fetchImpl, calls } = server({ cut: 10 });
    await expect(core.downloadVerified({ url: 'https://x/a.exe', size: body.length, sha256: sha }, dir, { fetchImpl })).rejects.toThrow(/reset/);
    const file = await core.downloadVerified({ url: 'https://x/a.exe', size: body.length, sha256: sha }, dir, { fetchImpl });
    expect(calls[1]).toBe('bytes=10-');
    expect(readFileSync(file)).toEqual(body);
  });

  it('starts over when the server ignores the Range request', async () => {
    const { fetchImpl } = server({ ignoreRange: true });
    writeFileSync(path.join(dir, 'a.exe.partial'), body.subarray(0, 5));
    const file = await core.downloadVerified({ url: 'https://x/a.exe', size: body.length, sha256: sha }, dir, { fetchImpl });
    expect(readFileSync(file)).toEqual(body);
  });

  it('deletes the file and fails when the hash does not match', async () => {
    const { fetchImpl } = server({ data: Buffer.from('evil bytes of the same length as the real one!!').subarray(0, body.length) });
    await expect(core.downloadVerified({ url: 'https://x/a.exe', size: body.length, sha256: sha }, dir, { fetchImpl })).rejects.toThrow(/integrity/i);
    expect(existsSync(path.join(dir, 'a.exe'))).toBe(false);
    expect(existsSync(path.join(dir, 'a.exe.partial'))).toBe(false);
  });

  it('reuses an already verified download', async () => {
    writeFileSync(path.join(dir, 'a.exe'), body);
    const { fetchImpl, calls } = server();
    await core.downloadVerified({ url: 'https://x/a.exe', size: body.length, sha256: sha }, dir, { fetchImpl });
    expect(calls).toHaveLength(0);
  });
});

// NoteTOO Updater: the trust and version logic (no Electron, unit-tested). A release is only
// believed when its manifest carries a valid Ed25519 signature from the release key, and an
// installer is only kept when its size and SHA-256 match that signed manifest.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';

export interface Manifest {
  app: 'NoteTOO';
  version: string;
  releasedAt: string;
  notes: string;
  /** HTTPS download URL of the NSIS installer */
  url: string;
  size: number;
  sha256: string;
}

export interface Install {
  version: string;
  dir: string;
  exe: string;
}

const VERSION = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;
const MAX_SIZE = 1024 * 1024 * 1024;

/** -1, 0 or 1. Only plain x.y.z versions exist in NoteTOO releases. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) throw new Error(`Not a version number: "${!pa ? a : b}"`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

export class TrustError extends Error {}

/** Checks the signature over the exact manifest bytes, then the manifest's fields. */
export function verifyManifest(bytes: Buffer, signatureB64: string, publicKeyPem: string): Manifest {
  let ok = false;
  try {
    const sig = Buffer.from(signatureB64.trim(), 'base64');
    ok = sig.length === 64 && verify(null, bytes, createPublicKey(publicKeyPem), sig);
  } catch {
    ok = false;
  }
  if (!ok) throw new TrustError('The release information has an invalid signature. It was not published by NoteTOO, or it was changed on the way.');

  let m: Record<string, unknown>;
  try {
    m = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TrustError('The release information is not valid JSON.');
  }
  const bad = (what: string) => new TrustError(`The release information has an invalid ${what}.`);
  if (m.app !== 'NoteTOO') throw bad('app name');
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) throw bad('version');
  if (typeof m.url !== 'string') throw bad('download address');
  let url: URL;
  try {
    url = new URL(m.url);
  } catch {
    throw bad('download address');
  }
  if (url.protocol !== 'https:' || !url.pathname.toLowerCase().endsWith('.exe')) throw bad('download address');
  if (typeof m.size !== 'number' || !Number.isInteger(m.size) || m.size <= 0 || m.size > MAX_SIZE) throw bad('size');
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) throw bad('checksum');
  return {
    app: 'NoteTOO',
    version: m.version,
    releasedAt: typeof m.releasedAt === 'string' ? m.releasedAt : '',
    notes: typeof m.notes === 'string' ? m.notes.slice(0, 4000) : '',
    url: url.toString(),
    size: m.size,
    sha256: m.sha256.toLowerCase(),
  };
}

/**
 * NoteTOO among the Windows uninstall entries (as PowerShell's ConvertTo-Json prints them: an
 * object for one entry, an array for several). The NSIS installer names it "NoteTOO <version>".
 */
export function pickInstall(entries: unknown, exists: (file: string) => boolean): Install | null {
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const { DisplayName, DisplayVersion, InstallLocation, UninstallString } = e as Record<string, unknown>;
    if (typeof DisplayName !== 'string' || !/^NoteTOO \d/.test(DisplayName)) continue;
    if (typeof DisplayVersion !== 'string' || !VERSION.test(DisplayVersion)) continue;
    // Per-user NSIS installs leave InstallLocation empty; the uninstaller sits in the program folder.
    const uninstaller = typeof UninstallString === 'string' ? /^\s*"([^"]+)"|^\s*(\S+)/.exec(UninstallString) : null;
    const dir = typeof InstallLocation === 'string' && InstallLocation ? InstallLocation : uninstaller ? path.win32.dirname(uninstaller[1] ?? uninstaller[2]) : '';
    if (!dir) continue;
    const exe = path.join(dir, 'NoteTOO.exe');
    if (exists(exe)) return { version: DisplayVersion, dir, exe };
  }
  return null;
}

/**
 * NoteTOO's installer (electron-builder NSIS) stops every process whose path starts with its
 * install folder, as plain text: "…\Programs\NoteTOO" also matches "…\Programs\NoteTOO Updater\…".
 * An updater living at such a path would be stopped by the installer it is running.
 */
export function stoppedByInstaller(updaterExe: string, installDir: string): boolean {
  return updaterExe.toLowerCase().startsWith(installDir.toLowerCase());
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Downloads `m.url` into `dir` and returns the verified file. Progress survives an interrupted
 * download: the `.partial` file is continued with a Range request next time. A file whose size
 * or SHA-256 differs from the signed manifest is deleted and never returned.
 */
export async function downloadVerified(
  m: Pick<Manifest, 'url' | 'size' | 'sha256'>,
  dir: string,
  o: { fetchImpl: FetchLike; signal?: AbortSignal; onProgress?: (bytes: number) => void },
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const name = path.basename(new URL(m.url).pathname).replace(/[^\w.-]/g, '_');
  const final = path.join(dir, name);
  const partial = final + '.partial';
  const fail = () => {
    rmSync(partial, { force: true });
    rmSync(final, { force: true });
    return new TrustError('The download failed its integrity check (wrong size or checksum), so it was deleted. Try again.');
  };

  if (existsSync(final)) {
    if (statSync(final).size === m.size && (await sha256Of(final)) === m.sha256) {
      o.onProgress?.(m.size);
      return final;
    }
    rmSync(final, { force: true });
  }

  let have = existsSync(partial) ? statSync(partial).size : 0;
  if (have > m.size) {
    rmSync(partial, { force: true });
    have = 0;
  }
  if (have < m.size) {
    const res = await o.fetchImpl(m.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: o.signal });
    if (!res.ok || !res.body) throw new Error(`The download server answered ${res.status}.`);
    if (res.status !== 206) have = 0; // Range ignored: start over
    const out = createWriteStream(partial, { flags: have ? 'a' : 'w' });
    const closed = new Promise<void>((resolve, reject) => {
      out.on('close', resolve);
      out.on('error', reject);
    });
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        have += value.length;
        if (have > m.size) throw fail();
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        o.onProgress?.(have);
      }
    } finally {
      out.end();
      await closed;
    }
  }
  if (statSync(partial).size !== m.size || (await sha256Of(partial)) !== m.sha256) throw fail();
  renameSync(partial, final);
  return final;
}

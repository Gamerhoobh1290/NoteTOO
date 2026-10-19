// The NoteTOO server's settings: %APPDATA%\NoteTOO\server.json, next to the desktop app's own
// settings and never in the school folder. The file is re-read when it changes, so
// `--add-folder` or `--new-key` from another window applies to a running server at once, and every
// save starts from what is on disk, so the two never undo each other's edits.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { makeKey } from '../electron/receive.mjs';

export const DEFAULT_PORT = 8787;

export interface ServerConfig {
  port: number;
  /** The folders browsers may open (absolute paths). Nothing else on this PC can be reached. */
  folders: string[];
  /** Access key typed on the sign-in page. */
  key: string;
  /** Signs session cookies; replaced together with the key, which signs every browser out. */
  secret: string;
  /** Folder opened last, reopened when a browser connects. */
  last: string | null;
  /** Extra host names to answer to, besides IP addresses, this PC's name, localhost and *.ts.net. */
  hosts: string[];
  /** The AI settings (src/ai/settings.ts), shared by every browser; validated by the page. */
  ai: Record<string, unknown> | null;
  /** The agent's settings (server/agent/tools.mts: scripts, Python, steps). */
  agent: Record<string, unknown> | null;
}

export const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function newCredentials() {
  return { key: makeKey(), secret: randomBytes(32).toString('hex') };
}

function parse(raw: Partial<ServerConfig>): ServerConfig {
  return {
    port: Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 ? raw.port! : DEFAULT_PORT,
    folders: strings(raw.folders).map((p) => path.resolve(p)),
    ...(typeof raw.key === 'string' && raw.key && typeof raw.secret === 'string' && raw.secret.length >= 32
      ? { key: raw.key, secret: raw.secret }
      : newCredentials()),
    last: typeof raw.last === 'string' ? raw.last : null,
    hosts: strings(raw.hosts).map((h) => h.toLowerCase()),
    ai: raw.ai && typeof raw.ai === 'object' && !Array.isArray(raw.ai) ? raw.ai : null,
    agent: raw.agent && typeof raw.agent === 'object' && !Array.isArray(raw.agent) ? raw.agent : null,
  };
}

/** The desktop app's recent folders, offered as the first shared folders. */
function desktopFolders(dataDir: string): string[] {
  try {
    const s = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) as { recent?: unknown; last?: unknown };
    return [...new Set([...(typeof s.last === 'string' ? [s.last] : []), ...strings(s.recent)])].filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export class ConfigStore {
  readonly file: string;
  private value: ServerConfig;
  private mtime = 0;

  constructor(readonly dataDir: string) {
    this.file = path.join(dataDir, 'server.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // First start: share the folders the desktop app already knows. Written back either way, so a
    // key added by parse() (first start, or removed by hand) is kept.
    this.value = this.readFile() ?? parse({ folders: desktopFolders(dataDir) });
    this.write(this.value);
  }

  private readFile(): ServerConfig | null {
    try {
      const st = statSync(this.file);
      const v = parse(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ServerConfig>);
      this.mtime = st.mtimeMs;
      return v;
    } catch {
      return null;
    }
  }

  private write(v: ServerConfig) {
    // Owner-only where the OS supports modes (on Windows, %APPDATA% is already private to the user).
    writeFileSync(this.file + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
    this.mtime = statSync(this.file).mtimeMs;
  }

  /** The current settings (re-read when the file changed). */
  get(): ServerConfig {
    try {
      if (statSync(this.file).mtimeMs !== this.mtime) this.value = this.readFile() ?? this.value;
    } catch {
      /* deleted: keep what we have; the next update writes it again */
    }
    return this.value;
  }

  update(fn: (c: ServerConfig) => void): ServerConfig {
    const v = structuredClone(this.get());
    fn(v);
    this.write(v);
    return (this.value = v);
  }
}

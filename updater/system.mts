// NoteTOO Updater: the Windows side effects. Finding the installed NoteTOO, closing it the
// way its own close button does (so it saves first), running the installer, starting NoteTOO.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pickInstall, type Install } from './core.mjs';

function powershell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { windowsHide: true, timeout: 20_000, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
}

const UNINSTALL_KEYS = [
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
];

/** The installed NoteTOO from the uninstall entry its installer wrote (per-user first). */
export async function findInstall(): Promise<Install | null> {
  const out = await powershell(
    `Get-ItemProperty ${UNINSTALL_KEYS.map((k) => `'${k}'`).join(',')} -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.DisplayName -like 'NoteTOO *' } | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString | ConvertTo-Json -Compress`,
  );
  return pickInstall(out ? JSON.parse(out) : null, existsSync);
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Process IDs of the installed NoteTOO (all its Electron processes). */
export async function runningPids(exe: string): Promise<number[]> {
  const out = await powershell('Get-Process -Name NoteTOO -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress');
  if (!out) return [];
  const list = ([] as { Id?: unknown; Path?: unknown }[]).concat(JSON.parse(out));
  return list.filter((p) => typeof p.Id === 'number' && typeof p.Path === 'string' && samePath(p.Path, exe)).map((p) => p.Id as number);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Asks NoteTOO to close like its window's close button (taskkill without /F sends WM_CLOSE).
 * NoteTOO then saves pending edits; if one cannot be saved it stays open and says so. Never
 * forces it. Resolves true once every NoteTOO process has exited.
 */
export async function closeGracefully(exe: string, timeoutMs = 25_000): Promise<boolean> {
  const pids = await runningPids(exe);
  if (!pids.length) return true;
  await new Promise<void>((resolve) => execFile('taskkill.exe', pids.flatMap((p) => ['/PID', String(p)]), { windowsHide: true }, () => resolve()));
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!pids.some(alive)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return !pids.some(alive);
}

/**
 * Runs the NSIS installer silently over the existing install. `/D=` must be the last argument
 * and unquoted (NSIS rule), hence the verbatim command line with a quoted program path.
 */
export function runInstaller(installer: string, dir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(installer, ['/S', `/D=${dir}`], { windowsVerbatimArguments: true, argv0: `"${installer}"`, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The installer did not finish within 5 minutes.'));
    }, 5 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

export function launch(exe: string) {
  spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
}

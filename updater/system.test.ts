// The updater's Windows process check, against real processes (Windows only).
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { runningPids } = await import('./system.mts');

describe.runIf(process.platform === 'win32')('runningPids', () => {
  let dir: string | null = null;
  let child: ChildProcess | null = null;
  afterEach(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child!.once('exit', r));
      child.kill();
      await exited; // Windows keeps the .exe locked until the process is gone
    }
    child = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('finds nothing, without failing, when that NoteTOO is not running', async () => {
    // PowerShell used to exit with code 1 when no NoteTOO process existed, which left the update stuck.
    expect(await runningPids(path.join(tmpdir(), 'no-such-folder', 'NoteTOO.exe'))).toEqual([]);
  });

  it('finds a running NoteTOO.exe by its path', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'notetoo-pids-'));
    const exe = path.join(dir, 'NoteTOO.exe');
    copyFileSync(process.execPath, exe); // any program, named like NoteTOO
    child = spawn(exe, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => child!.once('spawn', r));
    expect(await runningPids(exe)).toEqual([child.pid]);
    expect(await runningPids(path.join(dir, 'other', 'NoteTOO.exe'))).toEqual([]);
  }, 30_000);
});

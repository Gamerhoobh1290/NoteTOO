// The Python guard on a real interpreter: what scripts may do, what they may not, and attempts to
// switch the guard off from inside the script.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { runPython } = await import('./python.mts');
const hasPython = ['python3', 'python'].some((c) => spawnSync(c, ['-c', 'import sys; assert sys.version_info >= (3, 8)']).status === 0);

const base = mkdtempSync(path.join(tmpdir(), 'notetoo-py-'));
const root = path.join(base, 'School');
const outside = path.join(base, 'Outside');
let n = 0;

beforeAll(() => {
  mkdirSync(path.join(root, 'Maths'), { recursive: true });
  mkdirSync(path.join(root, '.noteTOO'));
  mkdirSync(outside);
  writeFileSync(path.join(root, 'Maths/a.txt'), 'old');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const run = (code: string) =>
  runPython({ code, root, workDir: path.join(base, 'work', String(++n)), backupDir: path.join(base, 'backup'), timeoutMs: 30_000, allowNetwork: false });
const lastLine = (s: string) => s.trim().split('\n').pop() ?? '';

describe.skipIf(!hasPython)('python guard', () => {
  it('writes inside the school folder, backs up what it changes, reports written files', async () => {
    const r = await run("open('Maths/a.txt','w').write('new'); open('Maths/b.md','w').write('# b'); print('ok')");
    expect(r).toMatchObject({ exitCode: 0, stdout: 'ok\n', written: ['Maths/a.txt', 'Maths/b.md'] });
    expect(readFileSync(path.join(base, 'backup/Maths/a.txt'), 'utf8')).toBe('old');
  });

  it.each([
    ['writing outside', `open(${JSON.stringify(path.join(outside, 'x'))}, 'w')`, /only write inside the school folder/],
    ['writing .noteTOO', "open('.noteTOO/x.json', 'w')", /only write inside the school folder/],
    ['deleting', "import os; os.remove('Maths/a.txt')", /cannot delete/],
    ['renaming an existing file', "import os; os.rename('Maths/a.txt', 'Maths/c.txt')", /cannot move or rename/],
    ['the network', "import socket; socket.create_connection(('127.0.0.1', 9))", /network access is blocked/],
  ])('blocks %s', async (_name, code, err) => {
    const r = await run(code);
    expect(r.exitCode).toBe(126);
    expect(lastLine(r.stderr)).toMatch(/^NoteTOO guard stopped the script: /);
    expect(lastLine(r.stderr)).toMatch(err);
  });

  it('starting programs and reading other personal files fail with an error libraries can handle', async () => {
    const r = await run(
      "import subprocess, os\ntry:\n    subprocess.run(['echo', 'x'])\nexcept OSError as e:\n    print('refused:', e)\ntry:\n    open(os.path.expanduser('~/.bashrc'))\nexcept OSError as e:\n    print('refused:', e)\nprint('still running')",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/refused: NoteTOO: starting programs is blocked[\s\S]*refused: NoteTOO: reading .* is blocked[\s\S]*still running/);
  });

  it('a blocked action ends the script: it cannot catch the error and carry on', async () => {
    const r = await run(
      `try:\n    open(${JSON.stringify(path.join(outside, 'first'))}, 'w')\nexcept BaseException as e:\n    print('caught', e.__traceback__)\nopen('Maths/after.txt', 'w').write('x')`,
    );
    expect(r.exitCode).toBe(126);
    expect(r.stdout).toBe('');
    expect(existsSync(path.join(root, 'Maths/after.txt'))).toBe(false);
  });

  it.each([
    ['through __main__', "import __main__; print(sorted(k for k in vars(__main__) if not k.startswith('__')))"],
    ['through the calling frames', "import sys; f = sys._getframe(1); print(sorted(f.f_globals), sorted(f.f_locals))"],
  ])('nothing of the guard is reachable %s', async (_name, code) => {
    const r = await run(code);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/busy|state|written|hook|ROOT|NET/);
  });

  it.each([
    ['gc', "import gc; [c for c in gc.get_objects() if isinstance(c, dict) and 'busy' in c][0]['busy'] = True"],
    ['tracing', 'import sys; sys.settrace(lambda *a: None)'],
    [
      'a custom path object that runs code inside the hook',
      `import sys
class P:
    def __fspath__(self):
        sys._getframe(1).f_locals
        return ${JSON.stringify(path.join(outside, 'y'))}
open(P(), 'w')`,
    ],
    [
      'a str subclass path',
      `class S(str):
    def startswith(self, *a): return True
open(S(${JSON.stringify(path.join(outside, 'z'))}), 'w')`,
    ],
  ])('cannot switch the guard off with %s', async (_name, code) => {
    const r = await run(`${code}\nopen(${JSON.stringify(path.join(outside, 'escaped'))}, 'w').write('x')`);
    expect(r.exitCode).toBe(126);
    expect(r.stderr).toMatch(/NoteTOO guard stopped the script/);
    expect(existsSync(path.join(outside, 'escaped'))).toBe(false);
    expect(existsSync(path.join(outside, 'y'))).toBe(false);
    expect(existsSync(path.join(outside, 'z'))).toBe(false);
  });

  it('pathlib paths and temporary files work', async () => {
    const r = await run(
      "import pathlib, tempfile, os\npathlib.Path('Maths/p.txt').write_text('p')\nt = tempfile.NamedTemporaryFile(delete=False); t.write(b'x'); t.close(); os.remove(t.name)\nprint(pathlib.Path('Maths/p.txt').read_text())",
    );
    expect(r).toMatchObject({ exitCode: 0, stdout: 'p\n' });
  });

  it('stops a script at its time limit', async () => {
    const r = await runPython({ code: 'while True: pass', root, workDir: path.join(base, 'work', 'loop'), backupDir: path.join(base, 'backup'), timeoutMs: 1500, allowNetwork: false });
    expect(r.timedOut).toBe(true);
  });
});

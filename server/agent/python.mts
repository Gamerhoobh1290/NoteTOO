// Python scripts the agent writes, run on the PC under guard: for work the built-in tools can't do
// (calculations, data processing, charts, converting files with libraries the user has installed).
//
// The guard is a Python audit hook (PEP 578) installed before the script runs. It is a safety net
// against mistakes, NOT a security boundary: code in the same process can defeat any Python-level
// guard (for example by replacing the os.path functions it relies on). That is why every script is
// shown to the user and runs only with their approval (tools.mts). A blocked action ends the script
// at once (no exception, so no traceback hands the script the guard's frame). It:
//  - allows writing only inside the school folder (never in .noteTOO) and the run's work folder,
//    and copies every existing file to the backup folder before it is first changed;
//  - blocks reading inside the user's home folder (keys, browser profiles…) except the school
//    folder, the work folder and Python's own installation and packages;
//  - blocks deleting files outside the work folder, starting programs, loading native code through
//    ctypes, the Windows registry, and network access (unless the user approved network access).
// Each run has a time limit (the whole process tree is killed), capped output, and on Linux/macOS
// a memory limit.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';

export const GUARD = String.raw`
def _install():
    # Everything the guard needs lives in this function's closure: the script cannot reach it
    # through __main__, its globals or a frame (the hook is never on the script's stack), and the
    # gc introspection that could find it is blocked below.
    import os, sys, shutil, json, atexit, tempfile, pathlib

    ROOT = os.path.realpath(os.environ['NOTETOO_ROOT'])
    WORK = os.path.realpath(os.environ['NOTETOO_WORK'])
    BACKUP = os.environ.pop('NOTETOO_BACKUP')
    NET = os.environ.get('NOTETOO_ALLOW_NET') == '1'
    norm = lambda p: os.path.normcase(os.path.realpath(p))
    N_ROOT, N_WORK = norm(ROOT), norm(WORK)
    N_TMP = norm(tempfile.gettempdir())
    N_HOME = norm(os.path.expanduser('~'))
    N_META = norm(os.path.join(ROOT, '.noteTOO'))
    py_dirs = set()
    for p in [sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix] + [x for x in sys.path if x]:
        try:
            if os.path.isdir(p):
                py_dirs.add(norm(p))
        except Exception:
            pass
    try:
        import site
        for p in site.getsitepackages() + [site.getusersitepackages()]:
            py_dirs.add(norm(p))
    except Exception:
        pass
    PY = frozenset(py_dirs)

    def inside(p, d):
        return p == d or p.startswith(d.rstrip(os.sep) + os.sep)

    def scratch(p):
        # the run's own folder (temporary files go there too: TEMP/TMP point into it)
        return inside(p, N_WORK) or (inside(p, N_TMP) and not inside(p, N_ROOT))

    def writable(p):
        return (inside(p, N_ROOT) and not inside(p, N_META)) or scratch(p)

    def readable(p):
        if writable(p) or inside(p, N_ROOT) or any(inside(p, d) for d in PY):
            return True
        return not inside(p, N_HOME)

    state = {'busy': False}
    written, backed, created = set(), set(), set()

    # The hook must never run the script's own code (a custom path object or a str subclass could
    # read the hook's frame): only plain values, and pathlib/DirEntry paths, are accepted.
    mro_of = type.__dict__['__mro__'].__get__
    dict_of = type.__dict__['__dict__'].__get__
    TRUSTED_FSPATH = (pathlib.PurePath.__dict__['__fspath__'], os.DirEntry.__dict__['__fspath__'])

    def plain(p):
        if isinstance(p, str):
            return str.__str__(p)
        if isinstance(p, bytes):
            return os.fsdecode(bytes.__getitem__(p, slice(None)))
        for k in mro_of(type(p)):
            f = dict_of(k).get('__fspath__')
            if f is not None:
                if f in TRUSTED_FSPATH:
                    return plain(f(p))
                break
        deny('unsupported path object (use a string or pathlib.Path)')

    def real(p):
        if p is None or isinstance(p, int):
            return None
        return norm(os.path.abspath(plain(p)))

    def original(p):
        return os.path.abspath(plain(p))

    def changing(p, orig):
        state['busy'] = True
        try:
            if not os.path.exists(orig):
                created.add(p)
            if p not in backed and inside(p, N_ROOT) and os.path.isfile(orig):
                backed.add(p)
                dst = os.path.join(BACKUP, os.path.relpath(orig, ROOT))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(orig, dst)
        finally:
            state['busy'] = False
        if inside(p, N_ROOT):
            written.add(os.path.relpath(orig, ROOT).replace(os.sep, '/'))

    BLOCKED_EXEC = ('subprocess.Popen', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn', 'os.startfile', 'os.fork',
                    'os.forkpty', 'pty.spawn', 'os.kill', 'os.killpg', 'ctypes.dlopen', 'ctypes.dlsym', 'ctypes.call_function',
                    'webbrowser.open', 'os.symlink', 'os.link', 'gc.get_objects', 'gc.get_referrers', 'gc.get_referents',
                    'sys.setprofile', 'sys.settrace')
    NET_EVENTS = ('socket.connect', 'socket.sendto', 'socket.sendmsg', 'socket.bind', 'socket.getaddrinfo',
                  'socket.gethostbyname', 'socket.gethostbyaddr', 'urllib.Request', 'http.client.connect', 'ftplib.connect',
                  'smtplib.connect', 'poplib.connect', 'imaplib.open', 'nntplib.connect', 'telnetlib.Telnet.open')

    def deny(msg):
        # No exception: its traceback would hand the script this frame. The script ends here.
        state['busy'] = True
        try:
            os.write(2, ('\nNoteTOO guard stopped the script: ' + msg + '\n').encode('utf-8', 'replace'))
            report()
        finally:
            os._exit(126)

    def hook(event, args):
        if state['busy']:
            return
        if event == 'open':
            target, mode, flags = args
            p = real(target)
            if p is None:
                return
            mode = str.__str__(mode) if isinstance(mode, str) else ''
            flags = int.__int__(flags) if isinstance(flags, int) else 0
            w = any(c in mode for c in 'wax+') or bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC))
            if w:
                if not writable(p):
                    deny('scripts may only write inside the school folder: %s' % p)
                changing(p, original(target))
            elif not readable(p):
                deny('reading %s is blocked (outside the school folder)' % p)
        elif event in ('os.remove', 'os.unlink', 'os.rmdir', 'shutil.rmtree'):
            p = real(args[0])
            if p is not None and not (scratch(p) or p in created):
                deny('scripts cannot delete files; ask NoteTOO to delete them (it asks you first): %s' % p)
        elif event in ('os.rename', 'os.replace'):
            src, dst = real(args[0]), real(args[1])
            if src is None or dst is None:
                return
            if not writable(dst):
                deny('scripts may only write inside the school folder: %s' % dst)
            if not (scratch(src) or src in created):
                deny('scripts cannot move or rename existing files; ask NoteTOO to move them (annotations move with them): %s' % src)
            changing(dst, original(args[1]))
        elif event in ('os.mkdir', 'os.chmod', 'os.chown', 'os.truncate', 'os.utime'):
            p = real(args[0])
            if p is not None and not writable(p):
                deny('scripts may only change things inside the school folder: %s' % p)
            if event == 'os.truncate' and p is not None:
                changing(p, original(args[0]))
        elif event.startswith(BLOCKED_EXEC):
            deny('this is blocked in scripts (%s)' % str.__str__(event))
        elif event.startswith('winreg.'):
            deny('the Windows registry is off limits to scripts')
        elif not NET and event.startswith(NET_EVENTS):
            deny('network access is blocked; ask again with network access if the task really needs it')

    def report():
        state['busy'] = True
        try:
            with open(os.path.join(WORK, '_written.json'), 'w', encoding='utf-8') as f:
                json.dump(sorted(written), f)
        except Exception:
            pass

    atexit.register(report)
    if os.name == 'posix':
        try:
            import resource
            limit = int(os.environ.get('NOTETOO_MEMORY_MB', '2048')) * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        except Exception:
            pass
    sys.addaudithook(hook)


def _run(script):
    import sys, types
    with open(script, encoding='utf-8') as f:
        code = compile(f.read(), 'script.py', 'exec')
    _install()
    # The script gets a fresh __main__: nothing of the guard is reachable from it.
    main = types.ModuleType('__main__')
    main.__file__ = script
    main.__builtins__ = __builtins__
    sys.modules['__main__'] = main
    sys.argv = ['script.py']
    exec(code, main.__dict__)


_script = __import__('sys').argv[1]
for _k in [k for k in globals() if k not in ('_run', '_install', '_script', '__builtins__', '__name__')]:
    del globals()[_k]
_run(_script)
`;

export interface PythonResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** files of the school folder the script wrote ('/'-separated) */
  written: string[];
  ms: number;
}

const MAX_OUTPUT = 200_000;

let found: { cmd: string; args: string[]; version: string } | null | undefined;

/** The Python on this PC: the configured one, else the Windows launcher (py -3), python3, python. */
export function findPython(configured?: string): { cmd: string; args: string[]; version: string } | null {
  if (!configured && found !== undefined) return found;
  const candidates: [string, string[]][] = configured
    ? [[configured, []]]
    : process.platform === 'win32'
      ? [['py', ['-3']], ['python', []], ['python3', []]]
      : [['python3', []], ['python', []]];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const version = r.stdout?.trim();
    // Audit hooks need Python 3.8+; the Microsoft Store stub prints nothing.
    if (r.status === 0 && /^3\.(8|9|\d\d)\./.test(version ?? '')) {
      const hit = { cmd, args, version };
      if (!configured) found = hit;
      return hit;
    }
  }
  if (!configured) found = null;
  return null;
}

function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export async function runPython(o: {
  code: string;
  /** the school folder (absolute) */
  root: string;
  /** a fresh folder for this run */
  workDir: string;
  /** where files are copied before the script changes them */
  backupDir: string;
  timeoutMs: number;
  allowNetwork: boolean;
  python?: string;
  signal?: AbortSignal;
}): Promise<PythonResult> {
  const py = findPython(o.python);
  if (!py) {
    throw new Error(
      o.python
        ? `The Python set in the agent settings (${o.python}) does not run, or is older than 3.8.`
        : 'Python 3.8 or later was not found on the PC. Install it from python.org (tick "Add python.exe to PATH"), then try again.',
    );
  }
  mkdirSync(path.join(o.workDir, 'tmp'), { recursive: true });
  await fsp.writeFile(path.join(o.workDir, '_guard.py'), GUARD);
  await fsp.writeFile(path.join(o.workDir, 'script.py'), o.code);
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  Object.assign(env, {
    NOTETOO_ROOT: o.root,
    NOTETOO_WORK: o.workDir,
    NOTETOO_BACKUP: o.backupDir,
    NOTETOO_ALLOW_NET: o.allowNetwork ? '1' : '0',
    MPLCONFIGDIR: path.join(o.workDir, 'mpl'),
    TEMP: path.join(o.workDir, 'tmp'),
    TMP: path.join(o.workDir, 'tmp'),
    TMPDIR: path.join(o.workDir, 'tmp'),
    MPLBACKEND: 'Agg',
  });
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(py.cmd, [...py.args, '-B', '-E', '-X', 'utf8', path.join(o.workDir, '_guard.py'), path.join(o.workDir, 'script.py')], {
      cwd: o.root,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, d: Buffer) => (s.length < MAX_OUTPUT ? s + d.toString('utf8') : s);
    child.stdout.on('data', (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on('data', (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, o.timeoutMs);
    const onAbort = () => child.pid && killTree(child.pid);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', async (exitCode) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      let written: string[] = [];
      const log = path.join(o.workDir, '_written.json');
      if (existsSync(log)) written = (JSON.parse(await fsp.readFile(log, 'utf8').catch(() => '[]')) as string[]).filter((p) => typeof p === 'string');
      resolve({ exitCode, timedOut, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), written, ms: Date.now() - started });
    });
  });
}

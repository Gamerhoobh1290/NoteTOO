// Recycle Bin for the NoteTOO server (Electron's shell.trashItem is not available in plain Node.js):
// the Windows shell's own delete with undo, without any dialog, since nobody may be at the PC to
// answer one. The path is passed in an environment variable, never inside the script.

import { execFile } from 'node:child_process';

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NoteTooRecycleBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Send(string path) {
    // FO_DELETE; FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT
    var op = new SHFILEOPSTRUCT { wFunc = 3, pFrom = path + "\\0\\0", fFlags = 0x40 | 0x10 | 0x400 | 0x4 };
    int r = SHFileOperation(ref op);
    return r != 0 ? r : (op.fAnyOperationsAborted ? -1 : 0);
  }
}
'@
$r = [NoteTooRecycleBin]::Send($env:NOTETOO_RECYCLE_PATH)
if ($r -ne 0) { [Console]::Error.Write("Windows error $r"); exit 1 }
`;
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

export function moveToRecycleBin(full: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.reject(new Error('The Recycle Bin is only available on Windows.'));
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      { env: { ...process.env, NOTETOO_RECYCLE_PATH: full }, windowsHide: true, timeout: 60_000 },
      (err, _stdout, stderr) => (err ? reject(new Error(/Windows error -?\d+/.exec(String(stderr))?.[0] ?? err.message)) : resolve()),
    );
  });
}

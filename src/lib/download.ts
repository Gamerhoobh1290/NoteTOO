// Downloading from the NoteTOO server: saves a copy on this computer (e.g. the laptop). The files
// stay in the school folder on the PC; nothing there is moved or changed. Only when the page is
// served by the NoteTOO server (the desktop app and a local folder already are on this computer).

import { desktop } from '../desktop/bridge';
import { errorMessage, toast } from './ui';

export const canDownload = desktop?.mode === 'server';

/** Starts a download of `url` with the browser's own download manager. */
function save(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

/** Saves a copy of one file. */
export function downloadFile(rootId: string, path: string) {
  save(`${desktop!.fileUrl(rootId, path)}?download=1`);
  toast('Downloading a copy to this computer. The file stays on your PC.');
}

/** Saves files and folders as one .zip (prepared on the PC, then streamed). */
export async function downloadZip(rootId: string, paths: string[], name?: string) {
  let res: Response;
  try {
    res = await fetch('/api/zip/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: rootId, paths, name }),
      cache: 'no-store',
    });
  } catch {
    return toast("Can't reach NoteTOO on your PC. Check that the PC is on and the NoteTOO server is running.", 'error');
  }
  const j = (await res.json().catch(() => ({}))) as { id?: string; name?: string; files?: number; bytes?: number; error?: string };
  if (!res.ok || !j.id) return toast(`Could not download: ${j.error ?? `the server answered with an error (${res.status})`}`, 'error');
  try {
    save(`/api/zip/${j.id}`);
    const mb = (j.bytes ?? 0) / 1024 / 1024;
    toast(`Downloading “${j.name}” (${j.files} file${j.files === 1 ? '' : 's'}, ${mb < 1 ? '< 1' : Math.round(mb)} MB). The originals stay on your PC.`);
  } catch (e) {
    toast(`Could not download: ${errorMessage(e)}`, 'error');
  }
}

import { extName } from '../fs/paths';
import type { SheetData } from '../components/previews/sheetWorker';

export type { SheetData };

/** Parses a spreadsheet in a worker so large workbooks don't freeze the page. */
export function readSheets(file: File, signal?: AbortSignal): Promise<SheetData[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../components/previews/sheetWorker.ts', import.meta.url), { type: 'module' });
    const done = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = (e: MessageEvent<{ sheets?: SheetData[]; error?: string }>) => {
      done();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.sheets ?? []);
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message));
    };
    (async () => {
      const data = extName(file.name) === 'csv' ? await file.text() : await file.arrayBuffer();
      worker.postMessage({ data }, typeof data === 'string' ? [] : [data]);
    })().catch((e) => {
      done();
      reject(e);
    });
  });
}

// Parses spreadsheets off the main thread so large workbooks don't freeze the UI.
import * as XLSX from 'xlsx';

export const MAX_ROWS = 2000;
export const MAX_COLS = 200;

export interface SheetData {
  name: string;
  rows: string[][];
  totalRows: number;
  totalCols: number;
}

self.onmessage = (e: MessageEvent<{ data: ArrayBuffer | string }>) => {
  try {
    const { data } = e.data;
    const wb = typeof data === 'string' ? XLSX.read(data, { type: 'string', dense: true }) : XLSX.read(data, { type: 'array', dense: true });
    const sheets: SheetData[] = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const all = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '', blankrows: true });
      const totalCols = all.reduce((m, r) => Math.max(m, r.length), 0);
      return {
        name,
        rows: all.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map((c) => String(c))),
        totalRows: all.length,
        totalCols,
      };
    });
    self.postMessage({ sheets });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};

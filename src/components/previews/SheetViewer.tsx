import { useEffect, useState } from 'react';
import { readSheets, type SheetData } from '../../lib/sheets';
import { errorMessage } from '../../lib/ui';
import { Spinner, cls } from '../common';

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + colName(i % 26));

export default function SheetViewer({ file }: { file: File }) {
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    setSheets(null);
    setError(null);
    setCurrent(0);
    const ac = new AbortController();
    readSheets(file, ac.signal).then(setSheets, (e) => {
      if ((e as DOMException).name !== 'AbortError') setError(`Could not read this spreadsheet: ${errorMessage(e)}`);
    });
    return () => ac.abort();
  }, [file]);

  if (error) return <div className="empty">{error}</div>;
  if (!sheets) return <Spinner label="Reading spreadsheet…" />;
  if (!sheets.length) return <div className="empty">This workbook has no sheets.</div>;

  const sheet = sheets[Math.min(current, sheets.length - 1)];
  const cols = Math.min(sheet.totalCols, 200);
  const truncated = sheet.totalRows > sheet.rows.length || sheet.totalCols > cols;
  return (
    <>
      {truncated && (
        <div className="notice">
          Large sheet: showing the first {sheet.rows.length} rows and {cols} columns of {sheet.totalRows} × {sheet.totalCols}.
        </div>
      )}
      <div className="sheet-scroll">
        {sheet.rows.length ? (
          <table className="sheet">
            <thead>
              <tr>
                <th />
                {Array.from({ length: cols }, (_, i) => (
                  <th key={i}>{colName(i)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((r, i) => (
                <tr key={i}>
                  <th>{i + 1}</th>
                  {Array.from({ length: cols }, (_, j) => (
                    <td key={j} title={r[j] && r[j].length > 40 ? r[j] : undefined}>
                      {r[j] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">This sheet is empty.</div>
        )}
      </div>
      <div className="sheet-tabs" role="tablist" aria-label="Sheets">
        {sheets.map((s, i) => (
          <button key={s.name + i} role="tab" aria-selected={i === current} className={cls('sheet-tab', i === current && 'on')} onClick={() => setCurrent(i)}>
            {s.name}
          </button>
        ))}
      </div>
    </>
  );
}

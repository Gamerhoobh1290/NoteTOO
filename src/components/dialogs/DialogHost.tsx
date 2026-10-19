import { useEffect, useRef, useState } from 'react';
import { useDialog, type DialogRequest } from '../../lib/ui';
import { windowsApp } from '../../desktop/bridge';

export const SHORTCUTS: [string, string][] = [
  ['Ctrl+K or /', 'Search files'],
  ['Esc', 'Clear search / close panel or dialog'],
  ['Alt+1', 'Toggle sidebar'],
  ['Alt+2', 'Toggle annotations panel'],
  ['Alt+3', 'Toggle scratchpad'],
  ['Alt+4', 'Toggle AI assistant'],
  ['← / →  or  P / N', 'Previous / next PDF page'],
  ['+ / −', 'Zoom in / out (PDF, image)'],
  ['Ctrl+F', 'Search inside the open PDF'],
  ['V / H / C', 'Select, Highlight area, Comment pin tools (PDF, image)'],
  ['?', 'Show this list'],
  ...(windowsApp
    ? ([
        ['Ctrl+O', 'Open another folder'],
        ['F5', 'Re-scan the folder'],
        ['Ctrl+= / Ctrl+− / Ctrl+0', 'Zoom the window in / out / reset'],
        ['F11', 'Full screen'],
      ] as [string, string][])
    : []),
];

const keys = new WeakMap<DialogRequest, number>();
let nextKey = 0;
function dialogKey(d: DialogRequest): number {
  if (!keys.has(d)) keys.set(d, ++nextKey);
  return keys.get(d)!;
}

export function DialogHost() {
  const d = useDialog();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current!;
    if (d && !el.open) el.showModal();
    if (!d && el.open) el.close();
  }, [d]);

  const cancel = () => {
    if (!d) return;
    if (d.kind === 'confirm') d.resolve(false);
    else d.resolve(null);
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      {d && <DialogBody key={dialogKey(d)} d={d} cancel={cancel} />}
    </dialog>
  );
}

function DialogBody({ d, cancel }: { d: DialogRequest; cancel: () => void }) {
  const [value, setValue] = useState(d.kind === 'prompt' ? (d.initial ?? '') : d.kind === 'choice' ? (d.options[0]?.value ?? '') : '');
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (d.kind === 'prompt' && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(0, d.selectEnd ?? inputRef.current.value.length);
    }
  }, [d]);

  if (d.kind === 'shortcuts') {
    return (
      <div className="dialog-body">
        <h2>Keyboard shortcuts</h2>
        <table className="shortcuts">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="dialog-actions">
          <button className="btn primary" autoFocus onClick={() => d.resolve(null)}>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (d.kind === 'confirm') {
    return (
      <div className="dialog-body">
        <h2>{d.title}</h2>
        <p className="dialog-message">{d.message}</p>
        <div className="dialog-actions">
          <button className="btn" autoFocus onClick={cancel}>
            Cancel
          </button>
          <button className={d.danger ? 'btn danger' : 'btn primary'} onClick={() => d.resolve(true)}>
            {d.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    );
  }

  const error = d.kind === 'prompt' ? (d.validate?.(value.trim()) ?? null) : value ? null : 'Choose an option.';
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!error) d.resolve(d.kind === 'prompt' ? value.trim() : value);
  };

  return (
    <form className="dialog-body" onSubmit={submit}>
      <h2>{d.title}</h2>
      <label className="field">
        <span>{d.label}</span>
        {d.kind === 'prompt' ? (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
            }}
            aria-invalid={touched && !!error}
          />
        ) : d.options.length ? (
          <select autoFocus size={Math.min(12, d.options.length)} value={value} onChange={(e) => setValue(e.target.value)}>
            {d.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <p className="muted">No other folders available.</p>
        )}
      </label>
      {touched && error && <p className="field-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={cancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!!error}>
          {d.confirmLabel ?? 'OK'}
        </button>
      </div>
    </form>
  );
}

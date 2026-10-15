// Desktop app: "Receive from phone". The top-bar button (highlighted while receiving) opens a dialog
// that switches the LAN server in the main process on and off and shows the QR code, address and key.
// Arrivals re-scan the folder and say where the files went.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, KeyRound, ShieldAlert, Smartphone } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { desktop, type ReceivedFile, type ReceiveState } from '../desktop/bridge';
import { baseName, parentPath } from '../fs/paths';
import { errorMessage, toast } from '../lib/ui';
import { useApp } from '../state/AppContext';
import { formatSize } from '../lib/fileKinds';
import { cls } from './common';

/** The key as shown and typed: XXXX-XXXX-XXXX. */
const formatKey = (k: string) => k.match(/.{1,4}/g)!.join('-');

function QrCode({ text }: { text: string }) {
  const { size, d } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { size: n, d };
  }, [text]);
  // Dark on white with a quiet zone, also in dark mode: that is what phone cameras read reliably.
  return (
    <svg className="receive-qr" viewBox={`-4 -4 ${size + 8} ${size + 8}`} role="img" aria-label="QR code with the address and key" shapeRendering="crispEdges">
      <rect x={-4} y={-4} width={size + 8} height={size + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

export function ReceiveButton() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ReceiveState | null>(null);
  const refreshRef = useRef(app.refresh);
  refreshRef.current = app.refresh;
  const setViewRef = useRef(app.setView);
  setViewRef.current = app.setView;

  // Arrivals come in bursts (several photos): re-scan and announce once they settle.
  useEffect(() => {
    if (!desktop) return;
    /** Newest file already handled; undefined until the first state (files from before don't count). */
    let newest: string | null | undefined;
    const id = (f: ReceivedFile) => `${f.at}:${f.path}`;
    let pending: ReceivedFile[] = [];
    let timer: number | undefined;
    const flush = async () => {
      const files = pending;
      pending = [];
      await refreshRef.current();
      const dirs = [...new Set(files.map((f) => parentPath(f.path)))];
      const what = files.length === 1 ? `"${baseName(files[0].path)}"` : `${files.length} files`;
      const where = dirs.length === 1 ? dirs[0] : `${dirs.length} folders`;
      toast(`Received ${what} in ${where}.`, 'info', { label: 'Open', run: () => setViewRef.current({ kind: 'file', path: files[0].path }) });
    };
    const onState = (s: ReceiveState) => {
      setState(s);
      // The list is newest first and capped, so compare with the newest file seen, not the length.
      const at = newest ? s.files.findIndex((f) => id(f) === newest) : -1;
      const fresh = newest === undefined ? [] : at === -1 ? s.files : s.files.slice(0, at);
      newest = s.files[0] ? id(s.files[0]) : null;
      if (fresh.length) {
        pending.push(...fresh);
        clearTimeout(timer);
        timer = window.setTimeout(() => void flush(), 800);
      }
    };
    void desktop.receiveState().then(onState);
    const off = desktop.onReceiveState(onState);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <button
        className={cls('icon-btn', state?.running && 'active')}
        title={state?.running ? 'Receiving from phone (click for details)' : 'Receive from phone'}
        aria-label="Receive from phone"
        aria-pressed={!!state?.running}
        onClick={() => {
          if (desktop) setOpen(true);
          else toast('Receive from phone is only available in the NoteTOO desktop app for Windows.');
        }}
      >
        <Smartphone size={17} />
      </button>
      {desktop && <ReceiveDialog open={open} state={state} close={() => setOpen(false)} />}
    </>
  );
}

function ReceiveDialog({ open, state, close }: { open: boolean; state: ReceiveState | null; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog receive-dialog"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {open && <ReceiveBody state={state} close={close} />}
    </dialog>
  );
}

function ReceiveBody({ state, close }: { state: ReceiveState | null; close: () => void }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const bridge = desktop!;
  const running = !!state?.running;
  const url = state?.urls[0];

  const toggle = async () => {
    const root = app.fs?.desktop?.rootId;
    if (!root) return;
    setBusy(true);
    try {
      await (running ? bridge.receiveStop() : bridge.receiveStart(root));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(formatKey(state!.key!));
      toast('Key copied.');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="dialog-body">
      <h2>Receive from phone</h2>
      <p className="muted hint">
        Send photos and videos from your phone's browser straight into “{app.fs?.rootName}”, in their original quality.
      </p>

      <label className="receive-switch">
        <input type="checkbox" role="switch" checked={running} disabled={busy} onChange={() => void toggle()} />
        <span>{running ? 'Receiving' : 'Off'}</span>
      </label>
      {state?.error && <p className="field-error receive-error">{state.error}</p>}

      {running && url && state.key && (
        <div className="receive-connect">
          <QrCode text={`${url}/#k=${state.key}`} />
          <div className="receive-steps">
            <p>Scan with the phone's camera, or open this address in Safari:</p>
            {state.urls.map((u) => (
              <code key={u} className="receive-url">
                {u}
              </code>
            ))}
            {state.urls.length > 1 && <p className="muted hint">Several networks found. If the first address doesn't open, try the next.</p>}
            <div className="receive-key">
              <KeyRound size={15} aria-hidden />
              <code aria-label="Access key">{showKey ? formatKey(state.key) : '••••-••••-••••'}</code>
              <button className="icon-btn small" title={showKey ? 'Hide key' : 'Show key'} aria-label={showKey ? 'Hide key' : 'Show key'} onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button className="icon-btn small" title="Copy key" aria-label="Copy key" onClick={() => void copyKey()}>
                <Copy size={15} />
              </button>
            </div>
            <button className="btn small" onClick={() => void bridge.receiveNewKey()}>
              New key
            </button>
          </div>
        </div>
      )}

      {!!state?.files.length && (
        <section className="receive-files" aria-label="Received files">
          <h3>Received ({state.files.length})</h3>
          <ul>
            {state.files.map((f) => (
              <li key={`${f.path}:${f.at}`}>
                <button
                  className="receive-file"
                  title={`Open ${f.path}`}
                  onClick={() => {
                    app.setView({ kind: 'file', path: f.path });
                    close();
                  }}
                >
                  <span className="receive-file-name">{baseName(f.path)}</span>
                  <span className="muted">
                    {parentPath(f.path)} · {formatSize(f.size)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="receive-notes muted">
        <p>The phone must be on the same Wi-Fi as this PC. The first time, Windows may ask whether NoteTOO can use the network: allow it on private networks.</p>
        <p className="receive-warning">
          <ShieldAlert size={15} aria-hidden />
          <span>The connection is not encrypted, and anyone with the key can add files while this is on. Don't use it on public Wi-Fi, and switch it off when you're done.</span>
        </p>
      </div>

      <div className="dialog-actions">
        <button className="btn primary" autoFocus onClick={close}>
          Close
        </button>
      </div>
    </div>
  );
}

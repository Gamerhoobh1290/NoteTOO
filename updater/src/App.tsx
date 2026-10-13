import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Phase, UpdaterState } from '../bridge';
import { formatSize } from '../../src/lib/fileKinds';

const api = window.updater;

/** Which of the three steps a phase belongs to (null: no update running). */
const STEP: Partial<Record<Phase, 0 | 1 | 2>> = { downloading: 0, verifying: 1, 'confirm-close': 2, closing: 2, installing: 2 };
const STEPS = ['Download', 'Verify', 'Install'];

function time(iso?: string) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function Status({ s }: { s: UpdaterState }) {
  const next = s.latest?.version;
  switch (s.phase) {
    case 'detecting':
      return <p className="status">Looking for NoteTOO on this PC…</p>;
    case 'not-installed':
      return (
        <div className="status">
          <h1>NoteTOO isn’t installed</h1>
          <p className="muted">The updater updates an installed NoteTOO. Get the NoteTOO installer from the releases page first.</p>
        </div>
      );
    case 'idle':
    case 'checking':
      return <p className="status">Checking for updates…</p>;
    case 'up-to-date':
      return (
        <div className="status">
          <h1>NoteTOO is up to date</h1>
          <p className="muted">Last checked {time(s.checkedAt)}.</p>
        </div>
      );
    case 'available':
      return (
        <div className="status">
          <h1>NoteTOO {next} is available</h1>
          <p className="muted">
            {s.latest!.releasedAt && `Released ${time(s.latest!.releasedAt)}. `}Download size {formatSize(s.latest!.size)}. Your notes, annotations and settings are kept.
          </p>
        </div>
      );
    case 'downloading':
      return (
        <div className="status">
          <h1>Downloading NoteTOO {next}</h1>
          <p className="muted num">
            {formatSize(s.progress?.done ?? 0)} of {formatSize(s.progress?.total ?? s.latest?.size ?? 0)}
          </p>
        </div>
      );
    case 'verifying':
      return (
        <div className="status">
          <h1>Verifying the download</h1>
          <p className="muted">Checking that it is the file NoteTOO published, unchanged.</p>
        </div>
      );
    case 'confirm-close':
      return (
        <div className="status">
          <h1>Close NoteTOO to install</h1>
          <p className="muted">NoteTOO is open. It saves your work before closing, then the update installs.</p>
        </div>
      );
    case 'closing':
      return (
        <div className="status">
          <h1>Closing NoteTOO</h1>
          <p className="muted">Waiting for NoteTOO to save and close…</p>
        </div>
      );
    case 'installing':
      return (
        <div className="status">
          <h1>Installing NoteTOO {next}</h1>
          <p className="muted">{s.step}</p>
        </div>
      );
    case 'done':
      return (
        <div className="status">
          <h1>NoteTOO {s.installed?.version} is installed</h1>
          <p className="muted">Your notes, annotations and settings were kept.</p>
        </div>
      );
    case 'error':
      return (
        <div className="status" role="alert">
          <h1 className="danger">{s.error!.title}</h1>
          <p className="muted">{s.error!.detail}</p>
        </div>
      );
  }
}

function Steps({ s }: { s: UpdaterState }) {
  const at = STEP[s.phase];
  if (at === undefined) return null;
  const pct = s.progress && s.progress.total ? (s.progress.done / s.progress.total) * 100 : 0;
  return (
    <ol className="steps" aria-label="Update progress">
      {STEPS.map((label, i) => {
        const st = i < at ? 'done' : i === at ? 'now' : 'todo';
        const determinate = i === 0 && s.phase === 'downloading';
        return (
          <li key={label} className={`step ${st}`} aria-current={st === 'now' ? 'step' : undefined}>
            <div
              className={`track${st === 'now' && !determinate ? ' busy' : ''}`}
              role={st === 'now' ? 'progressbar' : undefined}
              aria-valuenow={determinate ? Math.round(pct) : undefined}
              aria-valuemin={determinate ? 0 : undefined}
              aria-valuemax={determinate ? 100 : undefined}
              aria-label={st === 'now' ? label : undefined}
            >
              <span style={{ width: st === 'done' ? '100%' : determinate ? `${pct}%` : undefined }} />
            </div>
            <span className="step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Actions({ s }: { s: UpdaterState }) {
  const btn = (label: string, run: () => void, primary = false) => (
    <button key={label} className={`btn${primary ? ' primary' : ''}`} onClick={run}>
      {label}
    </button>
  );
  switch (s.phase) {
    case 'not-installed':
      return btn('Open releases page', api.openReleasesPage, true);
    case 'up-to-date':
      return btn('Check again', api.check);
    case 'available':
      return [btn('Check again', api.check), btn('Download and install', api.update, true)];
    case 'downloading':
      return btn('Cancel', api.cancel);
    case 'confirm-close':
      return [btn('Not now', api.cancel), btn('Close NoteTOO and install', api.closeAndInstall, true)];
    case 'done':
      return btn('Open NoteTOO', api.openNoteToo, true);
    case 'error':
      return [
        ...(s.error!.retry === 'check' ? [btn('Open releases page', api.openReleasesPage)] : []),
        btn('Try again', api.retry, true),
      ];
    default:
      return null;
  }
}

export default function App() {
  const [s, setS] = useState<UpdaterState | null>(null);
  useEffect(() => {
    const off = api.onState(setS);
    void api.getState().then(setS);
    return off;
  }, []);
  if (!s) return null;

  const latest = s.latest?.version;
  const newer = latest && s.installed && latest !== s.installed.version && s.phase !== 'up-to-date';
  const showNotes = s.latest?.notes && ['available', 'downloading', 'verifying', 'confirm-close', 'closing', 'installing', 'done'].includes(s.phase);

  return (
    <div className="shell">
      <header className="topbar">
        <img src="./icon.png" alt="" width={18} height={18} />
        <span className="brand">NoteTOO Updater</span>
      </header>
      <main className="body">
        <section className="versions" aria-label="Versions">
          <div className="version">
            <span className="v-label">Installed</span>
            <span className="v-num">{s.installed?.version ?? '–'}</span>
          </div>
          <div className={`version${newer ? ' next' : ''}`}>
            <span className="v-label">Latest</span>
            <span className="v-num">{latest ?? '–'}</span>
          </div>
        </section>
        <div aria-live="polite">
          <Status s={s} />
        </div>
        <Steps s={s} />
        {showNotes && (
          <section className="notes" aria-label={`What’s new in ${latest}`}>
            <h2>What’s new in {latest}</h2>
            <div className="notes-body">
              <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>
                {s.latest!.notes}
              </Markdown>
            </div>
          </section>
        )}
      </main>
      <footer className="actions">
        <span className="muted small">Updater {s.updaterVersion}</span>
        <div className="buttons">
          <Actions s={s} />
        </div>
      </footer>
    </div>
  );
}

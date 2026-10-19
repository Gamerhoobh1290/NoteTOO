import { Folder, FolderOpen, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { desktop } from '../desktop/bridge';
import { useApp } from '../state/AppContext';
import { Spinner } from './common';

/** Connected to the NoteTOO server: the folders are the ones it shares from the PC. */
const server = desktop?.mode === 'server';

export function StartScreen() {
  const app = useApp();

  if (app.phase === 'starting') {
    return (
      <div className="start">
        <Spinner label="Opening your folder…" />
      </div>
    );
  }

  if (app.phase === 'unsupported') {
    return (
      <div className="start">
        <div className="start-card">
          <TriangleAlert size={36} className="warn" />
          <h1>Chrome or Edge is required</h1>
          <p>
            NoteTOO saves everything as real files in a folder on your PC, using the File System Access API. This browser
            does not support it. Please open NoteTOO in a recent version of <strong>Google Chrome</strong> or{' '}
            <strong>Microsoft Edge</strong> on a computer.
          </p>
          {import.meta.env.DEV && (
            <button className="link-btn" onClick={app.openSample}>
              Use the sample folder (dev only)
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="start">
      <div className="start-card">
        <h1 className="start-title">NoteTOO</h1>
        <p className="muted">Organize, preview and annotate your school files.</p>
        {!server && (
          <button className="btn primary big" onClick={app.openFolder} autoFocus>
            <FolderOpen size={20} /> {desktop ? 'Open a folder…' : 'Open my school folder'}
          </button>
        )}
        {server && app.recent.length === 0 && (
          <p className="start-note">
            Your PC does not share any folder yet. On the PC, run <code>NoteTOO-Server.cmd --add-folder "D:\School"</code>,
            then reload this page.
          </p>
        )}
        {desktop && app.recent.length > 0 && (
          <section className="recent" aria-labelledby="recent-title">
            <h2 id="recent-title">{server ? 'Folders on your PC' : 'Recent folders'}</h2>
            <ul>
              {app.recent.map((p) => (
                <li key={p}>
                  <button className="recent-open" onClick={() => app.openRecent(p)} title={`Open ${p}`}>
                    <Folder size={18} aria-hidden />
                    <span className="recent-text">
                      <span className="recent-name">{p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p}</span>
                      <span className="recent-path">{p}</span>
                    </span>
                  </button>
                  {!server && (
                    <button className="icon-btn small recent-forget" title="Remove from this list" aria-label={`Remove ${p} from recent folders`} onClick={() => app.forgetRecent(p)}>
                      <X size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="start-note">
          {server
            ? 'NoteTOO runs on your PC: your files, notes and AI stay there, and everything you change is saved there.'
            : desktop
            ? 'Everything you create (notes, comments, highlights) is saved as files inside that folder, so your drive sync keeps it. NoteTOO reopens it the next time it starts.'
            : 'Everything you create (notes, comments, highlights) is saved as files inside that folder, so your drive sync keeps it. Nothing is stored in the browser, which is why NoteTOO asks for the folder each time it starts.'}
        </p>
        {import.meta.env.DEV && !desktop && (
          <button className="link-btn" onClick={app.openSample}>
            Use the sample folder (dev only, in memory)
          </button>
        )}
      </div>
    </div>
  );
}

/** Shown over the app when the folder permission was revoked; keeps unsaved edits mounted. */
export function ReconnectOverlay() {
  const app = useApp();
  return (
    <div className="overlay" role="alertdialog" aria-modal="true" aria-labelledby="reconnect-title">
      <div className="start-card">
        <ShieldAlert size={36} className="warn" />
        <h2 id="reconnect-title">Access to “{app.fs?.rootName}” was lost</h2>
        <p>
          {server
            ? 'NoteTOO on your PC can no longer reach this folder: it was moved or renamed, it is on a drive that was disconnected, or it is no longer shared. Unsaved changes are kept until you reconnect.'
            : desktop
            ? 'The folder is no longer available: it was moved or renamed, or it is on a drive that was disconnected. Put it back and reconnect, or choose another folder; unsaved changes are kept until then.'
            : 'The browser no longer allows NoteTOO to read or write this folder (permission revoked, or the folder was moved). Reconnect to continue; unsaved changes are kept until then.'}
        </p>
        <div className="row-actions">
          <button className="btn primary" onClick={app.reconnect} autoFocus>
            Reconnect to folder
          </button>
          <button className="btn" onClick={server ? app.closeFolder : app.openFolder}>
            Choose another folder
          </button>
        </div>
      </div>
    </div>
  );
}

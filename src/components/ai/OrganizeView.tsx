import { ArrowRight, FolderPlus, ListTree, Settings, Sparkles, X } from 'lucide-react';
import { baseName, extName, splitPath, validateName } from '../../fs/paths';
import { useApp } from '../../state/AppContext';
import { useAi } from '../../state/AiContext';
import { FileIcon, Spinner } from '../common';

/** Problem with a destination the user typed, or null. */
function destError(from: string, to: string): string | null {
  const segs = splitPath(to.trim());
  if (segs.length < 2) return 'Use Subject/Section/…/name.';
  for (const s of segs) {
    const err = validateName(s);
    if (err) return err;
    if (s.startsWith('.')) return 'Hidden folders are not allowed.';
  }
  if (extName(segs[segs.length - 1]) !== extName(baseName(from))) return 'Keep the file extension.';
  return null;
}

export function OrganizeView() {
  const app = useApp();
  const ai = useAi();
  const o = ai.organize;
  const title = o?.scope || app.fs?.rootName || 'Folder';

  if (!o) {
    return (
      <div className="page">
        <div className="empty">
          <p>Nothing to review.</p>
          <button className="btn" onClick={() => app.setView({ kind: 'home' })}>
            Back to subjects
          </button>
        </div>
      </div>
    );
  }

  const changes = o.plan?.changes ?? [];
  const errors = changes.map((c, i) => (o.selected.has(i) && o.edits[i] !== undefined ? destError(c.from, o.edits[i]) : null));
  const blocked = errors.some(Boolean);
  const toggle = (i: number) =>
    ai.setOrganize((x) => {
      if (!x) return x;
      const selected = new Set(x.selected);
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      return { ...x, selected };
    });
  const selectAll = (on: boolean) => ai.setOrganize((x) => x && { ...x, selected: on ? new Set(changes.map((_, i) => i)) : new Set() });
  const edit = (i: number, value: string) => ai.setOrganize((x) => x && { ...x, edits: { ...x.edits, [i]: value } });

  const groups: [string, number[]][] = [
    ['Moves', changes.flatMap((c, i) => (c.move ? [i] : []))],
    ['Renames', changes.flatMap((c, i) => (!c.move ? [i] : []))],
  ];

  return (
    <div className="page organize">
      <div className="page-head">
        <div className="page-titles">
          <span className="crumbs">
            <Sparkles size={13} aria-hidden /> AI organizer
          </span>
          <h1>Organize {title}</h1>
        </div>
        <button className="btn" onClick={ai.closeOrganize}>
          <X size={16} /> {o.status === 'scanning' ? 'Stop' : 'Close'}
        </button>
      </div>

      {o.status === 'scanning' && (
        <div className="card organize-progress">
          <Spinner label={o.progress || 'Working…'} />
          <p className="muted hint">
            The AI reads the start of each file, then proposes where it belongs. Nothing changes until you apply the changes you checked.
          </p>
        </div>
      )}

      {o.status === 'error' && (
        <div className="card organize-progress">
          <p className="field-error">{o.error}</p>
          <div className="row-actions">
            <button className="btn" onClick={() => ai.setSettingsOpen(true)}>
              <Settings size={15} /> AI settings
            </button>
            <button className="btn primary" onClick={() => ai.startOrganize(o.scope)}>
              Try again
            </button>
          </div>
        </div>
      )}

      {o.status === 'review' && o.plan && (
        <>
          {o.skipped > 0 && <div className="notice notice-warn">Only the first 400 files were reviewed; {o.skipped} were skipped. Organize one subject at a time for the rest.</div>}
          {!changes.length ? (
            <div className="card organize-progress">
              <p>
                <ListTree size={16} aria-hidden /> Everything already looks well organized. No changes proposed.
              </p>
            </div>
          ) : (
            <>
              <p className="muted">
                Review the proposals. Uncheck what you don’t want, or edit a destination. Annotations move with their files, and you can undo everything
                afterwards.
              </p>
              {o.plan.newFolders.length > 0 && (
                <section className="card list-card">
                  <div className="list-head">
                    <h2>
                      <FolderPlus size={15} aria-hidden /> New folders
                    </h2>
                    <span className="muted hint">Created only if a checked change needs them</span>
                  </div>
                  <div className="chips pad">
                    {o.plan.newFolders.map((d) => (
                      <span key={d} className="chip">
                        {d.split('/').join(' › ')}
                      </span>
                    ))}
                  </div>
                </section>
              )}
              {groups.map(([label, idx]) =>
                idx.length ? (
                  <section key={label} className="card list-card">
                    <div className="list-head">
                      <h2>
                        {label} ({idx.length})
                      </h2>
                    </div>
                    <ul className="organize-list">
                      {idx.map((i) => {
                        const c = changes[i];
                        return (
                          <li key={c.from} className="organize-row">
                            <input type="checkbox" checked={o.selected.has(i)} onChange={() => toggle(i)} aria-label={`Apply change to ${baseName(c.from)}`} />
                            <FileIcon name={c.from} size={18} />
                            <div className="organize-main">
                              <div className="organize-paths">
                                <span className="organize-from" title={c.from}>
                                  {c.from}
                                </span>
                                <ArrowRight size={14} aria-hidden />
                                <input
                                  className="organize-to"
                                  value={o.edits[i] ?? c.to}
                                  onChange={(e) => edit(i, e.target.value)}
                                  aria-label={`New path for ${baseName(c.from)}`}
                                  aria-invalid={!!errors[i]}
                                  spellCheck={false}
                                />
                              </div>
                              {errors[i] ? <span className="field-error">{errors[i]}</span> : c.reason && <span className="muted hint">{c.reason}</span>}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null,
              )}
            </>
          )}
          {o.plan.rejected.length > 0 && (
            <details className="card list-card organize-rejected">
              <summary className="muted">
                {o.plan.rejected.length} unusable suggestion{o.plan.rejected.length > 1 ? 's were' : ' was'} ignored
              </summary>
              <ul>
                {o.plan.rejected.map((r) => (
                  <li key={r.from} className="muted hint">
                    {r.from} → {r.target}: {r.why}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {changes.length > 0 && (
            <div className="organize-bar">
              <button className="link-btn" onClick={() => selectAll(true)}>
                Select all
              </button>
              <button className="link-btn" onClick={() => selectAll(false)}>
                Select none
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={ai.closeOrganize}>
                Cancel
              </button>
              <button className="btn primary" disabled={!o.selected.size || blocked} onClick={ai.applyOrganize}>
                Apply {o.selected.size} change{o.selected.size === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

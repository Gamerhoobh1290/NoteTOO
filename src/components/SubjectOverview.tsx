import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, Ellipsis, Folder, FolderPlus, GripVertical, Inbox, NotebookPen, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import type { Entry } from '../fs/fsService';
import { type Section, baseName, classify, parentPath } from '../fs/paths';
import { formatDate } from '../lib/fileKinds';
import { errorMessage, openMenu, pickFiles } from '../lib/ui';
import { downloadItems } from './Sidebar';
import { sectionKey, sortEntries, useApp } from '../state/AppContext';
import { sectionsOf, type SectionInfo } from '../state/sections';
import { entryMenu } from './Sidebar';
import { FileIcon, Spinner, cls, useDragSource, useDropTarget, useIsDragged, useRowSelect } from './common';

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const QUICK: Section[] = ['Cours', 'TD', 'TP', 'Exams'];

export function HomeView() {
  const app = useApp();
  const subjects = sortEntries((app.dirs[''] ?? []).filter((e) => e.kind === 'dir'), 'name');
  return (
    <div className="page">
      <div className="page-head">
        <div className="page-titles">
          <span className="crumbs">{app.fs?.rootName}</span>
          <h1>Subjects</h1>
        </div>
        <button className="btn primary" data-tour="new-subject" onClick={app.createSubject}>
          <Plus size={16} /> New subject
        </button>
      </div>
      {subjects.length ? (
        <div className="card-grid">
          {subjects.map((s) => (
            <SubjectCard key={s.path} entry={s} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <p>
            No subjects yet. Create one, or add folders to <strong>{app.fs?.rootName}</strong> and press Refresh.
          </p>
        </div>
      )}
      <p className="muted hint">
        Tip: drop files from your PC onto a subject to copy them in. They land in its “To sort” tray. The scratchpad (top
        right) is saved as <code>_scratchpad.md</code> in your folder.
      </p>
    </div>
  );
}

function SubjectCard({ entry }: { entry: Entry }) {
  const app = useApp();
  const drop = useDropTarget(entry.path, { name: entry.name });
  return (
    <button
      className={cls('card subject-card', drop.state && `dz-${drop.state}`)}
      onClick={() => app.setView({ kind: 'subject', subject: entry.path })}
      {...drop.props}
    >
      <span className="tile-icon t-Other">
        <BookOpen size={20} aria-hidden />
      </span>
      <span className="row-label">{entry.name}</span>
      {drop.over && <span className="drop-hint">{drop.label}</span>}
    </button>
  );
}

export function SubjectOverview({ subject }: { subject: string }) {
  const app = useApp();
  const { fs, rev, loadDir } = app;
  const [files, setFiles] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const children = app.dirs[subject];
  const sections = children ? sectionsOf(subject, children) : null;
  const other = sections?.find((s) => s.section === 'Other');
  // Files from the PC dropped anywhere else on the page land in "Other" (the To sort tray).
  const pageDrop = useDropTarget(other?.dirPath ?? subject, { externalOnly: true, name: 'To sort' });

  useEffect(() => {
    if (!fs) return;
    let cancelled = false;
    void loadDir(subject);
    fs.walk(subject)
      .then((f) => !cancelled && (setFiles(f), setError(null)))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [fs, subject, rev, loadDir]);

  // Section folders' first level, for the subfolder drop targets on each tile.
  const existing = sections?.filter((s) => s.exists).map((s) => s.dirPath).join('|');
  useEffect(() => {
    if (existing) for (const d of existing.split('|')) void loadDir(d);
  }, [existing, rev, loadDir]);

  if (error) return <div className="empty">Could not read this subject: {error}</div>;
  if (!sections || !files || !other) return <Spinner />;

  const counts = new Map<Section, number>();
  const latest = new Map<Section, number>();
  for (const f of files) {
    const s = classify(f.path)?.section ?? 'Other';
    counts.set(s, (counts.get(s) ?? 0) + 1);
    latest.set(s, Math.max(latest.get(s) ?? 0, f.lastModified));
  }
  // "To sort": loose files directly in the subject folder or directly in Other.
  const loose = sortEntries(
    files.filter((f) => parentPath(f.path) === subject || parentPath(f.path) === other.dirPath),
    'date',
  );
  const recent = [...files].sort((a, b) => b.lastModified - a.lastModified).slice(0, 8);
  const dirOf = (s: Section) => sections.find((x) => x.section === s)!.dirPath;

  return (
    <div className={cls('page', pageDrop.state === 'over' && 'page-drop')} {...pageDrop.props}>
      <div className="page-head">
        <div className="page-titles">
          <span className="crumbs">
            {app.fs?.rootName} › {subject}
          </span>
          <h1>{subject}</h1>
        </div>
        <div className="row-actions">
          <button className="btn" data-tour="subject-notes" onClick={() => app.setView({ kind: 'notes', subject })}>
            <NotebookPen size={16} /> Notes
          </button>
          <button className="btn" onClick={() => app.createFolder(subject)}>
            <FolderPlus size={16} /> New folder
          </button>
          <button
            className="icon-btn"
            title="More actions"
            aria-label="More actions"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(r.left - 120, r.bottom + 4, [
                ...downloadItems(app, [subject], 'dir').map((i) => ({ ...i, label: 'Download subject (.zip)' })),
                { label: 'Rename subject…', icon: Pencil, onSelect: () => app.renameEntry({ path: subject, kind: 'dir' }) },
                { label: 'Delete subject…', icon: Trash2, danger: true, onSelect: () => app.deleteEntry({ path: subject, kind: 'dir' }) },
              ]);
            }}
          >
            <Ellipsis size={18} />
          </button>
          <button className="btn primary" data-tour="add-files" onClick={async () => app.addFiles(other.dirPath, await pickFiles())}>
            <Upload size={16} /> Add files
          </button>
        </div>
      </div>

      <section className="stack" aria-labelledby="sections-title">
        <div className="section-head">
          <h2 id="sections-title">Sections</h2>
          <span className="muted hint">Drag a file onto a section or onto a folder inside it. Files from your PC are copied, files already here are moved.</span>
        </div>
        <div className="tile-grid">
          {sections.map((s) => (
            <SectionTile key={s.section} info={s} count={counts.get(s.section) ?? 0} latest={latest.get(s.section) ?? 0} />
          ))}
        </div>
      </section>

      <div className="split-row">
        <ToSortTray files={loose} dirOf={dirOf} otherDir={other.dirPath} />
        <section className="card list-card" aria-labelledby="recent-title">
          <div className="list-head">
            <h2 id="recent-title">Recently modified</h2>
            <span className="muted hint">Drag to re-file</span>
          </div>
          {recent.length ? (
            <ul className="file-list" data-select-scope>
              {recent.map((f) => (
                <FileRow key={f.path} entry={f} compact />
              ))}
            </ul>
          ) : (
            <p className="muted pad">No files yet. Drop files on a section above, or use “Add files”.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionTile({ info, count, latest }: { info: SectionInfo; count: number; latest: number }) {
  const app = useApp();
  const drop = useDropTarget(info.dirPath, { name: info.section });
  const subs = info.exists ? sortEntries((app.dirs[info.dirPath] ?? []).filter((e) => e.kind === 'dir'), 'name') : [];
  const reveal = () => {
    app.setPanels({ sidebar: true });
    app.toggle(info.subject, true, info.subject);
    app.toggle(sectionKey(info.subject, info.section), true, info.exists ? info.dirPath : undefined);
  };
  return (
    <div className={cls('tile', `t-${info.section}`, drop.state && `dz-${drop.state}`)} {...drop.props}>
      <button className="tile-main" onClick={reveal} title="Show in sidebar">
        <span className="tile-icon">
          <Folder size={20} aria-hidden />
        </span>
        <span className="tile-text">
          <span className="tile-name">{info.section}</span>
          <span className="muted">
            {count} file{count === 1 ? '' : 's'}
          </span>
        </span>
      </button>
      {subs.length > 0 && (
        <div className="chips">
          {subs.slice(0, 4).map((d) => (
            <SubfolderChip key={d.path} entry={d} />
          ))}
          {subs.length > 4 && <span className="muted hint">+{subs.length - 4} more</span>}
        </div>
      )}
      {drop.state === 'over' || drop.state === 'here' ? (
        <span className="drop-hint">
          {drop.state === 'over' && <ArrowRight size={14} aria-hidden />}
          {drop.label}
        </span>
      ) : (
        <span className="tile-foot muted">{latest ? `Updated ${shortDate.format(latest)}` : info.section === 'Other' ? 'Loose files land here' : 'Empty'}</span>
      )}
    </div>
  );
}

function SubfolderChip({ entry }: { entry: Entry }) {
  const app = useApp();
  const drop = useDropTarget(entry.path, { name: entry.name });
  return (
    <button
      className={cls('chip', drop.state && `dz-${drop.state}`)}
      title={`Open ${entry.name} in the sidebar`}
      onClick={() => {
        app.setPanels({ sidebar: true });
        app.toggle(entry.path, true, entry.path);
      }}
      {...drop.props}
    >
      <Folder size={13} aria-hidden />
      <span className="row-label">{entry.name}</span>
      {drop.state === 'over' && <span className="chip-drop">Move into</span>}
    </button>
  );
}

function ToSortTray({ files, dirOf, otherDir }: { files: Entry[]; dirOf: (s: Section) => string; otherDir: string }) {
  const drop = useDropTarget(otherDir, { name: 'To sort' });
  return (
    <section className={cls('card list-card tray', drop.state === 'over' && 'dz-over')} data-tour="to-sort" aria-labelledby="tosort-title" {...drop.props}>
      <div className="list-head">
        <Inbox size={18} aria-hidden className="muted" />
        <h2 id="tosort-title">To sort</h2>
        <span className="count-pill">{files.length}</span>
        <span className="muted hint grow-right">Loose files in this subject. Drag them, or pick a section.</span>
      </div>
      {files.length ? (
        <ul className="file-list" data-select-scope>
          {files.map((f) => (
            <FileRow key={f.path} entry={f} quick={QUICK.map((s) => ({ section: s, dir: dirOf(s) }))} />
          ))}
        </ul>
      ) : (
        <div className="tray-empty">
          <Check size={26} aria-hidden className="ok" />
          <strong>Everything is sorted</strong>
          <span className="muted hint">Files dropped on the subject without a section show up here.</span>
        </div>
      )}
    </section>
  );
}

/** A draggable, selectable file row (To sort tray and Recently modified). */
function FileRow({ entry, quick, compact }: { entry: Entry; quick?: { section: Section; dir: string }[]; compact?: boolean }) {
  const app = useApp();
  const src = useDragSource(entry.path);
  const rowSelect = useRowSelect();
  const section = classify(entry.path)?.section ?? 'Other';
  const where = parentPath(entry.path).split('/').slice(1).join(' › ') || 'Subject folder';
  const selected = app.selection.includes(entry.path);
  const lifted = useIsDragged(entry.path);
  return (
    <li
      className={cls('file-row', selected && 'multi', compact && 'compact', lifted && 'lifted')}
      title={`${entry.path}\nDrag to a section · Ctrl/Shift-click to select several`}
      {...src}
      onClick={(e) => {
        if (rowSelect(e, entry.path)) return;
        app.setView({ kind: 'file', path: entry.path });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, entryMenu(app, entry));
      }}
    >
      <span className="grip" aria-hidden>
        <GripVertical size={15} />
      </span>
      <span className="kind-tile">
        <FileIcon name={entry.name} size={compact ? 15 : 17} />
      </span>
      <span className="file-text">
        <button
          className="file-name"
          onClick={(e) => {
            e.stopPropagation();
            if (!rowSelect(e, entry.path)) app.setView({ kind: 'file', path: entry.path });
          }}
        >
          {baseName(entry.path)}
        </button>
        {!compact && <span className="muted hint">{formatDate(entry.lastModified)}</span>}
      </span>
      {compact && <span className={cls('badge', `t-${section}`)}>{where}</span>}
      {compact && <span className="mono muted nowrap">{entry.lastModified ? shortDate.format(entry.lastModified) : '—'}</span>}
      {quick && (
        <span className="quick" role="group" aria-label={`Sort ${entry.name} into`}>
          {quick.map((q) => (
            <button
              key={q.section}
              className={cls('qs', `t-${q.section}`)}
              aria-label={`Move ${entry.name} to ${q.section}`}
              onClick={(e) => {
                e.stopPropagation();
                void app.moveEntries(app.dragPathsFor(entry.path), q.dir);
              }}
            >
              {q.section}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}


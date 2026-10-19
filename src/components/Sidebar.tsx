import { useEffect, useMemo, type ComponentType } from 'react';
import {
  BookOpen, ChevronDown, ChevronRight, Ellipsis, ExternalLink, Folder, FolderInput, FolderOpen, FolderPlus, FolderSearch,
  NotebookPen, Pencil, Plus, Trash2, Upload,
} from 'lucide-react';
import type { Entry } from '../fs/fsService';
import { SECTIONS, type Section, classify, parentPath, searchKey, splitPath } from '../fs/paths';
import { openMenu, pickFiles, type MenuItem } from '../lib/ui';
import { sectionKey, sortEntries, useApp, type SortKey } from '../state/AppContext';
import { sectionsOf, type SectionInfo } from '../state/sections';
import { FileIcon, Spinner, cls, useDragSource, useDropTarget, useIsDragged, useRowSelect } from './common';

export function Sidebar() {
  const app = useApp();
  const searching = !!(app.query.trim() || app.filterSubject || app.filterSection);
  const subjects = sortEntries((app.dirs[''] ?? []).filter((e) => e.kind === 'dir'), 'name');

  return (
    <nav className="sidebar" aria-label="Subjects and files">
      <div className="sidebar-filters">
        <select aria-label="Filter by subject" value={app.filterSubject} onChange={(e) => app.setFilterSubject(e.target.value)}>
          <option value="">All subjects</option>
          {subjects.map((s) => (
            <option key={s.path} value={s.path}>
              {s.name}
            </option>
          ))}
        </select>
        <select aria-label="Filter by section" value={app.filterSection} onChange={(e) => app.setFilterSection(e.target.value as Section | '')}>
          <option value="">All sections</option>
          {SECTIONS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select aria-label="Sort" value={app.sort} onChange={(e) => app.setSort(e.target.value as SortKey)}>
          <option value="name">Name</option>
          <option value="date">Modified</option>
          <option value="type">Type</option>
        </select>
      </div>

      {searching ? (
        <SearchResults />
      ) : (
        <>
          <div className="sidebar-head">
            <span>Subjects</span>
            <button className="icon-btn small-32" title="New subject" aria-label="New subject" onClick={app.createSubject}>
              <Plus size={16} />
            </button>
          </div>
          {!app.dirs[''] ? (
            <Spinner />
          ) : subjects.length ? (
            <ul className="tree" role="tree" data-select-scope>
              {subjects.map((s) => (
                <SubjectNode key={s.path} entry={s} />
              ))}
            </ul>
          ) : (
            <p className="muted pad">No subjects yet.</p>
          )}
          <p className="sidebar-tip">Drag files onto any folder here to move them. Hold over a closed folder to open it.</p>
        </>
      )}
    </nav>
  );
}

// ---------- tree ----------

interface RowProps {
  depth: number;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  label: string;
  open?: boolean;
  onToggle?: () => void;
  onActivate: (e: React.MouseEvent | React.KeyboardEvent) => void;
  /** the view currently showing this item */
  current?: boolean;
  menu?: () => MenuItem[];
  /** folder that receives drops on this row */
  dropDir?: string;
  /** what this row drags (files and folders) */
  dragPath?: string;
  /** a file row: part of multi-select */
  file?: boolean;
  tint?: Section;
  title?: string;
  trailing?: React.ReactNode;
}

function Row(p: RowProps) {
  const app = useApp();
  const drop = useDropTarget(p.dropDir ?? '', { name: p.label, onSpring: p.onToggle && !p.open ? p.onToggle : undefined });
  const src = useDragSource(p.dragPath ?? '');
  const lifted = useIsDragged(p.dragPath ?? '');
  const isDrop = p.dropDir !== undefined;
  const multi = !!p.file && !!p.dragPath && app.selection.includes(p.dragPath);
  const showMenu = (x: number, y: number) => p.menu && openMenu(x, y, p.menu());
  const dropText = drop.state === 'here' ? 'Already here' : drop.label.startsWith('Copy') ? 'Copy here' : 'Move here';
  const Icon = p.icon;
  return (
    <div
      className={cls(
        'row',
        p.current && 'selected',
        multi && 'multi',
        lifted && 'lifted',
        isDrop && drop.state && `dz-${drop.state}`,
        isDrop && drop.over && p.onToggle && !p.open && 'springing',
        p.tint && `t-${p.tint}`,
      )}
      style={{ paddingLeft: 6 + p.depth * 14 }}
      role="treeitem"
      aria-expanded={p.onToggle ? !!p.open : undefined}
      aria-selected={!!p.current || multi}
      tabIndex={0}
      title={p.title ?? p.label}
      data-path={p.file ? p.dragPath : undefined}
      {...(p.dragPath ? { draggable: true, onDragStart: src.onDragStart, onDragEnd: src.onDragEnd } : {})}
      onClick={p.onActivate}
      onContextMenu={(e) => {
        if (!p.menu) return;
        e.preventDefault();
        showMenu(e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') p.onActivate(e);
        else if (e.key === 'ArrowRight' && p.onToggle && !p.open) p.onToggle();
        else if (e.key === 'ArrowLeft' && p.onToggle && p.open) p.onToggle();
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = [...document.querySelectorAll<HTMLElement>('.sidebar .row[tabindex]')];
          rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
          e.preventDefault();
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          showMenu(r.left + 24, r.bottom);
        }
      }}
      {...(isDrop ? drop.props : {})}
    >
      {p.onToggle ? (
        <button
          className="twisty"
          tabIndex={-1}
          aria-label={p.open ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation();
            p.onToggle!();
          }}
        >
          {p.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      ) : (
        <span className="twisty" />
      )}
      <span className="row-icon">
        <Icon size={16} aria-hidden />
      </span>
      <span className="row-label">{p.label}</span>
      {isDrop && drop.over ? <span className="row-drop">{dropText}</span> : p.trailing}
      {p.menu && (
        <button
          className="row-menu"
          tabIndex={-1}
          aria-label={`Actions for ${p.label}`}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 2);
          }}
        >
          <Ellipsis size={16} />
        </button>
      )}
    </div>
  );
}

function SubjectNode({ entry }: { entry: Entry }) {
  const app = useApp();
  const open = !!app.expanded[entry.path];
  const children = app.dirs[entry.path];
  const current = (app.view.kind === 'subject' || app.view.kind === 'notes') && app.view.subject === entry.path;
  return (
    <li>
      <Row
        depth={0}
        icon={BookOpen}
        label={entry.name}
        open={open}
        current={current}
        dropDir={entry.path}
        onToggle={() => app.toggle(entry.path, undefined, entry.path)}
        onActivate={() => {
          app.setView({ kind: 'subject', subject: entry.path });
          app.toggle(entry.path, true, entry.path);
        }}
        menu={() => [
          { label: 'Overview', icon: BookOpen, onSelect: () => app.setView({ kind: 'subject', subject: entry.path }) },
          { label: 'Subject notes', icon: NotebookPen, onSelect: () => app.setView({ kind: 'notes', subject: entry.path }) },
          { label: 'New folder…', icon: FolderPlus, onSelect: () => app.createFolder(entry.path) },
          ...windowsItems(app, entry),
          { label: 'Rename…', icon: Pencil, onSelect: () => app.renameEntry(entry) },
          { label: 'Delete…', icon: Trash2, danger: true, onSelect: () => app.deleteEntry(entry) },
        ]}
      />
      {open && (
        <ul role="group">
          {children ? sectionsOf(entry.path, children).map((s) => <SectionNode key={s.section} info={s} />) : <Spinner />}
        </ul>
      )}
    </li>
  );
}

function SectionNode({ info }: { info: SectionInfo }) {
  const app = useApp();
  const key = sectionKey(info.subject, info.section);
  const open = !!app.expanded[key];
  const own = info.exists ? app.dirs[info.dirPath] : [];
  const items = own ? sortEntries([...own, ...info.extras], app.sort) : null;
  const toggle = () => app.toggle(key, undefined, info.exists ? info.dirPath : undefined);
  return (
    <li>
      <Row
        depth={1}
        icon={open ? FolderOpen : Folder}
        label={info.section}
        tint={info.section}
        open={open}
        onToggle={toggle}
        onActivate={toggle}
        dropDir={info.dirPath}
        title={info.exists ? info.dirPath : `${info.dirPath} (created when you add something)`}
        menu={() => [
          { label: 'Add files…', icon: Upload, onSelect: async () => app.addFiles(info.dirPath, await pickFiles()) },
          { label: 'New folder…', icon: FolderPlus, onSelect: () => app.createFolder(info.dirPath, key) },
          ...(info.exists ? windowsItems(app, { path: info.dirPath, kind: 'dir' }) : []),
        ]}
      />
      {open && (
        <ul role="group">
          {!items ? <Spinner /> : items.length ? items.map((e) => <EntryNode key={e.path} entry={e} depth={2} />) : <EmptyHint depth={2} />}
        </ul>
      )}
    </li>
  );
}

function EmptyHint({ depth }: { depth: number }) {
  return (
    <li className="empty-hint" style={{ paddingLeft: 6 + depth * 14 + 26 }}>
      Empty — drop files here
    </li>
  );
}

/** Desktop app: hand the item to Windows (its default program, or File Explorer). */
function windowsItems(app: ReturnType<typeof useApp>, entry: Pick<Entry, 'path' | 'kind'>): MenuItem[] {
  if (!app.fs?.desktop?.windows) return [];
  return entry.kind === 'file'
    ? [
        { label: 'Open with default app', icon: ExternalLink, onSelect: () => app.openInWindows(entry.path) },
        { label: 'Show in File Explorer', icon: FolderSearch, onSelect: () => app.showInExplorer(entry.path) },
      ]
    : [{ label: 'Open in File Explorer', icon: FolderSearch, onSelect: () => app.openInWindows(entry.path) }];
}

export function entryMenu(app: ReturnType<typeof useApp>, entry: Entry): MenuItem[] {
  const many = entry.kind === 'file' && app.selection.length > 1 && app.selection.includes(entry.path);
  if (many) {
    return [
      { label: `Move ${app.selection.length} files to…`, icon: FolderInput, onSelect: () => app.moveEntryPrompt(app.selection) },
      { label: `Delete ${app.selection.length} files…`, icon: Trash2, danger: true, onSelect: () => app.deleteFiles(app.selection) },
    ];
  }
  const common: MenuItem[] = [
    ...windowsItems(app, entry),
    { label: 'Rename…', icon: Pencil, onSelect: () => app.renameEntry(entry) },
    { label: 'Move to…', icon: FolderInput, onSelect: () => app.moveEntryPrompt([entry.path]) },
    { label: 'Delete…', icon: Trash2, danger: true, onSelect: () => app.deleteEntry(entry) },
  ];
  if (entry.kind === 'file') return common;
  return [
    { label: 'Add files…', icon: Upload, onSelect: async () => app.addFiles(entry.path, await pickFiles()) },
    { label: 'New folder…', icon: FolderPlus, onSelect: () => app.createFolder(entry.path) },
    ...common,
  ];
}

function EntryNode({ entry, depth }: { entry: Entry; depth: number }) {
  const app = useApp();
  const rowSelect = useRowSelect();
  if (entry.kind === 'file') {
    return (
      <li>
        <Row
          depth={depth}
          icon={() => <FileIcon name={entry.name} />}
          label={entry.name}
          file
          current={app.view.kind === 'file' && app.view.path === entry.path}
          onActivate={(e) => {
            if ('button' in e && rowSelect(e, entry.path)) return;
            app.setView({ kind: 'file', path: entry.path });
          }}
          dragPath={entry.path}
          menu={() => entryMenu(app, entry)}
        />
      </li>
    );
  }
  return <FolderNode entry={entry} depth={depth} />;
}

function FolderNode({ entry, depth }: { entry: Entry; depth: number }) {
  const app = useApp();
  const open = !!app.expanded[entry.path];
  const children = app.dirs[entry.path];
  const toggle = () => app.toggle(entry.path, undefined, entry.path);
  return (
    <li>
      <Row
        depth={depth}
        icon={open ? FolderOpen : Folder}
        label={entry.name}
        open={open}
        onToggle={toggle}
        onActivate={toggle}
        dropDir={entry.path}
        dragPath={entry.path}
        menu={() => entryMenu(app, entry)}
      />
      {open && (
        <ul role="group">
          {!children ? (
            <Spinner />
          ) : children.length ? (
            sortEntries(children, app.sort).map((e) => <EntryNode key={e.path} entry={e} depth={depth + 1} />)
          ) : (
            <EmptyHint depth={depth + 1} />
          )}
        </ul>
      )}
    </li>
  );
}

// ---------- search ----------

function SearchResults() {
  const app = useApp();
  const { index, ensureIndex, rev } = app;
  useEffect(() => {
    void ensureIndex();
  }, [ensureIndex, rev]);

  const q = searchKey(app.query.trim());
  const results = useMemo(() => {
    if (!index) return null;
    const hits = index.filter((e) => {
      if (e.kind !== 'file') return false;
      const c = classify(e.path);
      if (app.filterSubject && c?.subject !== app.filterSubject) return false;
      if (app.filterSection && c?.section !== app.filterSection) return false;
      return !q || searchKey(e.name).includes(q);
    });
    return sortEntries(hits, app.sort);
  }, [index, q, app.filterSubject, app.filterSection, app.sort]);

  if (!results) return <Spinner label="Scanning folder…" />;
  const shown = results.slice(0, 500);
  return (
    <div className="results">
      <div className="sidebar-head">
        <span>
          {results.length} file{results.length === 1 ? '' : 's'}
        </span>
        <button
          className="link-btn"
          onClick={() => {
            app.setQuery('');
            app.setFilterSubject('');
            app.setFilterSection('');
          }}
        >
          Clear
        </button>
      </div>
      <ul className="tree" role="tree" data-select-scope>
        {shown.map((e) => (
          <ResultRow key={e.path} entry={e} />
        ))}
      </ul>
      {results.length > shown.length && <p className="muted pad">Showing the first {shown.length}. Refine your search.</p>}
    </div>
  );
}

function ResultRow({ entry: e }: { entry: Entry }) {
  const app = useApp();
  const src = useDragSource(e.path);
  const rowSelect = useRowSelect();
  const section = classify(e.path)?.section;
  return (
    <li>
      <div
        className={cls('row result', app.view.kind === 'file' && app.view.path === e.path && 'selected', app.selection.includes(e.path) && 'multi')}
        role="treeitem"
        aria-selected={app.selection.includes(e.path)}
        tabIndex={0}
        title={e.path}
        {...src}
        onClick={(ev) => {
          if (rowSelect(ev, e.path)) return;
          app.setView({ kind: 'file', path: e.path });
        }}
        onKeyDown={(ev) => ev.key === 'Enter' && app.setView({ kind: 'file', path: e.path })}
        onContextMenu={(ev) => {
          ev.preventDefault();
          openMenu(ev.clientX, ev.clientY, entryMenu(app, e));
        }}
      >
        <span className="row-icon">
          <FileIcon name={e.name} />
        </span>
        <span className="result-text">
          <span className="row-label">{e.name}</span>
          <span className="result-path">
            {section && <span className={cls('dot', `t-${section}`)} />}
            {splitPath(parentPath(e.path)).join(' › ')}
          </span>
        </span>
      </div>
    </li>
  );
}

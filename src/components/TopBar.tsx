import { useEffect, useState } from 'react';
import {
  ChevronDown, Folder, FolderOpen, FolderSearch, Keyboard, LogOut, Monitor, Moon, NotebookPen, PanelLeft, PanelRight,
  RefreshCw, Search, Sparkles, Sun, X,
} from 'lucide-react';
import { desktop, windowsApp, type ThemeSource } from '../desktop/bridge';
import { openMenu, shortcutsDialog, toast, type MenuItem } from '../lib/ui';
import { useApp } from '../state/AppContext';
import { cls } from './common';
import { ReceiveButton } from './ReceiveDialog';

const THEMES: { id: ThemeSource; label: string; icon: typeof Sun }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

/** Desktop app: System / Light / Dark, kept in the app's settings (not in the school folder). */
function ThemeButton() {
  const [theme, setTheme] = useState<ThemeSource>('system');
  useEffect(() => {
    void windowsApp?.getTheme().then(setTheme);
  }, []);
  const i = THEMES.findIndex((t) => t.id === theme);
  const cur = THEMES[i];
  const next = THEMES[(i + 1) % THEMES.length];
  return (
    <button
      className="icon-btn"
      title={`Theme: ${cur.label} (click for ${next.label})`}
      aria-label={`Theme: ${cur.label}. Switch to ${next.label}`}
      onClick={() => {
        setTheme(next.id);
        void windowsApp?.setTheme(next.id);
      }}
    >
      <cur.icon size={17} />
    </button>
  );
}

/**
 * Desktop app: the folder name opens a menu to switch folders, show it in Explorer or close it.
 * Connected to the NoteTOO server: switch between the folders it shares, or close.
 */
function folderMenu(app: ReturnType<typeof useApp>, x: number, y: number) {
  const others = app.recent.slice(1, 7); // the first one is the open folder
  const items: MenuItem[] = [
    ...others.map((p) => ({ label: others.filter((o) => baseOf(o) === baseOf(p)).length > 1 ? p : baseOf(p), icon: Folder, onSelect: () => app.openRecent(p) })),
    ...(windowsApp
      ? [
          { label: 'Open another folder…  Ctrl+O', icon: FolderOpen, onSelect: app.openFolder },
          { label: 'Open in File Explorer', icon: FolderSearch, onSelect: () => app.openInWindows('') },
        ]
      : []),
    { label: 'Close folder', icon: LogOut, onSelect: app.closeFolder },
  ];
  openMenu(x, y, items);
}
/** Last segment of a Windows path ("D:\School\Maths" -> "Maths"). */
const baseOf = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export function TopBar() {
  const app = useApp();
  return (
    <header className="topbar">
      <button
        className={cls('icon-btn', app.panels.sidebar && 'active')}
        title="Toggle sidebar (Alt+1)"
        aria-label="Toggle sidebar"
        aria-pressed={app.panels.sidebar}
        onClick={() => app.setPanels({ sidebar: !app.panels.sidebar })}
      >
        <PanelLeft size={18} />
      </button>
      <button className="brand" onClick={() => app.setView({ kind: 'home' })} title="All subjects">
        NoteTOO
      </button>
      {desktop ? (
        <button
          className="folder-name folder-switch"
          title={windowsApp ? 'Switch folder, open it in File Explorer, or close it' : 'Switch folder or close it'}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            folderMenu(app, r.left, r.bottom + 6);
          }}
        >
          <FolderOpen size={15} aria-hidden />
          <span className="folder-label">{app.fs?.rootName}</span>
          <ChevronDown size={14} aria-hidden />
        </button>
      ) : (
        <span className="folder-name" title={`Folder: ${app.fs?.rootName}`}>
          <FolderOpen size={15} aria-hidden />
          {app.fs?.rootName}
        </span>
      )}

      <div className="search">
        <Search size={16} aria-hidden />
        <input
          id="global-search"
          type="search"
          placeholder="Search files…  (Ctrl+K)"
          aria-label="Search files by name"
          value={app.query}
          onChange={(e) => {
            app.setQuery(e.target.value);
            if (!app.panels.sidebar) app.setPanels({ sidebar: true });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              app.setQuery('');
              e.currentTarget.blur();
            }
          }}
        />
        {app.query && (
          <button className="icon-btn small" aria-label="Clear search" onClick={() => app.setQuery('')}>
            <X size={14} />
          </button>
        )}
      </div>

      <div className="topbar-actions">
        <button
          className="icon-btn"
          data-tour="refresh"
          title="Refresh (re-scan the folder)"
          aria-label="Refresh"
          onClick={async () => {
            await app.refresh();
            toast('Folder re-scanned.');
          }}
        >
          <RefreshCw size={17} />
        </button>
        <ReceiveButton />
        <button
          className={cls('btn ai-toggle', app.panels.ai && 'active')}
          title="AI assistant (Alt+4)"
          aria-pressed={app.panels.ai}
          onClick={() => app.setPanels({ ai: !app.panels.ai, scratchpad: false })}
        >
          <Sparkles size={16} /> <span className="hide-sm">AI</span>
        </button>
        <button
          className={cls('btn', app.panels.scratchpad && 'active')}
          data-tour="scratchpad"
          title="Scratchpad (Alt+3)"
          aria-pressed={app.panels.scratchpad}
          onClick={() => app.setPanels({ scratchpad: !app.panels.scratchpad, ai: false })}
        >
          <NotebookPen size={16} /> <span className="hide-sm">Scratchpad</span>
        </button>
        <button
          className={cls('icon-btn', app.panels.annotations && 'active')}
          data-tour="annotations"
          title="Toggle annotations panel (Alt+2)"
          aria-label="Toggle annotations panel"
          aria-pressed={app.panels.annotations}
          onClick={() => app.setPanels({ annotations: !app.panels.annotations })}
        >
          <PanelRight size={18} />
        </button>
        <button className="icon-btn" data-tour="shortcuts" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => shortcutsDialog()}>
          <Keyboard size={18} />
        </button>
        {windowsApp ? (
          <ThemeButton />
        ) : (
          <button className="icon-btn" title="Close folder" aria-label="Close folder" onClick={app.closeFolder}>
            <LogOut size={17} />
          </button>
        )}
      </div>
    </header>
  );
}

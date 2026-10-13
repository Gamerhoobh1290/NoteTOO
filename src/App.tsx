import { useEffect } from 'react';
import { FolderInput, Trash2, X } from 'lucide-react';
import { installDragTracking, useDrag } from './lib/dnd';
import { NARROW, isTypingTarget, shortcutsDialog, toast } from './lib/ui';
import { desktop } from './desktop/bridge';
import { SUBJECT_NOTES, joinPath } from './fs/paths';
import { AppProvider, useApp, type View } from './state/AppContext';
import { AiProvider } from './state/AiContext';
import { AiPanel } from './components/ai/AiPanel';
import { AiSettingsDialog } from './components/ai/AiSettingsDialog';
import { OrganizeView } from './components/ai/OrganizeView';
import { ErrorBoundary, MenuHost, Toasts, cls } from './components/common';
import { DialogHost } from './components/dialogs/DialogHost';
import { FileView } from './components/FileView';
import { NoteEditor } from './components/notes/NoteEditor';
import { ScratchpadPanel } from './components/notes/ScratchpadPanel';
import { Sidebar } from './components/Sidebar';
import { ReconnectOverlay, StartScreen } from './components/StartScreen';
import { HomeView, SubjectOverview } from './components/SubjectOverview';
import { TopBar } from './components/TopBar';

export default function App() {
  return (
    <AppProvider>
      <AiProvider>
        <Shell />
        <AiSettingsDialog />
      </AiProvider>
      <DialogHost />
      <MenuHost />
      <Toasts />
    </AppProvider>
  );
}

function viewKey(v: View): string {
  return v.kind === 'file' ? `file:${v.path}` : v.kind === 'home' || v.kind === 'organize' ? v.kind : `${v.kind}:${v.subject}`;
}

function useGlobalShortcuts() {
  const app = useApp();
  const { panels, setPanels, selection, select, openFolder, refresh, phase } = app;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      const typing = isTypingTarget(e.target);
      // Desktop app: the usual Windows commands.
      if (desktop && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openFolder();
        return;
      }
      if (desktop && e.key === 'F5' && phase === 'open') {
        e.preventDefault();
        void refresh().then(() => toast('Folder re-scanned.'));
        return;
      }
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
        e.preventDefault();
        setPanels({ sidebar: true });
        requestAnimationFrame(() => document.getElementById('global-search')?.focus());
      } else if (e.altKey && !e.ctrlKey && ['Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(e.code)) {
        e.preventDefault();
        if (e.code === 'Digit1') setPanels({ sidebar: !panels.sidebar });
        if (e.code === 'Digit2') setPanels({ annotations: !panels.annotations });
        if (e.code === 'Digit3') setPanels({ scratchpad: !panels.scratchpad, ai: false });
        if (e.code === 'Digit4') setPanels({ ai: !panels.ai, scratchpad: false });
      } else if (e.key === '?' && !typing) {
        void shortcutsDialog();
      } else if (e.key === 'Escape' && !typing && selection.length) {
        select('clear');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panels, setPanels, selection, select, openFolder, refresh, phase]);
}

function Shell() {
  const app = useApp();
  useGlobalShortcuts();

  // Tracks drags app-wide (so every folder can show itself as a target) and keeps the
  // browser from opening a file dropped outside a drop zone.
  useEffect(() => installDragTracking(), []);
  const dragging = useDrag();

  // Dev only: `?sample` opens the generated sample folder in memory.
  const { phase, openSample } = app;
  useEffect(() => {
    if (import.meta.env.DEV && phase === 'closed' && new URLSearchParams(location.search).has('sample')) void openSample();
  }, [phase, openSample]);

  // On narrow windows the sidebar overlays the content: get it out of the way once a file opens.
  const v = app.view;
  const { setPanels } = app;
  const openedFile = v.kind === 'file' ? v.path : null;
  useEffect(() => {
    if (openedFile && window.matchMedia(NARROW).matches) setPanels({ sidebar: false });
  }, [openedFile, setPanels]);

  if (phase === 'unsupported' || phase === 'closed' || phase === 'starting') return <StartScreen />;

  return (
    <div className={cls('shell', !app.panels.sidebar && 'no-sidebar', app.panels.ai && 'ai-open', dragging && 'is-dragging', dragging?.kind === 'external' && 'is-dragging-in')}>
      <TopBar />
      <div className="body">
        {app.panels.sidebar && <Sidebar />}
        <main className="main">
          <ErrorBoundary key={viewKey(v)}>
            {v.kind === 'home' && <HomeView />}
            {v.kind === 'subject' && <SubjectOverview subject={v.subject} />}
            {v.kind === 'file' && <FileView path={v.path} />}
            {v.kind === 'organize' && <OrganizeView />}
            {v.kind === 'notes' && <NoteEditor key={v.subject} path={joinPath(v.subject, SUBJECT_NOTES)} title={`${v.subject} — notes`} />}
          </ErrorBoundary>
        </main>
      </div>
      {app.selection.length > 0 && <SelectionBar />}
      {app.panels.scratchpad && <ScratchpadPanel />}
      {app.panels.ai && <AiPanel />}
      {phase === 'lost' && <ReconnectOverlay />}
    </div>
  );
}

/** Shown while several files are selected (Ctrl/Shift-click): bulk move or delete. */
function SelectionBar() {
  const app = useApp();
  const n = app.selection.length;
  return (
    <div className="selection-bar" role="region" aria-label="Selected files">
      <strong>
        {n} file{n > 1 ? 's' : ''} selected
      </strong>
      <span className="muted hint">Drag any of them to move all</span>
      <button className="btn small" onClick={() => app.moveEntryPrompt(app.selection)}>
        <FolderInput size={15} /> Move to…
      </button>
      <button className="btn small danger-outline" onClick={() => app.deleteFiles(app.selection)}>
        <Trash2 size={15} /> Delete…
      </button>
      <button className="icon-btn small" aria-label="Clear selection (Esc)" title="Clear selection (Esc)" onClick={() => app.select('clear')}>
        <X size={15} />
      </button>
    </div>
  );
}

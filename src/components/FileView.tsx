import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Wand2 } from 'lucide-react';
import { isNotFound } from '../fs/fsService';
import { baseName, sidecarPath, splitPath } from '../fs/paths';
import { AI_COLOR, loadSidecar, newId, serializeSidecar, type Annotation, type Color, type Sidecar } from '../fs/sidecar';
import { fileKind, supportsAreas } from '../lib/fileKinds';
import { errorMessage } from '../lib/ui';
import { useAi } from '../state/AiContext';
import { useApp } from '../state/AppContext';
import { useDiskDoc } from '../state/useDiskDoc';
import { AnnotationsPanel } from './annotations/AnnotationsPanel';
import type { AnnotationProps, NewShape, Tool } from './annotations/AnnotationLayer';
import { ErrorBoundary, FileIcon, Spinner, useDragSource } from './common';
import MediaViewer from './previews/MediaViewer';
import UnsupportedPreview from './previews/UnsupportedPreview';
import { SaveIndicator } from './SaveStatus';

// Heavy viewers are loaded on first use.
const PdfViewer = lazy(() => import('./previews/PdfViewer'));
const ImageViewer = lazy(() => import('./previews/ImageViewer'));
const DocxViewer = lazy(() => import('./previews/DocxViewer'));
const SheetViewer = lazy(() => import('./previews/SheetViewer'));
const TextViewer = lazy(() => import('./previews/TextViewer'));

/** The file handle's contents; re-read only when its lastModified changes on disk. */
function useFileContents(path: string, enabled: boolean) {
  const { fs, rev } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  useEffect(() => {
    if (!fs || !enabled) return;
    let cancelled = false;
    (async () => {
      try {
        // A re-scan (focus, Refresh) re-reads the contents only when the file changed.
        const cur = fileRef.current;
        if (cur) {
          const st = await fs.stat(path);
          if (st && st.lastModified === cur.lastModified && st.size === cur.size) return;
        }
        const f = await fs.readFile(path);
        if (cancelled) return;
        setFile((cur) => (cur && cur.name === f.name && cur.lastModified === f.lastModified && cur.size === f.size ? cur : f));
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setFile(null);
        setError(isNotFound(e) ? 'This file no longer exists. It may have been moved or deleted outside NoteTOO.' : errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fs, path, rev, enabled]);
  return { file, error };
}

export function FileView({ path }: { path: string }) {
  const app = useApp();
  const fs = app.fs!;
  const kind = fileKind(baseName(path));
  // Desktop app: audio/video stream from disk (with seeking) instead of being read whole.
  const streamUrl = (kind === 'video' || kind === 'audio') && fs.desktop ? fs.desktop.fileUrl(path) : null;
  const { file, error } = useFileContents(path, !streamUrl);
  const areas = supportsAreas(kind);

  const doc = useDiskDoc<Sidecar>({
    fs,
    path: sidecarPath(path),
    serialize: serializeSidecar,
    load: async () => {
      const r = await loadSidecar(fs, path);
      return {
        value: r.sidecar,
        lastModified: r.lastModified,
        notice: r.backup
          ? `The annotations file of "${baseName(path)}" was damaged. It was kept as "${r.backup}" and a fresh one was started.`
          : undefined,
      };
    },
  });

  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState<Color>('yellow');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { setPanels } = app;
  const dragSource = useDragSource(path);
  const { update } = doc;

  // AI highlight suggestions: shown dashed until kept (saved as purple highlights) or discarded.
  const ai = useAi();
  const suggestions = ai.suggestions[path];
  const { resolveSuggestion } = ai;
  const reviewSuggestions = useCallback(
    (ids: string[], keep: boolean) => {
      const picked = (suggestions ?? []).filter((x) => ids.includes(x.id));
      if (keep && picked.length) {
        const t = new Date().toISOString();
        update((s) => ({
          ...s,
          annotations: [
            ...s.annotations,
            ...picked.map((x): Annotation => ({ id: newId(), type: 'area', page: x.page, rect: x.rect, rects: x.rects, color: AI_COLOR, comment: x.why, createdAt: t, updatedAt: t })),
          ],
        }));
      }
      for (const x of picked) resolveSuggestion(path, x.id);
    },
    [suggestions, update, resolveSuggestion, path],
  );
  const focus = ai.focusSuggestion;
  useEffect(() => {
    if (focus?.path !== path) return;
    setSelectedId(focus.id);
    setFlash((f) => ({ id: focus.id, n: (f?.n ?? 0) + 1 }));
    setPanels({ annotations: true });
  }, [focus, path, setPanels]);

  const onCreate = useCallback(
    (shape: NewShape) => {
      const t = new Date().toISOString();
      const a: Annotation = { ...shape, id: newId(), color, comment: '', createdAt: t, updatedAt: t };
      update((s) => ({ ...s, annotations: [...s.annotations, a] }));
      setSelectedId(a.id);
      setFocusId(a.id);
      setTool('select');
      setPanels({ annotations: true });
    },
    [color, update, setPanels],
  );
  const jump = useCallback((id: string) => {
    setSelectedId(id);
    setFlash((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  }, []);

  const annot: AnnotationProps = {
    annotations: doc.value?.annotations ?? [],
    tool,
    color,
    selectedId,
    flash,
    setTool,
    setColor,
    onCreate,
    onSelect: (id) => {
      setSelectedId(id);
      setPanels({ annotations: true });
    },
    suggestions,
  };

  const preview = () => {
    if (streamUrl) return <MediaViewer src={streamUrl} kind={kind as 'video' | 'audio'} onOpenExternally={() => app.openInWindows(path)} />;
    if (!file) return null;
    switch (kind) {
      case 'pdf':
        return <PdfViewer file={file} annot={annot} />;
      case 'image':
        return <ImageViewer file={file} annot={annot} />;
      case 'docx':
        return <DocxViewer file={file} />;
      case 'sheet':
        return <SheetViewer file={file} />;
      case 'video':
      case 'audio':
        return <MediaViewer file={file} kind={kind} />;
      case 'text':
      case 'markdown':
      case 'code':
        return <TextViewer file={file} kind={kind} />;
      default:
        return <UnsupportedPreview file={file} path={path} rootName={fs.rootName} />;
    }
  };

  return (
    <div className="fileview">
      <div className="fileview-main">
        <div className="fileview-head">
          <div className="fileview-drag" title="Drag onto a folder in the sidebar to move this file" {...dragSource}>
            <span className="kind-tile">
              <FileIcon name={baseName(path)} size={18} />
            </span>
            <div className="fileview-titles">
              <span className="crumbs" title={path}>
                {splitPath(path).slice(0, -1).join(' › ')}
              </span>
              <h1 className="fileview-title" title={baseName(path)}>
                {baseName(path)}
              </h1>
            </div>
          </div>
          {!app.panels.annotations && <SaveIndicator doc={doc} />}
        </div>
        <div className="fileview-body" ref={bodyRef}>
          {error ? (
            <div className="empty">{error}</div>
          ) : !file && !streamUrl ? (
            <Spinner />
          ) : (
            <ErrorBoundary>
              <Suspense fallback={<Spinner />}>{preview()}</Suspense>
            </ErrorBoundary>
          )}
          <SelectionExplain container={bodyRef} onExplain={(text) => ai.explain(path, text)} />
        </div>
      </div>
      {app.panels.annotations && (
        <AnnotationsPanel
          doc={doc}
          areas={areas}
          selectedId={selectedId}
          focusId={focusId}
          onJump={jump}
          onClose={() => setPanels({ annotations: false })}
          suggestions={suggestions}
          onReviewSuggestions={reviewSuggestions}
        />
      )}
    </div>
  );
}

/** Floating "Explain" button over text selected in the preview (PDF text layer, docs, notes, code). */
function SelectionExplain({ container, onExplain }: { container: React.RefObject<HTMLDivElement | null>; onExplain: (text: string) => void }) {
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const update = () => {
      const s = document.getSelection();
      const text = s?.toString().trim() ?? '';
      const root = container.current;
      if (!s || s.rangeCount === 0 || text.length < 3 || !root || !root.contains(s.anchorNode) || !root.contains(s.focusNode)) return setSel(null);
      const r = s.getRangeAt(0).getBoundingClientRect();
      const box = root.getBoundingClientRect();
      setSel({
        text: text.slice(0, 6000),
        x: Math.min(Math.max(r.left + r.width / 2 - box.left, 60), box.width - 60),
        y: Math.max(r.top - box.top - 40, 6),
      });
    };
    const onUp = () => setTimeout(update, 0);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    const onScroll = () => setSel(null);
    container.current?.addEventListener('scroll', onScroll, true);
    const el = container.current;
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onUp);
      el?.removeEventListener('scroll', onScroll, true);
    };
  }, [container]);
  if (!sel) return null;
  return (
    <button
      className="btn small selection-explain"
      style={{ left: sel.x, top: sel.y }}
      onMouseDown={(e) => e.preventDefault()} // keep the selection
      onClick={() => {
        onExplain(sel.text);
        setSel(null);
      }}
    >
      <Wand2 size={14} /> Explain
    </button>
  );
}

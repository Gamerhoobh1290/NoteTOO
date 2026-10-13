import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  File, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, type LucideIcon,
} from 'lucide-react';
import { type FileKind, fileKind } from '../lib/fileKinds';
import { baseName, isInside, parentPath } from '../fs/paths';
import { DRAG_TYPE, draggedPaths, endDrag, getDrag, startDrag, useDrag, type DragState } from '../lib/dnd';
import { closeMenu, dismissToast, toast, useMenu, useToasts } from '../lib/ui';
import { useApp } from '../state/AppContext';

const KIND_ICONS: Record<FileKind, LucideIcon> = {
  pdf: FileText, image: FileImage, docx: FileText, sheet: FileSpreadsheet, video: FileVideo,
  audio: FileAudio, markdown: FileText, text: FileText, code: FileCode, other: File,
};

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const kind = fileKind(name);
  const Icon = KIND_ICONS[kind];
  return <Icon size={size} className={`ficon ficon-${kind}`} aria-hidden />;
}

export function cls(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" aria-hidden />
      {label}
    </div>
  );
}

/** Object URL for a blob, revoked when the blob changes or the component unmounts. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

// ---------- drag and drop ----------

function droppedFiles(dt: DataTransfer): { files: File[]; folders: number } {
  const files: File[] = [];
  let folders = 0;
  for (const item of dt.items) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      folders++;
      continue;
    }
    const f = item.getAsFile();
    if (f) files.push(f);
  }
  return { files, folders };
}

export type DropState = 'candidate' | 'over' | 'here' | null;

/**
 * Makes an element a folder drop target: items dragged inside the app are moved there,
 * files from the PC are copied there. While anything is dragged, it reports its state so it
 * can outline itself (candidate), highlight under the pointer (over) or say "Already here".
 */
export function useDropTarget(
  dirPath: string,
  opts: { name?: string; externalOnly?: boolean; onSpring?: () => void } = {},
) {
  const app = useApp();
  const drag = useDrag();
  const [over, setOver] = useState(false);
  const spring = useRef<ReturnType<typeof setTimeout>>(undefined);
  const name = opts.name ?? (baseName(dirPath) || dirPath);

  const status = (d: DragState = getDrag()): 'valid' | 'here' | 'invalid' | 'none' => {
    if (!d) return 'none';
    if (d.kind === 'external') return 'valid';
    if (opts.externalOnly) return 'none';
    if (d.paths.some((p) => isInside(dirPath, p))) return 'invalid';
    if (d.paths.every((p) => parentPath(p) === dirPath)) return 'here';
    return 'valid';
  };
  const st = status(drag);

  useEffect(() => {
    if (drag) return;
    setOver(false);
    clearTimeout(spring.current);
  }, [drag]);
  useEffect(() => () => clearTimeout(spring.current), []);

  const leave = () => {
    setOver(false);
    clearTimeout(spring.current);
  };

  const props = {
    onDragEnter(e: React.DragEvent) {
      const s = status();
      if ((s === 'valid' || s === 'here') && opts.onSpring && !spring.current) {
        e.stopPropagation();
        spring.current = setTimeout(() => {
          spring.current = undefined;
          opts.onSpring?.();
        }, 650);
      }
    },
    onDragOver(e: React.DragEvent) {
      const types = e.dataTransfer.types;
      const internal = types.includes(DRAG_TYPE);
      if (!internal && !types.includes('Files')) return;
      const s = status();
      if (s === 'invalid' || (internal && opts.externalOnly)) return;
      e.stopPropagation();
      if (!over) setOver(true);
      if (s === 'here') return; // shows "Already here", no drop
      e.preventDefault();
      e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    },
    onDragLeave(e: React.DragEvent) {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) leave();
    },
    async onDrop(e: React.DragEvent) {
      e.preventDefault();
      e.stopPropagation();
      leave();
      const paths = draggedPaths(e.dataTransfer);
      if (paths) {
        if (!opts.externalOnly) await app.moveEntries(paths, dirPath);
        return;
      }
      const { files, folders } = droppedFiles(e.dataTransfer);
      if (folders) toast('Folders cannot be dropped; drop the files inside them, or create a subfolder first.', 'error');
      await app.addFiles(dirPath, files);
    },
  };

  const state: DropState = st === 'here' ? 'here' : st === 'valid' ? (over ? 'over' : 'candidate') : null;
  const label = st === 'here' ? 'Already here' : drag?.kind === 'external' ? `Copy to ${name}` : `Move to ${name}`;
  return { over, state, label, props };
}

/** True while `path` is being dragged (the source row fades out). */
export function useIsDragged(path: string): boolean {
  const drag = useDrag();
  return drag?.kind === 'internal' && drag.paths.includes(path);
}

/** Props that make a file row draggable; it carries the whole selection when the row is selected. */
export function useDragSource(path: string) {
  const { dragPathsFor } = useApp();
  return {
    draggable: true,
    'data-path': path,
    onDragStart: (e: React.DragEvent) => startDrag(e, dragPathsFor(path)),
    onDragEnd: () => endDrag(),
  };
}

/**
 * Click handling for selectable file rows: Ctrl/Cmd-click toggles, Shift-click selects a range
 * within the closest [data-select-scope]. Returns true when the click was a selection click.
 */
export function useRowSelect() {
  const { select, selection } = useApp();
  return (e: React.MouseEvent, path: string): boolean => {
    if (e.ctrlKey || e.metaKey) {
      select('toggle', path);
      return true;
    }
    if (e.shiftKey) {
      const scope = (e.currentTarget as HTMLElement).closest('[data-select-scope]');
      const order = scope ? [...scope.querySelectorAll<HTMLElement>('[data-path]')].map((el) => el.dataset.path!) : [path];
      select('range', path, order);
      return true;
    }
    if (selection.length) select('clear');
    return false;
  };
}

// ---------- hosts ----------
export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cls('toast', t.kind === 'error' && 'toast-error')} onClick={() => dismissToast(t.id)}>
          <span>{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                dismissToast(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function MenuHost() {
  const m = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!m) return;
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(m.x, window.innerWidth - r.width - 8), y: Math.min(m.y, window.innerHeight - r.height - 8) });
    el.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      if (e.type === 'pointerdown' && el.contains(e.target as Node)) return;
      closeMenu();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    };
  }, [m]);

  if (!m) return null;
  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: pos.x || m.x, top: pos.y || m.y }}
      onKeyDown={(e) => {
        const items = [...ref.current!.querySelectorAll('button')];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
        if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
      }}
    >
      {m.items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={cls('menu-item', it.danger && 'danger')}
          onClick={() => {
            closeMenu();
            it.onSelect();
          }}
        >
          {it.icon && <it.icon size={15} />}
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Keeps one broken preview from taking the whole app down. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="empty">
          <h3>Something went wrong while showing this.</h3>
          <p className="muted">{this.state.error.message}</p>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

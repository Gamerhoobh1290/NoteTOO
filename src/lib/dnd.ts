// App-wide drag state, so every drop target can show itself while something is being dragged.
import { useSyncExternalStore } from 'react';
import { baseName } from '../fs/paths';

/** dataTransfer type carrying a JSON array of paths dragged inside the app. */
export const DRAG_TYPE = 'application/x-notetoo-paths';

export type DragState = { kind: 'internal'; paths: string[] } | { kind: 'external' } | null;

let state: DragState = null;
const listeners = new Set<() => void>();
function set(next: DragState) {
  state = next;
  listeners.forEach((l) => l());
}
export const getDrag = () => state;
export function useDrag(): DragState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Starts dragging app items: sets the payload and a compact drag card ("name" or "name +2"). */
export function startDrag(e: React.DragEvent, paths: string[]) {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
  e.dataTransfer.setData('text/plain', paths.map(baseName).join('\n'));
  e.dataTransfer.effectAllowed = 'move';
  const card = document.createElement('div');
  card.className = 'drag-card';
  card.textContent = baseName(paths[0]);
  if (paths.length > 1) {
    const n = document.createElement('span');
    n.className = 'drag-count';
    n.textContent = String(paths.length);
    card.append(n);
  }
  document.body.append(card);
  e.dataTransfer.setDragImage(card, 14, 18);
  setTimeout(() => card.remove());
  // Changing the DOM synchronously inside dragstart can make Chrome cancel the drag.
  setTimeout(() => set({ kind: 'internal', paths }));
}

export function endDrag() {
  if (state) set(null);
}

/** Paths dragged from inside the app, or null for anything else (e.g. files from the PC). */
export function draggedPaths(dt: DataTransfer): string[] | null {
  const raw = dt.getData(DRAG_TYPE);
  if (!raw) return null;
  try {
    const paths = JSON.parse(raw);
    return Array.isArray(paths) && paths.every((p) => typeof p === 'string') ? paths : null;
  } catch {
    return null;
  }
}

/** Tracks files dragged in from the PC (enter/leave the window) and clears state when a drag ends. */
export function installDragTracking(): () => void {
  let depth = 0;
  const isExternal = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files') && !e.dataTransfer.types.includes(DRAG_TYPE);
  const onEnter = (e: DragEvent) => {
    if (!isExternal(e)) return;
    depth++;
    if (!state) set({ kind: 'external' });
  };
  const onLeave = (e: DragEvent) => {
    if (!isExternal(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) endDrag();
  };
  const onEnd = () => {
    depth = 0;
    endDrag();
  };
  // Dropping outside a drop zone must not make the browser open the file.
  const onOver = (e: DragEvent) => e.preventDefault();
  // Capture phase: drop targets stop propagation, and a drop from the PC fires no dragend.
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    onEnd();
  };
  window.addEventListener('dragenter', onEnter);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('dragover', onOver);
  window.addEventListener('drop', onDrop, true);
  window.addEventListener('dragend', onEnd);
  return () => {
    window.removeEventListener('dragenter', onEnter);
    window.removeEventListener('dragleave', onLeave);
    window.removeEventListener('dragover', onOver);
    window.removeEventListener('drop', onDrop, true);
    window.removeEventListener('dragend', onEnd);
  };
}

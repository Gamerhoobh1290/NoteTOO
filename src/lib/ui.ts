// Tiny in-memory stores for toasts and modal dialogs (nothing is persisted).
import { useSyncExternalStore, type ComponentType } from 'react';

function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: T) {
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error || e instanceof DOMException) return e.message || e.name;
  return String(e);
}

// ---------- toasts ----------
export interface ToastAction {
  label: string;
  run: () => void;
}
export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: ToastAction;
}
const toasts = createStore<Toast[]>([]);
let toastId = 0;

export function toast(message: string, kind: Toast['kind'] = 'info', action?: ToastAction, durationMs?: number) {
  if (toasts.get().some((t) => t.message === message)) return;
  const id = ++toastId;
  toasts.set([...toasts.get(), { id, message, kind, action }]);
  setTimeout(() => dismissToast(id), durationMs ?? (kind === 'error' ? 9000 : action ? 8000 : 4000));
}
export function dismissToast(id: number) {
  toasts.set(toasts.get().filter((t) => t.id !== id));
}
export function useToasts() {
  return useSyncExternalStore(toasts.subscribe, toasts.get);
}

// ---------- dialogs ----------
interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}
interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  /** returns an error message or null */
  validate?: (value: string) => string | null;
  /** select this part of the initial value (e.g. name without extension) */
  selectEnd?: number;
}
interface ChoiceOptions {
  title: string;
  label: string;
  options: { value: string; label: string }[];
  confirmLabel?: string;
}
export type DialogRequest =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptOptions)
  | ({ kind: 'choice'; resolve: (value: string | null) => void } & ChoiceOptions)
  | { kind: 'shortcuts'; resolve: (v: null) => void };

const dialogs = createStore<DialogRequest | null>(null);

function open<T>(make: (resolve: (v: T) => void) => DialogRequest): Promise<T> {
  return new Promise((resolve) => {
    dialogs.set(
      make((v: T) => {
        dialogs.set(null);
        resolve(v);
      }),
    );
  });
}

export const confirmDialog = (o: ConfirmOptions) => open<boolean>((resolve) => ({ kind: 'confirm', ...o, resolve }));
export const promptDialog = (o: PromptOptions) => open<string | null>((resolve) => ({ kind: 'prompt', ...o, resolve }));
export const choiceDialog = (o: ChoiceOptions) => open<string | null>((resolve) => ({ kind: 'choice', ...o, resolve }));
export const shortcutsDialog = () => open<null>((resolve) => ({ kind: 'shortcuts', resolve }));
export function useDialog() {
  return useSyncExternalStore(dialogs.subscribe, dialogs.get);
}

// ---------- context menus ----------
export interface MenuItem {
  label: string;
  icon?: ComponentType<{ size?: number }>;
  onSelect: () => void;
  danger?: boolean;
}
export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}
const menu = createStore<MenuState | null>(null);
export const openMenu = (x: number, y: number, items: MenuItem[]) => menu.set({ x, y, items });
export const closeMenu = () => menu.set(null);
export function useMenu() {
  return useSyncExternalStore(menu.subscribe, menu.get);
}

// ---------- misc ----------
/** Opens the OS file picker (plain <input type=file>, read-only access to the picked files). */
export function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Keys pressed here belong to the sidebar/panels/menus, not to the open viewer. */
export function isOutsideViewer(t: EventTarget | null): boolean {
  return isTypingTarget(t) || !!(t as HTMLElement | null)?.closest?.('.sidebar, .panel, .menu, .scratchpad, dialog');
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

/** Matches styles.css: below this width the side panels overlay the content. */
export const NARROW = '(max-width: 900px)';

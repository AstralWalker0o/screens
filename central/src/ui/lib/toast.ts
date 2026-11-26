import { useSyncExternalStore } from 'react';

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast { id: number; kind: ToastKind; title: string; detail?: string }

let toasts: Toast[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(kind: ToastKind, title: string, detail?: string, ms?: number) {
  // Collapse duplicates that arrive together (e.g. several queries failing at once).
  const dup = toasts.find((t) => t.kind === kind && t.title === title && t.detail === detail);
  if (dup) return dup.id;
  const id = nextId++;
  toasts = [...toasts.slice(-4), { id, kind, title, detail }];
  emit();
  setTimeout(() => dismissToast(id), ms ?? (kind === 'error' ? 8000 : 4000));
  return id;
}

export const toast = {
  success: (title: string, detail?: string) => push('success', title, detail),
  error: (title: string, detail?: string) => push('error', title, detail),
  info: (title: string, detail?: string) => push('info', title, detail),
};

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => toasts,
    () => toasts,
  );
}

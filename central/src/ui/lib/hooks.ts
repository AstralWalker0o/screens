import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { openLive, type LiveStatus } from '../api';
import type { LiveEvent } from '../../shared/types';

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Re-render every `ms` so relative times stay fresh. */
const nowSubs = new Set<() => void>();
let nowVal = Date.now();
setInterval(() => {
  nowVal = Date.now();
  nowSubs.forEach((s) => s());
}, 30_000);
export function useNow(): number {
  return useSyncExternalStore(
    (cb) => {
      nowSubs.add(cb);
      return () => nowSubs.delete(cb);
    },
    () => nowVal,
  );
}

export function useElementWidth<T extends HTMLElement>(): [React.RefCallback<T>, number] {
  const [w, setW] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    ro.current = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setW(cr.width);
    });
    ro.current.observe(el);
  }, []);
  return [ref, w];
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}

export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(q).matches,
    () => false,
  );
}

/** Subscribe to a site's live event stream while mounted. */
export function useLive(siteId: string | null | undefined, onEvent: (e: LiveEvent) => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    if (!siteId) return;
    return openLive(siteId, (e) => ref.current(e), setStatus);
  }, [siteId]);
  return status;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

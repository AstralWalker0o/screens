// A tiny stale-while-revalidate cache: enough for a single-admin console
// without pulling in a data-fetching library.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiError } from '../api';
import { toast } from './toast';

interface Entry {
  data?: unknown;
  error?: unknown;
  updatedAt: number;
  stale: boolean;
  inflight?: Promise<void>;
  fn?: () => Promise<unknown>;
  subs: Set<() => void>;
}

const cache = new Map<string, Entry>();

function entry(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { updatedAt: 0, stale: true, subs: new Set() };
    cache.set(key, e);
  }
  return e;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function reportError(err: unknown, title = 'Something went wrong') {
  const msg = errorMessage(err);
  toast.error(title, msg);
}

function run(key: string, e: Entry, silent: boolean): Promise<void> {
  if (e.inflight) return e.inflight;
  const fn = e.fn;
  if (!fn) return Promise.resolve();
  e.inflight = (async () => {
    try {
      e.data = await fn();
      e.error = undefined;
      e.updatedAt = Date.now();
      e.stale = false;
    } catch (err) {
      e.error = err;
      if (!silent) reportError(err, `Couldn't load ${labelFor(key)}`);
    } finally {
      e.inflight = undefined;
      e.subs.forEach((s) => s());
    }
  })();
  e.subs.forEach((s) => s());
  return e.inflight;
}

function labelFor(key: string): string {
  return key.split(':')[0].replace(/[-_]/g, ' ');
}

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  fetching: boolean;
  refetch: () => Promise<void>;
}

export function useQuery<T>(
  key: string | null,
  fn: () => Promise<T>,
  opts: { refreshMs?: number; staleMs?: number; /** show errors inline only, no toast */ silent?: boolean } = {},
): QueryResult<T> {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const { refreshMs, staleMs = 15_000, silent = false } = opts;

  useEffect(() => {
    if (!key) return;
    const e = entry(key);
    e.fn = () => fnRef.current();
    e.subs.add(force);
    if (e.stale || Date.now() - e.updatedAt > staleMs) void run(key, e, silent);
    let t: ReturnType<typeof setInterval> | undefined;
    if (refreshMs) {
      t = setInterval(() => {
        if (!document.hidden) void run(key, e, true);
      }, refreshMs);
    }
    return () => {
      e.subs.delete(force);
      if (t) clearInterval(t);
    };
  }, [key, refreshMs, staleMs, silent]);

  const e = key ? cache.get(key) : undefined;
  const refetch = useCallback(async () => {
    if (!key) return;
    const en = entry(key);
    en.fn ??= () => fnRef.current();
    await run(key, en, false);
  }, [key]);

  return {
    data: e?.data as T | undefined,
    error: e?.error,
    loading: !!key && e?.data === undefined && !e?.error,
    fetching: !!e?.inflight,
    refetch,
  };
}

/** Mark matching keys stale and refetch those currently on screen. */
export function invalidate(...prefixes: string[]) {
  for (const [key, e] of cache) {
    if (prefixes.some((p) => key === p || key.startsWith(`${p}:`) || key.startsWith(p))) {
      e.stale = true;
      if (e.subs.size && e.fn) void run(key, e, true);
    }
  }
}

/** Optimistically replace cached data (and notify subscribers). */
export function setQueryData<T>(key: string, updater: (old: T | undefined) => T | undefined) {
  const e = entry(key);
  e.data = updater(e.data as T | undefined);
  e.subs.forEach((s) => s());
}

export function peekQuery<T>(key: string): T | undefined {
  return cache.get(key)?.data as T | undefined;
}

/**
 * Run a mutation: toasts the API's error message on failure, an optional
 * success message, and invalidates the given cache prefixes either way.
 */
export async function act<T>(
  fn: () => Promise<T>,
  opts: { success?: string | ((r: T) => string | undefined); error?: string; invalidate?: string[] } = {},
): Promise<T | undefined> {
  try {
    const r = await fn();
    const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success;
    if (msg) toast.success(msg);
    return r;
  } catch (err) {
    reportError(err, opts.error ?? 'That didn’t work');
    return undefined;
  } finally {
    if (opts.invalidate?.length) invalidate(...opts.invalidate);
  }
}

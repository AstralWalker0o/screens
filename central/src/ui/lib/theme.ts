import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'theme';
const subs = new Set<() => void>();

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function resolved(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') return mq?.matches ? 'dark' : 'light';
  return pref;
}

function apply() {
  const r = resolved(readPref());
  document.documentElement.setAttribute('data-theme', r);
  subs.forEach((s) => s());
}

mq?.addEventListener('change', () => {
  if (readPref() === 'system') apply();
});

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* storage blocked: still apply for this page view */
  }
  apply();
}

function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function useTheme(): { pref: ThemePref; resolved: 'light' | 'dark'; setPref: (p: ThemePref) => void } {
  const pref = useSyncExternalStore(subscribe, readPref, () => 'system' as ThemePref);
  return { pref, resolved: resolved(pref), setPref: setThemePref };
}

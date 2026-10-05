// Small UI stores: theme (per-browser preference) and the top-bar search query.
import { useSyncExternalStore } from 'react';

// ---------- theme: dark by default; the choice is kept in this browser only
export type Theme = 'dark' | 'light';
const THEME_KEY = 'trenches-theme';
const THEME_EVENT = 'trenches:theme';
const readTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* storage blocked: theme still applies for this visit */ }
  window.dispatchEvent(new Event(THEME_EVENT));
}
const subTheme = (cb: () => void) => { window.addEventListener(THEME_EVENT, cb); return () => window.removeEventListener(THEME_EVENT, cb); };
export const useTheme = () => useSyncExternalStore(subTheme, readTheme);

// ---------- search query (top bar -> token grid)
let query = '';
const listeners = new Set<() => void>();
export function setQuery(q: string) { query = q; listeners.forEach((l) => l()); }
const subQuery = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const useQuery = () => useSyncExternalStore(subQuery, () => query);

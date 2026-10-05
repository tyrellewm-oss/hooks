import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CONTENT } from './shared';

// ---------- routing (4 routes; no router dependency)
const NAV = 'trenches:navigate';
export function navigate(to: string) {
  if (to === location.pathname) return;
  history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAV));
  window.scrollTo(0, 0);
}
function subscribePath(cb: () => void) {
  window.addEventListener('popstate', cb); window.addEventListener(NAV, cb);
  return () => { window.removeEventListener('popstate', cb); window.removeEventListener(NAV, cb); };
}
export const usePath = () => useSyncExternalStore(subscribePath, () => location.pathname);

// ---------- polling
export interface Live<T> { data: T | null; error: Error | null; fetchedAt: number; refresh: () => Promise<void> }
/** Fetch now and every `ms`; keeps the last good data on a failed poll (the error is shown alongside). */
export function usePoll<T>(fetcher: () => Promise<T>, ms: number, key: string): Live<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; fetchedAt: number }>({ data: null, error: null, fetchedAt: 0 });
  const f = useRef(fetcher); f.current = fetcher;
  const refresh = useCallback(async () => {
    try { const data = await f.current(); setState({ data, error: null, fetchedAt: Date.now() }); }
    catch (e) { setState((s) => ({ ...s, error: e as Error })); }
  }, []);
  useEffect(() => {
    setState({ data: null, error: null, fetchedAt: 0 });
    void refresh();
    const t = setInterval(() => { if (!document.hidden) void refresh(); }, ms);
    return () => clearInterval(t);
  }, [key, ms, refresh]);
  return { ...state, refresh };
}

/** Re-render every `ms` (moves the "now" marker and countdowns between polls). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// ---------- pre-trade checklist (AC-24)
// Same storage key and record as the old page (app/public/app.js), so a confirmation carries over between them:
// all 8 ticked, same copy version, less than 30 days old.
const CK = 'trenches-checklist';
const CK_EVENT = 'trenches:checklist';
const MAX_AGE_MS = 30 * 864e5;
function readChecklist(): { valid: boolean; at: number | null } {
  try {
    const s = JSON.parse(localStorage.getItem(CK) || 'null');
    const valid = !!s && s.version === CONTENT.version && Array.isArray(s.ticked) && s.ticked.length === 8 && s.ticked.every(Boolean) && Date.now() - s.at < MAX_AGE_MS;
    return { valid, at: valid ? s.at : null };
  } catch { return { valid: false, at: null }; }
}
let ckSnap = readChecklist();
let ckKey = JSON.stringify(ckSnap);
function subscribeChecklist(cb: () => void) {
  const on = () => { const n = readChecklist(); const k = JSON.stringify(n); if (k !== ckKey) { ckSnap = n; ckKey = k; } cb(); };
  window.addEventListener('storage', on); window.addEventListener(CK_EVENT, on);
  return () => { window.removeEventListener('storage', on); window.removeEventListener(CK_EVENT, on); };
}
export const useChecklist = () => useSyncExternalStore(subscribeChecklist, () => ckSnap);
export function confirmChecklist() {
  try { localStorage.setItem(CK, JSON.stringify({ version: CONTENT.version, ticked: Array(8).fill(true), at: Date.now() })); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(CK_EVENT));
}
export function resetChecklist() {
  try { localStorage.removeItem(CK); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(CK_EVENT));
}

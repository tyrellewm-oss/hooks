import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

// ---------- routing (4 routes; no router dependency)
const NAV = 'hookd:navigate';
export function navigate(to: string, { replace = false }: { replace?: boolean } = {}) {
  if (to === location.pathname) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
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

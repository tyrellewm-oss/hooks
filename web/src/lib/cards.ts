// Token cards for the lists (home and tokens page): the server's quick read (?view=card, no switch-history scan) in one
// shared store. Each token loads on its own, a few at a time, so a list draws every card at once and fills in its
// numbers as they arrive instead of waiting for the slowest token. A list you come back to, or a token page opened
// from one, starts from what is already here.
import { useEffect, useSyncExternalStore } from 'react';
import type { TokenView } from './types';
import { api } from './api';

/** view: the last good read (kept when a later read fails); at: when that read arrived */
export interface Card { view: TokenView | null; at: number; error: string | null }

let cards: ReadonlyMap<string, Card> = new Map();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
function put(mint: string, c: Card) {
  const next = new Map(cards); next.set(mint, c); cards = next;
  listeners.forEach((l) => l());
}

const PARALLEL = 4;   // each read is several chain calls on the server
const queue: string[] = [];
const pending = new Set<string>();
let running = 0;
function pump() {
  while (running < PARALLEL && queue.length) {
    const mint = queue.shift()!;
    running++;
    api.cardView(mint)
      .then((view) => put(mint, { view, at: Date.now(), error: null }))
      .catch((e) => { const old = cards.get(mint); put(mint, { view: old?.view ?? null, at: old?.at ?? 0, error: String((e as Error)?.message ?? e) }); })
      .finally(() => { running--; pending.delete(mint); pump(); });
  }
}

/** Queue a read of this token, unless one is already queued or the card is younger than maxAgeMs. */
export function loadCard(mint: string, maxAgeMs = 0) {
  const c = cards.get(mint);
  if (pending.has(mint) || (c && !c.error && Date.now() - c.at < maxAgeMs)) return;
  pending.add(mint); queue.push(mint); pump();
}

/** The card for a token, if a list has read it (not reactive: for a first paint). */
export const peekCard = (mint: string): Card | undefined => cards.get(mint);

/** The cards for these mints: read now, in list order, and again every pollMs while the tab is visible. A mint has
 *  an entry once its first read has finished (with a view or an error). */
export function useCards(mints: string[], pollMs = 30_000): ReadonlyMap<string, Card> {
  const snap = useSyncExternalStore(subscribe, () => cards);
  const key = mints.join(',');
  useEffect(() => {
    const list = key ? key.split(',') : [];
    const tick = () => { if (!document.hidden) list.forEach((m) => loadCard(m, pollMs / 2)); };
    tick();
    const t = setInterval(tick, pollMs);
    return () => clearInterval(t);
  }, [key, pollMs]);
  return snap;
}

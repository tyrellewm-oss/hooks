// The lift-only switch's public history for one token (AC-29): every RestrictionsLifted event among the recent
// transactions of the token's lift account and the global account. Both are extra accounts of the transfer hook, so
// every transfer of every hooked token lists them, and finding the rare switch use means reading recent trades.
// A confirmed transaction never changes, so each one is fetched once and remembered (a fetch that fails, or finds
// nothing yet, is forgotten and tried again on the next read). Fetches run a few at a time.
import type { Connection, PublicKey } from '@solana/web3.js';
import { parseRestrictionsLifted } from '../sdk/hook.js';

type LiftEvt = ReturnType<typeof parseRestrictionsLifted>[number];
export interface SwitchEventJson { scope: string; oldMinCapBps: number; newMinCapBps: number; lifted: boolean; slot: string; signer: string; link: string }
export type SwitchHistoryConn = Pick<Connection, 'getSignaturesForAddress' | 'getTransaction'>;

export function switchHistoryReader(conn: SwitchHistoryConn, opts: { link: (sig: string) => string; scan?: number; parallel?: number; cacheMax?: number }) {
  const { link, scan = 50, parallel = 5, cacheMax = 20_000 } = opts;
  const cache = new Map<string, Promise<LiftEvt[]>>();
  function eventsOf(sig: string): Promise<LiftEvt[]> {
    let p = cache.get(sig);
    if (p) return p;
    const forget = () => { if (cache.get(sig) === p) cache.delete(sig); };
    p = conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).then(tx => {
      if (!tx) { forget(); return []; }   // not served yet: look again next time
      return parseRestrictionsLifted(tx.meta?.logMessages ?? []);
    }, e => { forget(); throw e; });
    cache.set(sig, p);
    if (cache.size > cacheMax) cache.delete(cache.keys().next().value!);
    return p;
  }
  /** Events for this mint (and global ones), newest first. `accounts`: the mint's lift account, then the global one. */
  return async function switchHistory(mint: PublicKey, accounts: PublicKey[]): Promise<SwitchEventJson[]> {
    const lists = await Promise.all(accounts.map(a => conn.getSignaturesForAddress(a, { limit: scan }, 'confirmed').catch(() => [])));
    const sigs = [...new Set(lists.flat().filter(s => !s.err).map(s => s.signature))];
    const out: SwitchEventJson[] = [];
    for (let i = 0; i < sigs.length; i += parallel) {
      const batch = sigs.slice(i, i + parallel);
      const evts = await Promise.all(batch.map(eventsOf));
      batch.forEach((sig, j) => { for (const e of evts[j]) {
        if (e.scope === 0 || e.mint.equals(mint)) out.push({ scope: e.scopeName, oldMinCapBps: e.oldFloorBps, newMinCapBps: e.newFloorBps, lifted: e.lifted, slot: e.slot.toString(), signer: e.signer.toBase58(), link: link(sig) });
      } });
    }
    return out.sort((a, b) => Number(BigInt(b.slot) - BigInt(a.slot)));
  };
}

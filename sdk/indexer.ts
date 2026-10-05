// Trade indexer (read-only): for each registry token, walk its pools' transactions (DBC curve, then the DAMM v2 pool
// after graduation), turn swaps into trades, and keep them in .index/<cluster>/<mint>.json for the page's price chart
// and trades feed. Never signs or sends.
//
// Amounts come from the POOL side: the change of the pool authority's token accounts (base vault and wSOL quote
// vault) in the transaction. That is exactly what was swapped, unaffected by the trader's account rent, wSOL wrapping
// or network fee. A failed swap rejected by our hook (cap hit) is kept as a "blocked" row with the error name.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PublicKey, type Connection } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { EXEMPT_OWNERS } from './replay.js';
import { hookErrorFromLogs } from './hook.js';
import type { ClusterName } from './cluster.js';

export const INDEX_DIR = '.index';
export const MAX_TRADES = 5000;
export const WSOL = NATIVE_MINT.toBase58();

export interface Trade {
  sig: string; slot: number; time: number | null;   // unix seconds (block time)
  pool: string; venue: 'curve' | 'pool';            // DBC curve, or DAMM v2 after graduation
  side: 'buy' | 'sell' | 'blocked';
  trader: string;                                    // fee payer
  baseRaw: string; quoteLamports: string;            // absolute amounts swapped (pool side); '0' for blocked
  price: number | null;                              // SOL per whole token
  error?: string;                                    // hook error name for blocked rows
}
export interface TokenIndex { mint: string; cluster: ClusterName; decimals: number; pools: Record<string, { venue: Trade['venue']; lastSig: string | null }>; trades: Trade[]; updatedAt: string }

interface TokenBal { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }

/** Sum of a mint's balance change across accounts owned by the pool authorities. */
function poolDelta(pre: TokenBal[], post: TokenBal[], mint: string): bigint {
  const val = (list: TokenBal[]) => {
    const m = new Map<number, bigint>();
    for (const b of list) if (b.mint === mint && b.owner && EXEMPT_OWNERS.has(b.owner)) m.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
    return m;
  };
  const a = val(pre), b = val(post); let d = 0n;
  for (const i of new Set([...a.keys(), ...b.keys()])) d += (b.get(i) ?? 0n) - (a.get(i) ?? 0n);
  return d;
}

/** One transaction -> a trade, or null if it isn't a swap of `mint` through a pool (claims, burns, setup...). */
export function parseTrade(tx: any, sig: string, mint: string, pool: string, venue: Trade['venue'], decimals: number, hookProgram?: PublicKey): Trade | null {
  if (!tx?.meta) return null;
  const msg = tx.transaction?.message;
  const keys = msg?.staticAccountKeys ?? msg?.accountKeys ?? [];
  const trader = keys[0] ? (typeof keys[0] === 'string' ? keys[0] : keys[0].toBase58?.() ?? String(keys[0].pubkey ?? keys[0])) : '';
  const base = { sig, slot: Number(tx.slot), time: tx.blockTime ?? null, pool, venue, trader };
  if (tx.meta.err) {
    const e = hookErrorFromLogs(tx.meta.logMessages ?? [], hookProgram);
    return e ? { ...base, side: 'blocked', baseRaw: '0', quoteLamports: '0', price: null, error: e } : null;
  }
  const pre: TokenBal[] = tx.meta.preTokenBalances ?? [], post: TokenBal[] = tx.meta.postTokenBalances ?? [];
  const dBase = poolDelta(pre, post, mint), dQuote = poolDelta(pre, post, WSOL);
  // a swap moves base and quote in opposite directions through the pool
  if (dBase === 0n || dQuote === 0n || (dBase > 0n) === (dQuote > 0n)) return null;
  const side = dBase < 0n ? 'buy' : 'sell';   // base left the pool = someone bought
  const baseAbs = dBase < 0n ? -dBase : dBase, quoteAbs = dQuote < 0n ? -dQuote : dQuote;
  const price = (Number(quoteAbs) / 1e9) / (Number(baseAbs) / 10 ** decimals);
  return { ...base, side, baseRaw: baseAbs.toString(), quoteLamports: quoteAbs.toString(), price: Number.isFinite(price) ? price : null };
}

export const indexFile = (cluster: ClusterName, mint: string, dir = INDEX_DIR) => join(dir, cluster, `${mint}.json`);
export function readIndex(cluster: ClusterName, mint: string, dir = INDEX_DIR): TokenIndex | null {
  const f = indexFile(cluster, mint, dir);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}
function writeIndex(ix: TokenIndex, dir: string) {
  const f = indexFile(ix.cluster, ix.mint, dir);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + '.tmp', JSON.stringify(ix));
  renameSync(f + '.tmp', f);   // atomic: the site never reads a half-written file
}

/** The DAMM v2 pool a DBC launch migrates into (pinned migration config; base vs wSOL). */
export function dammPoolFor(mint: string, dammConfig: string): string {
  return deriveDammV2PoolAddress(new PublicKey(dammConfig), new PublicKey(mint), NATIVE_MINT).toBase58();
}

export interface IndexTarget { mint: string; decimals?: number; pools: { address: string; venue: Trade['venue'] }[] }
export interface IndexOptions { dir?: string; maxPerPool?: number; hookProgram?: PublicKey; log?: (s: string) => void; concurrency?: number }

/** Index one token: new signatures since the last run on each pool, newest first, then merge and save. */
export async function indexToken(conn: Connection, cluster: ClusterName, t: IndexTarget, o: IndexOptions = {}): Promise<{ added: number; total: number }> {
  const dir = o.dir ?? INDEX_DIR, maxPerPool = o.maxPerPool ?? 500, log = o.log ?? (() => {});
  const prev = readIndex(cluster, t.mint, dir);
  const ix: TokenIndex = prev ?? { mint: t.mint, cluster, decimals: t.decimals ?? 6, pools: {}, trades: [], updatedAt: '' };
  if (t.decimals !== undefined) ix.decimals = t.decimals;
  const seen = new Set(ix.trades.map((x) => x.sig));
  const fresh: Trade[] = [];
  for (const p of t.pools) {
    const state = ix.pools[p.address] ?? { venue: p.venue, lastSig: null };
    const sigs: { signature: string }[] = []; let before: string | undefined;
    while (sigs.length < maxPerPool) {
      const page = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: Math.min(100, maxPerPool - sigs.length), before, until: state.lastSig ?? undefined }, 'confirmed');
      if (!page.length) break;
      sigs.push(...page); before = page[page.length - 1].signature;
      if (page.length < 100) break;
    }
    const todo = sigs.map((s) => s.signature).filter((s) => !seen.has(s));
    log(`  ${p.venue} ${p.address.slice(0, 6)}…: ${todo.length} new signature(s)`);
    const conc = Math.max(1, o.concurrency ?? 3);
    for (let i = 0; i < todo.length; i += conc) {
      const batch = todo.slice(i, i + conc);
      const txs = await Promise.all(batch.map((s) => conn.getTransaction(s, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null)));
      txs.forEach((tx, j) => { const tr = parseTrade(tx, batch[j], t.mint, p.address, p.venue, ix.decimals, o.hookProgram); if (tr) fresh.push(tr); });
    }
    if (sigs.length) state.lastSig = sigs[0].signature;   // newest seen; next run starts after it
    ix.pools[p.address] = state;
  }
  ix.trades = [...fresh, ...ix.trades].sort((a, b) => b.slot - a.slot || a.sig.localeCompare(b.sig)).slice(0, MAX_TRADES);
  ix.updatedAt = new Date().toISOString();
  writeIndex(ix, dir);
  return { added: fresh.length, total: ix.trades.length };
}

/** What the page needs: newest trades plus candles over a time interval (seconds). Prices only, no volume totals. */
export interface Candle { t: number; o: number; h: number; l: number; c: number; n: number }
export function candles(trades: Trade[], intervalSec: number): Candle[] {
  const pts = trades.filter((x) => x.price !== null && x.time !== null && x.side !== 'blocked').sort((a, b) => a.slot - b.slot);
  const out: Candle[] = [];
  for (const x of pts) {
    const t = Math.floor(x.time! / intervalSec) * intervalSec;
    const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, x.price!); last.l = Math.min(last.l, x.price!); last.c = x.price!; last.n++; }
    else out.push({ t, o: x.price!, h: x.price!, l: x.price!, c: x.price!, n: 1 });
  }
  return out;
}

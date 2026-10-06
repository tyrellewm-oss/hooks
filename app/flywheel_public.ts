// Transparency page data: the keeper's public logs (flywheel/<cluster>-*.json, written by sdk/flywheel), reshaped
// for the page. Read-only. Only registry mints are shown (ticket 8.5b): the caller passes the registry set that
// siteRoute read once for this request. Every claim, buyback and burn keeps its signature and explorer link.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explorerTx, type ClusterName } from '../sdk/cluster.js';

export const FLYWHEEL_DIR = 'flywheel';
const MAX_RUNS = 30;

export interface PublicRun { runId: string; startedAt: string; status: string; reason: string; claimedLamports: string; links: { what: string; sig: string; link: string }[] }
export interface PublicKeeper {
  name: string; mint: string; state: string; paused: boolean; pauseReason: string;
  claimedSol: string; devSol: string; spentSol: string; reserveSol: string;
  burnedTokens: string; supplyTokens: string; pctOfSupply: string;
  burns: { at: string; tokens: string; sol: string; sig: string; link: string }[];
  /** buy pot: SOL paid to winners, SOL waiting for the next winner, and each payout with its tx (newest first) */
  potSol: string; potPendingSol: string;
  potPayouts: { at: string; win: number; owner: string; sol: string; sig: string; link: string }[];
  runs: PublicRun[];
  pools: { dbc: string | null; route: string | null };
}

const str = (v: unknown, d = '') => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : d);

export function shapeKeeperLog(name: string, l: any, cluster: ClusterName): PublicKeeper {
  const runs: PublicRun[] = (Array.isArray(l.runs) ? l.runs : []).slice(-MAX_RUNS).reverse().map((r: any) => {
    const links: PublicRun['links'] = [];
    for (const c of Array.isArray(r.claims) ? r.claims : []) if (c?.sig) links.push({ what: `claim (${str(c.source)})`, sig: c.sig, link: explorerTx(c.sig, cluster) });
    const pot = (Array.isArray(r.pot_payouts) ? r.pot_payouts : []).map((p: any) => [`pot payout (win #${str(p?.win)})`, p?.sig] as const);
    for (const [what, s] of [['dev payout (15%)', r?.dev_sig], ...pot, ['buyback swap', r?.swap?.sig], ['burn', r?.burn?.sig]] as const) {
      if (typeof s === 'string' && s) links.push({ what, sig: s, link: explorerTx(s, cluster) });
    }
    const claimed = (Array.isArray(r.claims) ? r.claims : []).reduce((a: bigint, c: any) => { try { return a + BigInt(str(c?.claimed_lamports, '0')); } catch { return a; } }, 0n);
    return { runId: str(r.run_id), startedAt: str(r.started_at), status: str(r.status, 'unknown'), reason: str(r.reason), claimedLamports: claimed.toString(), links };
  });
  return {
    name, mint: str(l.mint), state: str(l.state, 'unknown'), paused: l.paused === true, pauseReason: str(l.pause_reason),
    claimedSol: str(l.claimedSol, '0'), devSol: str(l.devSol, '0'), spentSol: str(l.spentSol, '0'), reserveSol: str(l.reserveSol, '0'),
    burnedTokens: str(l.burnedTokens, '0'), supplyTokens: str(l.supplyTokens), pctOfSupply: str(l.pctOfSupply, '0'),
    burns: (Array.isArray(l.burns) ? l.burns : []).slice().reverse().map((b: any) => ({ at: str(b.at), tokens: str(b.tokens), sol: str(b.sol), sig: str(b.sig), link: b.sig ? explorerTx(b.sig, cluster) : '' })),
    potSol: str(l.potSol, '0'), potPendingSol: str(l.potPendingSol, '0'),
    potPayouts: (Array.isArray(l.pot_payouts) ? l.pot_payouts : []).slice().reverse().map((p: any) => ({ at: str(p.at), win: Number(p.win) || 0, owner: str(p.owner), sol: str(p.sol), sig: str(p.sig), link: p.sig ? explorerTx(p.sig, cluster) : '' })),
    runs,
    pools: { dbc: l.main_dbc_pool ?? null, route: l.route_pool ?? null },
  };
}

/** Public keeper logs for this cluster, registry mints only. A file that doesn't parse is skipped and reported. */
export function loadPublicKeepers(cluster: ClusterName, registered: ReadonlySet<string>, dir = FLYWHEEL_DIR): { keepers: PublicKeeper[]; skipped: string[] } {
  const keepers: PublicKeeper[] = []; const skipped: string[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.startsWith(`${cluster}-`) && f.endsWith('.json')).sort(); } catch { return { keepers, skipped }; }
  for (const f of files) {
    let l: any;
    try { l = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { skipped.push(f); continue; }
    if (typeof l?.mint !== 'string' || !registered.has(l.mint)) continue;
    keepers.push(shapeKeeperLog(f.replace(/\.json$/, ''), l, cluster));
  }
  return { keepers, skipped };
}

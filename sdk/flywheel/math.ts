// Pure, integer-only flywheel math (spec §4, §5). No floats touch lamports or token amounts.
export const BPS = 10_000n;
export const DEV_SHARE_PCT = 15n;

/** §4: dev = floor(claimed × 15 / 100), buyback = claimed − dev (rounding dust always goes to buyback). */
export function splitFees(claimed: bigint): { dev: bigint; buyback: bigint } {
  if (claimed < 0n) throw new Error('negative claim');
  const dev = (claimed * DEV_SHARE_PCT) / 100n;
  return { dev, buyback: claimed - dev };
}

/** Pot variant of the §4 split: dev = floor(claimed × 15 / 100) exactly as splitFees, pot = floor(potBase × potPct / 100)
 *  where potBase is the part of `claimed` that came from bonding-curve fees (the pot is a curve-phase game), buyback =
 *  the remainder (dust to buyback). potPct 0 gives splitFees' numbers with pot 0. */
export function splitWithPot(claimed: bigint, potPct: bigint, potBase: bigint): { dev: bigint; pot: bigint; buyback: bigint } {
  const { dev } = splitFees(claimed);
  if (potPct < 0n || DEV_SHARE_PCT + potPct > 100n) throw new Error(`bad pot share ${potPct}`);
  if (potBase < 0n || potBase > claimed) throw new Error(`pot base ${potBase} outside 0..${claimed}`);
  const pot = (potBase * potPct) / 100n;
  return { dev, pot, buyback: claimed - dev - pot };
}

/** One recorded pot win still visible in the 16-slot ring buffer (owner = the winning buyer's wallet). */
export interface PotWin { win: number; owner: string }
export interface PotPlan {
  payouts: { win: number; owner: string; lamports: bigint }[];
  /** unpaid wins pushed out of the ring before they could be paid (their share stays in the pot) */
  overwritten: number;
  /** pot left in the treasury for later winners after these payouts */
  held: bigint;
  /** pot moved to the buyback: only once the pot is closed (graduated), when no unpaid winner is left to pay */
  release: bigint;
  /** the paid cursor once every payout in this plan has landed */
  paidThrough: bigint;
  reason: 'none' | 'no_new_wins' | 'all_unpaid_overwritten' | 'pot_empty' | 'below_min';
}
/** Plan one run's pot payouts (pure). `wins` = wins recorded on chain, `paidWins` = the paid cursor, `ringWins` = wins
 *  still visible in the ring. The pot splits equally among the unpaid wins still visible; dust stays in the pot.
 *  Unpaid wins already pushed out of the ring are counted in `overwritten` and skipped; their share stays in the pot.
 *  Open pot (curve still running): a share below `minPayout` pays nobody yet and the whole pot carries.
 *  Closed pot (graduated: no new wins can happen): the minimum is waived, unpaid winners get whatever the pot holds,
 *  and anything left over goes to the buyback instead of sitting in the treasury forever. */
export function planPotPayouts(potPending: bigint, wins: bigint, paidWins: bigint, ringWins: PotWin[], minPayout: bigint, open = true): PotPlan {
  if (potPending < 0n || wins < 0n || paidWins < 0n || minPayout < 0n) throw new Error('negative pot input');
  if (paidWins > wins) throw new Error(`paid cursor ${paidWins} ahead of wins ${wins}`);
  const unpaid = ringWins.filter(w => BigInt(w.win) > paidWins && BigInt(w.win) <= wins).sort((a, b) => a.win - b.win);
  if (new Set(unpaid.map(w => w.win)).size !== unpaid.length) throw new Error('duplicate win numbers in the ring');
  const overwritten = Number(wins - paidWins) - unpaid.length;
  if (overwritten < 0) throw new Error('ring holds more unpaid wins than the chain counter');
  const none = (reason: PotPlan['reason'], paidThrough: bigint): PotPlan =>
    open ? { payouts: [], overwritten, held: potPending, release: 0n, paidThrough, reason } : { payouts: [], overwritten, held: 0n, release: potPending, paidThrough: wins, reason };
  if (unpaid.length === 0) return none(wins === paidWins ? 'no_new_wins' : 'all_unpaid_overwritten', wins);
  const share = potPending / BigInt(unpaid.length);
  if (share === 0n) return none('pot_empty', paidWins);
  if (open && share < minPayout) return none('below_min', paidWins);
  const left = potPending - share * BigInt(unpaid.length);
  return { payouts: unpaid.map(w => ({ win: w.win, owner: w.owner, lamports: share })), overwritten, held: open ? left : 0n, release: open ? 0n : left, paidThrough: wins, reason: 'none' };
}

/** §5: min_out = outRaw × (10,000 − slippage_bps) / 10,000 (floor). */
export function minOut(outRaw: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) throw new Error('bad slippage');
  return (outRaw * (BPS - BigInt(slippageBps))) / BPS;
}

/** Output at the pool's spot price for `inLamports` of token B (SOL) into token A, from DAMM v2 sqrt_price (Q64.64):
 *  price(B per A, raw) = sqrtP² / 2^128, so A out at spot = in × 2^128 / sqrtP². */
export function spotOutBtoA(inLamports: bigint, sqrtPriceX64: bigint): bigint {
  if (sqrtPriceX64 <= 0n) throw new Error('bad sqrt price');
  return (inLamports << 128n) / (sqrtPriceX64 * sqrtPriceX64);
}

/** Deviation of a quote from spot in bps (fees + curve impact), floor; 0 if the quote beats spot. */
export function deviationBps(spotOut: bigint, quoteOut: bigint): number {
  if (spotOut <= 0n) throw new Error('spot out is 0');
  if (quoteOut >= spotOut) return 0;
  return Number(((spotOut - quoteOut) * BPS) / spotOut);
}

export type CarryReason = 'none' | 'max_cap' | 'impact_halving' | 'max_cap+impact_halving';
export interface SwapPlan { inLamports: bigint; halvings: number; carryover: bigint; reason: CarryReason; impactBps: number; quoteOut: bigint }

/** §5 sizing: start at min(pending, max), halve while impact > max_impact (at most `maxHalvings` times), then fail closed.
 *  `quote(in)` returns { out, impactBps }. Throws 'impact_too_high' if still over after the last halving. */
export async function planSwap(pending: bigint, maxPerRun: bigint, maxImpactBps: number, maxHalvings: number,
  quote: (inLamports: bigint) => Promise<{ out: bigint; impactBps: number }>): Promise<SwapPlan> {
  if (pending <= 0n) throw new Error('nothing pending');
  const capped = pending > maxPerRun;
  let inL = capped ? maxPerRun : pending;
  let halvings = 0;
  for (;;) {
    const q = await quote(inL);
    if (q.impactBps <= maxImpactBps) {
      const carry = pending - inL;
      const reason: CarryReason = carry === 0n ? 'none' : capped && halvings ? 'max_cap+impact_halving' : halvings ? 'impact_halving' : 'max_cap';
      return { inLamports: inL, halvings, carryover: carry, reason, impactBps: q.impactBps, quoteOut: q.out };
    }
    if (halvings >= maxHalvings) throw new Error(`impact_too_high: ${q.impactBps} bps > ${maxImpactBps} after ${halvings} halvings`);
    inL = inL / 2n; halvings++;
    if (inL === 0n) throw new Error('impact_too_high: size halved to 0');
  }
}

/** §8: one run id per cadence window: `<cluster>-<UTC window start ISO>`. */
export function runIdFor(cluster: string, nowMs: number, cadenceSec: number): string {
  const w = Math.floor(nowMs / 1000 / cadenceSec) * cadenceSec;
  return `${cluster}-${new Date(w * 1000).toISOString().replace('.000Z', 'Z')}`;
}

/** Median of bigints (lower median for even length). */
export function medianBig(xs: bigint[]): bigint | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)];
}
/** §5 soft warning: implied price (raw tokens per lamport ×1e9) vs median of last 5 successful runs; > band_pct → warn only. */
export function historyWarning(impliedX1e9: bigint, history: bigint[], bandPct: number): string | null {
  const m = medianBig(history.slice(-5));
  if (m === null || m === 0n) return null;
  const diff = impliedX1e9 > m ? impliedX1e9 - m : m - impliedX1e9;
  return diff * 100n > m * BigInt(bandPct) ? `warn_price_vs_history: implied ${impliedX1e9} vs median ${m} (> ${bandPct}%)` : null;
}

export const fmtSol = (l: bigint) => {
  const neg = l < 0n; const a = neg ? -l : l;
  return `${neg ? '-' : ''}${a / 1_000_000_000n}.${(a % 1_000_000_000n).toString().padStart(9, '0')}`;
};
export const fmtTokens = (raw: bigint, decimals: number) => {
  const d = 10n ** BigInt(decimals); return `${raw / d}.${(raw % d).toString().padStart(decimals, '0')}`;
};
/** pct of supply with 4 decimals, as a string, from raw integers. */
export const pctOf = (part: bigint, whole: bigint) => (whole === 0n ? '0.0000' : fmtTokens((part * 1_000_000n) / whole, 4));

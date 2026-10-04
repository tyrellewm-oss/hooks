// Pure token-page logic (no DOM, no React): lifecycle phase, cap config from the chain view, the approximate
// curve fee right now, and amount parsing. Unit-tested in tests/web_token_logic.test.ts.
import { effectiveCap, nextChange, roomUnderCap, type CapConfig } from '../../../sdk/capMath';
import type { TokenView, FeeInfo, TokenStatus } from './types';

export const SLOT_MS_APPROX = 400; // ~0.4 s/slot; every duration derived from it is shown as approximate

export type Phase = 'early' | 'capped' | 'uncapped' | 'graduated' | 'unknown';

export const PHASES: { id: Exclude<Phase, 'unknown'>; label: string; hint: string }[] = [
  { id: 'early', label: 'Curve, early fee', hint: 'capped, anti-sniper fee still falling' },
  { id: 'capped', label: 'Curve, capped', hint: 'cap per token account applies' },
  { id: 'uncapped', label: 'Curve, no cap', hint: 'ramp over or cap lifted' },
  { id: 'graduated', label: 'Graduated', hint: 'hook removed, DAMM v2 pool' },
];

export function capConfigOf(st: TokenStatus): CapConfig | null {
  if (!st.steps || st.launchSlot === undefined || st.uncappedAfter === undefined) return null;
  return {
    launchSlot: BigInt(st.launchSlot),
    supply: BigInt(st.supply),
    steps: st.steps.map((s) => ({ slotOffset: BigInt(s.slotOffset), maxBps: s.maxBps })),
    uncappedAfter: BigInt(st.uncappedAfter),
  };
}

export const isGraduated = (v: TokenView) => v.status.transferHookProgram === null || v.pool?.isMigrated === true;

/** Slots since launch at `slot` (0 before launch). */
export function elapsedSlots(st: TokenStatus, slot: bigint): bigint {
  if (st.launchSlot === undefined) return 0n;
  const l = BigInt(st.launchSlot);
  return slot > l ? slot - l : 0n;
}

/** Cap per token account at `slot` (base units), with the lift switch applied. null = no cap. */
export function liveCap(v: TokenView, slot: bigint): bigint | null {
  if (isGraduated(v)) return null;
  const cfg = capConfigOf(v.status);
  if (!cfg) return null;
  const st = v.status;
  return effectiveCap(cfg, { lifted: !!st.mintLifted, raisedFloorBps: st.raisedFloorBps ?? 0 }, !!st.globalLifted, slot);
}

export function liveNextChange(v: TokenView, slot: bigint): { slot: bigint; bps: number | null } | null {
  if (isGraduated(v) || liveCap(v, slot) === null) return null;
  const cfg = capConfigOf(v.status);
  return cfg ? nextChange(cfg, slot) : null;
}

export function phaseOf(v: TokenView, slot: bigint): Phase {
  if (isGraduated(v)) return 'graduated';
  if (!capConfigOf(v.status)) return 'unknown';
  if (liveCap(v, slot) === null) return 'uncapped';
  if (v.fee && elapsedSlots(v.status, slot) < BigInt(v.fee.totalSlots)) return 'early';
  return 'capped';
}

/** Approximate curve fee (%) at `elapsed` slots, from the on-chain fee scheduler config. Real fees follow the
 *  DBC scheduler exactly; this is for display and is always labelled approximate. */
export function curveFeePctAt(fee: FeeInfo | null, elapsed: bigint): number | null {
  if (!fee) return null;
  if (fee.periods <= 0 || fee.periodSlots <= 0 || elapsed >= BigInt(fee.totalSlots)) return fee.endPct;
  const k = Math.min(fee.periods, Math.trunc(Number(elapsed) / fee.periodSlots));
  const pct = fee.mode.startsWith('exponential') && fee.cliffPct > 0
    ? fee.cliffPct * Math.pow(fee.endPct / fee.cliffPct, k / fee.periods)
    : fee.cliffPct - (k * (fee.cliffPct - fee.endPct)) / fee.periods;
  return Math.round(Math.max(fee.endPct, pct) * 100) / 100;
}

/** Slot estimate between polls: last chain slot plus wall-clock time at ~0.4 s/slot. Display only. */
export function estimateSlot(chainSlot: number, fetchedAt: number, now: number): bigint {
  const drift = Math.max(0, Math.trunc((now - fetchedAt) / SLOT_MS_APPROX));
  return BigInt(chainSlot) + BigInt(drift);
}

/** "12.5" tokens -> base units, exact (no float). Throws on bad input. */
export function parseTokenAmount(s: string, decimals: number): bigint {
  const t = s.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error('Enter a number of tokens');
  const [whole, frac = ''] = t.split('.');
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Base units -> plain token string (no grouping), for putting back into the amount field. */
export function formatTokenAmount(base: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = base / d, frac = base % d;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

export interface BuyPreview { balance: bigint; after: bigint; cap: bigint | null; room: bigint | null; overBy: bigint }
export function buyPreview(balance: bigint, amount: bigint, cap: bigint | null): BuyPreview {
  const after = balance + amount;
  return { balance, after, cap, room: roomUnderCap(cap, balance), overBy: cap !== null && after > cap ? after - cap : 0n };
}

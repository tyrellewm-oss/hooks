// TS mirror of crates/cap-math (AC-2). Same rules, bigint math. Kept in sync by
// tests/capmath.test.ts (table tests identical to the Rust ones + random parity vs on-chain view).
export const MAX_STEPS = 8;
export const BPS_DENOM = 10_000;
export const FLOOR_BPS = 10;
/** Longest allowed ramp (QA H-3), ~30 days at ~0.4 s/slot (estimate). */
export const MAX_RAMP_SLOTS = 6_480_000n;
export const U64_MAX = (1n << 64n) - 1n;
export interface Limits { minStepSlots: bigint; minRampSlots: bigint }
export const RELEASE_LIMITS: Limits = { minStepSlots: 10n, minRampSlots: 150n };
export const TEST_SLOTS_LIMITS: Limits = { minStepSlots: 1n, minRampSlots: 2n };
export interface Step { slotOffset: bigint; maxBps: number }
export interface CapConfig { launchSlot: bigint; supply: bigint; steps: Step[]; uncappedAfter: bigint }
export interface Lift { lifted: boolean; raisedFloorBps: number }

export type ScheduleError = 'BadLength' | 'FirstOffsetNotZero' | 'BadOffsets' | 'Decreasing' | 'OutOfRange' | 'BadEnd' | 'ZeroSupply';

export function validate(c: CapConfig, lim: Limits): ScheduleError | null {
  if (c.supply === 0n) return 'ZeroSupply';
  const n = c.steps.length;
  if (n === 0 || n > MAX_STEPS) return 'BadLength';
  if (c.steps[0].slotOffset !== 0n) return 'FirstOffsetNotZero';
  for (let i = 0; i < n; i++) {
    const s = c.steps[i];
    if (s.maxBps < FLOOR_BPS || s.maxBps > BPS_DENOM) return 'OutOfRange';
    if (i > 0) {
      const p = c.steps[i - 1];
      const gap = s.slotOffset - p.slotOffset;
      if (gap <= 0n || gap < lim.minStepSlots) return 'BadOffsets';
      if (s.maxBps < p.maxBps) return 'Decreasing';
    }
  }
  const gap = c.uncappedAfter - c.steps[n - 1].slotOffset;
  if (gap <= 0n || gap < lim.minStepSlots) return 'BadEnd';
  if (c.uncappedAfter < lim.minRampSlots || c.uncappedAfter > MAX_RAMP_SLOTS) return 'BadEnd';
  return null;
}

const satSub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
// Rust u64::saturating_add (QA L-1)
const satAdd = (a: bigint, b: bigint) => (a + b > U64_MAX ? U64_MAX : a + b);

export function capBpsAt(c: CapConfig, slot: bigint): number | null {
  if (c.steps.length === 0) return null;
  const elapsed = satSub(slot, c.launchSlot);
  if (elapsed >= c.uncappedAfter) return null;
  let bps = c.steps[0].maxBps;
  for (const s of c.steps) { if (s.slotOffset <= elapsed) bps = s.maxBps; else break; }
  return bps;
}
export const bpsToAmount = (supply: bigint, bps: number) => (supply * BigInt(Math.min(bps, BPS_DENOM))) / BigInt(BPS_DENOM);
export function capAt(c: CapConfig, slot: bigint): bigint | null {
  const b = capBpsAt(c, slot);
  return b === null ? null : bpsToAmount(c.supply, b);
}
export function nextChange(c: CapConfig, slot: bigint): { slot: bigint; bps: number | null } | null {
  const elapsed = satSub(slot, c.launchSlot);
  if (elapsed >= c.uncappedAfter) return null;
  const cur = capBpsAt(c, slot);
  for (const s of c.steps) if (s.slotOffset > elapsed && s.maxBps !== cur) return { slot: satAdd(c.launchSlot, s.slotOffset), bps: s.maxBps };
  return { slot: satAdd(c.launchSlot, c.uncappedAfter), bps: null };
}
export function effectiveCap(c: CapConfig, lift: Lift, globalLifted: boolean, slot: bigint): bigint | null {
  if (globalLifted || lift.lifted) return null;
  let bps = capBpsAt(c, slot);
  if (bps === null) return null;
  if (lift.raisedFloorBps > bps) bps = lift.raisedFloorBps;
  if (bps >= BPS_DENOM) return null;
  return bpsToAmount(c.supply, bps);
}
export type Decision = { allow: true } | { allow: false; cap: bigint };
export function decide(destExempt: boolean, cap: bigint | null, postBalance: bigint): Decision {
  if (destExempt || cap === null || postBalance <= cap) return { allow: true };
  return { allow: false, cap };
}
/** Room left for a wallet under the cap (null = unlimited). */
export const roomUnderCap = (cap: bigint | null, balance: bigint) => (cap === null ? null : cap > balance ? cap - balance : 0n);

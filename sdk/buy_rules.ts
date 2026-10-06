// The optional launch hooks (program v2 rules: max single buy, max bought per slot, Nth-buy pot, slow mode) as the studio sends
// them: shares of supply in bps, turned into the raw token amounts the program stores. Limits mirror the program's
// validate_rules (programs/trenches-hook/src/lib.rs, constants.rs) so a bad value is refused before any tx is built.
import type { BuyRules } from './hook.js';

export const POT_EVERY_MIN = 10;
export const POT_EVERY_MAX = 100_000;
export const RULES_WINDOW_MAX = 1_000_000;
/** Slow mode: maximum gap between curve buys (program constants.rs COOLDOWN_MAX; ~1 min at ~0.4 s/slot). */
export const COOLDOWN_MAX = 150;
/** Raw supply of a studio launch: 1,000,000,000 tokens with 6 decimals (curveConfigParams). */
export const LAUNCH_SUPPLY_RAW = 1_000_000_000n * 1_000_000n;

/** What the launch form sends. Omitted / null / 0 = that hook is off. */
export interface BuyRulesInput { maxBuyBps?: number | null; maxPerSlotBps?: number | null; windowSlots?: number | string | null; potEvery?: number | null; potMinBps?: number | null; cooldownSlots?: number | null }

export class BuyRulesRefusal extends Error {}

const bps = (v: unknown, what: string, min: number): number => {
  if (v === undefined || v === null || v === 0) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > 10_000) throw new BuyRulesRefusal(`${what} must be a whole number of bps, ${min} to 10000 (got ${String(v)})`);
  return v;
};

/** null when no optional hook is on (the launch uses the v1 hook config, exactly as before). */
export function parseBuyRules(v: unknown, supplyRaw: bigint = LAUNCH_SUPPLY_RAW): BuyRules | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new BuyRulesRefusal('rules must be an object');
  const r = v as BuyRulesInput;
  const maxBuy = bps(r.maxBuyBps, 'max single buy', 1);
  const perSlot = bps(r.maxPerSlotBps, 'max bought per slot', 1);
  const potMin = bps(r.potMinBps, 'pot minimum buy', 0);
  const potEvery = r.potEvery === undefined || r.potEvery === null ? 0 : r.potEvery;
  if (typeof potEvery !== 'number' || !Number.isInteger(potEvery) || (potEvery !== 0 && (potEvery < POT_EVERY_MIN || potEvery > POT_EVERY_MAX)))
    throw new BuyRulesRefusal(`pot: every Nth buy must be ${POT_EVERY_MIN} to ${POT_EVERY_MAX} (got ${String(r.potEvery)})`);
  const cooldown = r.cooldownSlots === undefined || r.cooldownSlots === null ? 0 : r.cooldownSlots;
  if (typeof cooldown !== 'number' || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > COOLDOWN_MAX)
    throw new BuyRulesRefusal(`slow mode must be 0 (off) to ${COOLDOWN_MAX} slots between buys (got ${String(r.cooldownSlots)})`);
  if (!maxBuy && !perSlot && !potEvery && !cooldown) return null;
  if (maxBuy && perSlot && perSlot < maxBuy) throw new BuyRulesRefusal('max bought per slot must be at least the max single buy');
  let windowSlots: bigint;
  try { windowSlots = BigInt(r.windowSlots ?? 0); } catch { throw new BuyRulesRefusal('window must be a whole number of slots'); }
  if (windowSlots < 0n || windowSlots > BigInt(RULES_WINDOW_MAX)) throw new BuyRulesRefusal(`window must be 0 (until graduation) to ${RULES_WINDOW_MAX} slots`);
  const raw = (b: number) => (supplyRaw * BigInt(b)) / 10_000n;
  return { maxBuyTokens: raw(maxBuy), maxPerSlotTokens: raw(perSlot), windowSlots, potEvery, potMinTokens: potEvery ? raw(potMin) : 0n, cooldownSlots: BigInt(cooldown) };
}

/** Back to the form's shares (bps of supply) for display. */
export function buyRulesBps(r: BuyRules, supplyRaw: bigint = LAUNCH_SUPPLY_RAW) {
  const b = (t: bigint) => Number((t * 10_000n) / supplyRaw);
  return { maxBuyBps: b(r.maxBuyTokens), maxPerSlotBps: b(r.maxPerSlotTokens), windowSlots: r.windowSlots.toString(), potEvery: r.potEvery, potMinBps: b(r.potMinTokens), cooldownSlots: Number(r.cooldownSlots) };
}

/** A create-pool simulation that fails with Anchor's InstructionFallbackNotFound (101) on a rules launch means the
 *  cluster's hook program predates the v2 rules instruction. */
export function rulesUnsupportedHint(message: string): string | null {
  return /"Custom":\s*101\b|InstructionFallbackNotFound/.test(message)
    ? 'the hook program on this cluster does not have the optional hooks yet (it needs the program upgrade). Turn the optional hooks off to launch now.'
    : null;
}

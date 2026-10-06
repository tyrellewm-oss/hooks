// The hooks every Hookd token runs, in one place for the hooks page and the launch tool. Values are the studio
// defaults (sdk/launch.ts DEFAULT_LAUNCH_FEES, the flywheel keeper spec's 15/85 split); each token page shows its own.
import type { ReactNode } from 'react';
import type { Meta } from './types';
import { approxDuration, pctOf } from './shared';
import { CapDiagram, FlywheelDiagram, LiftDiagram, SniperFeeDiagram, MaxBuyDiagram, SlotLimitDiagram, PotDiagram, CooldownDiagram, LockDiagram } from '../components/HookArt';
import { IconFee, IconFlame, IconShield, IconSwitch, IconCeiling, IconBlocks, IconTrophy, IconClock, IconLock } from '../components/Icons';

export const SNIPER_DEFAULT = { startBps: 5000, endBps: 100, periods: 10, durationSlots: 150 };
export const FLYWHEEL_SPLIT = { devPct: 15, buybackPct: 85 };

export type HookId = 'cap' | 'fee' | 'switch' | 'burn' | 'lock' | OptionalHookId;
export type OptionalHookId = 'maxbuy' | 'slot' | 'pot' | 'cooldown';
export const HOOK_IDS: HookId[] = ['cap', 'fee', 'switch', 'burn', 'maxbuy', 'slot', 'pot', 'cooldown', 'lock'];

/** Studio defaults for the optional hooks (shares of supply in bps; window in slots, 0 = until graduation). */
export const RULES_DEFAULT = { maxBuyBps: 50, maxPerSlotBps: 150, windowSlots: '1500', potEvery: 50, potMinBps: 1, cooldownSlots: 25 };
/** Creator lock defaults (not a transfer-hook rule: DBC locked vesting, set at launch). ~1 day at ~0.4 s/slot. */
export const CREATOR_LOCK_DEFAULT = { pct: 5, slots: 216_000 };
export const CREATOR_LOCK_DURATIONS: { slots: number; label: string }[] = [
  { slots: 216_000, label: '~1 day' },
  { slots: 1_512_000, label: '~1 week' },
  { slots: 6_480_000, label: '~30 days' },
];
export const RULES_WINDOWS: { slots: string; label: string }[] = [
  { slots: '150', label: 'First ~1 min' },
  { slots: '1500', label: 'First ~10 min' },
  { slots: '4500', label: 'First ~30 min' },
  { slots: '0', label: 'Until graduation' },
];
export const windowText = (slots: string) => (slots === '0' ? 'until graduation' : `first ${approxDuration(slots)}`);
export interface HookInfo {
  id: HookId;
  name: string;
  icon: ReactNode;
  tone: 'accent' | 'amber' | 'sim' | 'green';
  /** one line for tiles */
  short: string;
  /** when it is on */
  when: string;
  /** where it runs */
  runs: string;
  steps: string[];
  settings: { k: string; v: string }[];
  limits: string;
  diagram: ReactNode;
  /** how the launch tool treats it */
  launch: 'tunable' | 'always' | 'optional';
}

export function hookList(meta: Meta): HookInfo[] {
  const s = meta.defaultSchedule;
  const capStart = pctOf(s.steps[0]?.maxBps ?? 0);
  const capEnd = pctOf(s.steps[s.steps.length - 1]?.maxBps ?? 0);
  const ramp = approxDuration(s.uncappedAfter);
  const f = SNIPER_DEFAULT;
  const feeTime = approxDuration(String(f.durationSlots));
  return [
    {
      id: 'cap', name: 'Cap per token account', icon: <IconShield size={20} />, tone: 'accent', launch: 'tunable',
      short: `Each token account holds at most ${capStart} → ${capEnd} of supply`,
      when: 'Bonding curve only', runs: 'Transfer hook program, checked on every transfer',
      steps: [
        'Someone buys on the bonding curve, so tokens move into their token account.',
        "The transfer hook runs inside that same transaction and reads the account's new balance.",
        `If the balance would go over the cap (${capStart} of supply at launch, rising to ${capEnd}), the whole buy fails and nothing moves. Otherwise the tokens land.`,
      ],
      settings: [
        { k: 'Cap at launch', v: capStart },
        { k: 'Cap at the end of the ramp', v: capEnd },
        { k: 'Ramp steps', v: String(s.steps.length) },
        { k: 'No cap after', v: ramp },
      ],
      limits: 'Per token account, not per wallet: one person can use several accounts or wallets. It slows snipers down; it does not stop them. Selling back into the curve is never blocked.',
      diagram: <CapDiagram capText={capStart} />,
    },
    {
      id: 'fee', name: 'Anti-sniper fee', icon: <IconFee size={20} />, tone: 'amber', launch: 'always',
      short: `Curve fee starts at ${pctOf(f.startBps)} and falls to ${pctOf(f.endBps)} in ${feeTime}`,
      when: `First ${feeTime} after launch`, runs: 'Meteora bonding curve fee schedule, set at launch',
      steps: [
        `The curve's trading fee starts high: ${pctOf(f.startBps)} on the first trades.`,
        `It steps down ${f.periods} times over ${f.durationSlots} slots (${feeTime}).`,
        `After that it stays at ${pctOf(f.endBps)} until graduation. Bots that buy in the first seconds pay the most.`,
      ],
      settings: [
        { k: 'Starting fee', v: pctOf(f.startBps) },
        { k: 'Fee after the schedule', v: pctOf(f.endBps) },
        { k: 'Steps', v: String(f.periods) },
        { k: 'Length', v: `${f.durationSlots} slots · ${feeTime}` },
      ],
      limits: 'It makes the first seconds expensive; it does not block anyone. Once the pool takes over at graduation, only the pool fee applies.',
      diagram: <SniperFeeDiagram {...f} durationText={feeTime} />,
    },
    {
      id: 'switch', name: 'Lift-only switch', icon: <IconSwitch size={20} />, tone: 'sim', launch: 'always',
      short: 'The admin key can only raise or remove the cap, never tighten it',
      when: 'Bonding curve only', runs: 'Transfer hook program, one admin instruction',
      steps: [
        'The cap schedule is frozen at launch. Nobody can tighten it or add a new one.',
        'One admin switch exists, and it only works upwards: raise the cap for a token, or remove it.',
        'Every use is recorded on chain and listed in the switch history on the token page.',
      ],
      settings: [
        { k: 'Can raise the cap', v: 'yes' },
        { k: 'Can remove the cap', v: 'yes' },
        { k: 'Can tighten or add', v: 'no' },
        { k: 'Every use', v: 'on chain + announced' },
      ],
      limits: 'It exists so a mistake in a schedule can be undone in the buyer’s favour. It cannot be used against holders.',
      diagram: <LiftDiagram />,
    },
    {
      id: 'burn', name: 'Buyback & burn', icon: <IconFlame size={20} />, tone: 'green', launch: 'always',
      short: `${FLYWHEEL_SPLIT.buybackPct}% of trading fees buy the token back and burn it`,
      when: 'After graduation, about every 5 min', runs: 'Flywheel keeper (off chain bot, public logs)',
      steps: [
        'Trading fees build up while the token is on the curve.',
        `After graduation the keeper claims them on a timer and splits them: ${FLYWHEEL_SPLIT.devPct}% to the dev wallet, ${FLYWHEEL_SPLIT.buybackPct}% to buy the token on the pool.`,
        'Every token it buys is burned, so total supply goes down. Each claim, buy and burn is logged on the Transparency page.',
      ],
      settings: [
        { k: 'Buyback share', v: `${FLYWHEEL_SPLIT.buybackPct}%` },
        { k: 'Dev share', v: `${FLYWHEEL_SPLIT.devPct}%` },
        { k: 'Bought tokens', v: 'burned' },
        { k: 'Runs', v: 'about every 5 min' },
      ],
      limits: 'It is a bot, not part of the token: if it stops, fees wait until it runs again. Burning supply does not set or support any price.',
      diagram: <FlywheelDiagram {...FLYWHEEL_SPLIT} />,
    },
  ];
}

/** The optional hooks a launch can turn on (program v2 rules). Values shown are the studio defaults unless `r` is a
 *  token's own rules. */
export function optionalHookList(r: { maxBuyBps: number; maxPerSlotBps: number; windowSlots: string; potEvery: number; potMinBps: number; cooldownSlots: number } = RULES_DEFAULT): HookInfo[] {
  const win = windowText(r.windowSlots);
  const Win = win[0].toUpperCase() + win.slice(1);
  return [
    {
      id: 'maxbuy', name: 'Max single buy', icon: <IconCeiling size={20} />, tone: 'accent', launch: 'optional',
      short: `No single buy over ${pctOf(r.maxBuyBps)} of supply`,
      when: `Curve · ${win}`, runs: 'Transfer hook program, checked on every curve buy',
      steps: [
        'Someone buys on the bonding curve.',
        'The hook checks the size of that one buy, not how much the buyer already holds.',
        `If it is over ${pctOf(r.maxBuyBps)} of supply, the buy fails and nothing moves. Smaller buys land as normal.`,
      ],
      settings: [
        { k: 'Max per buy', v: pctOf(r.maxBuyBps) },
        { k: 'Applies', v: Win },
        { k: 'Selling', v: 'never limited' },
      ],
      limits: 'Someone can still split a big buy into several smaller ones, or use several wallets. Together with the cap and the per-slot limit that gets slower and more expensive. Selling is never limited.',
      diagram: <MaxBuyDiagram maxText={pctOf(r.maxBuyBps)} />,
    },
    {
      id: 'slot', name: 'Per-slot buy limit', icon: <IconBlocks size={20} />, tone: 'sim', launch: 'optional',
      short: `At most ${pctOf(r.maxPerSlotBps)} of supply bought in any one slot (~0.4 s)`,
      when: `Curve · ${win}`, runs: 'Transfer hook program, a running total per slot',
      steps: [
        'Every curve buy in the same slot (about 0.4 seconds) is added up, across all wallets.',
        `If a buy would take that slot over ${pctOf(r.maxPerSlotBps)} of supply, it fails and nothing moves.`,
        'The next slot starts again from zero. Bundles that buy with many wallets at once hit the limit together.',
      ],
      settings: [
        { k: 'Limit per slot', v: pctOf(r.maxPerSlotBps) },
        { k: 'Applies', v: Win },
        { k: 'Counts', v: 'all buyers together' },
      ],
      limits: 'It limits everyone together, so in a busy opening an honest buy can fail too; trying again a moment later works. It does not stop buying spread over many slots.',
      diagram: <SlotLimitDiagram limitText={pctOf(r.maxPerSlotBps)} />,
    },
    {
      id: 'pot', name: 'Buy pot', icon: <IconTrophy size={20} />, tone: 'amber', launch: 'optional',
      short: `Every ${ordinal(r.potEvery)} buy is a pot winner`,
      when: 'Bonding curve', runs: 'Transfer hook program counts buys and records winners on chain',
      steps: [
        `The hook counts curve buys in order: the first buy in each slot that is at least ${pctOf(r.potMinBps)} of supply.`,
        `Every ${ordinal(r.potEvery)} counted buy is recorded on chain as a winner: wallet, buy number and slot.`,
        'Winners are listed live on the token page.',
      ],
      settings: [
        { k: 'Winner every', v: `${r.potEvery} buys` },
        { k: 'Minimum buy', v: pctOf(r.potMinBps) },
        { k: 'Counted per slot', v: '1 buy' },
        { k: 'Payouts', v: 'not live yet' },
      ],
      limits: 'It is not random: anyone watching the count can try to time the winning buy. The hook only records winners; it cannot hold or send SOL, and payouts are not switched on yet.',
      diagram: <PotDiagram every={r.potEvery} minText={pctOf(r.potMinBps)} />,
    },
    {
      id: 'cooldown', name: 'Slow mode', icon: <IconClock size={20} />, tone: 'green', launch: 'optional',
      short: `One curve buy every ${r.cooldownSlots} slots (${slotSecs(r.cooldownSlots)})`,
      when: `Curve \u00b7 ${win}`, runs: 'Transfer hook program, one shared timer for the whole token',
      steps: [
        'After any curve buy lands, a shared timer starts for the whole token.',
        `The next buy, from anyone, must wait ${r.cooldownSlots} slots (${slotSecs(r.cooldownSlots)}). A buy inside the gap fails and nothing moves.`,
        'A crew splitting across many wallets waits out the gap for every single buy, so taking a large share takes a long time.',
      ],
      settings: [
        { k: 'Gap between buys', v: `${r.cooldownSlots} slots \u00b7 ${slotSecs(r.cooldownSlots)}` },
        { k: 'Applies', v: Win },
        { k: 'Counts', v: 'all buyers together' },
        { k: 'Selling', v: 'never limited' },
      ],
      limits: 'It slows everyone down equally, honest buyers included: in a busy opening a buy can fail just for being second; trying again after the gap works. It throttles how fast the curve can fill during the window.',
      diagram: <CooldownDiagram gapText={`${r.cooldownSlots}-slot`} />,
    },
  ];
}

/** ~seconds for a slot count at ~0.4 s/slot (estimate, same base as approxDuration). */
const slotSecs = (slots: number) => approxDuration(String(slots));

/** Creator lock as a hook card (display only): DBC locked vesting set at launch, not a transfer-hook rule. */
export function creatorLockInfo(pct: number, slots: number): HookInfo {
  const dur = approxDuration(String(slots));
  return {
    id: 'lock', name: 'Creator lock', icon: <IconLock size={20} />, tone: 'accent', launch: 'optional',
    short: `${pct}% of supply locked for the creator until ${dur} after graduation`,
    when: `From launch until ${dur} after graduation`, runs: 'Meteora DBC locked vesting, set at launch',
    steps: [
      `${pct}% of the supply is set aside for the creator at launch, locked on chain.`,
      'It stays locked through the whole bonding curve and through graduation.',
      `It unlocks in one piece ${dur} after the token migrates to the pool. Until then the creator cannot sell any of it.`,
    ],
    settings: [
      { k: 'Creator share', v: `${pct}% of supply` },
      { k: 'Unlocks', v: `${dur} after graduation` },
      { k: 'Unlock shape', v: 'all at once' },
      { k: 'Changeable later', v: 'no' },
    ],
    limits: 'It locks only this allocation: it does not stop the creator buying more on the curve like anyone else. A launch without it gives the creator no allocation at all.',
    diagram: <LockDiagram pctText={`${pct}%`} durText={approxDuration(String(slots))} />,
  };
}

/** Every hook: the four each token runs, then the optional ones. */
export const allHooks = (meta: Meta): HookInfo[] => [...hookList(meta), ...optionalHookList(), creatorLockInfo(CREATOR_LOCK_DEFAULT.pct, CREATOR_LOCK_DEFAULT.slots)];

export function ordinal(n: number): string {
  const t = n % 100, o = n % 10;
  return `${n}${t >= 11 && t <= 13 ? 'th' : o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th'}`;
}

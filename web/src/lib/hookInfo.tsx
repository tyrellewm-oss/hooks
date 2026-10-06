// The hooks every Trenches token runs, in one place for the hooks page and the launch tool. Values are the studio
// defaults (sdk/launch.ts DEFAULT_LAUNCH_FEES, the flywheel keeper spec's 15/85 split); each token page shows its own.
import type { ReactNode } from 'react';
import type { Meta } from './types';
import { approxDuration, pctOf } from './shared';
import { CapDiagram, FlywheelDiagram, LiftDiagram, SniperFeeDiagram } from '../components/HookArt';
import { IconFee, IconFlame, IconShield, IconSwitch } from '../components/Icons';

export const SNIPER_DEFAULT = { startBps: 5000, endBps: 100, periods: 10, durationSlots: 150 };
export const FLYWHEEL_SPLIT = { devPct: 15, buybackPct: 85 };

export type HookId = 'cap' | 'fee' | 'switch' | 'burn';
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
  launch: 'tunable' | 'always';
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

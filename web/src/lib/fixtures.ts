// Fixture mode (`npm run dev:fixtures`): a simulated backend for UI work without a validator or devnet.
// Every screen shows a "simulated" banner in this mode (AC-28: the real page shows only live chain numbers).
// The cap rule itself is the real one: buys over the cap fail with WalletCapExceeded via sdk/capMath.ts.
import { effectiveCap, nextChange } from '../../../sdk/capMath';
import { BALANCED } from '../../../sdk/schedules';
import type { Meta, TokenView, TradeResult, Side, CreateRequest, CreateReply, SwitchEvent } from './types';
import type { Api } from './api';
import { ApiError } from './errors';

const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);
const SUPPLY = 1_000_000_000n * UNIT;
const T0 = Date.now();
const SLOT0 = 412_000_000;
const slotAt = (ms: number) => SLOT0 + Math.trunc((ms - T0) / 400);
const PROGRAM_ID = 'FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz'; // the devnet hook program (README)

interface Sim {
  mint: string; pool: string; config: string; name: string; symbol: string;
  launchedMsAgo: number; graduated: boolean; reserveSol: number;
  balances: Record<string, bigint>; switchHistory: SwitchEvent[]; raisedFloorBps: number;
}
const tokens = (n: number) => BigInt(Math.round(n * 1e6)) * (UNIT / 1_000_000n);
const fakeKey = (tag: string) => (tag + '1'.repeat(44)).slice(0, 44);

const SIMS: Sim[] = [
  { mint: fakeKey('FixtureEarLyFeeMint'), pool: fakeKey('FixturePooA'), config: fakeKey('FixtureCfgA'), name: 'Fixture Early', symbol: 'TFEE',
    launchedMsAgo: 25_000, graduated: false, reserveSol: 0.031, balances: { A: 0n, B: tokens(4_000_000) }, switchHistory: [], raisedFloorBps: 0 },
  { mint: fakeKey('FixtureCappedMint'), pool: fakeKey('FixturePooB'), config: fakeKey('FixtureCfgB'), name: 'Fixture Capped', symbol: 'TCAP',
    launchedMsAgo: 245_000, graduated: false, reserveSol: 0.082, balances: { A: tokens(12_400_000), B: tokens(3_000_000) }, switchHistory: [], raisedFloorBps: 0 },
  { mint: fakeKey('FixtureOpenMint'), pool: fakeKey('FixturePooC'), config: fakeKey('FixtureCfgC'), name: 'Fixture Open', symbol: 'TOPEN',
    launchedMsAgo: 40 * 60_000, graduated: false, reserveSol: 0.164, balances: { A: tokens(52_000_000), B: tokens(8_500_000) }, raisedFloorBps: 500,
    switchHistory: [{ scope: 'mint', oldMinCapBps: 0, newMinCapBps: 500, lifted: false, slot: String(slotAt(T0 - 32 * 60_000)), signer: fakeKey('FixtureLiftAuthority'), link: '' }] },
  { mint: fakeKey('FixtureGraduatedMint'), pool: fakeKey('FixturePooD'), config: fakeKey('FixtureCfgD'), name: 'Fixture Graduated', symbol: 'TGRAD',
    launchedMsAgo: 3 * 3600_000, graduated: true, reserveSol: 0.2, balances: { A: tokens(9_000_000), B: tokens(41_000_000) }, switchHistory: [], raisedFloorBps: 0 },
];

const FEE = { mode: 'linear fee scheduler', cliffPct: 50, endPct: 1, periods: 10, periodSlots: 15, totalSlots: 150, collectFeeMode: 0, migrationFeeOption: 0, creatorTradingFeePercentage: 0, migrationQuoteThresholdSol: 0.2 };
const FEE_CONFIG = { startBps: 5000, endBps: 100, durationSlots: 150, migrationFeeOption: 0, creatorTradingFeePercentage: 0, percentageSupplyOnMigration: 20 };
const steps = BALANCED.steps.map((s) => ({ slotOffset: s.slotOffset.toString(), maxBps: s.maxBps }));
const latency = () => new Promise((r) => setTimeout(r, 150 + Math.random() * 250));

function launchSlot(s: Sim) { return slotAt(T0 - s.launchedMsAgo); }
function capCfg(s: Sim) { return { launchSlot: BigInt(launchSlot(s)), supply: SUPPLY, steps: BALANCED.steps, uncappedAfter: BALANCED.uncappedAfter }; }

function view(s: Sim): TokenView {
  const slot = slotAt(Date.now());
  const cfg = capCfg(s);
  const cap = effectiveCap(cfg, { lifted: false, raisedFloorBps: s.raisedFloorBps }, false, BigInt(slot));
  const nc = cap === null ? null : nextChange(cfg, BigInt(slot));
  return {
    status: {
      cluster: 'DEVNET', slot, mint: s.mint, supply: SUPPLY.toString(), decimals: DECIMALS, mintAuthority: null, freezeAuthority: null,
      transferHookProgram: s.graduated ? null : PROGRAM_ID, transferHookAuthority: s.graduated ? null : 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',
      launchSlot: String(launchSlot(s)), steps, uncappedAfter: BALANCED.uncappedAfter.toString(), testSlotsBuild: false, exemptOwners: [],
      launcher: fakeKey('FixtureLaunchKey'), liftAuthority: fakeKey('FixtureLiftAuthority'), launchAuthority: fakeKey('FixtureLaunchKey'),
      globalLifted: false, mintLifted: false, raisedFloorBps: s.raisedFloorBps, currentCap: s.graduated || cap === null ? null : cap.toString(),
      nextChange: s.graduated || !nc ? null : { slot: nc.slot.toString(), bps: nc.bps },
      mintHook: { ok: true, phase: s.graduated ? 'post' : 'pre', problems: [] },
    },
    launch: { name: s.name, symbol: s.symbol, mint: s.mint, pool: s.pool, config: s.config, time: new Date(T0 - s.launchedMsAgo).toISOString(), steps, uncappedAfter: BALANCED.uncappedAfter.toString(), migrationQuoteThresholdSol: 0.2, fee: FEE_CONFIG },
    fee: FEE,
    feeConfig: FEE_CONFIG,
    pool: { quoteReserveSol: Math.round(s.reserveSol * 1e4) / 1e4, isMigrated: s.graduated, curveComplete: s.graduated },
    balances: Object.fromEntries(Object.entries(s.balances).map(([k, v]) => [k, v.toString()])),
    switchHistory: s.switchHistory,
    explorer: { mint: '', pool: '', program: '' },
  };
}

const find = (mint: string) => {
  const s = SIMS.find((x) => x.mint === mint);
  if (!s) throw new ApiError('unknown token', 404);
  return s;
};
const fakeSig = () => Array.from({ length: 88 }, () => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Math.trunc(Math.random() * 58)]).join('');

export const fixtureApi: Api = {
  async meta(): Promise<Meta> {
    await latency();
    return {
      defaultSchedule: { id: BALANCED.id, name: BALANCED.name, label: BALANCED.label, steps, uncappedAfter: BALANCED.uncappedAfter.toString() },
      cluster: 'DEVNET', rpc: 'fixture mode (simulated, no RPC)', programId: PROGRAM_ID, commit: 'fixture', liftAuthority: fakeKey('FixtureLiftAuthority'),
      wallets: { A: fakeKey('FixtureTestWaLLetA'), B: fakeKey('FixtureTestWaLLetB') },
      launches: SIMS.map((s) => ({ mint: s.mint, pool: s.pool, time: new Date(T0 - s.launchedMsAgo).toISOString() })),
    };
  },
  async token(mint) { await latency(); return view(find(mint)); },
  async trade(mint, wallet, side: Side, amount): Promise<TradeResult> {
    await latency(); await latency();
    const s = find(mint);
    if (s.graduated) throw new Error('refusing: DBC pool has graduated (simulated)');
    const amt = BigInt(Math.round(Number(amount) * 1e6)) * (UNIT / 1_000_000n);
    if (amt <= 0n) throw new Error('amount must be > 0');
    const bal = s.balances[wallet] ?? 0n;
    const sig = fakeSig();
    if (side === 'sell') {
      if (amt > bal) return { ok: false, sig, link: '', err: 'insufficient funds (simulated)', hookError: null, hookCode: null };
      s.balances[wallet] = bal - amt; s.reserveSol = Math.max(0, s.reserveSol - Number(amt) * 2.5e-16);
      return { ok: true, sig, link: '' };
    }
    const slot = BigInt(slotAt(Date.now()));
    const cap = effectiveCap(capCfg(s), { lifted: false, raisedFloorBps: s.raisedFloorBps }, false, slot);
    if (cap !== null && bal + amt > cap) {
      return { ok: false, sig, link: '', err: '{"InstructionError":[2,{"Custom":6000}]}', hookError: 'WalletCapExceeded', hookCode: 6000,
        capHit: { tokenAccount: fakeKey('FixtureTokenAccount'), owner: wallet, balance: (bal + amt).toString(), cap: cap.toString(), slot: slot.toString() } };
    }
    s.balances[wallet] = bal + amt; s.reserveSol = Math.min(0.1999, s.reserveSol + Number(amt) * 2.5e-16);
    return { ok: true, sig, link: '' };
  },
  async create(req: CreateRequest): Promise<CreateReply> {
    await latency(); await latency();
    return { mint: fakeKey('FixtureNew' + req.symbol), pool: fakeKey('FixtureNewPooL'), registered: false, note: 'not registered: add to keeper/registry.json' };
  },
};

// Fixture mode (`npm run dev:fixtures`): a simulated backend for UI work without a validator or devnet.
// Every screen shows a "simulated" banner in this mode (AC-28: the real page shows only live chain numbers).
// The cap rule itself is the real one: buys over the cap fail with WalletCapExceeded via sdk/capMath.ts.
import { effectiveCap, nextChange } from '../../../sdk/capMath';
import { BALANCED } from '../../../sdk/schedules';
import type { Meta, TokenView, TradeResult, Side, CreateRequest, CreateReply, SwitchEvent, BuiltSwap, FlywheelReply, PublicKeeper, TradesReply, IndexedTrade, Candle, MetadataInput, TokenMetadata } from './types';
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

function view(s: Sim, owner?: string | null): TokenView {
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
    metadata: META.get(s.mint) ?? null,
    launch: { name: s.name, symbol: s.symbol, mint: s.mint, pool: s.pool, config: s.config, time: new Date(T0 - s.launchedMsAgo).toISOString(), steps, uncappedAfter: BALANCED.uncappedAfter.toString(), migrationQuoteThresholdSol: 0.2, fee: FEE_CONFIG },
    fee: FEE,
    feeConfig: FEE_CONFIG,
    pool: { quoteReserveSol: Math.round(s.reserveSol * 1e4) / 1e4, isMigrated: s.graduated, curveComplete: s.graduated },
    balances: Object.fromEntries(Object.entries(s.balances).map(([k, v]) => [k, v.toString()])),
    wallet: owner ? { owner, tokens: (s.balances[owner] ?? 0n).toString(), sol: 1.5 } : null,
    switchHistory: s.switchHistory,
    explorer: { mint: '', pool: '', program: '' },
  };
}

const find = (mint: string) => {
  const s = SIMS.find((x) => x.mint === mint);
  if (!s) throw new ApiError('unknown token', 404);
  return s;
};
const META = new Map<string, TokenMetadata>([[SIMS[1].mint, { description: 'Fixture token for UI work. Studio-entered details show here.', website: 'https://example.org', x: 'https://x.com/example', telegram: null, image: null, updatedAt: new Date(T0).toISOString() }]]);
const PENDING = new Map<string, { mint: string; owner: string; side: Side; amount: string }>();

/** The simulated swap: same cap rule as the program (sdk/capMath.ts). `dry` = simulate without changing balances. */
function exec(s: Sim, wallet: string, side: Side, amount: string, dry: boolean): TradeResult {
  const amt = BigInt(Math.round(Number(amount) * 1e6)) * (UNIT / 1_000_000n);
  if (amt <= 0n) throw new ApiError('amount must be > 0', 400);
  const bal = s.balances[wallet] ?? 0n;
  const sig = dry ? '' : fakeSig();
  if (side === 'sell') {
    if (amt > bal) return { ok: false, sig, link: '', err: 'insufficient funds (simulated)', hookError: null, hookCode: null };
    if (!dry) { s.balances[wallet] = bal - amt; s.reserveSol = Math.max(0, s.reserveSol - Number(amt) * 2.5e-16); }
    return { ok: true, sig, link: '' };
  }
  const slot = BigInt(slotAt(Date.now()));
  const cap = s.graduated ? null : effectiveCap(capCfg(s), { lifted: false, raisedFloorBps: s.raisedFloorBps }, false, slot);   // no cap after graduation
  if (cap !== null && bal + amt > cap) {
    return { ok: false, sig, link: '', err: '{"InstructionError":[2,{"Custom":6000}]}', hookError: 'WalletCapExceeded', hookCode: 6000,
      capHit: { tokenAccount: fakeKey('FixtureTokenAccount'), owner: wallet, balance: (bal + amt).toString(), cap: cap.toString(), slot: slot.toString() } };
  }
  if (!dry) { s.balances[wallet] = bal + amt; s.reserveSol = Math.min(0.1999, s.reserveSol + Number(amt) * 2.5e-16); }
  return { ok: true, sig, link: '' };
}

/** Simulated trade history (fixture mode only): a random walk from launch, plus one cap-blocked buy. */
const TRADES = new Map<string, IndexedTrade[]>();
function fixtureTrades(s: Sim): IndexedTrade[] {
  let t = TRADES.get(s.mint);
  if (t) return t;
  const start = Math.trunc((T0 - s.launchedMsAgo) / 1000), end = Math.trunc(T0 / 1000);
  const n = Math.min(80, Math.max(6, Math.trunc((end - start) / 45)));
  let seed = s.mint.length * 7919; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let price = 2.8e-10; t = [];
  for (let i = 0; i < n; i++) {
    const time = start + Math.trunc(((i + 1) / (n + 1)) * (end - start));
    const buy = rnd() < 0.68; price *= buy ? 1 + rnd() * 0.06 : 1 - rnd() * 0.04;
    const tokens = BigInt(Math.trunc(200_000 + rnd() * 6_000_000)) * 1_000_000n;
    t.push({ sig: fakeSig(), slot: SLOT0 + i, time, pool: s.pool, venue: s.graduated && i > n * 0.7 ? 'pool' : 'curve', side: buy ? 'buy' : 'sell', trader: fakeKey(`FixtureTrader${i % 7}`),
      baseRaw: tokens.toString(), quoteLamports: String(Math.trunc((Number(tokens) / 1e6) * price * 1e9)), price });
    if (i === 2) t.push({ sig: fakeSig(), slot: SLOT0 + i, time: time + 1, pool: s.pool, venue: 'curve', side: 'blocked', trader: fakeKey('FixtureTrader1'), baseRaw: '0', quoteLamports: '0', price: null, error: 'WalletCapExceeded' });
  }
  t.reverse(); TRADES.set(s.mint, t);
  return t;
}
function candlesOf(trades: IndexedTrade[], iv: number): Candle[] {
  const out: Candle[] = [];
  for (const x of [...trades].reverse()) {
    if (x.price === null || x.time === null) continue;
    const t = Math.trunc(x.time / iv) * iv; const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, x.price); last.l = Math.min(last.l, x.price); last.c = x.price; last.n++; }
    else out.push({ t, o: x.price, h: x.price, l: x.price, c: x.price, n: 1 });
  }
  return out;
}

/** Simulated keeper log in the shape of app/flywheel_public.ts (fixture mode only). */
function fixtureKeeper(s: Sim, state: string, nBurns: number): PublicKeeper {
  const burns = Array.from({ length: nBurns }, (_, i) => ({ at: new Date(T0 - (i + 1) * 5 * 60_000).toISOString(), tokens: (190_000 - i * 1_300).toFixed(6), sol: '0.001000000', sig: fakeSig(), link: '' }));
  const burned = burns.reduce((a, b) => a + Number(b.tokens), 0);
  const runs = Array.from({ length: Math.max(2, nBurns) }, (_, i) => ({
    runId: `fixture-run-${i}`, startedAt: new Date(T0 - (i + 1) * 5 * 60_000).toISOString(),
    status: nBurns === 0 ? 'logged' : i === 3 ? 'failed_price' : 'logged', reason: nBurns === 0 ? 'waiting for graduation: no buyback on the curve' : i === 3 ? 'price check: spot vs 30-min average > 10%' : '',
    claimedLamports: nBurns ? '1400000' : '0',
    links: nBurns && i !== 3 ? [{ what: 'claim (damm_v2)', sig: fakeSig(), link: '' }, { what: 'dev payout (15%)', sig: fakeSig(), link: '' }, { what: 'buyback swap', sig: fakeSig(), link: '' }, { what: 'burn', sig: fakeSig(), link: '' }] : [],
  }));
  return { name: `devnet-${s.symbol.toLowerCase()}`, mint: s.mint, state, paused: false, pauseReason: '', claimedSol: (nBurns * 0.0014).toFixed(9), devSol: (nBurns * 0.00021).toFixed(9), spentSol: (nBurns * 0.001).toFixed(9), reserveSol: '0.000190000',
    burnedTokens: burned.toFixed(6), supplyTokens: (1_000_000_000 - burned).toFixed(6), pctOfSupply: ((burned / 1e9) * 100).toFixed(4), burns, runs, pools: { dbc: s.pool, route: s.graduated ? fakeKey('FixtureDammPooL') : null } };
}

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
  async token(mint, owner) { await latency(); return view(find(mint), owner); },
  async trade(mint, wallet, side: Side, amount): Promise<TradeResult> {
    await latency(); await latency();
    return exec(find(mint), wallet, side, amount, false);
  },
  async walletBuild(mint, owner, side: Side, amount, opts): Promise<BuiltSwap> {
    await latency();
    const s = find(mint);
    const venue = opts?.venue ?? 'curve';
    if (venue === 'curve' && s.graduated) throw new ApiError("this token can't be traded on the curve: it has graduated (simulated)", 409);
    if (venue === 'pool' && !s.graduated) throw new ApiError("this token hasn't graduated yet, so it has no pool (simulated)", 409);
    const slippageBps = opts?.slippageBps ?? 100;
    const r = exec(s, owner, side, amount, true);   // simulate only
    const tx = Array.from(fakeSig(), (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');   // stand-in hex
    PENDING.set(tx, { mint, owner, side, amount });
    const lamports = Math.round(Number(amount) * 5.3);   // ~5.3 lamports per token, like the devnet TDT pool
    const quote = venue === 'pool' ? { expectedLamports: String(lamports), limitLamports: String(Math.round(side === 'buy' ? lamports * (1 + slippageBps / 1e4) : lamports * (1 - slippageBps / 1e4))), slippageBps, priceImpactPct: '0.27' } : undefined;
    return { tx, encoding: 'hex', owner, side, amount, lastValidBlockHeight: 0, expiresInMs: 90_000, venue, quote,
      simulation: { ok: r.ok, err: r.err ?? null, hookError: r.hookError ?? null, hookCode: r.hookCode ?? null, capHit: r.capHit ?? null, unitsConsumed: 120_000 } };
  },
  async walletSubmit(tx): Promise<TradeResult> {
    await latency(); await latency();
    const hex = Array.from(atob(tx), (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');   // the page sends base64 back
    const p = PENDING.get(hex);
    if (!p) throw new ApiError('refusing: this transaction was not built by this page, was changed after it was built, or has expired. Build it again.', 400);
    PENDING.delete(hex);
    return exec(find(p.mint), p.owner, p.side, p.amount, false);
  },
  async saveMetadata(mint, m: MetadataInput): Promise<TokenMetadata> {
    await latency(); find(mint);
    for (const [k, host] of [['website', null], ['x', ['x.com', 'twitter.com']], ['telegram', ['t.me']]] as const) {
      const v = (m as any)[k]; if (!v) continue;
      let u: URL; try { u = new URL(v); } catch { throw new ApiError(`${k}: not a valid link`, 400); }
      if (u.protocol !== 'https:') throw new ApiError(`${k}: must start with https://`, 400);
      if (host && !(host as readonly string[]).includes(u.hostname.replace(/^www\./, ''))) throw new ApiError(`${k}: must be a ${host.join(' or ')} link`, 400);
    }
    if (m.description.length > 280) throw new ApiError('description: at most 280 characters', 400);
    const prev = META.get(mint);
    const image = m.image === null ? null : m.image ? `data:image/png;base64,${m.image.data}` : prev?.image ?? null;
    const out: TokenMetadata = { description: m.description.trim(), website: m.website || null, x: m.x || null, telegram: m.telegram || null, image, updatedAt: new Date().toISOString() };
    META.set(mint, out); return out;
  },
  async trades(mint, interval): Promise<TradesReply> {
    await latency();
    const s = find(mint);
    const trades = fixtureTrades(s);
    return { indexed: true, updatedAt: new Date().toISOString(), decimals: DECIMALS, interval, trades: trades.slice(0, 100), candles: candlesOf(trades, interval) };
  },
  async flywheel(): Promise<FlywheelReply> {
    await latency();
    return { cluster: 'DEVNET', skipped: [], keepers: [fixtureKeeper(SIMS[3], 'active', 13), fixtureKeeper(SIMS[2], 'waiting_for_graduation', 0)] };
  },
  async create(req: CreateRequest): Promise<CreateReply> {
    await latency(); await latency();
    return { mint: fakeKey('FixtureNew' + req.symbol), pool: fakeKey('FixtureNewPooL'), registered: false, note: 'not registered: add to keeper/registry.json' };
  },
};

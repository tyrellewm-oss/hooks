// Ticket #5: price source for the flywheel buyback. One test per acceptance criterion (1-17) and per refusal, plus the
// helpers they rest on. Offline: the RPC, the pool and the independent price API are stubs (one test uses a local
// HTTP server on 127.0.0.1). No keys are loaded from disk and nothing is sent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Keypair, PublicKey, Connection, TransactionInstruction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkPriceConfig, computeTwap, checkSpotVsTwap, checkIndepVsTwap, fetchIndependent, anchoredMinOut, readSamples, samplesPath, PriceSampler, PriceRefusal,
  PriceConfigRefusal, WSOL_MINT, decRational, PRICE_SOURCE_KEYS, repairTornTail, INDEP_API_KEY_ENV, indepApiKey, warmupCeilingS, WARMUP_GRACE_S, type PriceSample, type PriceSourceConfig, type HttpGet } from '../sdk/flywheel/price_source.js';
import { assertRegistryPoolPair, RegistryPairRefusal, WSOL_MINT_ADDRESS } from '../sdk/registry.js';
import { Keeper, FailClosed, preflightOffline, startKeeper, initState, type KeySet } from '../sdk/flywheel/keeper.js';
import type { KeeperConfig } from '../sdk/flywheel/config.js';
import { redactPaths, redactDeep, redactedJson, redactSecrets, SECRET_ENV_VARS } from '../sdk/redact.js';
import { serverError } from '../app/errors.js';

const base = JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')) as KeeperConfig;
const PS = base.price_source;
const MINT = base.main_mint, POOL = base.route_pool!;
const OTHER_POOL = base.main_dbc_pool;                      // a pre-graduation (DBC) pool address
const X64 = 1n << 64n, Q128 = 1n << 128n;
const T = 1_790_000_000, SLOT = 400_000_000;                // chain time and slot of "now"
const slotAt = (t: number) => SLOT - (T - t) * 2;
const GRAD = { slot: slotAt(T - 3600), t: T - 3600 };
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'price-src-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const ps = (o: Partial<PriceSourceConfig> = {}): PriceSourceConfig => ({ ...PS, ...o });
const isqrt = (n: bigint) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };

/** Samples every `step` s for t in [from, to], constant (or per-t) sqrt price. */
function series(from: number, to: number, o: { step?: number; sqrt?: bigint | ((t: number) => bigint); pool?: string; session?: string; slot?: (t: number) => number } = {}): PriceSample[] {
  const out: PriceSample[] = [];
  for (let t = from; t <= to; t += o.step ?? 15) {
    const sq = typeof o.sqrt === 'function' ? o.sqrt(t) : o.sqrt ?? X64;
    out.push({ v: 1, pool: o.pool ?? POOL, slot: (o.slot ?? slotAt)(t), t, sqrt_price: sq.toString(), session: o.session ?? 's1' });
  }
  return out;
}
const full = (o: Parameters<typeof series>[2] = {}) => series(T - 1800, T, o);   // a full 30-min window, 121 samples
const twap = (samples: PriceSample[], o: { p?: Partial<PriceSourceConfig>; nowT?: number; grad?: { slot: number; t: number } } = {}) =>
  computeTwap({ ps: ps(o.p), pool: POOL, nowT: o.nowT ?? T, grad: o.grad ?? GRAD, samples });
const refuses = (code: string, pause?: boolean) => (e: any) => e instanceof PriceRefusal && e.code === code && (pause === undefined || e.pause === pause);

// ---------------------------------------------------------------- independent price stubs
const jup = (o: { usdMint?: unknown; usdWsol?: unknown; block?: number; omit?: string; status?: number; decimals?: number } = {}): HttpGet & { calls: string[]; inits: any[] } => {
  const calls: string[] = []; const inits: any[] = [];
  const f = (async (url: string, init?: any) => {
    calls.push(url); inits.push(init);
    const body: any = {
      [MINT]: { usdPrice: o.usdMint ?? 0.2, blockId: o.block ?? SLOT, decimals: o.decimals ?? 6 },
      [WSOL_MINT]: { usdPrice: o.usdWsol ?? 200, blockId: o.block ?? SLOT, decimals: 9 },
    };
    if (o.omit) delete body[o.omit];
    return { ok: (o.status ?? 200) === 200, status: o.status ?? 200, json: async () => body };
  }) as HttpGet & { calls: string[]; inits: any[] };
  f.calls = calls; f.inits = inits; return f;
};

// ---------------------------------------------------------------- keeper harness (stubbed chain, pool and API)
type H = { samples?: PriceSample[]; p?: Partial<PriceSourceConfig>; nowT?: number | null; spotSqrt?: bigint; quoteOut?: (inL: bigint) => bigint; pool?: any; http?: HttpGet;
  registry?: string[]; registryMidRun?: string[]; realHttp?: boolean; migrated?: number; grad?: { slot: number; t: number } | null; cfg?: Partial<KeeperConfig>; fill?: (inL: bigint) => bigint };
/** A stubbed keeper on its own state dir. `now` is the chain time (block time of the current slot; the slot follows it);
 *  `restart()` replaces the keeper with a new instance that loads the same state file; `logs` are the Keeper.log lines. */
function harness(o: H = {}) {
  const dir = tmp();
  const cfg: KeeperConfig = { ...base, pinned_pubkeys: undefined, state_dir: join(dir, 'state'), public_log: join(dir, 'pub.json'), sources: [], max_swap_lamports_per_run: '1000000',
    price_source: ps(o.p), ...o.cfg };
  const ks: KeySet = { claim: Keypair.generate(), treasury: Keypair.generate(), gas: Keypair.generate() };
  const logs: string[] = [];
  const c = { slotCalls: 0, builds: [] as any[], sends: 0, simulated: [] as string[], priceChecks: 0 };
  const http = o.http ?? jup();
  let now = o.nowT === undefined ? T : o.nowT;
  const reg = join(dir, 'registry.json');
  const make = () => {
    const k = new Keeper(cfg, [], new Proxy({}, { get: () => { throw new Error('network'); } }) as unknown as Connection, ks, [], (t: string) => { logs.push(t); });
    k.registryPath = reg;
    (k as any).conn = {
      getBalance: async () => 1_000_000_000,
      getSlot: async () => { c.slotCalls++; return now === null ? SLOT : slotAt(now); },
      getBlockTime: async () => now,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }),
      sendRawTransaction: async () => {   // a fake pool: simulates the swap against min_out; nothing ever lands
        c.sends++;
        const st = JSON.parse(readFileSync(join(cfg.state_dir, 'state.json'), 'utf8')).current;
        const inL = BigInt(st.stages.swap.intent.in_lamports), mo = BigInt(st.stages.swap.intent.min_out_raw);
        const out = (o.fill ?? (x => x))(inL);
        if (out < mo) { c.simulated.push('fail_min_out'); throw new Error(`Transaction simulation failed: out ${out} < minimum_amount_out ${mo}`); }
        c.simulated.push('filled'); throw new Error('test stop: simulation only');
      },
    };
    (k as any).pinnedChecks = async () => {};
    (k as any).tokenAmt = async (ata: PublicKey) => (ata.equals(k.tWsol) ? BigInt(state().pending_lamports) : 0n);   // reconcile: treasury wSOL = pending
    (k as any).supply = async () => 1000n;
    (k as any).dbc = { state: { getPool: async () => ({ isMigrated: o.migrated ?? 1, partnerQuoteFee: { toString: () => '0' } }) } };
    const qo = o.quoteOut ?? (x => x);
    (k as any).quote = async (inL: bigint) => (o.registryMidRun && writeFileSync(reg, JSON.stringify({ devnet: o.registryMidRun, local: [] })), { out: qo(inL), impactBps: 10, spotOut: qo(inL), spotSqrtX64: o.spotSqrt ?? X64,
      pool: o.pool ?? { tokenAMint: new PublicKey(MINT), tokenBMint: NATIVE_MINT, tokenAVault: k.tMain, tokenBVault: k.tWsol } });
    (k as any).cp = { swap: async (a: any) => { c.builds.push(a); return { instructions: [new TransactionInstruction({ programId: CP_AMM_PROGRAM_ID, data: Buffer.alloc(1),
      keys: [{ pubkey: ks.treasury.publicKey, isSigner: true, isWritable: false }, ...[k.tWsol, k.tMain].map(pubkey => ({ pubkey, isSigner: false, isWritable: true }))] })] }; } };
    if (!o.realHttp) k.http = http;   // realHttp: the keeper's own fetch
    const pc = k.priceCheck.bind(k); k.priceCheck = async (...a: Parameters<Keeper['priceCheck']>) => { c.priceChecks++; return pc(...a); };
    return k;
  };
  let k = make();
  mkdirSync(cfg.state_dir, { recursive: true });
  if (o.samples !== undefined) writeFileSync(samplesPath(cfg.state_dir), o.samples.map(x => JSON.stringify(x)).join('\n') + '\n');
  else writeFileSync(samplesPath(cfg.state_dir), full().map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(reg, JSON.stringify({ devnet: o.registry ?? [MINT], local: [] }));
  const s = initState(cfg); s.pending_lamports = '1000000'; s.dev_baseline_raw = '0'; s.first_supply_raw = '1000'; s.price_grad = o.grad === undefined ? GRAD : o.grad; k.store.saveState(s);
  const state = () => k.store.loadState(() => initState(cfg));
  let runN = 0;
  const run = async () => { const r = await k.runOnce(Date.UTC(2026, 9, 4, 6, 0) + 300_000 * runN++); return { r, s: state(), last: state().runs.at(-1)! }; };
  return { get k() { return k; }, restart: () => { k = make(); }, setNow: (t: number) => { now = t; }, logs, cfg, c, http, state, run, dir };
}
const minOutOf = (h: ReturnType<typeof harness>) => BigInt(h.c.builds[0].minimumAmountOut.toString());

// ================================================================ refusals 1-9
test('criterion 1 (pre-graduation): isMigrated = 0 → waiting_for_graduation; no price source queried (no chain time, samples, quote or API call)', async () => {
  const h = harness({ migrated: 0 });
  const { r, s } = await h.run();
  assert.equal(r.status, 'waiting_for_graduation');
  assert.equal(h.c.priceChecks, 0); assert.equal(h.c.slotCalls, 0); assert.equal((h.http as any).calls.length, 0); assert.equal(h.c.builds.length, 0); assert.equal(h.c.sends, 0);
  assert.equal(s.runs.at(-1)!.price, undefined);
  // the other half of the gate (mint TransferHook still set) is the existing pinned check: graduationPhase → assertMintHook
  assert.match(readFileSync('sdk/flywheel/keeper.ts', 'utf8'), /assertMintHook\(this\.conn, this\.mint, graduationPhase\(mainPool\)/);
});

test('criterion 2 (post-graduation age): younger than min_post_grad_age_s → hold_twap_warmup; exactly min_post_grad_age_s passes; the first run after graduation records it and holds', () => {
  assert.throws(() => twap(full(), { grad: { slot: slotAt(T - 1799), t: T - 1799 } }), refuses('hold_twap_warmup'));
  assert.equal(twap(full(), { grad: { slot: slotAt(T - 1800), t: T - 1800 } }).used, 121);
  return (async () => {
    const h = harness({ grad: null });
    const { r, s, last } = await h.run();
    assert.equal(r.status, 'hold_twap_warmup'); assert.deepEqual(s.price_grad, { slot: SLOT, t: T });
    assert.equal(last.price!.code, 'hold_twap_warmup'); assert.equal(h.c.builds.length, 0); assert.equal(s.consecutive_failures, 0);   // within the warm-up ceiling: not counted
  })();
});

test('criterion 3 (missing samples): coverage below min_coverage_pct → refuse_twap_coverage; exactly min_coverage_pct passes', async () => {
  const all = full();                                         // 121 samples, expected = 1800/15 = 120, 80% = 96
  const drop = (n: number) => { const idx = new Set<number>(); for (let i = 1; idx.size < n; i += 4) idx.add(i); return all.filter((_, i) => !idx.has(i)); };   // gaps stay ≤ 30 s
  assert.equal(drop(25).length, 96); assert.equal(twap(drop(25)).used, 96);
  assert.equal(drop(26).length, 95); assert.throws(() => twap(drop(26)), refuses('refuse_twap_coverage'));
  assert.throws(() => twap([]), refuses('refuse_twap_coverage'));
  const h = harness({ samples: drop(26) }); const { r, last } = await h.run();
  assert.equal(r.status, 'refuse_twap_coverage'); assert.match(last.price!.reason as string, /coverage 95\/120/); assert.equal(h.c.builds.length, 0);
});

test('criterion 4 (stale samples): latest sample older than max_latest_sample_age_s, or any gap above max_sample_gap_s (also from the window start) → refuse_twap_stale; the limits themselves pass', async () => {
  const body = series(T - 1800, T - 45);
  assert.equal(twap([...body, ...series(T - 30, T - 30)]).last_t, T - 30);                                   // age 30 = limit
  assert.throws(() => twap([...body, ...series(T - 31, T - 31)]), refuses('refuse_twap_stale'));             // age 31
  const all = full();
  const gap60 = all.filter((_, i) => !(i >= 10 && i <= 12));                                                // 4 × 15 s = 60 s
  assert.equal(twap(gap60).max_gap_s, 60);
  const gap61 = gap60.map((x, i) => (i === 10 ? { ...x, t: x.t + 1, slot: x.slot + 2 } : x));              // 61 s, then 14 s
  assert.throws(() => twap(gap61), refuses('refuse_twap_stale'));
  const edge = [...series(T - 1810, T - 1810), ...series(T - 1800 + 61, T)];                               // same session; first in-window sample 61 s after the window start
  assert.throws(() => twap(edge), refuses('refuse_twap_stale'));
  const h = harness({ samples: gap61 }); const { r } = await h.run(); assert.equal(r.status, 'refuse_twap_stale'); assert.equal(h.c.builds.length, 0);
});

test('criterion 5 (spot vs TWAP): |spot − TWAP| / TWAP above max_spot_twap_dev_bps → refuse_spot_vs_twap, both directions; exactly the limit passes', async () => {
  for (const [spot, ok] of [[10_300n, true], [10_301n, false], [9_700n, true], [9_699n, false]] as const) {
    if (ok) checkSpotVsTwap(spot, 10_000n, 300); else assert.throws(() => checkSpotVsTwap(spot, 10_000n, 300), refuses('refuse_spot_vs_twap'));
  }
  // keeper: TWAP price 1 (sqrt 2^64); spot 4% higher (sqrt × 1.02) → refused before any build
  const h = harness({ spotSqrt: (X64 * 102n) / 100n }); const { r, last } = await h.run();
  assert.equal(r.status, 'refuse_spot_vs_twap'); assert.equal(last.price!.spot_twap_dev_bps, 403);   // (1.02)² with floored sqrt assert.equal(h.c.builds.length, 0);
  const lo = harness({ spotSqrt: (X64 * 98n) / 100n }); assert.equal((await lo.run()).r.status, 'refuse_spot_vs_twap');
});

test('criterion 5 at the keeper call site with the default limit (300 bps, devnet config): the largest spot sqrt within +300 / −300 bps of the TWAP passes, one Q64 step past it refuses', async () => {
  assert.equal(PS.max_spot_twap_dev_bps, 300);
  // TWAP = Q128 (constant sqrt 2^64). +300: largest sqrt with sqrt² ≤ 1.03·Q128; −300: smallest with sqrt² ≥ 0.97·Q128.
  // A square can't hit 1.03·Q128 exactly, so the exact-limit case is the unit test above and the overridden-limit test below.
  const hi = isqrt((Q128 * 10_300n) / 10_000n), lo = isqrt((Q128 * 9_700n) / 10_000n - 1n) + 1n;
  const at = async (sq: bigint) => { const h = harness({ spotSqrt: sq }); const { r, last } = await h.run(); return [r.status, last.price!.spot_twap_dev_bps, h.c.builds.length]; };
  assert.deepEqual(await at(hi), ['failed_swap', 299, 1]);                    // within +300: passes (a swap is built)
  assert.deepEqual(await at(hi + 1n), ['refuse_spot_vs_twap', 300, 0]);       // just past +300 (floored to 300 in the log): refused, nothing built
  assert.deepEqual(await at(lo), ['failed_swap', 299, 1]);                    // within −300: passes
  assert.deepEqual(await at(lo - 1n), ['refuse_spot_vs_twap', 300, 0]);       // just past −300: refused
});

test('criterion 6 (independent vs TWAP): |Jupiter − TWAP| / TWAP above max_indep_twap_dev_bps → refuse_indep_vs_twap, both directions; exactly the limit passes', async () => {
  for (const [n, ok] of [[10_500n, true], [10_501n, false], [9_500n, true], [9_499n, false]] as const) {
    if (ok) checkIndepVsTwap(n, 10_000n, Q128, 500); else assert.throws(() => checkIndepVsTwap(n, 10_000n, Q128, 500), refuses('refuse_indep_vs_twap'));
  }
  // keeper: TWAP 1 lamport per raw token; Jupiter 0.21 USD / 200 USD per SOL at 6 decimals = 1.05 → exactly 500 bps passes, 0.2101 refuses
  const ok = harness({ http: jup({ usdMint: 0.21 }) }); assert.equal((await ok.run()).r.status, 'failed_swap'); assert.equal(ok.c.builds.length, 1);
  const bad = harness({ http: jup({ usdMint: 0.2101 }) }); const { r, last } = await bad.run();
  assert.equal(r.status, 'refuse_indep_vs_twap'); assert.equal(last.price!.indep_twap_dev_bps, 505); assert.equal(bad.c.builds.length, 0);
  const low = harness({ http: jup({ usdMint: 0.1899 }) }); assert.equal((await low.run()).r.status, 'refuse_indep_vs_twap');
});

test('criteria 5 and 6 at the keeper call site: the configured limits are applied exactly (spot +201 / −1,900 bps and independent ±500 pass at the limit and refuse one past it)', async () => {
  // TWAP: constant 100·X64 → 10,000 lamports per raw token; the independent price at 2,000 USD / 200 USD per SOL is exactly that
  const S100 = full({ sqrt: 100n * X64 });
  const spot = async (sq: bigint, limit: number) => { const h = harness({ samples: S100, spotSqrt: sq, http: jup({ usdMint: 2000 }), p: { max_spot_twap_dev_bps: limit } }); const { r, last } = await h.run(); return [r.status, last.price!.spot_twap_dev_bps, h.c.builds.length]; };
  assert.deepEqual(await spot(101n * X64, 201), ['failed_swap', 201, 1]);             // +201 bps at a 201 limit: passes
  assert.deepEqual(await spot(101n * X64, 200), ['refuse_spot_vs_twap', 201, 0]);     // limit − 1: refuses
  assert.deepEqual(await spot(90n * X64, 1900), ['failed_swap', 1900, 1]);            // −1,900 bps at the limit: passes
  assert.deepEqual(await spot(90n * X64, 1899), ['refuse_spot_vs_twap', 1900, 0]);    // past it: refuses
  // independent price vs TWAP 1 lamport per raw token (default samples), default limit 500
  const ind = async (usd: number) => { const h = harness({ http: jup({ usdMint: usd }) }); const { r, last } = await h.run(); return [r.status, last.price!.indep_twap_dev_bps, h.c.builds.length]; };
  assert.deepEqual(await ind(0.21), ['failed_swap', 500, 1]);                // +500
  assert.deepEqual(await ind(0.21002), ['refuse_indep_vs_twap', 501, 0]);    // +501
  assert.deepEqual(await ind(0.19), ['failed_swap', 500, 1]);                // −500
  assert.deepEqual(await ind(0.18998), ['refuse_indep_vs_twap', 501, 0]);    // −501
});

test('criterion 7 (independent source down / omitted / stale): HTTP error, 429, timeout, network error, missing id, bad price, old blockId → refuse_indep_unavailable (no pool-only fallback)', async () => {
  const p = ps();
  const cases: [string, HttpGet][] = [
    ['HTTP 500', jup({ status: 500 })], ['HTTP 429', jup({ status: 429 })],
    ['network error', async () => { throw new Error('fetch failed'); }],
    ['timeout', (_u, init) => new Promise((_res, rej) => { const hold = setTimeout(() => {}, 5_000); init?.signal?.addEventListener('abort', () => { clearTimeout(hold); rej(init.signal!.reason); }); })],   // the abort timer is unref'd: keep the loop alive
    ['bad JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } })],
    ['mint omitted', jup({ omit: MINT })], ['wSOL omitted', jup({ omit: WSOL_MINT })],
    ['usdPrice 0', jup({ usdMint: 0 })], ['usdPrice string', jup({ usdMint: '0.2' })], ['decimals differ', jup({ decimals: 9 })],
    ['blockId 151 slots old', jup({ block: SLOT - 151 })],
  ];
  for (const [name, http] of cases) await assert.rejects(fetchIndependent(http, { ...p, indep_timeout_ms: 100 }, MINT, 6, SLOT), refuses('refuse_indep_unavailable'), name);
  const r150 = await fetchIndependent(jup({ block: SLOT - 150 }), p, MINT, 6, SLOT); assert.equal(r150.block_id_mint, SLOT - 150);   // 150 = limit passes
  const h = harness({ http: jup({ status: 429 }) }); const { r, last } = await h.run();
  assert.equal(r.status, 'refuse_indep_unavailable'); assert.match(last.price!.reason as string, /HTTP 429/); assert.equal(h.c.builds.length, 0);
  // require_independent = false: an unavailable source is tolerated (warning, TWAP only), but a price that is out of band still refuses
  const off = harness({ p: { require_independent: false }, http: jup({ status: 500 }) }); const o1 = await off.run();
  assert.equal(o1.r.status, 'failed_swap'); assert.equal(off.c.builds.length, 1); assert.ok(o1.last.warnings.some(w => /HTTP 500.*require_independent = false/.test(w)));
  const off2 = harness({ p: { require_independent: false }, http: jup({ usdMint: 0.3 }) }); assert.equal((await off2.run()).r.status, 'refuse_indep_vs_twap');
});

test('criterion 8 (wrong pool or mint): unpinned route pool, pool mints not {mint, wSOL}, mint not in the registry, an in-window sample from another pool → mismatch_pool / mismatch_registry + auto-pause', async () => {
  const cases: [string, H, string][] = [
    ['route pool not pinned', { cfg: { route_pool: null } }, 'failed_mismatch_pool'],
    ['pool mints not {mint, wSOL}', { pool: { tokenAMint: new PublicKey(MINT), tokenBMint: new PublicKey(OTHER_POOL) } }, 'failed_mismatch_pool'],
    ['pool mints unreadable', { pool: {} }, 'failed_mismatch_pool'],
    ['mint not in the registry at run start (8.5 check, before any read)', { registry: [Keypair.generate().publicKey.toBase58()] }, 'failed_registry'],
    ['mint removed from the registry during the run (price path re-reads it)', { registryMidRun: [Keypair.generate().publicKey.toBase58()] }, 'failed_mismatch_registry'],
    ['pool pair of another registry mint', { registry: [MINT, OTHER_POOL], pool: { tokenAMint: new PublicKey(OTHER_POOL), tokenBMint: NATIVE_MINT } }, 'failed_mismatch_pool'],
    ['sample recorded for another pool', { samples: full().map((x, i) => (i === 60 ? { ...x, pool: OTHER_POOL } : x)) }, 'failed_mismatch_pool'],
  ];
  for (const [name, o, status] of cases) {
    const h = harness(o); const { r, s } = await h.run();
    assert.equal(r.status, status, name); assert.equal(s.paused, true, name); assert.equal(h.c.builds.length, 0, name); assert.equal(h.c.sends, 0, name);
  }
  assert.throws(() => twap(full().map((x, i) => (i === 3 ? { ...x, pool: OTHER_POOL } : x))), refuses('mismatch_pool', true));
});

test('refusal 8, price direction: the price path refuses a route pool whose token A is wSOL (prices would be inverted), never inverts; pinnedChecks keeps requiring (main mint, wSOL)', async () => {
  const h = harness({ pool: { tokenAMint: NATIVE_MINT, tokenBMint: new PublicKey(MINT) } });   // a registry mint and wSOL, but reversed
  const { r, s, last } = await h.run();
  assert.equal(r.status, 'failed_mismatch_pool'); assert.match(last.reason!, /token order is not \(main mint, wSOL\)/); assert.equal(s.paused, true); assert.equal(h.c.builds.length, 0);
  assert.match(readFileSync('sdk/flywheel/keeper.ts', 'utf8'), /if \(!p\.tokenAMint\.equals\(this\.mint\) \|\| !p\.tokenBMint\.equals\(NATIVE_MINT\)\) throw new FailClosed\('mismatch_pool'/, 'pinnedChecks still requires (main mint, wSOL)');
});

test('refusal 8 helper: assertRegistryPoolPair accepts a registry mint and wSOL in either order and nothing else', () => {
  const reg = new Set([MINT]); const X = Keypair.generate().publicKey.toBase58();
  assert.equal(WSOL_MINT_ADDRESS, NATIVE_MINT.toBase58()); assert.equal(WSOL_MINT, NATIVE_MINT.toBase58());
  assert.equal(assertRegistryPoolPair(reg, MINT, WSOL_MINT_ADDRESS), MINT);
  assert.equal(assertRegistryPoolPair(reg, NATIVE_MINT, new PublicKey(MINT)), MINT);
  const kind = (k: string) => (e: any) => e instanceof RegistryPairRefusal && e.kind === k;
  assert.throws(() => assertRegistryPoolPair(reg, MINT, MINT), kind('pair'));
  assert.throws(() => assertRegistryPoolPair(reg, MINT, X), kind('pair'));
  assert.throws(() => assertRegistryPoolPair(reg, WSOL_MINT_ADDRESS, WSOL_MINT_ADDRESS), kind('pair'));
  assert.throws(() => assertRegistryPoolPair(reg, X, WSOL_MINT_ADDRESS), kind('registry'));
  assert.throws(() => assertRegistryPoolPair(reg, WSOL_MINT_ADDRESS, MINT.toLowerCase()), kind('registry'));   // exact match
});

test('criterion 9 (source switching): samples before the graduation slot never count; a graduation flip resets the window', async () => {
  // graduation at the window start (age = min_post_grad_age_s). Pre-graduation samples: DBC pool samples at 3x the price
  // (older), and at the window start itself a DBC sample and a route-pool sample in the slot just before graduation
  // (same block time). Post-graduation: the DAMM pool at price 1. The TWAP is the DAMM price only.
  const grad = { slot: slotAt(T - 1800), t: T - 1800 };
  const pre = [...series(T - 3000, T - 1815, { pool: OTHER_POOL, sqrt: 3n * X64, session: 'pre' }),
    ...series(T - 1800, T - 1800, { pool: OTHER_POOL, sqrt: 3n * X64, slot: () => grad.slot - 1, session: 'pre' }),
    ...series(T - 1800, T - 1800, { sqrt: 5n * X64, slot: () => grad.slot - 1 })];
  const r = twap([...pre, ...full()], { grad });
  assert.equal(r.twapQ128, Q128); assert.equal(r.used, 121);
  // the sampler session must also cover the window with post-graduation samples: pre-graduation samples of the same session do not count towards it
  const late = [...series(T - 3000, T - 1815, { slot: t => slotAt(t) - 10_000 }), ...series(T - 1790, T)];
  assert.throws(() => twap(late, { grad }), refuses('refuse_twap_coverage'));
  // keeper: a run that reads not-graduated clears the graduation record; the next graduated run starts over (warm-up), even with a full window on disk
  const h = harness({ migrated: 0 }); await h.run();
  assert.equal(h.state().price_grad, null);
  (h.k as any).dbc = { state: { getPool: async () => ({ isMigrated: 1, partnerQuoteFee: { toString: () => '0' } }) } };
  const r2 = await h.k.runOnce(Date.UTC(2026, 9, 4, 6, 10));
  assert.equal(r2.status, 'hold_twap_warmup'); assert.deepEqual(h.state().price_grad, { slot: SLOT, t: T }); assert.equal(h.c.builds.length, 0);
  assert.throws(() => twap(full(), { grad: { slot: SLOT, t: T - 1800 } }), refuses('refuse_twap_coverage'));   // only the sample at the new graduation slot counts
});

// ================================================================ criteria 10-17
test('criterion 10 (anchored min_out): min_out = min(quote-based, TWAP-based); with the spot out 10% above the TWAP out it comes from the TWAP and the fake pool fails on min_out', async () => {
  const a = anchoredMinOut(1_000_000n, 1_100_000n, Q128, 100, 200);   // TWAP price 1: twapOut = 1,000,000
  assert.deepEqual([a.twapOut, a.fromQuote, a.fromTwap, a.minOut, a.source], [1_000_000n, 1_067_000n, 970_000n, 970_000n, 'twap']);
  const b = anchoredMinOut(1_000_000n, 900_000n, Q128, 100, 200);     // quote lower than the TWAP: the quote binds
  assert.deepEqual([b.minOut, b.source], [873_000n, 'quote']);        // spec §3.7: min(900,000, 1,000,000) × (10,000 − 100 − 200) / 10,000
  const e = anchoredMinOut(1_000_000n, 1_000_000n, Q128, 100, 200);   // equal legs: same value either way
  assert.equal(e.minOut, 970_000n);
  // keeper: TWAP price 1; the pool spot price is 1/1.1 (spot out 10% above the TWAP out; within a 1,500 bps limit)
  const spotSqrt = isqrt((Q128 * 10n) / 11n);
  const h = harness({ p: { max_spot_twap_dev_bps: 1500 }, spotSqrt, quoteOut: x => (x * 11n) / 10n, fill: x => (x * 96n) / 100n });
  const { r, last } = await h.run();
  assert.equal(minOutOf(h), 970_000n); assert.equal(last.price!.min_out_source, 'twap'); assert.equal(last.price!.min_out_from_quote, '1067000');
  assert.deepEqual(h.c.simulated, ['fail_min_out']); assert.equal(r.status, 'failed_swap');                 // simulation fails on min_out instead of filling
  const q = harness({ quoteOut: x => (x * 99n) / 100n }); const qr = await q.run();   // quote 990,000 < TWAP out 1,000,000: the quote binds
  assert.equal(minOutOf(q), 960_300n); assert.equal(qr.last.price!.min_out_source, 'quote');   // 990,000 × 9,700 / 10,000
});

test('criterion 11 (dry-run default): no send for any price-path outcome; the decision record is written for every refusal', async () => {
  const outcomes: [string, H][] = [
    ['hold_twap_warmup', { grad: null }], ['refuse_twap_coverage', { samples: [] }], ['refuse_twap_stale', { samples: series(T - 1800, T - 60) }],
    ['refuse_spot_vs_twap', { spotSqrt: 2n * X64 }], ['refuse_indep_vs_twap', { http: jup({ usdMint: 1 }) }], ['refuse_indep_unavailable', { http: jup({ omit: MINT }) }],
    ['mismatch_pool', { cfg: { route_pool: null } }], ['mismatch_registry', { registryMidRun: [] as string[] }],
  ];
  for (const [code, o] of outcomes) {
    const h = harness(o); const { last } = await h.run();
    assert.equal(h.c.sends, 0, code); assert.equal(h.c.builds.length, 0, code);
    assert.equal(last.price!.decision, 'refuse', code); assert.equal(last.price!.code, code, code); assert.equal(last.swap!.status, 'refused', code);
    const pub = JSON.parse(readFileSync(h.cfg.public_log, 'utf8')); assert.equal(pub.runs.at(-1).price.code, code, code);
  }
  assert.match(readFileSync('sdk/flywheel/dryrun.ts', 'utf8'), /\['state\.json', 'PAUSE', 'price_samples\.jsonl'\]/);   // dry runs see the samples (read-only copy)
});

test('criterion 12 (rate limits): one independent-price request per run with both ids; the sampler reads at most once per sample_interval_s', async () => {
  const h = harness(); await h.run();
  const calls = (h.http as any).calls as string[]; assert.equal(calls.length, 1); assert.equal(calls[0], `${PS.indep_price_url}?ids=${MINT},${WSOL_MINT}`);
  let reads = 0; let clock = 0; const dir = tmp();
  const conn = { getAccountInfoAndContext: async () => { reads++; return { context: { slot: SLOT }, value: { data: Buffer.alloc(8), owner: CP_AMM_PROGRAM_ID } }; }, getBlockTime: async () => T };
  const smp = new PriceSampler(conn, new PublicKey(POOL), samplesPath(dir), ps(), () => X64, () => clock);
  assert.ok(await smp.tick()); clock = 14_999; assert.equal(await smp.tick(), null); clock = 15_000; assert.ok(await smp.tick());
  assert.equal(reads, 2);
});

test('criterion 13 (no keys in the sampler / price path): the price module imports no key loader and sends nothing', () => {
  const src = readFileSync('sdk/flywheel/price_source.ts', 'utf8');
  assert.doesNotMatch(src, /Keypair|loadOrCreate|secretKey|fromSecretKey|\.devnet-keys|keygen|sendRawTransaction|sendTransaction|\.sign\(/);
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
  assert.deepEqual(imports.sort(), ['../keyrules.js', '../redact.js', './store.js', '@meteora-ag/cp-amm-sdk', '@solana/web3.js', 'node:crypto', 'node:fs', 'node:path'].sort());
});

test('criterion 14 (restart): wiped samples, a new sampler session younger than the window, or a gap refuse until a full window refills; one fresh read never yields a TWAP', async () => {
  assert.throws(() => twap([]), refuses('refuse_twap_coverage'));
  assert.throws(() => twap(series(T, T)), refuses('refuse_twap_coverage'));                                           // one fresh read
  const restarted = [...series(T - 3000, T - 615, { session: 'old' }), ...series(T - 600, T, { session: 'new' })];     // no gap, but a restart 10 min ago
  assert.throws(() => twap(restarted), refuses('refuse_twap_coverage'));
  assert.equal(twap([...series(T - 3000, T - 1815, { session: 'old' }), ...series(T - 1800, T, { session: 'new' })]).session, 'new');   // refilled
  const interleaved = full().map((x, i) => (i % 2 ? { ...x, session: 'other' } : x));                                 // two samplers at once
  assert.throws(() => twap(interleaved), refuses('refuse_twap_coverage'));
  const gapped = [...series(T - 3000, T - 1000), ...series(T - 900, T + 1000)];                                       // 100 s gap at T−1000
  assert.throws(() => twap(gapped), refuses('refuse_twap_stale'));
  assert.equal(twap(gapped, { nowT: T + 1000 }).used, 120);                                                           // the gap has left the window
  const h = harness({ samples: [] }); assert.equal((await h.run()).r.status, 'refuse_twap_coverage');
  rmSync(samplesPath(h.cfg.state_dir)); const s = h.state(); s.paused = false; s.consecutive_failures = 0; h.k.store.saveState(s);
  assert.equal((await h.k.runOnce(Date.UTC(2026, 9, 4, 6, 10))).status, 'refuse_twap_coverage');                       // file wiped
});

test('criterion 15 (chain time): a box clock skewed by ±10 min gives the same decisions; freshness uses the block time of the current slot; a missing block time refuses', async () => {
  const orig = Date.now;
  const decide = async (skewMs: number, o: H = {}) => { Date.now = () => orig() + skewMs; try { const h = harness(o); const { r, last } = await h.run(); return [r.status, last.price!.chain_time, last.price!.latest_sample_age_s, h.c.builds.length]; } finally { Date.now = orig; } };
  for (const o of [{}, { samples: series(T - 1800, T - 60) }, { samples: drop1() }] as H[]) {
    const ref = await decide(0, o);
    assert.deepEqual(await decide(600_000, o), ref); assert.deepEqual(await decide(-600_000, o), ref);
  }
  assert.deepEqual((await decide(600_000)).slice(0, 2), ['failed_swap', T]);
  const h = harness({ nowT: null }); assert.equal((await h.run()).r.status, 'refuse_twap_stale');
  function drop1() { return full().filter((_, i) => i % 5 !== 1); }
});

test('criterion 16 (config fails closed): a missing section or key, a 0 s window, any *_bps above 2,000, a missing / misspelled / non-boolean require_independent, an unknown key or a bad URL refuses to start', async () => {
  assert.deepEqual(checkPriceConfig(base), PS);
  const bad = (o: any, re: RegExp, name: string) => assert.throws(() => checkPriceConfig({ ...base, ...o }), (e: any) => e instanceof PriceConfigRefusal && re.test(e.message), name);
  bad({ price_source: undefined }, /section is missing/, 'no section');
  for (const k of PRICE_SOURCE_KEYS) { const p: any = { ...PS }; delete p[k]; bad({ price_source: p }, new RegExp(`"${k}" is missing`), k); }
  bad({ price_source: { ...PS, twap_window_s: 0 } }, /twap_window_s/, 'window 0');
  for (const k of ['max_spot_twap_dev_bps', 'max_indep_twap_dev_bps']) {
    assert.doesNotThrow(() => checkPriceConfig({ ...base, price_source: { ...PS, [k]: 2000 } }));
    bad({ price_source: { ...PS, [k]: 2001 } }, new RegExp(k), `${k} 2001`);
  }
  for (const k of ['max_slippage_bps', 'max_price_impact_bps']) { assert.doesNotThrow(() => checkPriceConfig({ ...base, [k]: 2000 })); bad({ [k]: 2001 }, new RegExp(k), `${k} 2001`); }
  const { require_independent, ...noReq } = PS as any;
  bad({ price_source: { ...noReq, require_independant: true } }, /unknown key "require_independant"/, 'misspelled');
  bad({ price_source: { ...PS, require_independent: 'true' } }, /require_independent" must be true or false/, 'string');
  bad({ price_source: { ...PS, extra: 1 } }, /unknown key "extra"/, 'unknown key');
  bad({ price_source: { ...PS, indep_price_url: 'http://example.com/price' } }, /indep_price_url/, 'plain http');
  bad({ price_source: { ...PS, indep_price_url: 'https://example.com/price?ids=x' } }, /indep_price_url/, 'query');
  bad({ price_source: { ...PS, min_post_grad_age_s: PS.twap_window_s - 1 } }, /min_post_grad_age_s/, 'warm-up shorter than the window');
  bad({ price_source: { ...PS, max_sample_gap_s: PS.sample_interval_s - 1 } }, /max_sample_gap_s/, 'gap below the interval');
  // refuses at start: offline preflight, and startKeeper before any key file is opened or any connection
  const ks: KeySet = { claim: Keypair.generate(), treasury: Keypair.generate(), gas: Keypair.generate() };
  const cfg = { ...base, pinned_pubkeys: undefined, price_source: { ...PS, twap_window_s: 0 } } as KeeperConfig;
  assert.throws(() => preflightOffline(cfg, ks), (e: any) => e instanceof PriceConfigRefusal);
  let loaded = 0, connected = 0;
  await assert.rejects(startKeeper(cfg, [], { loadKey: () => { loaded++; return Keypair.generate(); }, connect: async () => { connected++; throw new Error('no'); }, log: () => {} }), (e: any) => e instanceof PriceConfigRefusal);
  assert.deepEqual([loaded, connected], [0, 0]);
  const h = harness({ p: { max_spot_twap_dev_bps: 5000 } }); const { r } = await h.run(); assert.equal(r.status, 'refuse_config'); assert.equal(h.c.builds.length, 0);   // re-checked every run
});

test('criterion 17 (independent source over HTTP, stand-in for the devnet run): a local price server up → passes; down → refuse_indep_unavailable', async () => {
  const body = JSON.stringify({ [MINT]: { usdPrice: 0.2, blockId: SLOT, decimals: 6 }, [WSOL_MINT]: { usdPrice: 200, blockId: SLOT, decimals: 9 } });
  const seen: string[] = [];
  const srv: Server = createServer((q, s) => { seen.push(q.url ?? ''); s.writeHead(200, { 'content-type': 'application/json' }); s.end(body); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/price/v3`;
  let closed = false; const close = async () => { if (closed) return; closed = true; srv.closeAllConnections(); await new Promise<void>(r => srv.close(() => r())); };   // fetch keeps the connection alive
  try {
    const up = harness({ p: { indep_price_url: url }, realHttp: true });   // the keeper's real fetch
    const ru = await up.run();
    assert.equal(ru.r.status, 'failed_swap'); assert.equal(up.c.builds.length, 1); assert.deepEqual(seen, [`/price/v3?ids=${MINT},${WSOL_MINT}`]);
  } finally { await close(); }   // closed even when an assertion fails, so the file never hangs
  const down = harness({ p: { indep_price_url: url }, realHttp: true });
  const rd = await down.run();
  assert.equal(rd.r.status, 'refuse_indep_unavailable'); assert.equal(down.c.builds.length, 0);
});

test('criterion 17 pump before the run: a spot moved off the TWAP, with the independent price served over HTTP, refuses by the spot check or fails the swap on min_out', async () => {
  const body = JSON.stringify({ [MINT]: { usdPrice: 0.2, blockId: SLOT, decimals: 6 }, [WSOL_MINT]: { usdPrice: 200, blockId: SLOT, decimals: 9 } });
  const srv: Server = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(body); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/price/v3`;
  let closed = false; const close = async () => { if (closed) return; closed = true; srv.closeAllConnections(); await new Promise<void>(r => srv.close(() => r())); };
  try {
    // Pump past the 300 bps band: the keeper refuses before it builds a swap.
    const pumped = harness({ p: { indep_price_url: url }, realHttp: true, spotSqrt: (X64 * 102n) / 100n });
    const rp = await pumped.run();
    assert.equal(rp.r.status, 'refuse_spot_vs_twap'); assert.equal(pumped.c.builds.length, 0); assert.equal(pumped.c.sends, 0);
    // Pump held inside a widened band: min_out stays on the TWAP, and the pool simulation fails closed.
    const spotSqrt = isqrt((Q128 * 10n) / 11n);
    const inside = harness({ p: { indep_price_url: url, max_spot_twap_dev_bps: 1500 }, realHttp: true, spotSqrt, quoteOut: x => (x * 11n) / 10n, fill: x => (x * 96n) / 100n });
    const ri = await inside.run();
    assert.equal(minOutOf(inside), 970_000n); assert.equal(ri.last.price!.min_out_source, 'twap');
    assert.deepEqual(inside.c.simulated, ['fail_min_out']); assert.equal(ri.r.status, 'failed_swap');
  } finally { await close(); }
});

// ================================================================ warm-up ceiling
test('warm-up ceiling: a warm-up hold does not count toward auto-pause up to window + 15 min (chain time); just over it, the hold counts and pauses; the start is persisted and cleared when the warm-up is satisfied or graduation flips back', async () => {
  assert.equal(WARMUP_GRACE_S, 900); assert.equal(warmupCeilingS(ps()), 2700);
  assert.ok(!(PRICE_SOURCE_KEYS as readonly string[]).some(k => /ceiling|grace/.test(k)), 'the ceiling is not a config key');
  const h = harness({ grad: null, p: { min_post_grad_age_s: 3600 } });   // a warm-up longer than the ceiling
  for (const t of [T, T + 900, T + 1800, T + 2700]) {                    // 4 holds (> auto_pause_after_failures): none counted
    h.setNow(t); const { r, s, last } = await h.run();
    assert.equal(r.status, 'hold_twap_warmup', `t+${t - T}`); assert.equal(s.paused, false, `t+${t - T}`); assert.equal(s.consecutive_failures, 0, `t+${t - T}`);
    assert.deepEqual(s.price_hold, { slot: SLOT, t: T, session: 's1' }); assert.equal(last.price!.hold_elapsed_s, t - T); assert.equal(last.price!.hold_counts, false);
  }
  assert.ok(h.logs.some(l => /warm-up hold \(hold_twap_warmup\): 2700s since slot \d+ \(ceiling 2700s, not counted/.test(l)), 'each hold is logged with its elapsed time');
  h.setNow(T + 2701); const o = await h.run();                           // just over the ceiling
  assert.equal(o.r.status, 'hold_twap_warmup'); assert.equal(o.s.paused, true); assert.equal(o.s.consecutive_failures, 1);
  assert.match(o.s.pause_reason, /warm-up hold has lasted 2701s \(> ceiling 2700s/); assert.equal(o.last.price!.hold_counts, true); assert.equal(h.c.builds.length, 0);
  // cleared when the warm-up is satisfied (the TWAP check passes) ...
  const ok = harness({ grad: null, samples: series(T, T + 1800), http: jup({ block: slotAt(T + 1800) }) });
  await ok.run(); assert.equal(ok.state().price_hold!.t, T);
  ok.setNow(T + 1800); const r2 = await ok.run(); assert.equal(r2.r.status, 'failed_swap'); assert.equal(r2.s.price_hold, null);
  // ... and when graduation flips back
  const fl = harness({ grad: null }); await fl.run(); assert.equal(fl.state().price_hold!.t, T);
  (fl.k as any).dbc = { state: { getPool: async () => ({ isMigrated: 0, partnerQuoteFee: { toString: () => '0' } }) } };
  await fl.run(); assert.equal(fl.state().price_hold, null); assert.equal(fl.state().price_grad, null);
});

test('warm-up ceiling: a hold that spans a sampler restart (new session) keeps its start and pauses past the ceiling', async () => {
  const all = [...series(T - 3000, T + 1485, { session: 'old' }), ...series(T + 1500, T + 2700, { session: 'new' })];   // sampler restarted at T+1500
  const h = harness({ grad: null, samples: [] });
  const at = async (t: number) => { h.setNow(t); writeFileSync(samplesPath(h.cfg.state_dir), all.filter(x => x.t <= t).map(x => JSON.stringify(x)).join('\n') + '\n'); return h.run(); };
  const a = await at(T); assert.equal(a.r.status, 'hold_twap_warmup'); assert.deepEqual(a.s.price_hold, { slot: SLOT, t: T, session: 'old' });
  const b = await at(T + 1800);                                          // warm-up satisfied; the window is refilling after the restart
  assert.equal(b.r.status, 'refuse_twap_coverage'); assert.match(b.last.reason!, /more than one sampler session/);
  assert.equal(b.s.price_hold!.t, T); assert.equal(b.last.price!.hold_elapsed_s, 1800); assert.equal(b.s.paused, false); assert.equal(b.s.consecutive_failures, 0);
  const c = await at(T + 2701);
  assert.equal(c.r.status, 'refuse_twap_coverage'); assert.equal(c.s.price_hold!.t, T); assert.equal(c.last.price!.hold_elapsed_s, 2701); assert.equal(c.s.paused, true);
  assert.match(c.s.pause_reason, /ceiling 2700s/);
});

test('warm-up ceiling: a hold that spans a keeper restart (a new keeper loading the state file) keeps its start and pauses past the ceiling', async () => {
  const h = harness({ grad: null, p: { min_post_grad_age_s: 3600 } });
  await h.run();
  assert.deepEqual(JSON.parse(readFileSync(join(h.cfg.state_dir, 'state.json'), 'utf8')).price_hold, { slot: SLOT, t: T, session: 's1' });   // on disk
  h.restart(); h.setNow(T + 2700); const a = await h.run(); assert.equal(a.s.paused, false); assert.equal(a.last.price!.hold_elapsed_s, 2700);
  h.restart(); h.setNow(T + 2701); const b = await h.run();
  assert.equal(b.r.status, 'hold_twap_warmup'); assert.equal(b.last.price!.hold_elapsed_s, 2701); assert.equal(b.s.paused, true);
});

// ================================================================ independent price API key
const KEY = 'jk-NoLeak-7f3c9a1e5b2d4c6e8a0f-Zq';
async function withKey<R>(v: string | undefined, f: () => Promise<R>): Promise<R> {
  const prev = process.env[INDEP_API_KEY_ENV];
  if (v === undefined) delete process.env[INDEP_API_KEY_ENV]; else process.env[INDEP_API_KEY_ENV] = v;
  try { return await f(); } finally { if (prev === undefined) delete process.env[INDEP_API_KEY_ENV]; else process.env[INDEP_API_KEY_ENV] = prev; }
}

test('independent price API key: keyless by default (no header); when set, sent only as the x-api-key header, never in the URL; the base URL is api.jup.ag/price/v3', async () => {
  for (const f of ['keeper/devnet.tdt.json', 'keeper/devnet.fw15.json']) assert.equal(JSON.parse(readFileSync(f, 'utf8')).price_source.indep_price_url, 'https://api.jup.ag/price/v3', f);
  assert.equal(INDEP_API_KEY_ENV, 'FW_JUPITER_API_KEY'); assert.ok((SECRET_ENV_VARS as readonly string[]).includes(INDEP_API_KEY_ENV), 'the key is a redacted secret');
  assert.equal(indepApiKey({}), undefined); assert.equal(indepApiKey({ FW_JUPITER_API_KEY: '' }), undefined); assert.equal(indepApiKey({ FW_JUPITER_API_KEY: '   ' }), undefined);
  assert.equal(indepApiKey({ FW_JUPITER_API_KEY: ` ${KEY} ` }), KEY);
  const plain = `${PS.indep_price_url}?ids=${MINT},${WSOL_MINT}`;
  for (const v of [undefined, '', '  ']) await withKey(v, async () => {
    const h = harness(); assert.equal((await h.run()).r.status, 'failed_swap');
    const j = h.http as any; assert.deepEqual(j.calls, [plain]); assert.equal(j.inits[0].headers, undefined, `no header when ${JSON.stringify(v)}`);
  });
  await withKey(KEY, async () => {
    const h = harness(); assert.equal((await h.run()).r.status, 'failed_swap');
    const j = h.http as any; assert.deepEqual(j.calls, [plain]); assert.ok(!j.calls[0].includes(KEY)); assert.deepEqual(j.inits[0].headers, { 'x-api-key': KEY });
  });
  const d = jup(); await fetchIndependent(d, ps(), MINT, 6, SLOT, KEY); assert.equal(d.calls[0], plain); assert.deepEqual(d.inits[0].headers, { 'x-api-key': KEY });
  const n = jup(); await fetchIndependent(n, ps(), MINT, 6, SLOT); assert.equal(n.inits[0].headers, undefined);
});

test('independent price API key: no leak through log lines, a thrown fetch error carrying the headers, or a non-200 body echoing the key (refusal messages, state, public log and every redaction sink)', async () => {
  await withKey(KEY, async () => {
    const sinks = (h: ReturnType<typeof harness>, extra: unknown[] = []) => [readFileSync(join(h.cfg.state_dir, 'state.json'), 'utf8'), readFileSync(h.cfg.public_log, 'utf8'), ...h.logs, ...extra.map(x => JSON.stringify(x))].join('\n');
    const noKey = (txt: string, name: string) => { for (const x of [KEY, encodeURIComponent(KEY), KEY.slice(0, 10), KEY.slice(-10)]) assert.ok(!txt.includes(x), `${name}: key (or a fragment) leaked`); };
    // (a) normal log lines (a passing run, and a line that names the key)
    const a = harness(); const ra = await a.run(); assert.equal(ra.r.status, 'failed_swap');
    a.k.log(`request headers {"x-api-key":"${KEY}"}`); assert.ok(a.logs.some(l => l.includes('<secret>')));
    noKey(sinks(a, [ra.r]), '(a) logs');
    // (b) a thrown fetch error whose message, cause and request carry the key and the headers
    let thrown: any;
    const boom: HttpGet = async (url, init) => {
      const e: any = new Error(`fetch failed (headers ${JSON.stringify(init?.headers)}) GET ${url}`);
      e.cause = Object.assign(new Error(`connect ECONNREFUSED x-api-key=${KEY}`), { headers: init?.headers });
      e.request = { url, headers: new Headers(init?.headers) }; e.config = { headers: { ...init?.headers } };
      thrown = e; throw e;
    };
    const b = harness({ http: boom }); const rb = await b.run();
    assert.equal(rb.r.status, 'refuse_indep_unavailable'); assert.match(rb.last.reason!, /fetch failed \(headers \{"x-api-key":"<secret>"\}\)/);
    noKey(sinks(b, [rb.r]), '(b) refusal');
    const b2 = harness({ http: boom, p: { require_independent: false } }); const rb2 = await b2.run();   // tolerated: the message goes to the run's warnings
    assert.equal(rb2.r.status, 'failed_swap'); assert.ok(rb2.last.warnings.some(w => /fetch failed.*<secret>/.test(w)));
    noKey(sinks(b2, [rb2.r]), '(b) warning');
    assert.ok(String(thrown.message).includes(KEY) && String(thrown.cause.message).includes(KEY), 'the stub error really carries the key');
    const cut: HttpGet = async () => { throw new Error('x'.repeat(110) + KEY); };   // the key straddles the 120-char cut of the refusal message
    const b3 = harness({ http: cut }); const rb3 = await b3.run(); assert.equal(rb3.r.status, 'refuse_indep_unavailable'); noKey(sinks(b3, [rb3.r]), '(b) cut');
    const logged: unknown[] = []; const se = serverError(thrown, (...x) => logged.push(...x));   // the site 500 path (send() deep-redacts its body the same way)
    noKey([redactPaths(thrown.message), redactPaths(String(thrown.cause?.message)), redactedJson(thrown), JSON.stringify(redactDeep(thrown)), JSON.stringify(redactDeep({ error: thrown }, redactPaths)),
      JSON.stringify(logged), JSON.stringify(redactDeep(se)), redactPaths(thrown.stack)].join('\n'), '(b) sinks');
    // (c) a non-200 whose body echoes the key (never read), and a 200 whose field echoes it
    const echo: HttpGet = async () => ({ ok: false, status: 401, json: async () => ({ error: `invalid x-api-key ${KEY}` }), text: async () => `invalid x-api-key ${KEY}` } as any);
    const c = harness({ http: echo }); const rc = await c.run();
    assert.equal(rc.r.status, 'refuse_indep_unavailable'); assert.match(rc.last.reason!, /HTTP 401/);
    noKey(sinks(c, [rc.r]), '(c) non-200');
    const field: HttpGet = async () => ({ ok: true, status: 200, json: async () => ({ [MINT]: { usdPrice: 0.2, blockId: SLOT, decimals: `echo ${KEY}` }, [WSOL_MINT]: { usdPrice: 200, blockId: SLOT, decimals: 9 } }) });
    const c2 = harness({ http: field }); const rc2 = await c2.run();
    assert.equal(rc2.r.status, 'refuse_indep_unavailable'); assert.match(rc2.last.reason!, /decimals echo <secret>/);
    noKey(sinks(c2, [rc2.r]), '(c) echoed field');
    // URL userinfo, credential query parameters and the cause's code: scrubbed / kept in run.reason, the state file and the public log
    const creds: HttpGet = async () => { const e: any = new Error('connect to https://jane:pa55-Wd9@price.example/v3?apikey=QpK-1x7&token=TkN-2y8 failed');
      e.cause = { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', headers: { 'x-api-key': KEY }, host: 'price.example' }; throw e; };
    const d = harness({ http: creds }); const rd = await d.run();
    assert.equal(rd.r.status, 'refuse_indep_unavailable');
    assert.match(rd.last.reason!, /https:\/\/<secret>@price\.example\/v3\?apikey=<secret>&token=<secret> failed \(cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE\)$/);
    const dState = readFileSync(join(d.cfg.state_dir, 'state.json'), 'utf8'), dPub = readFileSync(d.cfg.public_log, 'utf8');
    for (const [name, txt] of [['run.reason', rd.last.reason!], ['state file', dState], ['public log', dPub], ['logs', d.logs.join('\n')]] as const) {
      for (const x of ['pa55-Wd9', 'QpK-1x7', 'TkN-2y8', 'jane:', KEY, 'headers']) assert.ok(!txt.includes(x), `${name}: ${x}`);
    }
    assert.ok(dPub.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
    // any FailClosed reason (not only the price path) is scrubbed before it reaches the state file and the public log
    const f = harness(); const st = f.state(); const run: any = { run_id: 'r-x', status: 'planned', reason: '', warnings: [], txs: [], stages: {}, overrides: [] };
    (f.k as any).finishFail(st, run, new FailClosed('rpc', `rpc https://u:pw-Zz3@rpc.example/?api_key=AkQ-9 said ${KEY}`, true), true);
    const fState = readFileSync(join(f.cfg.state_dir, 'state.json'), 'utf8'), fPub = readFileSync(f.cfg.public_log, 'utf8');
    for (const txt of [fState, fPub, f.logs.join('\n')]) for (const x of ['pw-Zz3', 'AkQ-9', KEY]) assert.ok(!txt.includes(x), x);
    assert.match(JSON.parse(fState).runs.at(-1).reason, /^rpc https:\/\/<secret>@rpc\.example\/\?api_key=<secret> said <secret>$/);
    // CLI: the ERROR line (and say/ev, which use the same R) redact the key
    const cwd = tmp();
    const cli = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, resolve('scripts/flywheel.ts'), 'status', '--config', `cfg-${KEY}.json`],
      { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, FW_RPC_URL: 'http://127.0.0.1:9' } });
    assert.equal(cli.status, 1); assert.match(cli.stderr, /^ERROR: .*cfg-<secret>\.json/m); noKey(cli.stdout + cli.stderr, 'CLI');
    const src = readFileSync('scripts/flywheel.ts', 'utf8');
    assert.match(src, /const R = \(t: unknown\) => redactPaths\(t\);/); assert.match(src, /const say = .*R\(v\).*redactDeep\(v, R\)/); assert.match(src, /appendFileSync\(evlog, redactedJson\(/);
  });
  assert.equal(redactPaths(`x ${KEY} y`), `x ${KEY} y`, 'unset: nothing to redact');
  assert.equal(redactSecrets('GET https://a:b@h/x?key=1&ids=2&x-api-key=3 token=4 "access_token=5"'), 'GET https://<secret>@h/x?key=<secret>&ids=2&x-api-key=<secret> token=<secret> "access_token=<secret>"');
  assert.equal(redactSecrets(redactSecrets('u?apikey=1')), 'u?apikey=<secret>', 'idempotent');
  assert.equal(redactSecrets(`pubkey=${MINT} monkey=1 ${POOL} https://api.jup.ag/price/v3?ids=${MINT}`), `pubkey=${MINT} monkey=1 ${POOL} https://api.jup.ag/price/v3?ids=${MINT}`, 'no false positives on ids, pubkeys or plain URLs');
});

// ================================================================ helpers
test('TWAP is time-weighted over sqrt_price² (not a sample mean, not the mean sqrt price); a constant price gives that price exactly', () => {
  assert.equal(twap(full({ sqrt: 3n * X64 })).twapQ128, 9n * Q128);
  const step = full({ sqrt: t => (t < T - 900 ? X64 : 2n * X64) });     // 900 s at price 1, then 900 s at price 4
  assert.equal(twap(step).twapQ128, (5n * Q128) / 2n);
});

test('sampler: one sample per read with the context slot, its block time, the pool and the session; a restart is a new session; nothing is recorded without chain time or for a non-DAMM account', async () => {
  const dir = tmp(); const path = samplesPath(dir); let owner = CP_AMM_PROGRAM_ID; let bt: number | null = T; let clock = 0;
  const conn = { getAccountInfoAndContext: async () => ({ context: { slot: SLOT }, value: { data: Buffer.alloc(8), owner } }), getBlockTime: async () => bt };
  const a = new PriceSampler(conn, new PublicKey(POOL), path, ps(), () => 7n * X64, () => clock);
  const s1 = await a.tick();
  assert.deepEqual(s1, { v: 1, pool: POOL, slot: SLOT, t: T, sqrt_price: (7n * X64).toString(), session: a.session });
  assert.deepEqual(readSamples(path), [s1]);
  const b = new PriceSampler(conn, new PublicKey(POOL), path, ps(), () => 7n * X64, () => 0); assert.notEqual(b.session, a.session);
  bt = null; clock = 15_000; assert.equal(await a.tick(), null);
  bt = T; owner = new PublicKey(OTHER_POOL); clock = 30_000; assert.equal(await a.tick(), null);
  assert.equal(readSamples(path).length, 1);
  writeFileSync(path, readFileSync(path, 'utf8') + '{"v":1,"pool":"x"}\n');
  assert.throws(() => readSamples(path), refuses('refuse_twap_coverage'));
});

test('sampler: a torn last line (crash mid-write) is cut at sampler start and before each append; the keeper recovers and still waits for a full window; a malformed complete line still refuses and the 200-append cleanup survives it', async () => {
  const h = harness({ samples: full({ session: 'old' }) }); const path = samplesPath(h.cfg.state_dir);
  const torn = () => writeFileSync(path, readFileSync(path, 'utf8') + `{"v":1,"pool":"${POOL.slice(0, 12)}`);
  torn(); assert.throws(() => readSamples(path), refuses('refuse_twap_coverage'));
  assert.equal((await h.run()).r.status, 'refuse_twap_coverage');                        // torn file: the keeper refuses
  let bt: number | null = null; let clock = 0;
  const conn = { getAccountInfoAndContext: async () => ({ context: { slot: SLOT }, value: { data: Buffer.alloc(8), owner: CP_AMM_PROGRAM_ID } }), getBlockTime: async () => bt };
  const smp = new PriceSampler(conn, new PublicKey(POOL), path, ps(), () => X64, () => clock);   // restart
  assert.equal(await smp.tick(), null); assert.ok(smp.repaired > 0, 'cut at start, even when the first read records nothing');
  assert.equal(readSamples(path).length, 121);
  bt = T; clock = 15_000; const x = await smp.tick(); assert.equal(x!.session, smp.session);
  assert.equal(readSamples(path).length, 122);
  const r2 = await h.run();                                                              // recovered: now waiting for a full window from the new session
  assert.equal(r2.r.status, 'refuse_twap_coverage'); assert.match(r2.last.reason!, /more than one sampler session/);
  torn(); const before = smp.repaired; clock = 30_000; assert.ok(await smp.tick()); assert.ok(smp.repaired > before, 'cut before the append');
  assert.equal(readSamples(path).length, 123);
  assert.equal(repairTornTail(path), 0);
  // the every-200 cleanup: prunes to two windows on a clean file, and survives (leaves the file) on a malformed complete line
  writeFileSync(path, series(T - 5000, T - 15, { session: smp.session }).map(y => JSON.stringify(y)).join('\n') + '\n');
  (smp as any).appends = 199; clock = 45_000; assert.ok(await smp.tick());
  assert.ok(readSamples(path).every(y => y.t >= T - 3600)); assert.equal(readSamples(path).length, series(T - 5000, T - 15).filter(y => y.t >= T - 3600).length + 1);
  writeFileSync(path, readFileSync(path, 'utf8') + '{"bad":1}\n'); const len = readFileSync(path, 'utf8').length;
  (smp as any).appends = 199; clock = 60_000; assert.ok(await smp.tick());
  assert.ok(readFileSync(path, 'utf8').length > len, 'appended, not rewritten'); assert.throws(() => readSamples(path), refuses('refuse_twap_coverage'));
});

test('independent price: exact rational from the JSON numbers (0.21 USD / 200 USD per SOL at 6 decimals = 1.05 lamports per raw token)', async () => {
  assert.deepEqual(decRational(0.21), { n: 21n, d: 100n }); assert.deepEqual(decRational(1e-7), { n: 1n, d: 10_000_000n }); assert.deepEqual(decRational(2.5e21), { n: 25n * 10n ** 21n, d: 10n });
  const r = await fetchIndependent(jup({ usdMint: 0.21 }), ps(), MINT, 6, SLOT);
  assert.equal(r.n * 100n, r.d * 105n);
});

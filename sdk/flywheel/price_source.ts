// Ticket #5: price source for the flywheel buyback (post-graduation only, pinned DAMM v2 pool).
// - A read-only sampler records the pinned pool's sqrt_price with the slot and chain (block) time of each read, tagged
//   with the pool address and a sampler session id.
// - Before a swap is built, the keeper checks a time-weighted average (TWAP) of those samples, its fresh spot read and
//   an independent price (Jupiter Price API v3), and anchors min_out to the TWAP.
// Every failure refuses (fail closed). This module holds no keys and builds or sends no transactions.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, openSync, readSync, fstatSync, closeSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey, type Connection } from '@solana/web3.js';
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import { KeyRuleRefusal } from '../keyrules.js';
import { durableAppend, durableWrite } from './store.js';
import { redactSecrets } from '../redact.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const Q128 = 1n << 128n;
const BPS = 10_000n;

// ---------------------------------------------------------------- config (fails closed)
export interface PriceSourceConfig {
  sample_interval_s: number; twap_window_s: number; min_coverage_pct: number; max_sample_gap_s: number; max_latest_sample_age_s: number;
  max_spot_twap_dev_bps: number; max_indep_twap_dev_bps: number; indep_max_age_slots: number; require_independent: boolean;
  min_post_grad_age_s: number; indep_price_url: string; indep_timeout_ms: number;
}
export const PRICE_SOURCE_KEYS = ['sample_interval_s', 'twap_window_s', 'min_coverage_pct', 'max_sample_gap_s', 'max_latest_sample_age_s', 'max_spot_twap_dev_bps',
  'max_indep_twap_dev_bps', 'indep_max_age_slots', 'require_independent', 'min_post_grad_age_s', 'indep_price_url', 'indep_timeout_ms'] as const;
/** Ceiling for every *_bps limit (spec proposal). */
export const BPS_CEILING = 2_000;
export class PriceConfigRefusal extends KeyRuleRefusal { constructor(msg: string) { super(msg); this.name = 'PriceConfigRefusal'; } }

/** Validates `cfg.price_source` (and the existing *_bps limits). A missing section, a missing, unknown (e.g. misspelled)
 *  or out-of-range key, or a non-boolean `require_independent` refuses. Returns the validated section. */
export function checkPriceConfig(cfg: { price_source?: unknown; max_slippage_bps?: unknown; max_price_impact_bps?: unknown }): PriceSourceConfig {
  const no = (m: string): never => { throw new PriceConfigRefusal(`refusing: price_source config: ${m}`); };
  const p = cfg.price_source as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object' || Array.isArray(p)) no('the "price_source" section is missing');
  for (const k of Object.keys(p!)) if (!(PRICE_SOURCE_KEYS as readonly string[]).includes(k)) no(`unknown key "${k}" (allowed: ${PRICE_SOURCE_KEYS.join(', ')})`);
  for (const k of PRICE_SOURCE_KEYS) if (!(k in p!) || p![k] === null || p![k] === undefined) no(`"${k}" is missing`);
  const int = (v: unknown, k: string, lo: number, hi: number): number => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : no(`"${k}" must be an integer in [${lo}, ${hi}] (got ${JSON.stringify(v)})`));
  for (const k of ['max_slippage_bps', 'max_price_impact_bps'] as const) int(cfg[k], k, 0, BPS_CEILING);
  const sample_interval_s = int(p!.sample_interval_s, 'sample_interval_s', 1, 3_600);
  const twap_window_s = int(p!.twap_window_s, 'twap_window_s', 2 * sample_interval_s, 86_400);
  const r: PriceSourceConfig = {
    sample_interval_s, twap_window_s,
    min_coverage_pct: int(p!.min_coverage_pct, 'min_coverage_pct', 1, 100),
    max_sample_gap_s: int(p!.max_sample_gap_s, 'max_sample_gap_s', sample_interval_s, twap_window_s),
    max_latest_sample_age_s: int(p!.max_latest_sample_age_s, 'max_latest_sample_age_s', 1, twap_window_s),
    max_spot_twap_dev_bps: int(p!.max_spot_twap_dev_bps, 'max_spot_twap_dev_bps', 0, BPS_CEILING),
    max_indep_twap_dev_bps: int(p!.max_indep_twap_dev_bps, 'max_indep_twap_dev_bps', 0, BPS_CEILING),
    indep_max_age_slots: int(p!.indep_max_age_slots, 'indep_max_age_slots', 1, 100_000),
    require_independent: typeof p!.require_independent === 'boolean' ? p!.require_independent : no(`"require_independent" must be true or false (got ${JSON.stringify(p!.require_independent)})`),
    min_post_grad_age_s: int(p!.min_post_grad_age_s, 'min_post_grad_age_s', twap_window_s, 864_000),
    indep_price_url: '', indep_timeout_ms: int(p!.indep_timeout_ms, 'indep_timeout_ms', 100, 30_000),
  };
  const u = p!.indep_price_url;
  let url: URL | null = null; try { url = typeof u === 'string' ? new URL(u) : null; } catch { url = null; }
  const local = url && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (!url || !(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) no(`"indep_price_url" must be an https URL (http only for 127.0.0.1/localhost) without credentials, query or fragment (got ${JSON.stringify(u)})`);
  r.indep_price_url = u as string;
  return r;
}

// ---------------------------------------------------------------- refusals
export type PriceCode = 'hold_twap_warmup' | 'refuse_twap_coverage' | 'refuse_twap_stale' | 'refuse_spot_vs_twap' | 'refuse_indep_vs_twap' | 'refuse_indep_unavailable' | 'mismatch_pool' | 'mismatch_registry';
/** `warmup`: a warm-up hold (graduation younger than min_post_grad_age_s, or the window still refilling after a sampler
 *  restart). `noCount`: does not count toward auto-pause (a warm-up hold within the ceiling, see WARMUP_GRACE_S). */
export class PriceRefusal extends Error {
  constructor(public code: PriceCode, msg: string, public pause = false, public warmup = false, public noCount = false) { super(msg); this.name = 'PriceRefusal'; }
}
/** A warm-up hold counts toward auto-pause (and pauses) only once it has lasted longer than the TWAP window + 15 min,
 *  in chain time. A fixed rule, not a config key. */
export const WARMUP_GRACE_S = 900;
export const warmupCeilingS = (ps: PriceSourceConfig) => ps.twap_window_s + WARMUP_GRACE_S;
/** Optional API key for the independent price API, sent only as the x-api-key header. Unset or empty: keyless. */
export const INDEP_API_KEY_ENV = 'FW_JUPITER_API_KEY';
export function indepApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[INDEP_API_KEY_ENV];
  const k = typeof v === 'string' ? v.trim() : '';
  return k ? k : undefined;
}

// ---------------------------------------------------------------- samples
export interface PriceSample { v: 1; pool: string; slot: number; t: number; sqrt_price: string; session: string }
export const SAMPLES_FILE = 'price_samples.jsonl';
export const samplesPath = (stateDir: string) => join(stateDir, SAMPLES_FILE);

/** Persisted samples, oldest first. A missing file is an empty list; any malformed line refuses (refuse_twap_coverage). */
export function readSamples(path: string): PriceSample[] {
  if (!existsSync(path)) return [];
  let txt: string; try { txt = readFileSync(path, 'utf8'); } catch (e: any) { throw new PriceRefusal('refuse_twap_coverage', `price samples unreadable (${String(e?.message ?? e).slice(0, 120)})`); }
  const out: PriceSample[] = [];
  txt.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let s: any; try { s = JSON.parse(line); } catch { s = null; }
    const ok = s && s.v === 1 && typeof s.pool === 'string' && s.pool.length >= 32 && Number.isSafeInteger(s.slot) && s.slot >= 0 && Number.isSafeInteger(s.t) && s.t > 0
      && typeof s.sqrt_price === 'string' && /^[1-9]\d*$/.test(s.sqrt_price) && typeof s.session === 'string' && s.session !== '';
    if (!ok) throw new PriceRefusal('refuse_twap_coverage', `price sample line ${i + 1} is malformed`);
    out.push(s as PriceSample);
  });
  return out.sort((a, b) => a.slot - b.slot);
}

/** A crash mid-append can leave a torn last line (no trailing newline). Cuts the file back to its last complete line
 *  and returns the number of bytes removed (0 when the file is missing, empty or ends in a newline). Complete lines are
 *  never touched: a malformed complete line still refuses in readSamples. */
export function repairTornTail(path: string): number {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, 'r+');
  try {
    const size = fstatSync(fd).size; if (size === 0) return 0;
    const last = Buffer.alloc(1); readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0;
    const buf = readFileSync(path); const keep = buf.lastIndexOf(0x0a) + 1;   // 0 when no complete line
    truncateSync(path, keep);
    return size - keep;
  } finally { closeSync(fd); }
}

export interface SamplerConn {
  getAccountInfoAndContext(pk: PublicKey, commitment?: any): Promise<{ context: { slot: number }; value: { data: Buffer; owner: PublicKey } | null }>;
  getBlockTime(slot: number): Promise<number | null>;
}
/** sqrt_price of a DAMM v2 pool account (Q64.64), decoded with the cp-amm SDK's account coder. */
export function cpAmmSqrtDecoder(conn: Connection): (data: Buffer) => bigint {
  const cp: any = new CpAmm(conn);
  return (data: Buffer) => BigInt(cp._program.coder.accounts.decode('pool', data).sqrtPrice.toString());
}
/** Read-only sampler for the pinned pool. At most one RPC read per `sample_interval_s` (monotonic clock); each sample
 *  carries the read's context slot, that slot's block time (chain time), the pool address and this sampler's session id.
 *  A new sampler (a restart) is a new session, so the keeper refuses until this session alone covers a full window. */
export class PriceSampler {
  readonly session = randomBytes(8).toString('hex');
  private lastReadMs = -Infinity; private appends = 0;
  /** bytes of a torn tail removed (at the first tick, i.e. at start, and before every append) */
  repaired = 0;
  constructor(public conn: SamplerConn, public pool: PublicKey, public path: string, public ps: PriceSourceConfig,
    public decodeSqrt: (data: Buffer) => bigint, public clockMs: () => number = () => performance.now()) {}
  async tick(): Promise<PriceSample | null> {
    const now = this.clockMs();
    if (this.lastReadMs === -Infinity) this.repaired += repairTornTail(this.path);   // at start: recover from a crash mid-write
    if (now - this.lastReadMs < this.ps.sample_interval_s * 1000) return null;
    this.lastReadMs = now;
    const r = await this.conn.getAccountInfoAndContext(this.pool, 'confirmed');
    if (!r.value || !r.value.owner.equals(CP_AMM_PROGRAM_ID)) return null;   // not a DAMM v2 account: nothing recorded
    const t = await this.conn.getBlockTime(r.context.slot);
    if (t === null || !Number.isSafeInteger(t)) return null;                // no chain time: nothing recorded
    const sq = this.decodeSqrt(r.value.data);
    if (sq <= 0n) return null;
    const s: PriceSample = { v: 1, pool: this.pool.toBase58(), slot: r.context.slot, t, sqrt_price: sq.toString(), session: this.session };
    this.repaired += repairTornTail(this.path);   // a torn tail (crash mid-write) is cut first, so this line never fuses with it
    durableAppend(this.path, JSON.stringify(s));
    if (++this.appends % 200 === 0) {   // keep the file bounded: the last two windows
      let all: PriceSample[] | null = null;
      try { all = readSamples(this.path); } catch { all = null; }   // a malformed complete line: leave the file as is (the keeper keeps refusing)
      if (all) durableWrite(this.path, all.filter(x => x.t >= t - 2 * this.ps.twap_window_s).map(x => JSON.stringify(x)).join('\n') + '\n');
    }
    return s;
  }
}

// ---------------------------------------------------------------- TWAP
export interface TwapInput { ps: PriceSourceConfig; pool: string; nowT: number; grad: { slot: number; t: number }; samples: PriceSample[] }
export interface Twap { twapQ128: bigint; used: number; expected: number; coverage_pct: number; first_t: number; last_t: number; max_gap_s: number; session: string }

/** Time-weighted mean of the price (sqrt_price², Q128) over [nowT − window, nowT], chain time only. Refuses:
 *  hold_twap_warmup (graduation younger than min_post_grad_age_s), mismatch_pool (an in-window sample from another
 *  pool), refuse_twap_coverage (no samples, a sampler session younger than the window, more than one session in the
 *  window, coverage below min_coverage_pct), refuse_twap_stale (latest sample too old, or any gap above max_sample_gap_s,
 *  including from the window start to the first sample). Samples with slot < graduation slot never count. */
export function computeTwap(i: TwapInput): Twap {
  const { ps, nowT } = i; const W = ps.twap_window_s; const start = nowT - W;
  const gradAge = nowT - i.grad.t;
  if (gradAge < ps.min_post_grad_age_s) throw new PriceRefusal('hold_twap_warmup', `graduation seen ${gradAge}s ago (< min_post_grad_age_s ${ps.min_post_grad_age_s})`, false, true);
  const post = i.samples.filter(s => s.slot >= i.grad.slot);
  const win = post.filter(s => s.t >= start && s.t <= nowT);
  const foreign = win.find(s => s.pool !== i.pool);
  if (foreign) throw new PriceRefusal('mismatch_pool', `price sample at slot ${foreign.slot} was recorded for pool ${foreign.pool}, not the pinned pool ${i.pool}`, true);
  if (!win.length) throw new PriceRefusal('refuse_twap_coverage', `no price samples in the last ${W}s`);
  const session = win[win.length - 1].session;
  if (win.some(s => s.session !== session)) throw new PriceRefusal('refuse_twap_coverage', 'samples from more than one sampler session in the window (restart): waiting for a full window from one session', false, true);
  const firstOfSession = Math.min(...post.filter(s => s.session === session).map(s => s.t));
  if (nowT - firstOfSession < W) throw new PriceRefusal('refuse_twap_coverage', `sampler session started ${nowT - firstOfSession}s ago (< window ${W}s): window refilling`, false, true);
  const expected = Math.floor(W / ps.sample_interval_s);
  if (win.length * 100 < ps.min_coverage_pct * expected) throw new PriceRefusal('refuse_twap_coverage', `coverage ${win.length}/${expected} samples < ${ps.min_coverage_pct}%`);
  const last = win[win.length - 1];
  if (nowT - last.t > ps.max_latest_sample_age_s) throw new PriceRefusal('refuse_twap_stale', `latest price sample is ${nowT - last.t}s old (> ${ps.max_latest_sample_age_s}s)`);
  let maxGap = win[0].t - start;
  for (let k = 1; k < win.length; k++) maxGap = Math.max(maxGap, win[k].t - win[k - 1].t);
  if (maxGap > ps.max_sample_gap_s) throw new PriceRefusal('refuse_twap_stale', `gap of ${maxGap}s between price samples (> ${ps.max_sample_gap_s}s)`);
  let num = 0n, den = 0n;
  for (let k = 0; k < win.length; k++) {
    const dt = BigInt((k + 1 < win.length ? win[k + 1].t : nowT) - win[k].t);
    const sq = BigInt(win[k].sqrt_price); num += sq * sq * dt; den += dt;
  }
  if (den === 0n) throw new PriceRefusal('refuse_twap_coverage', 'price samples span no time');
  return { twapQ128: num / den, used: win.length, expected, coverage_pct: Math.floor((win.length * 100) / expected), first_t: win[0].t, last_t: last.t, max_gap_s: maxGap, session };
}

// ---------------------------------------------------------------- comparisons (exact integers)
/** |a − b| / b > maxBps / 10,000, exactly (a deviation of exactly maxBps passes). */
export function exceedsBps(a: bigint, b: bigint, maxBps: number): boolean {
  if (b <= 0n) return true;
  const d = a > b ? a - b : b - a;
  return d * BPS > BigInt(maxBps) * b;
}
export const devBps = (a: bigint, b: bigint): number => (b <= 0n ? Infinity : Number(((a > b ? a - b : b - a) * BPS) / b));
/** Spot vs TWAP (refusal 5). Both prices as Q128 raw lamports per raw token. */
export function checkSpotVsTwap(spotQ128: bigint, twapQ128: bigint, maxBps: number): void {
  if (exceedsBps(spotQ128, twapQ128, maxBps)) throw new PriceRefusal('refuse_spot_vs_twap', `spot is ${devBps(spotQ128, twapQ128)} bps from the TWAP (> ${maxBps})`);
}
/** Independent price (rational n/d, raw lamports per raw token) vs TWAP (Q128), exactly (refusal 6). */
export function checkIndepVsTwap(n: bigint, d: bigint, twapQ128: bigint, maxBps: number): void {
  const a = n * Q128, b = twapQ128 * d;
  if (exceedsBps(a, b, maxBps)) throw new PriceRefusal('refuse_indep_vs_twap', `independent price is ${devBps(a, b)} bps from the TWAP (> ${maxBps})`);
}

// ---------------------------------------------------------------- independent source (Jupiter Price API v3)
/** Exact rational of a JSON number, from its shortest decimal form. */
export function decRational(x: number): { n: bigint; d: bigint } {
  if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0) throw new Error(`not a positive number: ${String(x)}`);
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(x));
  if (!m) throw new Error(`unparseable number ${String(x)}`);
  const frac = m[2] ?? ''; let n = BigInt(m[1] + frac); let d = 10n ** BigInt(frac.length); const e = Number(m[3] ?? 0);
  if (e >= 0) n *= 10n ** BigInt(e); else d *= 10n ** BigInt(-e);
  return { n, d };
}
export type HttpGet = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export interface Indep { n: bigint; d: bigint; block_id_mint: number; block_id_wsol: number; usd_mint: number; usd_wsol: number }
/** One request for both ids. Price = usdPrice(mint) / usdPrice(wSOL) as raw lamports per raw token. Any HTTP error,
 *  timeout, 429, missing id, bad field or a blockId more than indep_max_age_slots behind `nowSlot` refuses
 *  (refuse_indep_unavailable). `apiKey` (optional) goes only in the x-api-key header, never in the URL; no header is
 *  sent without it. The response body of a non-200 is never read, and every refusal message is scrubbed of the key. */
export async function fetchIndependent(http: HttpGet, ps: PriceSourceConfig, mint: string, decimals: number, nowSlot: number, apiKey?: string): Promise<Indep> {
  const scrub = (m: string) => { const r = redactSecrets(m); return apiKey ? r.split(apiKey).join('<secret>') : r; };
  const no = (m: string): never => { throw new PriceRefusal('refuse_indep_unavailable', `independent price unavailable: ${scrub(m)}`); };
  let j: any;
  try {
    const url = `${ps.indep_price_url}?ids=${mint},${WSOL_MINT}`;
    const init: { signal: AbortSignal; headers?: Record<string, string> } = { signal: AbortSignal.timeout(ps.indep_timeout_ms) };
    if (apiKey) init.headers = { 'x-api-key': apiKey };
    const res = await http(url, init);
    if (!res.ok || res.status !== 200) no(`HTTP ${res.status}`);
    j = await res.json();
  } catch (e: any) {
    if (e instanceof PriceRefusal) throw e;
    // the error message and the cause's code (e.g. a TLS or socket error code) only: never the cause object or headers
    const code = typeof e?.cause?.code === 'string' && /^[A-Za-z0-9_.\-]{1,64}$/.test(e.cause.code) ? ` (cause: ${e.cause.code})` : '';
    no(scrub(String(e?.name === 'TimeoutError' ? 'timeout' : e?.message ?? e)).slice(0, 120) + scrub(code));   // scrub, then cut (a cut key is never left behind)
  }
  const entry = (id: string, dec: number) => {
    const x = j?.[id];
    if (!x || typeof x !== 'object') no(`${id} missing from the response`);
    if (typeof x.usdPrice !== 'number' || !Number.isFinite(x.usdPrice) || x.usdPrice <= 0) no(`${id} has no usable usdPrice`);
    if (!Number.isSafeInteger(x.blockId)) no(`${id} has no blockId`);
    if (x.decimals !== undefined && x.decimals !== dec) no(`${id} decimals ${x.decimals} != ${dec}`);
    if (nowSlot - x.blockId > ps.indep_max_age_slots) no(`${id} blockId ${x.blockId} is ${nowSlot - x.blockId} slots old (> ${ps.indep_max_age_slots})`);
    return x as { usdPrice: number; blockId: number };
  };
  const m = entry(mint, decimals), s = entry(WSOL_MINT, 9);
  let rm: { n: bigint; d: bigint }, rs: { n: bigint; d: bigint };
  try { rm = decRational(m.usdPrice); rs = decRational(s.usdPrice); } catch (e: any) { return no(String(e?.message ?? e)); }
  // lamports per raw token = (usdM / usdS) × 10^9 / 10^decimals
  return { n: rm.n * rs.d * 10n ** 9n, d: rm.d * rs.n * 10n ** BigInt(decimals), block_id_mint: m.blockId, block_id_wsol: s.blockId, usd_mint: m.usdPrice, usd_wsol: s.usdPrice };
}

// ---------------------------------------------------------------- min_out
/** min_out = min(quoteOut, twapOut(in)) × (10,000 − slippage − impact) / 10,000 (spec §3.7), where twapOut(in) =
 *  in / TWAP price. Both legs are reported (each × the same factor); the lower one is used. */
export function anchoredMinOut(inLamports: bigint, quoteOut: bigint, twapQ128: bigint, slippageBps: number, impactBps: number) {
  if (twapQ128 <= 0n) throw new PriceRefusal('refuse_twap_coverage', 'TWAP is 0');
  const twapOut = (inLamports * Q128) / twapQ128;
  const keep = BPS - BigInt(slippageBps) - BigInt(impactBps);   // > 0: checkPriceConfig caps each at 2,000 bps
  const fromQuote = (quoteOut * keep) / BPS, fromTwap = (twapOut * keep) / BPS;
  const source = quoteOut < twapOut ? 'quote' : 'twap';
  return { minOut: source === 'quote' ? fromQuote : fromTwap, fromQuote, fromTwap, twapOut, source };
}

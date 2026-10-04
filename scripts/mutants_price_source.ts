// Mutation check for ticket #5 (price source) and the keeper safety checks it touches. LOCAL, offline.
// Each mutant replaces one exact snippet in one source file, runs the keeper test files and must make at least one
// test fail ("killed"). The file is restored after every mutant (also on error or Ctrl-C); a dirty tree at the end fails.
// Usage: node --import tsx scripts/mutants_price_source.ts [name-filter]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TESTS = ['tests/price_source.test.ts', 'tests/flywheel.test.ts', 'tests/flywheel_dryrun.test.ts', 'tests/flywheel_no_dev_key.test.ts', 'tests/redact.test.ts', 'tests/registry.test.ts'];
const PS = 'sdk/flywheel/price_source.ts', K = 'sdk/flywheel/keeper.ts', R = 'sdk/redact.ts', REG = 'sdk/registry.ts';
type Mutant = { name: string; file: string; from: string; to: string };
const M: Mutant[] = [
  // spec §5 (the seven named mutants)
  { name: 'spec: spot used without the TWAP (spot-vs-TWAP check removed)', file: K, from: 'checkSpotVsTwap(spotQ128, tw.twapQ128, ps.max_spot_twap_dev_bps);', to: ';' },
  { name: 'spec: min_out from the quote only', file: PS, from: "minOut: source === 'quote' ? fromQuote : fromTwap", to: 'minOut: fromQuote' },
  { name: 'spec: a stale sample accepted (latest age)', file: PS, from: 'if (nowT - last.t > ps.max_latest_sample_age_s)', to: 'if (false)' },
  { name: 'spec: a stale sample accepted (gap)', file: PS, from: 'if (maxGap > ps.max_sample_gap_s)', to: 'if (false)' },
  { name: 'spec: a pre-graduation sample counted', file: PS, from: 'i.samples.filter(s => s.slot >= i.grad.slot)', to: 'i.samples.filter(s => true)' },
  { name: 'spec: a Jupiter error passes (require_independent ignored)', file: K, from: 'if (!(e instanceof PriceRefusal) || ps.require_independent) throw e;', to: 'if (!(e instanceof PriceRefusal)) throw e;' },
  { name: 'spec: a Jupiter error passes (non-200 accepted)', file: PS, from: "if (!res.ok || res.status !== 200) no(`HTTP ${res.status}`);", to: ';' },
  { name: 'spec: registry check dropped', file: K, from: 'regMint = assertRegistryPoolPair(loadRegistry(c.cluster, this.registryPath), tokA, tokB);', to: 'regMint = c.main_mint;' },
  { name: 'spec: window not reset at graduation (flip back)', file: K, from: "if (s.price_grad) { s.price_grad = null; run.warnings.push('graduation no longer reads as complete: price window reset'); }", to: ';' },
  { name: 'spec: window not reset at graduation (warm-up age ignored)', file: PS, from: 'if (gradAge < ps.min_post_grad_age_s)', to: 'if (false)' },
  // warm-up ceiling (window + 900 s, chain time, persisted)
  { name: 'ceiling: >= instead of > (just under counts)', file: K, from: 'const over = elapsed > ceiling;', to: 'const over = elapsed >= ceiling;' },
  { name: 'ceiling: one second late (just over not counted)', file: K, from: 'const over = elapsed > ceiling;', to: 'const over = elapsed > ceiling + 1;' },
  { name: 'ceiling: grace 899 s', file: PS, from: 'export const WARMUP_GRACE_S = 900;', to: 'export const WARMUP_GRACE_S = 899;' },
  { name: 'ceiling: grace 901 s', file: PS, from: 'export const WARMUP_GRACE_S = 900;', to: 'export const WARMUP_GRACE_S = 901;' },
  { name: 'ceiling: hold start overwritten each run (not kept across restarts)', file: K, from: 'if (!s.price_hold) { s.price_hold = { slot: nowSlot, t: holdNow, session: curSession }; this.save(s); }', to: 's.price_hold = { slot: nowSlot, t: holdNow, session: curSession }; this.save(s);' },
  { name: 'ceiling: hold restarts on a sampler restart (new session)', file: K, from: 'if (!s.price_hold) { s.price_hold = {', to: 'if (!s.price_hold || s.price_hold.session !== curSession) { s.price_hold = {' },
  { name: 'ceiling: hold start kept in memory only (lost on a keeper restart)', file: K, from: 'const hold = s.price_hold;', to: 'const hold = ((this as any)._hold ??= { ...s.price_hold!, slot: nowSlot, t: holdNow });' },
  { name: 'ceiling: holds always counted', file: K, from: 'if (!e.noCount) s.consecutive_failures++;', to: 's.consecutive_failures++;' },
  { name: 'ceiling: box clock instead of chain time', file: K, from: 'const nowT = await this.conn.getBlockTime(nowSlot);', to: 'const nowT = Math.floor(Date.now() / 1000);' },
  // TWAP inputs
  { name: 'twap: coverage < becomes <= (exactly 80% refused)', file: PS, from: 'if (win.length * 100 < ps.min_coverage_pct * expected)', to: 'if (win.length * 100 <= ps.min_coverage_pct * expected)' },
  { name: 'twap: restart refill skipped (session younger than window accepted)', file: PS, from: 'if (nowT - firstOfSession < W)', to: 'if (false)' },
  { name: 'twap: mixed sampler sessions accepted', file: PS, from: 'if (win.some(s => s.session !== session))', to: 'if (false)' },
  { name: 'twap: sample from another pool accepted', file: PS, from: 'const foreign = win.find(s => s.pool !== i.pool);', to: 'const foreign = undefined as PriceSample | undefined;' },
  { name: 'twap: mean of sqrt instead of sqrt²', file: PS, from: 'num += sq * sq * dt;', to: 'num += sq * (1n << 64n) * dt;' },
  // bps comparisons
  { name: 'bps: > becomes >= (exact limit refused)', file: PS, from: 'return d * BPS > BigInt(maxBps) * b;', to: 'return d * BPS >= BigInt(maxBps) * b;' },
  { name: 'bps: independent check removed', file: K, from: 'checkIndepVsTwap(ind.n, ind.d, tw.twapQ128, ps.max_indep_twap_dev_bps);', to: ';' },
  { name: 'bps: spot check uses the independent limit', file: K, from: 'checkSpotVsTwap(spotQ128, tw.twapQ128, ps.max_spot_twap_dev_bps);', to: 'checkSpotVsTwap(spotQ128, tw.twapQ128, ps.max_indep_twap_dev_bps);' },
  { name: 'bps: blockId age > becomes >=', file: PS, from: 'if (nowSlot - x.blockId > ps.indep_max_age_slots)', to: 'if (nowSlot - x.blockId >= ps.indep_max_age_slots)' },
  { name: 'bps: blockId age not checked', file: PS, from: 'if (nowSlot - x.blockId > ps.indep_max_age_slots)', to: 'if (false)' },
  { name: "main: existing quote-vs-spot check removed", file: K, from: 'if (spotDev > limit) throw', to: 'if (false) throw' },
  // pool / pair order
  { name: 'pair: (mint, wSOL) order not asserted', file: K, from: "if (String(tokA) !== c.main_mint || String(tokB) !== NATIVE_MINT.toBase58()) throw", to: 'if (false) throw' },
  { name: 'pair: registry pair accepts any second mint', file: REG, from: "const other = a === b ? null : a === WSOL_MINT_ADDRESS ? b : b === WSOL_MINT_ADDRESS ? a : null;", to: 'const other = a === WSOL_MINT_ADDRESS ? b : a;' },
  // config fails closed
  { name: 'config: bps ceiling 2,001', file: PS, from: 'export const BPS_CEILING = 2_000;', to: 'export const BPS_CEILING = 2_001;' },
  { name: 'config: unknown keys accepted', file: PS, from: "for (const k of Object.keys(p!)) if (!(PRICE_SOURCE_KEYS as readonly string[]).includes(k)) no(", to: 'for (const k of Object.keys(p!)) if (false) no(' },
  { name: 'config: missing keys accepted', file: PS, from: "for (const k of PRICE_SOURCE_KEYS) if (!(k in p!) || p![k] === null || p![k] === undefined) no(", to: 'for (const k of PRICE_SOURCE_KEYS) if (false) no(' },
  { name: 'config: require_independent coerced', file: PS, from: "require_independent: typeof p!.require_independent === 'boolean' ? p!.require_independent : no(", to: 'require_independent: !!p!.require_independent || no(' },
  { name: 'config: 0 s window accepted', file: PS, from: "int(p!.twap_window_s, 'twap_window_s', 2 * sample_interval_s, 86_400)", to: "int(p!.twap_window_s, 'twap_window_s', 0, 86_400)" },
  // API key and scrubbing
  { name: 'key: sent as Authorization instead of x-api-key', file: PS, from: "init.headers = { 'x-api-key': apiKey }", to: "init.headers = { authorization: apiKey }" },
  { name: 'key: also sent in the URL', file: PS, from: 'const url = `${ps.indep_price_url}?ids=${mint},${WSOL_MINT}`;', to: "const url = `${ps.indep_price_url}?ids=${mint},${WSOL_MINT}` + (apiKey ? `&apikey=${apiKey}` : '');" },
  { name: 'scrub: refusal messages not scrubbed of the key', file: PS, from: "const scrub = (m: string) => { const r = redactSecrets(m); return apiKey ? r.split(apiKey).join('<secret>') : r; };", to: 'const scrub = (m: string) => m;' },
  { name: 'scrub: run.reason not redacted', file: K, from: 'run.reason = redactSecrets(e.message); run.finished_at', to: 'run.reason = e.message; run.finished_at' },
  { name: 'scrub: user:pass@ kept', file: R, from: "return s.replace(URL_USERINFO, '$1<secret>@')", to: 'return s' },
  { name: 'scrub: ?apikey= kept', file: R, from: ".replace(SECRET_PARAM, '$1$2=<secret>');", to: ';' },
  { name: 'scrub: whole cause logged instead of cause.code', file: PS, from: '` (cause: ${e.cause.code})`', to: '` (cause: ${JSON.stringify(e.cause)})`' },
  // samples file
  { name: 'torn tail: not cut at sampler start', file: PS, from: 'if (this.lastReadMs === -Infinity) this.repaired += repairTornTail(this.path);', to: ';' },
  { name: 'torn tail: not cut before append', file: PS, from: 'this.repaired += repairTornTail(this.path);   // a torn tail', to: '// a torn tail' },
  { name: 'samples: malformed line skipped instead of refused', file: PS, from: "if (!ok) throw new PriceRefusal('refuse_twap_coverage', `price sample line ${i + 1} is malformed`);", to: 'if (!ok) return;' },
];

const filter = process.argv[2];
const files = new Map<string, string>();
const restoreAll = () => { for (const [f, src] of files) writeFileSync(f, src); };
process.on('SIGINT', () => { restoreAll(); process.exit(130); });
const run = () => spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=60000', ...TESTS], { encoding: 'utf8', maxBuffer: 64 << 20 });

const base = run();
if (base.status !== 0) { console.error('baseline FAILED: fix the tests first'); process.exit(1); }
let killed = 0, survived = 0, broken = 0;
for (const m of M.filter(x => !filter || x.name.includes(filter))) {
  const src = files.get(m.file) ?? readFileSync(m.file, 'utf8'); files.set(m.file, src);
  const n = src.split(m.from).length - 1;
  if (n !== 1) { console.log(`BROKEN    ${m.name} (snippet found ${n}x in ${m.file})`); broken++; continue; }
  try {
    writeFileSync(m.file, src.replace(m.from, m.to));
    const r = run();
    const fails = /^# fail (\d+)/m.exec(r.stdout)?.[1] ?? '?';
    if (r.status !== 0) { killed++; console.log(`KILLED    ${m.name} (${fails} failing)`); }
    else { survived++; console.log(`SURVIVED  ${m.name}`); }
  } finally { writeFileSync(m.file, src); }
}
restoreAll();
const changed = [...files].filter(([f, src]) => readFileSync(f, 'utf8') !== src).map(([f]) => f);
console.log(`\nmutants: ${killed} killed, ${survived} survived, ${broken} broken (of ${killed + survived + broken})`);
if (changed.length) { console.log(`NOT RESTORED: ${changed.join(', ')}`); process.exit(2); }
process.exit(survived || broken ? 1 : 0);

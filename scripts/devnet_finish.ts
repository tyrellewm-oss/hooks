// Resume a `dbc_flow.ts demo` run after the ramp (used when the public RPC dropped the demo mid-wait):
// after-ramp buy -> fill the curve (graduation) -> migrate to DAMM v2 -> status.
//   pnpm tsx scripts/devnet_finish.ts <mint> <dbcPool> [--cluster devnet] [--threshold 1]
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { writeFileSync } from 'node:fs';
import { resolveCluster, parseClusterArg, nowIct } from '../sdk/cluster.js';
import { loadOrCreate, deployerName } from '../sdk/keys.js';
import { Launchpad, type TxRecord } from '../sdk/launch.js';

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SUPPLY = 1_000_000_000n * 1_000_000n;
const pct = (p: number) => (SUPPLY * BigInt(Math.round(p * 100))) / 10_000n;
async function retry<T>(f: () => Promise<T>, n = 8): Promise<T> {
  for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= n) throw e; await new Promise(r => setTimeout(r, 3000 * (i + 1))); } }
}

(async () => {
  const c = await resolveCluster(parseClusterArg(argv));
  const lp = new Launchpad(c);
  const mint = new PublicKey(argv[0]), pool = new PublicKey(argv[1]);
  const deployer = loadOrCreate(c.name, deployerName(c.name));
  const A = loadOrCreate(c.name, 'buyerA'), B = loadOrCreate(c.name, 'buyerB');
  const threshold = Number(arg('--threshold', '1'));
  const st0 = await retry(() => lp.status(mint, A.publicKey));
  const L = BigInt(st0.launchSlot), U = BigInt(st0.uncappedAfter ?? '4500');
  const slot = BigInt(await retry(() => c.connection.getSlot('confirmed')));
  console.log(`slot ${slot}, launch ${L}, uncapped from ${L + U}: ${slot >= L + U ? 'ramp over' : 'STILL CAPPED'}`);
  if (slot < L + U) process.exit(2);
  const results: Record<string, TxRecord> = {};
  results.afterRamp = await retry(() => lp.swap(A, pool, 'buy', pct(3), 'AC-17(4) after the ramp (no cap): A buys +3%'), 2);
  const st1 = await retry(() => lp.status(mint, A.publicKey));
  results.fill = await retry(() => lp.buyExactIn(B, pool, BigInt(Math.round(threshold * 1.25 * LAMPORTS_PER_SOL)), 'AC-17(5) graduation: B buys enough SOL to complete the curve'), 1);
  const st2 = await retry(() => lp.status(mint, B.publicKey));
  if (st2.transferHookProgram === null) results.migrate = await lp.migrate(deployer, pool);
  else console.log('hook still set after fill; not migrating', st2.transferHookProgram);
  const st3 = await retry(() => lp.status(mint));
  const out = { cluster: c.label, time: nowIct(), resumed: { mint: mint.toBase58(), pool: pool.toBase58() }, // nested: listLaunches() reads top-level `mint` as a launch record
    statusAfterRamp: st1, statusAfterFill: st2, statusAfterMigration: st3,
    results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { purpose: v.purpose, ok: v.ok, hookError: v.hookError, link: v.link, sig: v.sig, err: v.err }])) };
  writeFileSync(`launches/${c.name}/${mint.toBase58()}.finish.json`, JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(JSON.stringify(out.results, null, 1)); console.log(`hook after migration: ${st3.transferHookProgram}`);
})().catch(e => { console.error(e); process.exit(1); });

// End-to-end DBC transfer-hook flow. Default cluster: LOCAL. DEVNET only with an explicit `--cluster devnet`.
//   pnpm tsx scripts/dbc_flow.ts demo [--cluster local|devnet] [--threshold 1]
//   pnpm tsx scripts/dbc_flow.ts lift-demo [--cluster ...]
//   pnpm tsx scripts/dbc_flow.ts status <mint> [--cluster ...]
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { writeFileSync } from 'node:fs';
import { resolveCluster, parseClusterArg, explorerAddr, nowIct, type Cluster } from '../sdk/cluster.js';
import { loadOrCreate, deployerName } from '../sdk/keys.js';
import { Launchpad, sendTx, type TxRecord } from '../sdk/launch.js';
import { resolveSchedule, scheduleFlag, type NamedSchedule } from '../sdk/schedules.js';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SUPPLY = 1_000_000_000n * 1_000_000n;
const pct = (p: number) => (SUPPLY * BigInt(Math.round(p * 100))) / 10_000n;
// Schedule: DEVNET default = Balanced ("approved by King (Oct 4, 2026)");
// LOCAL default = fast demo schedule. Override with --schedule strict|balanced|loose|demo and/or --uncapped SLOTS.
let SCHED: NamedSchedule;
try { SCHED = resolveSchedule(scheduleFlag(argv), parseClusterArg(argv)); } // QA L-16: typos exit non-zero, before any network use
catch (e: any) { console.error(`error: ${e.message}`); process.exit(2); }
const STEPS = SCHED.steps;
const UNCAPPED = BigInt(arg('--uncapped', SCHED.uncappedAfter.toString())!);
console.log(`schedule: ${SCHED.name} (${SCHED.label}): ${STEPS.map(s => `${s.maxBps / 100}% from +${s.slotOffset}`).join(', ')}, no cap from +${UNCAPPED} slots`);

async function fund(c: Cluster, from: Keypair, to: PublicKey, sol: number) {
  const bal = await c.connection.getBalance(to);
  if (bal >= sol * LAMPORTS_PER_SOL * 0.9) return;
  if (c.name === 'local') { const s = await c.connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL); await c.connection.confirmTransaction(s, 'confirmed'); return; }
  await sendTx(c, new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL - bal) })), [from], `fund test wallet ${to.toBase58().slice(0, 6)} with devnet SOL`);
}
async function waitSlot(c: Cluster, target: bigint) {
  for (;;) { const s = BigInt(await c.connection.getSlot('confirmed')); if (s >= target) return s; process.stdout.write(`\r  waiting for slot ${target} (now ${s})   `); await new Promise(r => setTimeout(r, 2000)); }
}
async function feeTotal(lp: Launchpad, pool: PublicKey) {
  const p: any = ((await lp.dbc.state.getPool(pool)) as any).poolState;
  return BigInt(p.partnerQuoteFee.toString()) + BigInt(p.protocolQuoteFee.toString()) + BigInt((p.creatorQuoteFee ?? 0).toString());
}

async function demo(c: Cluster) {
  const lp = new Launchpad(c);
  const deployer = loadOrCreate(c.name, deployerName(c.name));
  if (c.name === 'local') await fund(c, deployer, deployer.publicKey, 50);
  const A = loadOrCreate(c.name, 'buyerA'), B = loadOrCreate(c.name, 'buyerB');
  const walletSol = Number(arg('--wallet-sol', c.name === 'devnet' ? '0.6' : '5'));
  await fund(c, deployer, A.publicKey, walletSol); await fund(c, deployer, B.publicKey, walletSol + Number(arg('--threshold', '1')) * 1.3);
  const g = await lp.ensureGlobal(deployer, deployer.publicKey);
  console.log(`[${c.label}] hook ${lp.hook.programId.toBase58()} lift authority ${g.authority.toBase58()} (throwaway test key)`);
  const threshold = Number(arg('--threshold', '1'));
  const rec = await lp.launch(deployer, { name: 'Trenches Devnet Test', symbol: 'TDT', steps: STEPS, uncappedAfter: UNCAPPED, migrationQuoteThresholdSol: threshold });
  const pool = new PublicKey(rec.pool), mint = new PublicKey(rec.mint);
  const st0 = await lp.status(mint);
  console.log(JSON.stringify(st0, null, 1));
  const L = BigInt(st0.launchSlot);
  const results: Record<string, TxRecord> = {};
  const f0 = await feeTotal(lp, pool);
  results.buyUnderCap = await lp.swap(A, pool, 'buy', pct(0.5), 'AC-17(1) buy under cap: A buys 0.5% of supply (cap 1%)');
  const f1 = await feeTotal(lp, pool);
  results.capHit = await lp.swap(A, pool, 'buy', pct(0.6), 'AC-17(3) cap-hit: A buys +0.6% (would hold 1.1% > 1% cap) - EXPECTED FAIL');
  results.sell1 = await lp.swap(A, pool, 'sell', pct(0.2), 'AC-17(2)/AC-7 sell mid-ramp #1: A sells 0.2% into the curve');
  results.buyB = await lp.swap(B, pool, 'buy', pct(0.9), 'buy under cap: B buys 0.9%');
  results.sell2 = await lp.swap(B, pool, 'sell', pct(0.45), 'AC-7 sell mid-ramp #2: B sells 0.45%');
  results.sell3 = await lp.swap(B, pool, 'sell', await lp.tokenBalance(mint, B.publicKey), 'AC-7 sell mid-ramp #3: B sells all');
  console.log(`  [${c.label}] status after first-step trades:`, JSON.stringify(await lp.status(mint, A.publicKey)));
  await waitSlot(c, L + 150n); console.log();
  results.capRose = await lp.swap(A, pool, 'buy', pct(0.8), 'cap rose to 2% at launch+150 slots: A buys +0.8% (holds 1.1%)');
  results.capHit2 = await lp.swap(A, pool, 'buy', pct(1.0), 'cap-hit at 2% step: A buys +1.0% (would hold 2.1%) - EXPECTED FAIL');
  const f2 = await feeTotal(lp, pool);
  await waitSlot(c, L + UNCAPPED); console.log();
  const f3a = await feeTotal(lp, pool);
  results.afterRamp = await lp.swap(A, pool, 'buy', pct(3), 'AC-17(4) after the ramp (no cap): A buys +3% (holds 4.1%)');
  const f3 = await feeTotal(lp, pool);
  const st1 = await lp.status(mint, A.publicKey);
  // Fill the curve -> completion revokes the hook (DBC revoke_transfer_hook) -> migrate to DAMM v2.
  results.fill = await lp.buyExactIn(B, pool, BigInt(Math.round(threshold * 1.25 * LAMPORTS_PER_SOL)), 'AC-17(5) graduation: B buys enough SOL to complete the curve');
  const st2 = await lp.status(mint, B.publicKey);
  let migrate: TxRecord | undefined;
  if (st2.transferHookProgram === null) {
    // DBC's pool authority PDA pays DAMM v2 pool rent during migration. A fresh LOCAL validator has it at 0 SOL
    // (on devnet/mainnet it holds a balance), so top it up LOCALLY only.
    if (c.name === 'local') await fund(c, deployer, new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'), 1);
    migrate = await lp.migrate(deployer, pool);
  }
  const st3 = await lp.status(mint);
  // post-graduation transfer works without hook accounts
  const summary = {
    cluster: c.label, time: nowIct(), programId: lp.hook.programId.toBase58(), launch: rec,
    explorer: { mint: explorerAddr(rec.mint, c.name), pool: explorerAddr(rec.pool, c.name), program: explorerAddr(rec.programId, c.name) },
    statusAtLaunch: st0, statusAfterRamp: st1, statusAfterFill: st2, statusAfterMigration: st3,
    feeCheck: { note: 'quote fees accrued in pool (partner+protocol+creator) per buy, lamports', earlyBuyFee: (f1 - f0).toString(), earlyWindowTotal: (f2 - f0).toString(), lateBuyFee: (f3 - f3a).toString() },
    results: Object.fromEntries(Object.entries({ ...results, ...(migrate ? { migrate } : {}) }).map(([k, v]) => [k, { purpose: v.purpose, ok: v.ok, hookError: v.hookError, link: v.link, sig: v.sig, capHit: v.capHit, err: v.err }])),
  };
  writeFileSync(`launches/${c.name}/${rec.mint}.demo.json`, JSON.stringify(summary, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`\nsummary -> launches/${c.name}/${rec.mint}.demo.json`);
}

async function liftDemo(c: Cluster) {
  const lp = new Launchpad(c);
  const deployer = loadOrCreate(c.name, deployerName(c.name));
  if (c.name === 'local') await fund(c, deployer, deployer.publicKey, 20);
  await lp.ensureGlobal(deployer, deployer.publicKey);
  const rec = await lp.launch(deployer, { name: 'Trenches Lift Test', symbol: 'TLT', steps: STEPS, uncappedAfter: UNCAPPED, migrationQuoteThresholdSol: Number(arg('--threshold', '1')) });
  const mint = new PublicKey(rec.mint);
  const r1 = await sendTx(c, new Transaction().add(lp.hook.raiseMintCap(deployer.publicKey, mint, 300)), [deployer], 'AC-11/12 lift-only switch: raise TLT cap floor to 3% (event)');
  const r2 = await sendTx(c, new Transaction().add(lp.hook.raiseMintCap(deployer.publicKey, mint, 200)), [deployer], 'AC-11 lift-only switch: try to LOWER floor to 2% - EXPECTED FAIL ConfigFrozen');
  const r3 = await sendTx(c, new Transaction().add(lp.hook.liftMintCap(deployer.publicKey, mint)), [deployer], 'AC-11/12 lift-only switch: lift TLT cap entirely (event)');
  const r4 = await sendTx(c, new Transaction().add(lp.hook.raiseMintCap(deployer.publicKey, mint, 500)), [deployer], 'AC-11 lift-only switch: try to re-enable a cap after lift - EXPECTED FAIL ConfigFrozen');
  const st = await lp.status(mint);
  const out = { cluster: c.label, time: nowIct(), launch: rec, status: st, results: [r1, r2, r3, r4].map(r => ({ purpose: r.purpose, ok: r.ok, hookError: r.hookError, link: r.link, events: r.events })) };
  writeFileSync(`launches/${c.name}/${rec.mint}.lift.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.results, null, 1));
}

(async () => {
  const c = await resolveCluster(parseClusterArg(argv));
  console.log(`cluster: ${c.label} ${c.url}`);
  if (cmd === 'demo') await demo(c);
  else if (cmd === 'lift-demo') await liftDemo(c);
  else if (cmd === 'status') console.log(JSON.stringify(await new Launchpad(c).status(new PublicKey(argv[1])), null, 2));
  else console.log('usage: tsx scripts/dbc_flow.ts demo|lift-demo|status <mint> [--cluster local|devnet] [--threshold SOL] [--schedule strict|balanced|loose|demo] [--uncapped SLOTS]  (default: devnet=balanced "approved by King (Oct 4, 2026)", local=demo)');
})().catch(e => { console.error(e); process.exit(1); });

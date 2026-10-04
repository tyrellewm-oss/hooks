// QA check: which schedule is ACTIVE on-chain for a mint, and is the deployed program the release (test-slots OFF) build?
//   node --import tsx scripts/qa_schedule.ts <mint> [--cluster local|devnet]
// Read-only: reads accounts and SIMULATES view_schedule (no signature, no fee, nothing sent).
import { PublicKey, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolveCluster, parseClusterArg } from '../sdk/cluster.js';
import { HookClient, BPF_UPGRADEABLE, decodeMintConfig, decodeLift, parseProgramDataAuthority } from '../sdk/hook.js';

const argv = process.argv.slice(2);
const mintArg = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--cluster');
const c = await resolveCluster(parseClusterArg(argv));
const hook = new HookClient();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
console.log(`[${c.label}] ${c.url}  program ${hook.programId.toBase58()}`);

// 1) Deployed bytecode vs local builds
const [pd] = PublicKey.findProgramAddressSync([hook.programId.toBuffer()], BPF_UPGRADEABLE);
const pdAcc = await c.connection.getAccountInfo(pd);
if (!pdAcc) { console.log('program not deployed on this cluster'); process.exit(2); }
const pdAuth = (() => { try { return parseProgramDataAuthority(pdAcc); } catch (e: any) { return { upgradeAuthority: `unreadable (${e.message})`, immutable: false }; } })();
const upgradeAuth = pdAuth.immutable ? 'none (immutable)' : pdAuth.upgradeAuthority;
console.log(`upgrade authority: ${upgradeAuth}`);
const deployed = pdAcc.data.subarray(45);
for (const [label, path] of [['release (test-slots OFF)', 'target/deploy/trenches_hook.so'], ['test-slots (LOCAL only)', 'target/deploy-test-slots/trenches_hook.so']] as const) {
  if (!existsSync(path)) continue;
  const so = readFileSync(path);
  const match = sha(deployed.subarray(0, so.length)) === sha(so) && deployed.subarray(so.length).every(x => x === 0);
  console.log(`deployed bytes == ${label} build (${sha(so).slice(0, 16)}…): ${match ? 'YES' : 'no'}`);
}
if (!mintArg) { console.log('(pass a mint to read its frozen schedule)'); process.exit(0); }

// 2) Frozen schedule from the config PDA
const mint = new PublicKey(mintArg);
const cfgAcc = await c.connection.getAccountInfo(hook.configPda(mint));
if (!cfgAcc) { console.log('no config PDA for this mint'); process.exit(2); }
const cfg = decodeMintConfig(cfgAcc.data);
const lift = decodeLift((await c.connection.getAccountInfo(hook.liftPda(mint)))!.data);
console.log(`config PDA ${hook.configPda(mint).toBase58()}`);
console.log(`  launch_slot=${cfg.launchSlot} supply_ref=${cfg.supplyRef} uncapped_after=+${cfg.uncappedAfter} test_slots_build=${cfg.testSlotsBuild}`);
for (const s of cfg.steps) console.log(`  step offset=+${s.slotOffset} slots (~${(Number(s.slotOffset) * 0.4).toFixed(0)} s est.) max=${s.maxBps / 100}% of supply`);
console.log(`  lift state: lifted=${lift.lifted} raised_minimum_bps=${lift.raisedFloorBps}`);

// 3) Simulate view_schedule (program's own log + return data)
const msg = new TransactionMessage({ payerKey: cfg.launcher, recentBlockhash: (await c.connection.getLatestBlockhash()).blockhash, instructions: [hook.viewSchedule(mint)] }).compileToV0Message();
const sim = await c.connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
console.log('view_schedule (simulated) logs:');
for (const l of sim.value.logs ?? []) if (l.startsWith('Program log:')) console.log('  ' + l.slice(13));

// 4) Verdict
const gaps = cfg.steps.map((s, i) => (i ? s.slotOffset - cfg.steps[i - 1].slotOffset : s.slotOffset)).slice(1).concat(cfg.uncappedAfter - cfg.steps[cfg.steps.length - 1].slotOffset);
const real = !cfg.testSlotsBuild && gaps.every(g => g >= 10n) && cfg.uncappedAfter >= 150n;
console.log(`VERDICT: ${real ? 'REAL slot offsets (release build, steps >= 10 slots, ramp >= 150 slots)' : 'NOT the release schedule (test-slots build or short offsets)'}`);
process.exit(real ? 0 : 1);

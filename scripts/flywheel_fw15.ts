// FW-15 setup (DEVNET ONLY): fresh launch left UNFILLED (isMigrated = 0) + one small curve buy so the DBC partner fee > min_claim,
// then writes keeper/devnet.fw15.json (separate treasury/dev throwaways so the TDT keeper's reconciliation stays exact).
//   tsx scripts/flywheel_fw15.ts [--max-lamports 30000000]
import { PublicKey, Transaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveCluster } from '../sdk/cluster.js';
import { loadOrCreate } from '../sdk/keys.js';
import { Launchpad, sendTx } from '../sdk/launch.js';
import { resolveSchedule } from '../sdk/schedules.js';

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
(async () => {
  const c = await resolveCluster('devnet');   // genesis-checked
  const lp = new Launchpad(c);
  const deployer = loadOrCreate('devnet', 'deployer'), A = loadOrCreate('devnet', 'buyerA'), G = loadOrCreate('devnet', 'fw_gas');
  const T = loadOrCreate('devnet', 'fw15_treasury'), D = loadOrCreate('devnet', 'fw15_dev');
  const sched = resolveSchedule(undefined, 'devnet');
  const rec = await lp.launch(deployer, { name: 'Flywheel FW15 Test', symbol: 'FW15', steps: sched.steps, uncappedAfter: sched.uncappedAfter, migrationQuoteThresholdSol: 1 });
  console.log(JSON.stringify({ mint: rec.mint, pool: rec.pool, config: rec.config }));
  // buy 0.5% of supply (under the 1% opening cap), max 0.03 SOL in; anti-sniper fee phase → partner fee > min_claim; curve stays unfilled
  const tokens = (1_000_000_000n * 1_000_000n * 50n) / 10_000n;
  const r = await lp.swap(A, new PublicKey(rec.pool), 'buy', tokens, 'FW-15: small curve buy (0.5% of supply, under cap); curve stays unfilled', BigInt(arg('--max-lamports', '30000000')!));
  if (!r.ok) throw new Error('buy failed ' + r.err);
  // treasury/dev token accounts for the FW-15 keeper (gas pays rent)
  const mint = new PublicKey(rec.mint);
  const tx = new Transaction();
  for (const [m, o, p] of [[NATIVE_MINT, T.publicKey, TOKEN_PROGRAM_ID], [NATIVE_MINT, D.publicKey, TOKEN_PROGRAM_ID], [mint, T.publicKey, TOKEN_2022_PROGRAM_ID]] as const)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(G.publicKey, getAssociatedTokenAddressSync(m, o, false, p), o, m, p));
  const r2 = await sendTx(c, tx, [G], 'FW-15: create fw15 treasury/dev token accounts (gas pays rent)');
  if (!r2.ok) throw new Error('ata failed');
  const base = JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8'));
  const cfg = { ...base, name: 'devnet-fw15', main_mint: rec.mint, main_dbc_pool: rec.pool, route_pool: null,
    sources: [{ kind: 'dbc', pool: rec.pool, config: rec.config, base_mint: rec.mint }],
    keys: { ...base.keys, treasury: 'fw15_treasury', dev: 'fw15_dev' },
    pinned_pubkeys: { ...base.pinned_pubkeys, treasury: T.publicKey.toBase58(), dev: D.publicKey.toBase58() },
    state_dir: '.flywheel/devnet-fw15', public_log: 'flywheel/devnet-fw15.json' };
  writeFileSync('keeper/devnet.fw15.json', JSON.stringify(cfg, null, 2) + '\n');
  console.log(JSON.stringify({ launch: rec.txs, buy: r.sig, atas: r2.sig, config: 'keeper/devnet.fw15.json' }));
})().catch(e => { console.error(`ERROR: ${e?.message ?? e}`); process.exit(1); });

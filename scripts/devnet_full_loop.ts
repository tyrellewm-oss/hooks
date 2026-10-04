// DEVNET ONLY: one full loop with tickets #5, 8.3 and 8.3b together. Keys come from DEVNET_KEY_DIR (outside the repo).
//   DEVNET_KEY_DIR=~/.devnet-keys node --import tsx scripts/devnet_full_loop.ts launch [--threshold 0.2]
//   DEVNET_KEY_DIR=~/.devnet-keys node --import tsx scripts/devnet_full_loop.ts keeper-config <mint> <dbcPool> <dbcConfig>
// `launch`: a separate creator key pays and is DBC partner / pool creator / fee claimer; the hook config is signed by the
// separate launch key (8.3). The Global admin (deployer) only funds the test wallets and never signs a launch tx.
// Then trades on the curve (cap hit expected), the cap rises, the curve fills (graduation) and the pool migrates to DAMM v2.
// `keeper-config`: writes keeper/devnet.loop.json for the keeper (sources, route pool, position, pinned keys, price source).
// Every tx goes through sendTx (explorer link + tx log). Prints a JSON record; nothing secret is printed.
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolveCluster, type Cluster } from '../sdk/cluster.js';
import { loadOrCreate, deployerName } from '../sdk/keys.js';
import { Launchpad, sendTx, postMigrationDammConfig, type TxRecord } from '../sdk/launch.js';
import { LOCAL_DEMO } from '../sdk/schedules.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SUPPLY = 1_000_000_000n * 1_000_000n;
const pct = (p: number) => (SUPPLY * BigInt(Math.round(p * 100))) / 10_000n;
const ser = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);

async function fund(c: Cluster, from: ReturnType<typeof loadOrCreate>, to: PublicKey, sol: number, txs: Record<string, TxRecord>, label: string) {
  const bal = await c.connection.getBalance(to, 'confirmed');
  const want = Math.round(sol * LAMPORTS_PER_SOL);
  if (bal >= want * 0.9) return;
  txs[label] = await sendTx(c, new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: want - bal })), [from], `loop: fund ${label} ${to.toBase58().slice(0, 6)} with ${sol} devnet SOL (admin funds only)`);
  if (!txs[label].ok) throw new Error(`fund ${label} failed: ${txs[label].err}`);
}
async function waitSlot(c: Cluster, target: bigint) {
  for (;;) { const s = BigInt(await c.connection.getSlot('confirmed')); if (s >= target) return s; await new Promise(r => setTimeout(r, 2000)); }
}
const rec = (r: TxRecord) => ({ purpose: r.purpose, ok: r.ok, sig: r.sig, hookError: r.hookError ?? null, err: r.err ?? null, link: r.link });

async function launch(c: Cluster) {
  const lp = new Launchpad(c);
  const admin = loadOrCreate('devnet', deployerName('devnet'));        // must already exist (never created)
  const launchKey = loadOrCreate('devnet', 'launch');
  const creator = loadOrCreate('devnet', 'loop_creator');
  const A = loadOrCreate('devnet', 'loop_buyerA'), B = loadOrCreate('devnet', 'loop_buyerB');
  const distinct = new Set([admin, launchKey, creator, A, B].map(k => k.publicKey.toBase58()));
  if (distinct.size !== 5) throw new Error('refusing: loop keys must all be distinct');
  const threshold = Number(arg('--threshold', '0.2'));
  const txs: Record<string, TxRecord> = {};
  await fund(c, admin, creator.publicKey, 0.6, txs, 'fundCreator');
  await fund(c, admin, launchKey.publicKey, 0.02, txs, 'fundLaunchKey');
  await fund(c, admin, A.publicKey, 0.4, txs, 'fundBuyerA');
  await fund(c, admin, B.publicKey, threshold * 1.6 + 0.2, txs, 'fundBuyerB');
  const g = await lp.ensureLaunchAuthority(admin, launchKey.publicKey);   // already migrated: read-only check, no tx
  if (!g.launchAuthority?.equals(launchKey.publicKey)) throw new Error('refusing: on-chain launch authority is not the loop launch key');
  const r = await lp.launch(creator, { name: 'Hooks Devnet Loop', symbol: 'HLOOP', steps: LOCAL_DEMO.steps, uncappedAfter: LOCAL_DEMO.uncappedAfter, migrationQuoteThresholdSol: threshold }, launchKey);
  const pool = new PublicKey(r.pool), mint = new PublicKey(r.mint);
  const st0 = await lp.status(mint);
  if (st0.launcher !== launchKey.publicKey.toBase58()) throw new Error(`MintConfig.launcher ${st0.launcher} != launch key`);
  const L = BigInt(st0.launchSlot);
  txs.buyUnderCap = await lp.swap(A, pool, 'buy', pct(0.5), 'loop: A buys 0.5% (under the 1% cap)');
  txs.capHit = await lp.swap(A, pool, 'buy', pct(0.6), 'loop: A buys +0.6% (would hold 1.1% > 1% cap) - EXPECTED FAIL WalletCapExceeded');
  txs.sellMidRamp = await lp.swap(A, pool, 'sell', pct(0.2), 'loop: A sells 0.2% into the curve (sells never blocked)');
  txs.buyB = await lp.swap(B, pool, 'buy', pct(0.9), 'loop: B buys 0.9% (under cap)');
  await waitSlot(c, L + 150n);
  txs.capRose = await lp.swap(A, pool, 'buy', pct(0.8), 'loop: cap rose to 2% at +150 slots: A buys +0.8%');
  await waitSlot(c, L + LOCAL_DEMO.uncappedAfter);
  txs.afterRamp = await lp.swap(A, pool, 'buy', pct(3), 'loop: after the ramp (no cap): A buys +3%');
  txs.fill = await lp.buyExactIn(B, pool, BigInt(Math.round(threshold * 1.25 * LAMPORTS_PER_SOL)), 'loop: B buys enough SOL to complete the curve (graduation)');
  const st1 = await lp.status(mint);
  let migrate: TxRecord | null = null;
  if (st1.transferHookProgram === null) migrate = await lp.migrate(creator, pool);
  const st2 = await lp.status(mint);
  const out = { cluster: c.label, mint: r.mint, dbcPool: r.pool, dbcConfig: r.config, programId: r.programId,
    keys: { admin: admin.publicKey.toBase58(), launch: launchKey.publicKey.toBase58(), creator: creator.publicKey.toBase58(), buyerA: A.publicKey.toBase58(), buyerB: B.publicKey.toBase58() },
    launchTxs: r.txs, launcher: st0.launcher, launchSlot: st0.launchSlot,
    txs: Object.fromEntries(Object.entries({ ...txs, ...(migrate ? { migrate } : {}) }).map(([k, v]) => [k, rec(v)])),
    hookAfterFill: { program: st1.transferHookProgram, authority: st1.transferHookAuthority }, statusAfterMigration: st2 };
  mkdirSync('launches/devnet', { recursive: true });
  writeFileSync(`launches/devnet/${r.mint}.loop.json`, ser(out));
  console.log(ser(out));
}

async function keeperConfig(c: Cluster, mint: PublicKey, dbcPool: PublicKey, dbcConfig: PublicKey) {
  const creator = loadOrCreate('devnet', 'loop_creator');
  const gas = loadOrCreate('devnet', 'loop_gas'), treasury = loadOrCreate('devnet', 'loop_treasury'), dev = loadOrCreate('devnet', 'loop_dev');
  const damm = await postMigrationDammConfig(c);
  const route = deriveDammV2PoolAddress(damm.config, mint, NATIVE_MINT);
  const cp = new CpAmm(c.connection);
  const positions = await cp.getUserPositionByPool(route, creator.publicKey);
  if (positions.length < 1) throw new Error(`no DAMM v2 position for the creator in pool ${route.toBase58()}`);
  const p = positions[0];
  const base = JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8'));
  const cfg = { ...base, name: 'devnet-loop', main_mint: mint.toBase58(), main_dbc_pool: dbcPool.toBase58(), route_pool: route.toBase58(),
    sources: [{ kind: 'dbc', pool: dbcPool.toBase58(), config: dbcConfig.toBase58(), base_mint: mint.toBase58() },
      { kind: 'damm_v2', pool: route.toBase58(), position: p.position.toBase58(), position_nft_mint: p.positionState.nftMint.toBase58() }],
    keys: { claim_signer: 'loop_creator', treasury: 'loop_treasury', gas: 'loop_gas' },
    pinned_pubkeys: { claim_signer: creator.publicKey.toBase58(), treasury: treasury.publicKey.toBase58(), gas: gas.publicKey.toBase58() },
    dev_payout: dev.publicKey.toBase58(), max_swap_lamports_per_run: '20000000',
    price_source: { ...base.price_source, indep_price_url: arg('--indep-url', 'http://127.0.0.1:8787/price/v3') },
    state_dir: '.flywheel/devnet-loop', public_log: 'flywheel/devnet-loop.json' };
  writeFileSync('keeper/devnet.loop.json', JSON.stringify(cfg, null, 2) + '\n');
  console.log(ser({ route_pool: route.toBase58(), position: p.position.toBase58(), position_nft_mint: p.positionState.nftMint.toBase58(),
    claim_signer: creator.publicKey.toBase58(), treasury: treasury.publicKey.toBase58(), gas: gas.publicKey.toBase58(), dev_payout: dev.publicKey.toBase58() }));
}

const c = await resolveCluster('devnet');   // genesis-checked: devnet only
if (cmd === 'launch') await launch(c);
else if (cmd === 'keeper-config') await keeperConfig(c, new PublicKey(argv[1]), new PublicKey(argv[2]), new PublicKey(argv[3]));
else { console.error('usage: devnet_full_loop.ts launch [--threshold 0.2] | keeper-config <mint> <dbcPool> <dbcConfig> [--indep-url URL]'); process.exit(2); }
process.exit(0);

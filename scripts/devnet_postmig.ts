// Post-graduation checks for a launch (devnet or local): hook extension state, DAMM v2 pool fee, one buy from the DAMM v2 pool.
//   pnpm tsx scripts/devnet_postmig.ts <mint> <dbcPool> [--cluster devnet] [--sol 0.02]
import { PublicKey, LAMPORTS_PER_SOL, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { CpAmm, FEE_DENOMINATOR, BaseFeeMode, getBaseFeeModeFromPodAlignedData, decodePodAlignedFeeTimeScheduler, decodePodAlignedFeeRateLimiter, decodePodAlignedFeeMarketCapScheduler } from '@meteora-ag/cp-amm-sdk';
import { deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import { resolveCluster, parseClusterArg, explorerAddr, nowIct } from '../sdk/cluster.js';
import { loadOrCreate } from '../sdk/keys.js';
import { Launchpad, sendTx, dammV2MigrationConfigFor } from '../sdk/launch.js';
import { checkDammV2Config } from '../sdk/cluster_check.js';

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

(async () => {
  const c = await resolveCluster(parseClusterArg(argv));
  const dammRes = await dammV2MigrationConfigFor(c);   // same resolution Launchpad.migrate() uses (genesis-based pin)
  const DAMM_CONFIG = dammRes.config;
  if (dammRes.override) console.log(`overrides: DAMM_V2_MIGRATION_CONFIG=${dammRes.override}`);
  await checkDammV2Config(c.connection, DAMM_CONFIG);   // cluster check: owned by DAMM v2 here, else refuse before any tx
  const mint = new PublicKey(argv[0]), dbcPool = new PublicKey(argv[1]);
  const lp = new Launchpad(c);
  const st = await lp.status(mint);
  const dbcState: any = ((await lp.dbc.state.getPool(dbcPool)) as any);
  const ps = dbcState.poolState ?? dbcState;
  const damm = deriveDammV2PoolAddress(DAMM_CONFIG, mint, NATIVE_MINT);
  const cp = new CpAmm(c.connection);
  const pool: any = await cp.fetchPoolState(damm);
  const bf = pool.poolFees.baseFee;
  const data = Buffer.from(bf.baseFeeInfo.data);
  const mode = getBaseFeeModeFromPodAlignedData(data);
  const dec: any = mode <= 1 ? decodePodAlignedFeeTimeScheduler(data) : mode === 2 ? decodePodAlignedFeeRateLimiter(data) : decodePodAlignedFeeMarketCapScheduler(data);
  const cliff = dec.cliffFeeNumerator;
  const decoded = Object.fromEntries(Object.entries(dec).map(([k, v]: [string, any]) => [k, Array.isArray(v) ? `[${v.length}]` : v?.toString?.() ?? v]));
  const fee = {
    dammPool: damm.toBase58(), dammConfig: DAMM_CONFIG.toBase58(), feeDenominator: FEE_DENOMINATOR.toString(),
    baseFeeMode: BaseFeeMode[mode], baseFeeDecoded: decoded,
    cliffFeeNumerator: cliff ? cliff.toString() : null,
    cliffFeeBps: cliff ? Number(cliff.toString()) / Number(FEE_DENOMINATOR.toString()) * 10_000 : null,
    dynamicFeeInitialized: pool.poolFees.dynamicFee?.initialized ?? null,
    protocolFeePercent: pool.poolFees.protocolFeePercent ?? null, collectFeeMode: pool.collectFeeMode ?? null,
  };
  console.log(JSON.stringify({ dbcIsMigrated: ps.isMigrated, transferHookProgramOnMint: st.transferHookProgram, transferHookAuthority: st.transferHookAuthority, fee }, null, 1));
  // one buy from the DAMM v2 pool (SOL -> token), no hook accounts passed
  const A = loadOrCreate(c.name, 'buyerA');
  const lamports = BigInt(Math.round(Number(arg('--sol', '0.02')) * LAMPORTS_PER_SOL));
  const aIsMint = pool.tokenAMint.equals(mint);
  const progOf = (flag: number) => (flag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
  const before = await lp.tokenBalance(mint, A.publicKey);
  const tx = await cp.swap({
    payer: A.publicKey, pool: damm, inputTokenMint: NATIVE_MINT, outputTokenMint: mint, amountIn: new BN(lamports.toString()), minimumAmountOut: new BN(1),
    tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault,
    tokenAProgram: progOf(pool.tokenAFlag), tokenBProgram: progOf(pool.tokenBFlag), referralTokenAccount: null, poolState: pool,
  });
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const r = await sendTx(c, tx, [A], `post-migration buy: A buys with ${Number(lamports) / LAMPORTS_PER_SOL} SOL from the DAMM v2 pool (no hook)`);
  const after = await lp.tokenBalance(mint, A.publicKey);
  let logs: string[] = [];
  for (let i = 0; i < 8 && r.sig; i++) { const t = await c.connection.getTransaction(r.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (t) { logs = t.meta?.logMessages ?? []; break; } await new Promise(s => setTimeout(s, 3000)); }
  console.log(JSON.stringify({ time: nowIct(), aIsMint, buy: { ok: r.ok, sig: r.sig, link: r.link, err: r.err, tokensBefore: before.toString(), tokensAfter: after.toString(), hookInvoked: logs.some(l => l.includes(lp.hook.programId.toBase58())) }, dammPoolLink: explorerAddr(damm.toBase58(), c.name), logs }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });

// Meteora DBC transfer-hook pool integration (LOCAL default, DEVNET explicit). No mainnet path.
import BN from 'bn.js';
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram, SendTransactionError, type Signer } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync, getMint, getTransferHook, unpackAccount } from '@solana/spl-token';
import {
  DynamicBondingCurveClient, buildCurve, deriveDbcPoolAddress, ActivationType, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, TokenAuthorityOption, TokenDecimal, TokenType, SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HookClient, DEFAULT_PROGRAM_ID, DBC_PROGRAM_ID, HookProgramPinRefusal, resolveHookProgramId, type HookProgramResolution, TOKEN_2022, decodeGlobal, readHookAuthorities, decodeMintConfig, decodeLift, toCapConfig, hookErrorFromLogs, hookCodeFromLogs, capHitDetails, parseRestrictionsLifted } from './hook.js';
import { effectiveCap, nextChange, type Step } from './capMath.js';
import { type Cluster, type ClusterName, type ClusterClass, explorerTx, nowIct, classifyCluster } from './cluster.js';
import { launchConfigChecks, type Authorities } from './keyrules.js';
import { assertClusterAccounts, checkDammV2Config, ClusterCheckRefusal } from './cluster_check.js';
import { MintHookRefusal, mintHookAuthorityFor, assertPinNotOurs, assertMintHook, readMintTransferHook, mintHookProblems, graduationPhase, poolTxBaseMint, simulateMintTransferHook, sameMessageExceptBlockhash, type GraduationPhase, type MintHookExpectation, type MintTransferHook } from './mint_hook.js';

/** DAMM v2 config used at migration, per cluster (was hard-coded in migrate()).
 *  Primary source for the pin: Meteora DBC repo README at commit f552f20 (2026-09-09), section "Damm v2":
 *  `migration_fee_option == 0: 7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd` (option 0 = FixedBps25, base_fee_bps == 25,
 *  the default migrationFeeOption in DEFAULT_LAUNCH_FEES). The flat/Customizable option 6 would instead be
 *  A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck, so it is not used here. The pinned account was checked on mainnet:
 *  owned by the DAMM v2 program, non-executable, 328 bytes. Same address on every cluster (the local validator clones
 *  the devnet account). The env override `DAMM_V2_MIGRATION_CONFIG` is a test knob, gated by the genesis-based class
 *  (classifyCluster): devnet → any valid override; local (localhost URL + unknown genesis) → any valid override;
 *  mainnet/testnet → the override must equal that class's pin, and a class without a pin refuses; unknown → refuse.
 *  Resolution happens before any migration tx is built. */
export const DAMM_V2_MIGRATION_CONFIG: Record<ClusterName, string> = {
  devnet: '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd',
  local: '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd', // scripts/local_validator.sh clones this account from devnet
};
export const DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN = '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd';
/** Per-class pins. null = no pinned value: resolution on that class refuses (with or without an override). */
export const DAMM_V2_MIGRATION_CONFIG_PINS: Record<ClusterClass, string | null> = {
  devnet: DAMM_V2_MIGRATION_CONFIG.devnet, mainnet: DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN, testnet: null,
  local: DAMM_V2_MIGRATION_CONFIG.local, unknown: null,
};
export class ConfigPinRefusal extends Error {}
export class LaunchKeygenRefusal extends Error { constructor(m: string) { super(m); this.name = 'LaunchKeygenRefusal'; } }
/** Generating the DBC config and mint keypairs in this process is a devnet/local convenience only. On any other genesis
 *  class (mainnet, testnet, unknown) the mint keypair belongs to the signing side (M1-M4 mainnet key decision): this code
 *  takes public keys only. Today the hook gate also refuses mainnet/testnet/unknown, but only because no hook pin is set
 *  there; this guard does not depend on that. */
export function assertLaunchKeygenAllowed(cls: ClusterClass): void {
  if (cls !== 'devnet' && cls !== 'local') throw new LaunchKeygenRefusal(`refusing: launch() generates the config and mint keypairs locally, which is allowed only on devnet/local genesis (cluster class '${cls}')`);
}
/** The only place launch() creates keypairs: guard first, then generate. */
export function launchKeypairsFor(cls: ClusterClass): { config: Keypair; mint: Keypair } {
  assertLaunchKeygenAllowed(cls);
  return { config: Keypair.generate(), mint: Keypair.generate() };
}
export interface DammConfigResolution { config: PublicKey; override: string | null; clusterByGenesis: ClusterClass }
/** Resolve the migration DAMM v2 config from the RPC's genesis hash (+ the RPC URL, only to recognise a local validator).
 *  The cluster name is not used for the decision. Throws ConfigPinRefusal. */
export function resolveDammV2MigrationConfig(genesis: string, _name: ClusterName, env: NodeJS.ProcessEnv = process.env, url?: string): DammConfigResolution {
  const cls = classifyCluster(genesis, url);
  const raw = env.DAMM_V2_MIGRATION_CONFIG;
  const override = raw !== undefined && raw !== '' ? raw : null;
  const pinned = DAMM_V2_MIGRATION_CONFIG_PINS[cls];
  const overridable = cls === 'devnet' || cls === 'local';
  if (override === null) {
    if (pinned === null) throw new ConfigPinRefusal(`refusing: no pinned DAMM_V2_MIGRATION_CONFIG for cluster class '${cls}' (genesis ${genesis})`);
    return { config: new PublicKey(pinned), override: null, clusterByGenesis: cls };
  }
  if (!overridable && (pinned === null || override !== pinned))
    throw new ConfigPinRefusal(`refusing DAMM_V2_MIGRATION_CONFIG override ${override} on a non-devnet cluster (class '${cls}', genesis ${genesis}): ${pinned === null ? 'no pinned value, so no override is allowed' : `only the pinned value ${pinned} is allowed`}`);
  let pk: PublicKey; try { pk = new PublicKey(override); } catch { throw new ConfigPinRefusal(`DAMM_V2_MIGRATION_CONFIG override is not a valid address: ${override}`); }
  return { config: pk, override, clusterByGenesis: cls };
}
/** Same resolution for a connected cluster (one genesis read). */
export async function dammV2MigrationConfigFor(c: Pick<Cluster, 'name' | 'connection'> & { url?: string }, env: NodeJS.ProcessEnv = process.env): Promise<DammConfigResolution> {
  let genesis: string;
  try { genesis = await c.connection.getGenesisHash(); }   // fail closed: an RPC error never falls back to a default cluster
  catch (e: any) { throw new ConfigPinRefusal(`refusing: cannot read the genesis hash to pin DAMM_V2_MIGRATION_CONFIG (${String(e?.message ?? e).slice(0, 200)})`); }
  return resolveDammV2MigrationConfig(genesis, c.name, env, c.url);
}

/** The DAMM v2 migration config a post-migration check works against: the same genesis-pinned resolution as migrate(),
 *  then the cluster check that the account exists and is owned by DAMM v2 (ConfigPinRefusal / ClusterCheckRefusal). */
export async function postMigrationDammConfig(c: Pick<Cluster, 'name' | 'connection'> & { url?: string }, env: NodeJS.ProcessEnv = process.env): Promise<DammConfigResolution> {
  const r = await dammV2MigrationConfigFor(c, env);
  await checkDammV2Config(c.connection, r.config);
  return r;
}

export interface TxRecord { time: string; cluster: string; label: string; purpose: string; sig: string; ok: boolean; err?: string; hookError?: string | null; hookCode?: number | null; link: string; capHit?: any; events?: any[]; note?: string }

/** Tx log file for a cluster: `<cluster>.jsonl` in the default tx log dir; `TXLOG_DIR` redirects it (tests write to a temp dir). */
export function txlogFile(cluster: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TXLOG_DIR || 'txlog', `${cluster}.jsonl`);
}
/** `beforeSign` sees the exact message bytes about to be signed (blockhash and fee payer set) and may throw: then nothing
 *  is signed or sent. */
export async function sendTx(c: Cluster, tx: Transaction, signers: Signer[], purpose: string, note?: string, beforeSign?: (message: Buffer) => void): Promise<TxRecord> {
  const { blockhash, lastValidBlockHeight } = await c.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash; tx.feePayer = signers[0].publicKey;
  if (beforeSign) beforeSign(tx.serializeMessage());
  tx.sign(...signers);
  let sig = '';
  let rec: TxRecord;
  try {
    // skipPreflight so that expected failures (cap hits) land on-chain with a signature we can link to.
    sig = await c.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
    await c.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    let info = null;
    for (let i = 0; i < 10 && !info; i++) { info = await c.connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!info) await new Promise(r => setTimeout(r, 800)); }
    const logs = info?.meta?.logMessages ?? [];
    const ok = !info?.meta?.err;
    rec = { time: nowIct(), cluster: c.name, label: c.label, purpose, sig, ok, err: ok ? undefined : JSON.stringify(info?.meta?.err), hookError: hookErrorFromLogs(logs, c.hookProgram), hookCode: hookCodeFromLogs(logs, c.hookProgram), link: explorerTx(sig, c.name), capHit: capHitDetails(logs) ?? undefined, events: parseRestrictionsLifted(logs).map(e => ({ ...e, mint: e.mint.toBase58(), signer: e.signer.toBase58(), slot: e.slot.toString() })), note };
    (rec as any).logs = logs;
  } catch (e: any) {
    const logs = e instanceof SendTransactionError ? (e.logs ?? []) : [];
    rec = { time: nowIct(), cluster: c.name, label: c.label, purpose, sig, ok: false, err: String(e?.message ?? e).slice(0, 500), hookError: hookErrorFromLogs(logs, c.hookProgram), hookCode: hookCodeFromLogs(logs, c.hookProgram), link: sig ? explorerTx(sig, c.name) : '', note };
  }
  const file = txlogFile(c.name);
  mkdirSync(dirname(file), { recursive: true });
  const { logs, ...slim } = rec as any;
  appendFileSync(file, JSON.stringify(slim, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
  console.log(`[${c.label}] ${rec.ok ? 'OK  ' : 'FAIL'} ${purpose} ${rec.hookError ? '(' + rec.hookError + ')' : ''} ${rec.link || rec.err}`);
  return rec;
}

export interface LaunchOpts {
  /** Keeper keys and dev_payout (pubkeys) that must never hold the mint's TransferHook authority (blocker #7). */
  keeperKeys?: Record<string, string>;
  name: string; symbol: string; uri?: string;
  steps: Step[]; uncappedAfter: bigint;           // hook cap schedule (slots)
  totalSupply?: number;                           // whole tokens
  migrationQuoteThresholdSol?: number;            // tiny curve (L8 damage cap)
  feeStartBps?: number; feeEndBps?: number; feePeriods?: number; feeDurationSlots?: number; // anti-sniper fee schedule
  creatorTradingFeePercentage?: number;            // creator share of the non-protocol trading fee (0-100)
  migrationFeeOption?: MigrationFeeOption;         // DAMM v2 pool fee after migration (FixedBps25 = 0.25%)
  percentageSupplyOnMigration?: number;            // % of supply reserved for the DAMM v2 pool at migration (integer 1..49, default 20 -> 80% sold on the curve)
  authorities?: Authorities;                       // hook upgrade + lift authority for the §12a preflight (read from chain if omitted)
}
/** Default % of supply that goes to the migration pool (behaviour unchanged from the hard-coded 20). */
export const DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION = 20;
/** Accepted range. DBC's buildCurve does not validate this value itself: 0 divides by zero, and with DAMM v2 migration
 *  it throws "SafeMath: subtraction overflow" for 50..99 (probed against SDK buildCurve with our config; 1..49 build). */
export const PERCENTAGE_SUPPLY_ON_MIGRATION_MIN = 1;
export const PERCENTAGE_SUPPLY_ON_MIGRATION_MAX = 49;
/** Validate percentageSupplyOnMigration: integer 1..49 (undefined/null -> default 20). */
export function resolvePercentageSupplyOnMigration(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION;
  const lo = PERCENTAGE_SUPPLY_ON_MIGRATION_MIN, hi = PERCENTAGE_SUPPLY_ON_MIGRATION_MAX;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`percentageSupplyOnMigration must be an integer ${lo}..${hi} (got ${String(v)})`);
  return v;
}
/** Defaults used to build every DBC config (single source; the page displays the values recorded per launch). */
export const DEFAULT_LAUNCH_FEES = Object.freeze({ feeStartBps: 5000, feeEndBps: 100, feePeriods: 10, feeDurationSlots: 150, creatorTradingFeePercentage: 0, migrationFeeOption: MigrationFeeOption.FixedBps25 });
/** The fee config actually used for a launch (options over defaults). Recorded in launches/<cluster>/<mint>.json. */
export function launchFeeConfig(o: Partial<LaunchOpts>) {
  const d = DEFAULT_LAUNCH_FEES;
  return { startBps: o.feeStartBps ?? d.feeStartBps, endBps: o.feeEndBps ?? d.feeEndBps, periods: o.feePeriods ?? d.feePeriods, durationSlots: o.feeDurationSlots ?? d.feeDurationSlots,
    creatorTradingFeePercentage: o.creatorTradingFeePercentage ?? d.creatorTradingFeePercentage, migrationFeeOption: o.migrationFeeOption ?? d.migrationFeeOption,
    percentageSupplyOnMigration: resolvePercentageSupplyOnMigration(o.percentageSupplyOnMigration) };
}
export interface LaunchRecord { name?: string; symbol?: string; cluster: string; label: string; time: string; programId: string; config: string; pool: string; mint: string; quoteMint: string; steps: { slotOffset: string; maxBps: number }[]; uncappedAfter: string; migrationQuoteThresholdSol: number; fee: any; txs: Record<string, string>; mintHookCheck?: string; mintHookSimulation?: string }

/** DBC config params for a launch (pure; no network). Launchpad.configParams uses this. */
export function curveConfigParams(o: Partial<LaunchOpts>) {
  const f = launchFeeConfig(o);
  return buildCurve({
    token: { tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: o.totalSupply ?? 1_000_000_000, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: f.startBps, endingFeeBps: f.endBps, numberOfPeriod: f.periods, totalDuration: f.durationSlots } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: f.creatorTradingFeePercentage, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: f.migrationFeeOption, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot,
    percentageSupplyOnMigration: f.percentageSupplyOnMigration,
    migrationQuoteThreshold: o.migrationQuoteThresholdSol ?? 1,
  } as any);
}

/** Hook program id for a connected cluster (one genesis read; an RPC error refuses, never falls back). */
export async function hookProgramFor(c: { connection: { getGenesisHash(): Promise<string> }; url?: string }, env: NodeJS.ProcessEnv = process.env): Promise<HookProgramResolution> {
  let genesis: string;
  try { genesis = await c.connection.getGenesisHash(); }
  catch (e: any) { throw new HookProgramPinRefusal(`refusing: cannot read the genesis hash to pin HOOK_PROGRAM_ID (${String(e?.message ?? e).slice(0, 200)})`); }
  return resolveHookProgramId(genesis, c.url, env);
}
/** Hook gate, run by every Launchpad method that builds a tx or reads hook state: resolve the hook program id for this
 *  cluster (HookProgramPinRefusal), refuse an explicit constructor id that differs, adopt it, then the cluster check
 *  that the program account is executable (ClusterCheckRefusal). */
export async function gateHook(lp: { c: any; hook: HookClient; requestedHookProgram?: PublicKey }): Promise<HookProgramResolution> {
  const r = await hookProgramFor(lp.c);
  if (lp.requestedHookProgram && !lp.requestedHookProgram.equals(r.programId))
    throw new HookProgramPinRefusal(`refusing: Launchpad hook program ${lp.requestedHookProgram.toBase58()} differs from the resolved ${r.programId.toBase58()} (cluster class '${r.clusterClass}')`);
  if (r.override) console.warn(`overrides: HOOK_PROGRAM_ID=${r.override}`);
  lp.hook = new HookClient(r.programId);
  lp.c.hookProgram = r.programId;
  await assertClusterAccounts(lp.c.connection, { hookProgram: r.programId });
  return r;
}

/** Hook program id for read-only tools (scripts/qa_schedule.ts): the same resolver and executable check as gateHook(). */
export async function resolveQaHookProgram(c: { connection: any; url?: string }, env: NodeJS.ProcessEnv = process.env): Promise<PublicKey> {
  const r = await hookProgramFor(c, env);
  await assertClusterAccounts(c.connection, { hookProgram: r.programId });
  return r.programId;
}

/** Blocker #7: what the mint's TransferHook must hold for this cluster. Runs the hook gate (pinned program id) and resolves
 *  the pinned DBC signer for the genesis class (MintHookRefusal when unset: mainnet/testnet/unknown, no devnet fallback). */
export async function mintHookExpectationFor(lp: { c: any; hook: HookClient; requestedHookProgram?: PublicKey }, forbidden: Record<string, string | null | undefined> = {}): Promise<MintHookExpectation> {
  const r = await gateHook(lp);
  const authority = mintHookAuthorityFor(r.clusterClass);
  assertPinNotOurs(authority, forbidden);
  return { hookProgram: r.programId, authority, forbidden };
}
/** The DBC pool's graduation phase plus the mint check for that phase (MintHookRefusal before any tx is built). */
export async function assertPoolMintHook(lp: { c: any; hook: HookClient; dbc: any; requestedHookProgram?: PublicKey }, pool: PublicKey, want: GraduationPhase | 'any' = 'any', forbidden: Record<string, string | null | undefined> = {}): Promise<GraduationPhase> {
  const exp = await mintHookExpectationFor(lp, forbidden);
  let st: any;
  try { st = await lp.dbc.state.getPool(pool); }
  catch (e: any) { throw new MintHookRefusal(`refusing: cannot read DBC pool ${pool.toBase58()} (RPC error: ${String(e?.message ?? e).slice(0, 200)})`); }
  const ps = st?.poolState ?? st;
  if (!ps?.baseMint) throw new MintHookRefusal(`refusing: DBC pool ${pool.toBase58()} not found`);
  const phase = graduationPhase(ps);
  if (want !== 'any' && phase !== want) throw new MintHookRefusal(`refusing: DBC pool ${pool.toBase58()} is ${phase}-graduation, this step needs ${want}-graduation`);
  await assertMintHook(lp.c.connection, new PublicKey(ps.baseMint), phase, exp);
  return phase;
}


/** Monitoring flag for the mint's TransferHook (blocker #7): ok only when it matches the graduation phase. Read failures
 *  and an unknown phase are flagged (ok: false), never treated as fine. The hook gate itself still throws. */
export async function mintHookFlag(lp: { c: any; hook: HookClient; dbc: any; requestedHookProgram?: PublicKey }, mint: PublicKey, pool?: PublicKey): Promise<{ ok: boolean; phase: GraduationPhase | null; problems: string[] }> {
  const r = await gateHook(lp);
  let phase: GraduationPhase | null = null;
  try {
    const exp: MintHookExpectation = { hookProgram: r.programId, authority: mintHookAuthorityFor(r.clusterClass) };
    const st: any = pool ? await lp.dbc.state.getPool(pool) : (await lp.dbc.state.getPoolByBaseMint(mint))?.account;
    const ps = st?.poolState ?? st;
    if (!ps?.baseMint) throw new MintHookRefusal(`no DBC pool found for mint ${mint.toBase58()}`);
    if (!new PublicKey(ps.baseMint).equals(mint)) throw new MintHookRefusal(`DBC pool base mint ${new PublicKey(ps.baseMint).toBase58()} != ${mint.toBase58()}`);
    phase = graduationPhase(ps);
    const problems = mintHookProblems(await readMintTransferHook(lp.c.connection, mint), phase, exp);
    return { ok: problems.length === 0, phase, problems };
  } catch (e: any) {
    return { ok: false, phase, problems: [String(e?.message ?? e)] };
  }
}

/** Build the create-pool tx (DBC create pool + hook initialize_extra_account_meta_list, one tx) from PUBLIC keys only.
 *  Nothing here signs: the mint key is not needed to build or to simulate (blocker #7). */
export async function buildCreatePoolTx(lp: { dbc: any; hook: HookClient }, o: LaunchOpts, keys: { payer: PublicKey; config: PublicKey; mint: PublicKey }): Promise<Transaction> {
  const poolTx: Transaction = await lp.dbc.creator.createPoolWithTransferHook({
    name: o.name, symbol: o.symbol, uri: o.uri ?? 'https://example.invalid/devnet-test.json', payer: keys.payer, poolCreator: keys.payer,
    config: keys.config, baseMint: keys.mint, transferHookProgram: lp.hook.programId,
  } as any);
  const supplyRef = BigInt(o.totalSupply ?? 1_000_000_000) * 1_000_000n;
  // Same tx: hook config is frozen in the pool-creation slot, so the ramp starts exactly at launch.
  poolTx.add(lp.hook.initializeExtraAccountMetaList({ payer: keys.payer, authority: keys.payer, mint: keys.mint, steps: o.steps, uncappedAfter: o.uncappedAfter, supplyRef }));
  poolTx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  return poolTx;
}
/** Blocker #7 pre-send check: simulate the built, UNSIGNED create-pool tx (exact message bytes, sigVerify false, the RPC
 *  replaces the blockhash) and require the post-simulation mint's TransferHook = gated hook program + pinned DBC signer.
 *  The mint address is the one the tx itself names (DBC create-pool ix, base_mint); it must equal `expectedMint`.
 *  Returns the simulated message bytes, so the signing step can prove it signs the same bytes apart from the blockhash. */
export async function preSendMintHookCheck(conn: any, tx: Transaction, payer: PublicKey, expectedMint: PublicKey, exp: MintHookExpectation): Promise<{ messageBytes: Buffer; mint: PublicKey; hook: MintTransferHook }> {
  const mint = poolTxBaseMint(tx, DBC_PROGRAM_ID);
  if (!mint.equals(expectedMint)) throw new MintHookRefusal(`refusing: the built create-pool tx names base mint ${mint.toBase58()}, not the launch mint ${expectedMint.toBase58()}`);
  let blockhash: string;
  try { blockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; }
  catch (e: any) { throw new MintHookRefusal(`refusing: RPC error fetching a blockhash for the create-pool simulation: ${String(e?.message ?? e).slice(0, 200)}`); }
  tx.feePayer = payer; tx.recentBlockhash = blockhash;   // placeholder only: replaceRecentBlockhash swaps it
  const sim = await simulateMintTransferHook(conn, tx.serializeMessage(), mint);
  const p = mintHookProblems(sim.hook, 'pre', exp);
  if (p.length) throw new MintHookRefusal(`refusing before signing: simulated mint ${mint.toBase58()} (create-pool tx): ${p.join('; ')}`);
  return { messageBytes: sim.messageBytes, mint, hook: sim.hook };
}
const hookStr = (h: MintTransferHook) => `program_id=${h.programId?.toBase58() ?? 'unset'} authority=${h.authority?.toBase58() ?? 'unset'}`;

export class Launchpad {
  dbc: DynamicBondingCurveClient;
  hook: HookClient;
  /** Explicit id from the constructor, if any; the hook gate refuses when it differs from the cluster's resolved id. */
  requestedHookProgram?: PublicKey;
  constructor(public c: Cluster, programId?: PublicKey) {
    this.dbc = new DynamicBondingCurveClient(c.connection, 'confirmed');
    this.requestedHookProgram = programId;
    this.hook = new HookClient(programId ?? DEFAULT_PROGRAM_ID);   // placeholder until gateHook() resolves it per cluster
  }

  async ensureGlobal(upgradeAuthority: Keypair, liftAuthority: PublicKey) {
    await gateHook(this);
    const acc = await this.c.connection.getAccountInfo(this.hook.globalPda());
    if (acc) return decodeGlobal(acc.data);
    const r = await sendTx(this.c, new Transaction().add(this.hook.initializeGlobal(upgradeAuthority.publicKey, liftAuthority)), [upgradeAuthority], 'hook: initialize_global (set lift authority)');
    if (!r.ok) throw new Error('initialize_global failed');
    return decodeGlobal((await this.c.connection.getAccountInfo(this.hook.globalPda()))!.data);
  }

  configParams(o: LaunchOpts) { return curveConfigParams(o); }

  /** Hook upgrade authority (ProgramData) and lift authority (Global PDA), via the shared reader (throws AuthorityReadError). */
  async hookAuthorities(): Promise<Authorities> {
    await gateHook(this);
    const a = await readHookAuthorities(this.c.connection, this.hook.programId);
    return { upgradeAuthority: a.upgradeAuthority, liftAuthority: a.liftAuthority };
  }

  /** Blocker #7 helpers (module functions, so they also run with the test fakes' `this`). */
  mintHookExpectation(forbidden: Record<string, string | null | undefined> = {}) { return mintHookExpectationFor(this, forbidden); }
  assertPoolMintHook(pool: PublicKey, want: GraduationPhase | 'any' = 'any', forbidden: Record<string, string | null | undefined> = {}) { return assertPoolMintHook(this, pool, want, forbidden); }
  mintHookFlag(mint: PublicKey, pool?: PublicKey) { return mintHookFlag(this, mint, pool); }

  /** Partner config (transfer hook -> our program) + pool + hook config, by `deployer` (partner = creator = launcher in the beta). */
  async launch(deployer: Keypair, o: LaunchOpts): Promise<LaunchRecord> {
    // hook gate first (also when o.authorities is given): the hook program id pinned by genesis, executable here. Its
    // genesis class (not the Cluster's name) decides warn-vs-refuse in the §12a checks below.
    const gate = await gateHook(this);
    assertLaunchKeygenAllowed(gate.clusterClass);   // before any read or build: local keypair generation is devnet/local only
    // §12a preflight (FW-24): feeClaimer (= deployer here) must differ from the hook upgrade and lift authorities, and
    // upgrade != lift. Throws off devnet/local (by genesis class) before any tx is built; warns on devnet/local.
    const auth = o.authorities ?? (await this.hookAuthorities());
    for (const w of launchConfigChecks(gate.clusterClass, deployer.publicKey.toBase58(), auth)) console.warn(w);
    // blocker #7: the pinned DBC signer that will hold the new mint's TransferHook authority resolves for this genesis
    // class and is none of our keys. Refuses before any tx is built. (The program_id comparison runs on the mint itself.)
    const mintHookForbidden = { dev: deployer.publicKey.toBase58(), upgrade: auth.upgradeAuthority, lift: auth.liftAuthority, ...(o.keeperKeys ?? {}) };
    const mintHook = await mintHookExpectationFor(this, mintHookForbidden);
    const { config: configKp, mint: mintKp } = launchKeypairsFor(gate.clusterClass);
    const txs: Record<string, string> = {};
    const params = this.configParams(o);
    const cfgTx = await this.dbc.partner.createConfigWithTransferHook({
      config: configKp.publicKey, feeClaimer: deployer.publicKey, leftoverReceiver: deployer.publicKey, payer: deployer.publicKey,
      quoteMint: NATIVE_MINT, transferHookProgram: this.hook.programId, ...params,
    } as any);
    // The config goes first, in its own tx: config + pool + hook extra-metas in one legacy tx is over the 1232-byte limit
    // (1291 B with the devnet schedule), and the pool tx can only be built and simulated once the config exists. A config
    // left over by a refused launch is harmless and reusable (pool PDA = config + mints). The pool tx itself is never sent
    // without a passing pre-send simulation (below). Off devnet the config is pre-created once and pinned (blocker #8).
    const r1 = await sendTx(this.c, cfgTx, [deployer, configKp], `dbc: create_config_with_transfer_hook (${o.symbol})`);
    txs.createConfig = r1.sig; if (!r1.ok) throw new Error('create config failed: ' + r1.err);

    // Built once from public keys only (the DBC IDL marks base_mint as a signer, but only the send needs that signature).
    const poolTx = await buildCreatePoolTx(this, o, { payer: deployer.publicKey, config: configKp.publicKey, mint: mintKp.publicKey });
    const pool = deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, configKp.publicKey);
    // blocker #7 pre-send check: simulate these exact unsigned bytes; refuse before any signature on a wrong mint hook.
    const sim = await preSendMintHookCheck(this.c.connection, poolTx, deployer.publicKey, mintKp.publicKey, mintHook);
    // Signing step: the bytes signed must equal the simulated bytes apart from the blockhash (sendTx fetches a fresh one).
    const sameBytes = (m: Buffer) => { if (!sameMessageExceptBlockhash(sim.messageBytes, m)) throw new MintHookRefusal('refusing to sign: the create-pool tx differs from the simulated tx (beyond the blockhash)'); };
    const r2 = await sendTx(this.c, poolTx, [deployer, mintKp], `dbc: initialize_virtual_pool_with_token2022_transfer_hook + hook: initialize_extra_account_meta_list (${o.symbol})`, undefined, sameBytes);
    txs.createPoolAndHookConfig = r2.sig; if (!r2.ok) throw new Error('create pool failed: ' + r2.err);

    const rec: LaunchRecord = {
      name: o.name, symbol: o.symbol, cluster: this.c.name, label: this.c.label, time: nowIct(), programId: this.hook.programId.toBase58(), config: configKp.publicKey.toBase58(), pool: pool.toBase58(), mint: mintKp.publicKey.toBase58(),
      quoteMint: NATIVE_MINT.toBase58(), steps: o.steps.map(s => ({ slotOffset: s.slotOffset.toString(), maxBps: s.maxBps })), uncappedAfter: o.uncappedAfter.toString(),
      migrationQuoteThresholdSol: o.migrationQuoteThresholdSol ?? 1, fee: { mode: 'FeeSchedulerLinear (anti-sniper fee schedule)', ...launchFeeConfig(o) }, txs,
    };
    // blocker #7: the mint only exists now. The authority alone does not prove the mint is ours: the pinned signer is DBC's
    // shared pool-authority PDA, the same for every DBC pool. So all of these are required: the DBC pool at the derived
    // address has our config and our mint (still pre-graduation), and the mint's TransferHook holds our gated hook program
    // (program_id comparison) and the pinned DBC signer.
    let mintHookErr: Error | null = null;
    try {
      let st: any;
      try { st = await this.dbc.state.getPool(pool); }
      catch (e: any) { throw new MintHookRefusal(`refusing: cannot read the new DBC pool ${pool.toBase58()} (RPC error: ${String(e?.message ?? e).slice(0, 200)})`); }
      const ps = st?.poolState ?? st;
      if (!ps?.baseMint || !ps?.config) throw new MintHookRefusal(`refusing: new DBC pool ${pool.toBase58()} not found`);
      if (!new PublicKey(ps.baseMint).equals(mintKp.publicKey)) throw new MintHookRefusal(`refusing: new DBC pool base mint ${new PublicKey(ps.baseMint).toBase58()} != our mint ${mintKp.publicKey.toBase58()}`);
      if (!new PublicKey(ps.config).equals(configKp.publicKey)) throw new MintHookRefusal(`refusing: new DBC pool config ${new PublicKey(ps.config).toBase58()} != our config ${configKp.publicKey.toBase58()}`);
      if (graduationPhase(ps) !== 'pre') throw new MintHookRefusal(`refusing: new DBC pool ${pool.toBase58()} is already past graduation`);
      // second check: the on-chain mint after the pool tx, which must also equal what the simulation showed.
      const onChain = await assertMintHook(this.c.connection, sim.mint, 'pre', mintHook);
      if (hookStr(onChain) !== hookStr(sim.hook)) throw new MintHookRefusal(`refusing: the on-chain mint TransferHook (${hookStr(onChain)}) differs from the pre-send simulation (${hookStr(sim.hook)}); stop before any buy or keeper step`);
    } catch (e: any) { mintHookErr = e; rec.mintHookCheck = `FAILED: ${e.message}`; }
    rec.mintHookSimulation = `ok before signing: ${hookStr(sim.hook)}`;
    if (!mintHookErr) rec.mintHookCheck = 'ok';
    mkdirSync(`launches/${this.c.name}`, { recursive: true });
    writeFileSync(`launches/${this.c.name}/${rec.mint}.json`, JSON.stringify(rec, null, 2));
    if (mintHookErr) throw mintHookErr;
    return rec;
  }

  /** Buy exactly `tokens` (base units) or sell `tokens` (base units) via swap2_with_transfer_hook. */
  async swap(owner: Keypair, pool: PublicKey, side: 'buy' | 'sell', tokens: bigint, purpose?: string, maxSolIn?: bigint) {
    await assertPoolMintHook(this, pool, 'pre', { swapper: owner.publicKey.toBase58() });   // runs the hook gate; blocker #7
    if (maxSolIn === undefined) { // SDK wraps maximumAmountIn into wSOL up front, so bound it by the wallet balance
      const bal = BigInt(await this.c.connection.getBalance(owner.publicKey));
      maxSolIn = bal > 30_000_000n ? bal - 30_000_000n : 1n; if (maxSolIn > 2_000_000_000n) maxSolIn = 2_000_000_000n;
    }
    const params: any = side === 'buy'
      ? { owner: owner.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.ExactOut, amountOut: new BN(tokens.toString()), maximumAmountIn: new BN(maxSolIn.toString()) }
      : { owner: owner.publicKey, pool, swapBaseForQuote: true, referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn: new BN(tokens.toString()), minimumAmountOut: new BN(0) };
    const tx = await this.dbc.pool.swap2WithTransferHook(params);
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    return sendTx(this.c, tx, [owner], purpose ?? `dbc: swap2_with_transfer_hook ${side} ${tokens}`);
  }
  /** Buy with exact SOL in (used to fill the curve). */
  async buyExactIn(owner: Keypair, pool: PublicKey, lamportsIn: bigint, purpose: string) {
    await assertPoolMintHook(this, pool, 'pre', { buyer: owner.publicKey.toBase58() });   // runs the hook gate; blocker #7
    const tx = await this.dbc.pool.swap2WithTransferHook({ owner: owner.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.PartialFill, amountIn: new BN(lamportsIn.toString()), minimumAmountOut: new BN(0) } as any);
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    return sendTx(this.c, tx, [owner], purpose);
  }

  async migrate(payer: Keypair, pool: PublicKey) {
    const damm = await dammV2MigrationConfigFor(this.c);   // throws ConfigPinRefusal before any tx is built
    // hook gate (Token-2022 invokes the hook on the migration transfers): pinned id for this cluster, executable here
    const mintHook = await mintHookExpectationFor(this, { payer: payer.publicKey.toBase58() });   // runs the hook gate
    // cluster check (throws ClusterCheckRefusal before any tx is built): the pool's DBC config and the DAMM v2 migration
    // config must be owned by their programs on this cluster.
    let st: any;
    try { st = await this.dbc.state.getPool(pool); }
    catch (e: any) { throw new ClusterCheckRefusal(`refusing: cluster check could not read DBC pool ${pool.toBase58()} (RPC error: ${String(e?.message ?? e).slice(0, 200)})`); }
    const ps = st?.poolState ?? st;
    if (!ps?.config) throw new ClusterCheckRefusal(`refusing: DBC pool ${pool.toBase58()} does not exist on this cluster`);
    await assertClusterAccounts(this.c.connection, { dbcConfigs: [new PublicKey(ps.config)], dammV2Config: damm.config });
    // blocker #7: migration runs after graduation, so the mint's TransferHook program and authority must both be unset
    if (graduationPhase(ps) !== 'post') throw new MintHookRefusal(`refusing: DBC pool ${pool.toBase58()} has not graduated (migration progress ${ps.migrationProgress})`);
    await assertMintHook(this.c.connection, new PublicKey(ps.baseMint), 'post', mintHook);
    const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await this.dbc.migration.migrateToDammV2({ payer: payer.publicKey, pool, dammConfig: damm.config });
    return sendTx(this.c, transaction, [payer, firstPositionNftKeypair, secondPositionNftKeypair], 'dbc: migration_damm_v2 (graduation)',
      damm.override ? `overrides: DAMM_V2_MIGRATION_CONFIG=${damm.override}` : undefined);
  }

  async tokenBalance(mint: PublicKey, owner: PublicKey): Promise<bigint> {
    const a = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022);
    const info = await this.c.connection.getAccountInfo(a);
    return info ? unpackAccount(a, info, TOKEN_2022).amount : 0n;
  }

  async status(mint: PublicKey, wallet?: PublicKey, pool?: PublicKey) {
    const mintHookFlagOut = await mintHookFlag(this, mint, pool);   // runs the hook gate; blocker #7 (flags, never throws)
    const conn = this.c.connection;
    const [cfgAcc, liftAcc, globalAcc, slot] = await Promise.all([
      conn.getAccountInfo(this.hook.configPda(mint)), conn.getAccountInfo(this.hook.liftPda(mint)), conn.getAccountInfo(this.hook.globalPda()), conn.getSlot('confirmed'),
    ]);
    const mintInfo = await getMint(conn, mint, 'confirmed', TOKEN_2022);
    const th = getTransferHook(mintInfo);
    const out: any = { cluster: this.c.label, slot, mint: mint.toBase58(), supply: mintInfo.supply.toString(), decimals: mintInfo.decimals,
      mintAuthority: mintInfo.mintAuthority?.toBase58() ?? null, freezeAuthority: mintInfo.freezeAuthority?.toBase58() ?? null,
      transferHookProgram: th && !th.programId.equals(PublicKey.default) ? th.programId.toBase58() : null,
      transferHookAuthority: th && !th.authority.equals(PublicKey.default) ? th.authority.toBase58() : null };
    if (cfgAcc && liftAcc && globalAcc) {
      const cfg = decodeMintConfig(cfgAcc.data); const lift = decodeLift(liftAcc.data); const g = decodeGlobal(globalAcc.data);
      const cc = toCapConfig(cfg);
      const cap = effectiveCap(cc, lift, g.lifted, BigInt(slot));
      Object.assign(out, { launchSlot: cfg.launchSlot.toString(), steps: cfg.steps.map(s => ({ slotOffset: s.slotOffset.toString(), maxBps: s.maxBps })), uncappedAfter: cfg.uncappedAfter.toString(),
        testSlotsBuild: cfg.testSlotsBuild, exemptOwners: cfg.exemptOwners.map(k => k.toBase58()), launcher: cfg.launcher.toBase58(), liftAuthority: g.authority.toBase58(),
        globalLifted: g.lifted, mintLifted: lift.lifted, raisedFloorBps: lift.raisedFloorBps, currentCap: cap === null ? null : cap.toString(),
        nextChange: (() => { if (cap === null) return null; const n = nextChange(cc, BigInt(slot)); return n ? { slot: n.slot.toString(), bps: n.bps } : null; })() });
    }
    out.mintHook = mintHookFlagOut;
    if (wallet) out.walletBalance = (await this.tokenBalance(mint, wallet)).toString();
    return out;
  }
}

export function listLaunches(cluster: string): LaunchRecord[] {
  const d = `launches/${cluster}`; if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(`${d}/${f}`, 'utf8')));
}

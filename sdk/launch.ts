// Meteora DBC transfer-hook pool integration (LOCAL default, DEVNET explicit). No mainnet path.
import BN from 'bn.js';
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram, SendTransactionError } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync, getMint, getTransferHook, unpackAccount } from '@solana/spl-token';
import {
  DynamicBondingCurveClient, buildCurve, deriveDbcPoolAddress, ActivationType, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, TokenAuthorityOption, TokenDecimal, TokenType, SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { HookClient, TOKEN_2022, decodeGlobal, decodeMintConfig, decodeLift, toCapConfig, hookErrorFromLogs, hookCodeFromLogs, capHitDetails, parseRestrictionsLifted } from './hook.js';
import { effectiveCap, nextChange, type Step } from './capMath.js';
import { type Cluster, type ClusterName, explorerTx, nowIct, DEVNET_GENESIS, MAINNET_GENESIS } from './cluster.js';
import { launchConfigChecks, type Authorities } from './keyrules.js';

/** DAMM v2 config used at migration, per cluster (was hard-coded in migrate()).
 *  Pinned values are DBC SDK 1.5.13 `DAMM_V2_MIGRATION_FEE_ADDRESS[FixedBps25]` (the same address on every cluster; the
 *  local validator clones the devnet account). The env override `DAMM_V2_MIGRATION_CONFIG` is a devnet test knob:
 *  on any cluster whose genesis hash is not devnet's (mainnet, a local validator, anything else) it is refused
 *  unless it exactly equals the pinned mainnet value. Resolution happens before any migration tx is built. */
export const DAMM_V2_MIGRATION_CONFIG: Record<ClusterName, string> = {
  devnet: '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd',
  local: '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd', // local validator clones the devnet account
};
export const DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN = '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd';
export class ConfigPinRefusal extends Error {}
export interface DammConfigResolution { config: PublicKey; override: string | null; clusterByGenesis: 'devnet' | 'mainnet' | 'other' }
/** Resolve the migration DAMM v2 config from the RPC's genesis hash (not from a name or URL). Throws ConfigPinRefusal. */
export function resolveDammV2MigrationConfig(genesis: string, name: ClusterName, env: NodeJS.ProcessEnv = process.env): DammConfigResolution {
  const byGenesis = genesis === DEVNET_GENESIS ? 'devnet' : genesis === MAINNET_GENESIS ? 'mainnet' : 'other';
  const raw = env.DAMM_V2_MIGRATION_CONFIG;
  const override = raw !== undefined && raw !== '' ? raw : null;
  const pinned = byGenesis === 'devnet' ? DAMM_V2_MIGRATION_CONFIG.devnet : byGenesis === 'mainnet' ? DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN : DAMM_V2_MIGRATION_CONFIG[name];
  if (override === null) return { config: new PublicKey(pinned), override: null, clusterByGenesis: byGenesis };
  if (byGenesis !== 'devnet' && override !== DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN)
    throw new ConfigPinRefusal(`refusing DAMM_V2_MIGRATION_CONFIG override ${override} on a non-devnet cluster (genesis ${genesis}): only the pinned value ${DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN} is allowed`);
  let pk: PublicKey; try { pk = new PublicKey(override); } catch { throw new ConfigPinRefusal(`DAMM_V2_MIGRATION_CONFIG override is not a valid address: ${override}`); }
  return { config: pk, override, clusterByGenesis: byGenesis };
}
/** Same resolution for a connected cluster (one genesis read). */
export async function dammV2MigrationConfigFor(c: Pick<Cluster, 'name' | 'connection'>, env: NodeJS.ProcessEnv = process.env): Promise<DammConfigResolution> {
  return resolveDammV2MigrationConfig(await c.connection.getGenesisHash(), c.name, env);
}

export interface TxRecord { time: string; cluster: string; label: string; purpose: string; sig: string; ok: boolean; err?: string; hookError?: string | null; hookCode?: number | null; link: string; capHit?: any; events?: any[]; note?: string }

export async function sendTx(c: Cluster, tx: Transaction, signers: Keypair[], purpose: string, note?: string): Promise<TxRecord> {
  const { blockhash, lastValidBlockHeight } = await c.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash; tx.feePayer = signers[0].publicKey;
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
    rec = { time: nowIct(), cluster: c.name, label: c.label, purpose, sig, ok, err: ok ? undefined : JSON.stringify(info?.meta?.err), hookError: hookErrorFromLogs(logs), hookCode: hookCodeFromLogs(logs), link: explorerTx(sig, c.name), capHit: capHitDetails(logs) ?? undefined, events: parseRestrictionsLifted(logs).map(e => ({ ...e, mint: e.mint.toBase58(), signer: e.signer.toBase58(), slot: e.slot.toString() })), note };
    (rec as any).logs = logs;
  } catch (e: any) {
    const logs = e instanceof SendTransactionError ? (e.logs ?? []) : [];
    rec = { time: nowIct(), cluster: c.name, label: c.label, purpose, sig, ok: false, err: String(e?.message ?? e).slice(0, 500), hookError: hookErrorFromLogs(logs), hookCode: hookCodeFromLogs(logs), link: sig ? explorerTx(sig, c.name) : '', note };
  }
  mkdirSync('txlog', { recursive: true });
  const { logs, ...slim } = rec as any;
  appendFileSync(`txlog/${c.name}.jsonl`, JSON.stringify(slim, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
  console.log(`[${c.label}] ${rec.ok ? 'OK  ' : 'FAIL'} ${purpose} ${rec.hookError ? '(' + rec.hookError + ')' : ''} ${rec.link || rec.err}`);
  return rec;
}

export interface LaunchOpts {
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
export interface LaunchRecord { name?: string; symbol?: string; cluster: string; label: string; time: string; programId: string; config: string; pool: string; mint: string; quoteMint: string; steps: { slotOffset: string; maxBps: number }[]; uncappedAfter: string; migrationQuoteThresholdSol: number; fee: any; txs: Record<string, string> }

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

export class Launchpad {
  dbc: DynamicBondingCurveClient;
  hook: HookClient;
  constructor(public c: Cluster, programId?: PublicKey) {
    this.dbc = new DynamicBondingCurveClient(c.connection, 'confirmed');
    this.hook = new HookClient(programId);
  }

  async ensureGlobal(upgradeAuthority: Keypair, liftAuthority: PublicKey) {
    const acc = await this.c.connection.getAccountInfo(this.hook.globalPda());
    if (acc) return decodeGlobal(acc.data);
    const r = await sendTx(this.c, new Transaction().add(this.hook.initializeGlobal(upgradeAuthority.publicKey, liftAuthority)), [upgradeAuthority], 'hook: initialize_global (set lift authority)');
    if (!r.ok) throw new Error('initialize_global failed');
    return decodeGlobal((await this.c.connection.getAccountInfo(this.hook.globalPda()))!.data);
  }

  configParams(o: LaunchOpts) { return curveConfigParams(o); }

  /** Hook upgrade authority (from ProgramData) and lift authority (Global PDA). null when unreadable. */
  async hookAuthorities(): Promise<Authorities> {
    let upgradeAuthority: string | null = null, liftAuthority: string | null = null;
    const prog = await this.c.connection.getAccountInfo(this.hook.programId);
    if (prog && prog.data.length >= 36) {
      const pd = await this.c.connection.getAccountInfo(new PublicKey(prog.data.subarray(4, 36)));
      if (pd && pd.data.length >= 45 && pd.data[12] === 1) upgradeAuthority = new PublicKey(pd.data.subarray(13, 45)).toBase58();
    }
    const g = await this.c.connection.getAccountInfo(this.hook.globalPda());
    if (g) liftAuthority = decodeGlobal(g.data).authority.toBase58();
    return { upgradeAuthority, liftAuthority };
  }

  /** Partner config (transfer hook -> our program) + pool + hook config, by `deployer` (partner = creator = launcher in the beta). */
  async launch(deployer: Keypair, o: LaunchOpts): Promise<LaunchRecord> {
    // §12a preflight (FW-24): feeClaimer (= deployer here) must differ from the hook upgrade and lift authorities.
    // Throws off devnet/local before any tx is built; logs the accepted throwaway exception on devnet/local.
    const auth = o.authorities ?? (await this.hookAuthorities());
    for (const w of launchConfigChecks(this.c.name, deployer.publicKey.toBase58(), auth)) console.warn(w);
    const configKp = Keypair.generate();
    const mintKp = Keypair.generate();
    const txs: Record<string, string> = {};
    const params = this.configParams(o);
    const cfgTx = await this.dbc.partner.createConfigWithTransferHook({
      config: configKp.publicKey, feeClaimer: deployer.publicKey, leftoverReceiver: deployer.publicKey, payer: deployer.publicKey,
      quoteMint: NATIVE_MINT, transferHookProgram: this.hook.programId, ...params,
    } as any);
    const r1 = await sendTx(this.c, cfgTx, [deployer, configKp], `dbc: create_config_with_transfer_hook (${o.symbol})`);
    txs.createConfig = r1.sig; if (!r1.ok) throw new Error('create config failed: ' + r1.err);

    const poolTx = await this.dbc.creator.createPoolWithTransferHook({
      name: o.name, symbol: o.symbol, uri: o.uri ?? 'https://example.invalid/devnet-test.json', payer: deployer.publicKey, poolCreator: deployer.publicKey,
      config: configKp.publicKey, baseMint: mintKp.publicKey, transferHookProgram: this.hook.programId,
    } as any);
    const pool = deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, configKp.publicKey);
    const supplyRef = BigInt(o.totalSupply ?? 1_000_000_000) * 1_000_000n;
    // Same tx: hook config is frozen in the pool-creation slot, so the ramp starts exactly at launch.
    poolTx.add(this.hook.initializeExtraAccountMetaList({ payer: deployer.publicKey, authority: deployer.publicKey, mint: mintKp.publicKey, steps: o.steps, uncappedAfter: o.uncappedAfter, supplyRef }));
    poolTx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
    const r2 = await sendTx(this.c, poolTx, [deployer, mintKp], `dbc: initialize_virtual_pool_with_token2022_transfer_hook + hook: initialize_extra_account_meta_list (${o.symbol})`);
    txs.createPoolAndHookConfig = r2.sig; if (!r2.ok) throw new Error('create pool failed: ' + r2.err);

    const rec: LaunchRecord = {
      name: o.name, symbol: o.symbol, cluster: this.c.name, label: this.c.label, time: nowIct(), programId: this.hook.programId.toBase58(), config: configKp.publicKey.toBase58(), pool: pool.toBase58(), mint: mintKp.publicKey.toBase58(),
      quoteMint: NATIVE_MINT.toBase58(), steps: o.steps.map(s => ({ slotOffset: s.slotOffset.toString(), maxBps: s.maxBps })), uncappedAfter: o.uncappedAfter.toString(),
      migrationQuoteThresholdSol: o.migrationQuoteThresholdSol ?? 1, fee: { mode: 'FeeSchedulerLinear (anti-sniper fee schedule)', ...launchFeeConfig(o) }, txs,
    };
    mkdirSync(`launches/${this.c.name}`, { recursive: true });
    writeFileSync(`launches/${this.c.name}/${rec.mint}.json`, JSON.stringify(rec, null, 2));
    return rec;
  }

  /** Buy exactly `tokens` (base units) or sell `tokens` (base units) via swap2_with_transfer_hook. */
  async swap(owner: Keypair, pool: PublicKey, side: 'buy' | 'sell', tokens: bigint, purpose?: string, maxSolIn?: bigint) {
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
    const tx = await this.dbc.pool.swap2WithTransferHook({ owner: owner.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.PartialFill, amountIn: new BN(lamportsIn.toString()), minimumAmountOut: new BN(0) } as any);
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    return sendTx(this.c, tx, [owner], purpose);
  }

  async migrate(payer: Keypair, pool: PublicKey) {
    const damm = await dammV2MigrationConfigFor(this.c);   // throws ConfigPinRefusal before any tx is built
    const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await this.dbc.migration.migrateToDammV2({ payer: payer.publicKey, pool, dammConfig: damm.config });
    return sendTx(this.c, transaction, [payer, firstPositionNftKeypair, secondPositionNftKeypair], 'dbc: migration_damm_v2 (graduation)',
      damm.override ? `overrides: DAMM_V2_MIGRATION_CONFIG=${damm.override}` : undefined);
  }

  async tokenBalance(mint: PublicKey, owner: PublicKey): Promise<bigint> {
    const a = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022);
    const info = await this.c.connection.getAccountInfo(a);
    return info ? unpackAccount(a, info, TOKEN_2022).amount : 0n;
  }

  async status(mint: PublicKey, wallet?: PublicKey) {
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
    if (wallet) out.walletBalance = (await this.tokenBalance(mint, wallet)).toString();
    return out;
  }
}

export function listLaunches(cluster: string): LaunchRecord[] {
  const d = `launches/${cluster}`; if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(`${d}/${f}`, 'utf8')));
}

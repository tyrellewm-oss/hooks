// Flywheel keeper (spec v1.2.1): claim → split 15/85 → graduation gate → DAMM v2 swap → Token-2022 BurnChecked → log.
// DEVNET ONLY in this build. Every tx: fee payer = gas wallet, SPL memo `flywheel:<run_id>:<stage>`, journaled as
// pending (with its signature) BEFORE it is sent, resolved on restart, never re-sent once landed.
import BN from 'bn.js';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createTransferCheckedInstruction, createBurnCheckedInstruction, unpackAccount, getMint } from '@solana/spl-token';
import { CpAmm, CP_AMM_PROGRAM_ID, derivePositionNftAccount, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { utils as anchorUtils } from '@coral-xyz/anchor';
const bs58 = anchorUtils.bytes.bs58;
import { splitFees, minOut, spotOutBtoA, deviationBps, planSwap, runIdFor, historyWarning, fmtSol, fmtTokens, pctOf } from './math.js';
import type { KeeperConfig, SourceDbc, SourceDamm } from './config.js';
import { Store, durableWrite, ser } from './store.js';
import { keeperStartChecks, KeyRuleRefusal } from '../keyrules.js';
import { assertClusterAccounts, ClusterCheckRefusal } from '../cluster_check.js';
import { classifyCluster } from '../cluster.js';
import { HookClient, decodeGlobal } from '../hook.js';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const stageFail = (stage: string) => (stage.startsWith('claim') ? 'failed_claim' : stage === 'dev' ? 'failed_split' : `failed_${stage}`);
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

// ---------------------------------------------------------------- state
export interface StageRec { status: 'pending' | 'confirmed' | 'failed' | 'expired'; sig: string; lvbh: number; intent: Record<string, string>; result?: Record<string, any>; err?: string }
export interface ClaimLog { source: 'dbc' | 'damm_v2'; pool: string; claimable_before: string; claimed_lamports: string; claimed_vs_read_lamports: string; claimable_after?: string; rent_refund_lamports: string; sig: string; skipped?: string }
export interface RunLog {
  run_id: string; started_at: string; finished_at?: string; status: string; reason: string; overrides: string[]; warnings: string[];
  claims: ClaimLog[]; dev_lamports: string; dev_sig: string; buyback_lamports: string; carryover_lamports: string; carryover_reason: string;
  rent_refund_lamports: string;
  swap?: { route: string; pool: string; in_lamports: string; min_out_raw: string; out_raw: string; quote_out_raw: string; spot_out_raw: string; slippage_bps: number; price_impact_bps: number; spot_deviation_bps: number; halvings: number; forced_fail: boolean; sig: string; status: string };
  burn?: { burned_raw: string; tx_supply_change_raw: string; token_delta_raw: string; supply_before: string; supply_after: string; verified: boolean; sig: string };
  reconcile?: Record<string, string | boolean>;
  gas_lamports: string; txs: string[]; stages: Record<string, StageRec>;
  /** set while the run is stopped by a mid-run pause (the stage it stopped before); history kept in midrun_pauses */
  stopped_before?: string; midrun_pauses?: { at: string; before: string; by: string }[];
}
export interface KeeperState {
  version: 1; name: string; cluster: string; mint: string; decimals: number;
  pending_lamports: string; unsplit_lamports: string; unburned_raw: string;
  totals: { claimed_lamports: string; dev_lamports: string; spent_lamports: string; burned_raw: string; gas_lamports: string; rent_refund_lamports: string };
  dev_baseline_raw: string | null; first_supply_raw: string | null; last_supply_raw: string | null;
  consecutive_failures: number; paused: boolean; pause_reason: string;
  price_history_x1e9: string[]; burns: { at: string; tokens: string; sol: string; sig: string; run_id: string; burned_raw: string; in_lamports: string }[];
  current: RunLog | null; runs: RunLog[];
}
export const initState = (cfg: KeeperConfig): KeeperState => ({
  version: 1, name: cfg.name, cluster: cfg.cluster, mint: cfg.main_mint, decimals: cfg.main_decimals,
  pending_lamports: '0', unsplit_lamports: '0', unburned_raw: '0',
  totals: { claimed_lamports: '0', dev_lamports: '0', spent_lamports: '0', burned_raw: '0', gas_lamports: '0', rent_refund_lamports: '0' },
  dev_baseline_raw: null, first_supply_raw: null, last_supply_raw: null, consecutive_failures: 0, paused: false, pause_reason: '',
  price_history_x1e9: [], burns: [], current: null, runs: [],
});
const B = (s: string | undefined | null) => BigInt(s ?? '0');
const add = (a: string, b: bigint) => (B(a) + b).toString();

// ---------------------------------------------------------------- errors
export class FailClosed extends Error { constructor(public code: string, msg: string, public pause = false) { super(msg); } }
/** A pause seen immediately before a send: nothing was built, signed, journaled or sent for `stage`. Not a failure. */
export class PausedMidrun extends FailClosed { constructor(public stage: string, public by: string) { super('paused_midrun', `paused (${by}) before ${stage}; nothing sent`); } }

// ---------------------------------------------------------------- startup (pure first, then network)
export interface KeySet { claim: Keypair; treasury: Keypair; dev: Keypair; gas: Keypair }
export interface StartDeps { loadKey: (name: string) => Keypair; connect: (cfg: KeeperConfig) => Promise<Connection>; log?: (s: string) => void }
/** Refusals that need no network (FW-22, FW-23). Throws KeyRuleRefusal; returns warnings (FW-25 on devnet). */
export function preflightOffline(cfg: KeeperConfig, keys: KeySet): string[] {
  const keeperKeys = { claim_signer: keys.claim.publicKey.toBase58(), treasury: keys.treasury.publicKey.toBase58(), gas: keys.gas.publicKey.toBase58() };
  const warnings = keeperStartChecks(cfg.cluster, keeperKeys, { upgradeAuthority: cfg.hook_upgrade_authority, liftAuthority: cfg.hook_lift_authority }, { forceFailSwap: !!cfg.force_fail_swap });
  if (cfg.cluster !== 'devnet' && cfg.cluster !== 'local') throw new KeyRuleRefusal(`refusing to start: this keeper build is devnet-only (cluster=${cfg.cluster})`);
  if (cfg.pinned_pubkeys) for (const [role, pk] of Object.entries(cfg.pinned_pubkeys)) {
    const k = (keys as any)[role === 'claim_signer' ? 'claim' : role] as Keypair | undefined;
    if (pk && k && k.publicKey.toBase58() !== pk) throw new KeyRuleRefusal(`refusing to start: key '${role}' does not match pinned pubkey`);
  }
  return warnings;
}
export async function startKeeper(cfg: KeeperConfig, overrides: string[], deps: StartDeps): Promise<Keeper> {
  const keys: KeySet = { claim: deps.loadKey(cfg.keys.claim_signer), treasury: deps.loadKey(cfg.keys.treasury), dev: deps.loadKey(cfg.keys.dev), gas: deps.loadKey(cfg.keys.gas) };
  const warnings = preflightOffline(cfg, keys);           // throws before any connection exists
  const conn = await deps.connect(cfg);
  const genesis = await conn.getGenesisHash();
  if (genesis === MAINNET_GENESIS) throw new KeyRuleRefusal('refusing: RPC is mainnet-beta');
  if (cfg.cluster === 'devnet' && genesis !== DEVNET_GENESIS) throw new KeyRuleRefusal(`refusing: not devnet (genesis ${genesis})`);
  if (cfg.cluster === 'local' && classifyCluster(genesis, (conn as any).rpcEndpoint) !== 'local') throw new KeyRuleRefusal('refusing: not a local validator (needs a localhost RPC URL and a genesis that is not devnet/mainnet/testnet)');
  // cluster check (fail closed): the hook program is executable here and every DBC source config is owned by DBC
  try {
    await assertClusterAccounts(conn, { hookProgram: new PublicKey(cfg.hook_program), dbcConfigs: cfg.sources.flatMap(s => (s.kind === 'dbc' ? [new PublicKey(s.config)] : [])) });
  } catch (e: any) { throw e instanceof ClusterCheckRefusal ? new KeyRuleRefusal(e.message) : e; }
  // pinned authorities must match the chain (they feed the §12a check)
  const hc = new HookClient(new PublicKey(cfg.hook_program));
  const prog = await conn.getAccountInfo(hc.programId);
  const pd = prog && (await conn.getAccountInfo(new PublicKey(prog.data.subarray(4, 36))));
  const upg = pd && pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
  const g = await conn.getAccountInfo(hc.globalPda());
  const lift = g ? decodeGlobal(g.data).authority.toBase58() : null;
  if (upg !== cfg.hook_upgrade_authority || lift !== cfg.hook_lift_authority) throw new KeyRuleRefusal(`refusing: pinned hook authorities do not match chain (upgrade ${upg}, lift ${lift})`);
  for (const w of warnings) (deps.log ?? console.log)(w);
  return new Keeper(cfg, overrides, conn, keys, warnings, deps.log ?? console.log);
}

// ---------------------------------------------------------------- keeper
export interface RunOutcome { run_id: string; status: string; reason: string; txs: string[] }
export class Keeper {
  store: Store; cp: CpAmm; dbc: DynamicBondingCurveClient; mint: PublicKey; mainProg: PublicKey;
  tWsol: PublicKey; tMain: PublicKey; dWsol: PublicKey;
  /** devnet test knobs only: crash after a stage (FW-8), corrupt spot read (FW-14), break log path (FW-14). */
  faults: { crashAfter?: string; crashSend?: string; spotSkew?: boolean };
  constructor(public cfg: KeeperConfig, public overrides: string[], public conn: Connection, public keys: KeySet, public startWarnings: string[], public log: (s: string) => void) {
    this.store = new Store(cfg.state_dir);
    this.cp = new CpAmm(conn); this.dbc = new DynamicBondingCurveClient(conn, 'confirmed');
    this.mint = new PublicKey(cfg.main_mint); this.mainProg = new PublicKey(cfg.main_token_program);
    const T = keys.treasury.publicKey;
    this.tWsol = getAssociatedTokenAddressSync(NATIVE_MINT, T, false, TOKEN_PROGRAM_ID);
    this.tMain = getAssociatedTokenAddressSync(this.mint, T, false, this.mainProg);
    this.dWsol = getAssociatedTokenAddressSync(NATIVE_MINT, keys.dev.publicKey, false, TOKEN_PROGRAM_ID);
    const f = process.env.FW_FAULT ?? '';
    if (f === 'rpc_down') {   // devnet fault injection: every RPC after startup fails (FW-14)
      if (cfg.cluster !== 'devnet') throw new KeyRuleRefusal('test knobs are devnet-only');
      this.conn = new Connection('http://127.0.0.1:9', 'confirmed'); this.cp = new CpAmm(this.conn); this.dbc = new DynamicBondingCurveClient(this.conn, 'confirmed');
    }
    this.faults = { crashAfter: f.startsWith('crash_after:') ? f.slice(12) : undefined, crashSend: f.startsWith('crash_send:') ? f.slice(11) : undefined, spotSkew: f === 'spot_skew' };
    if ((this.faults.crashAfter || this.faults.crashSend || this.faults.spotSkew || cfg.force_fail_swap) && cfg.cluster !== 'devnet') throw new KeyRuleRefusal('test knobs are devnet-only');
  }

  // ---------- persistence helpers (a failed write = fail closed)
  private save(s: KeeperState) { this.store.saveState(s); }
  publish(s: KeeperState) { durableWrite(this.cfg.public_log, ser(publicLog(s, this.cfg))); }

  // ---------- chain reads
  private async tokenAmt(ata: PublicKey, prog = TOKEN_PROGRAM_ID): Promise<bigint> {
    const ai = await this.conn.getAccountInfo(ata, 'confirmed');
    if (!ai) throw new FailClosed('missing_account', `token account ${ata.toBase58()} missing (run setup)`);
    return unpackAccount(ata, ai, prog).amount;
  }
  private async supply(): Promise<bigint> { return (await getMint(this.conn, this.mint, 'confirmed', this.mainProg)).supply; }

  // ---------- tx plumbing
  private memo(runId: string, stage: string) { return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(`flywheel:${runId}:${stage}`) }); }
  /** Journal-first send. Returns the confirmed parsed tx, or throws FailClosed. Never re-sends a stage that has a sig unless that sig is provably expired and never landed. */
  private async sendStage(s: KeeperState, run: RunLog, stage: string, ixs: TransactionInstruction[], signers: Keypair[], intent: Record<string, string>, opts: { skipPreflight?: boolean } = {}): Promise<ParsedTransactionWithMeta> {
    // pause gate before EVERY send (claim, dev, swap, burn): same sources as the run-start check
    const by = this.pauseSource(s);
    if (by) throw new PausedMidrun(stage, by);
    const prev = run.stages[stage];
    if (prev && prev.status === 'confirmed') throw new Error(`BUG: stage ${stage} already confirmed`);
    if (prev && prev.status === 'pending') throw new Error(`BUG: stage ${stage} pending must be resolved first`);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), this.memo(run.run_id, stage), ...ixs);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash; tx.feePayer = this.keys.gas.publicKey;
    const uniq = [this.keys.gas, ...signers.filter(k => !k.publicKey.equals(this.keys.gas.publicKey))].filter((k, i, a) => a.findIndex(x => x.publicKey.equals(k.publicKey)) === i);
    tx.sign(...uniq);
    const sig = bs58.encode(tx.signature!);
    // journal BEFORE send
    run.stages[stage] = { status: 'pending', sig, lvbh: lastValidBlockHeight, intent };
    this.store.journal({ run_id: run.run_id, stage, status: 'pending', sig, lvbh: lastValidBlockHeight, intent });
    this.save(s);
    try {
      await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: !!opts.skipPreflight, maxRetries: 5, preflightCommitment: 'confirmed' });
    } catch (e: any) {
      // preflight rejection: nothing was broadcast with this blockhash+sig → mark failed (cannot land: never sent)
      run.stages[stage].status = 'failed'; run.stages[stage].err = `preflight: ${String(e?.message ?? e).slice(0, 300)}`;
      this.store.journal({ run_id: run.run_id, stage, status: 'failed', sig, err: run.stages[stage].err }); this.save(s);
      throw new FailClosed(stageFail(stage), `${stage} rejected in preflight: ${run.stages[stage].err}`);
    }
    if (this.faults.crashSend === stage) { this.log(`FW_FAULT crash_send:${stage} → exiting after send, before confirmation (devnet test)`); process.exit(98); }
    return this.awaitStage(s, run, stage);
  }
  /** Resolve a pending stage: wait for its sig; confirmed → return tx; landed with error → failed; expired & not landed → expired. */
  private async awaitStage(s: KeeperState, run: RunLog, stage: string): Promise<ParsedTransactionWithMeta> {
    const st = run.stages[stage];
    for (let i = 0; i < 90; i++) {
      const r = (await this.conn.getSignatureStatuses([st.sig], { searchTransactionHistory: true })).value[0];
      if (r && (r.confirmationStatus === 'confirmed' || r.confirmationStatus === 'finalized')) {
        let tx: ParsedTransactionWithMeta | null = null;
        for (let j = 0; j < 15 && !tx; j++) { tx = await this.conn.getParsedTransaction(st.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!tx) await sleep(1000); }
        if (!tx) throw new FailClosed('rpc_error', `tx ${st.sig} confirmed but not fetchable yet; stage stays pending`);
        if (!tx.transaction.message.accountKeys[0].pubkey.equals(this.keys.gas.publicKey)) throw new FailClosed('fee_payer_mismatch', `fee payer of ${stage} is not the gas wallet`, true);
        run.gas_lamports = add(run.gas_lamports, BigInt(tx.meta?.fee ?? 0)); s.totals.gas_lamports = add(s.totals.gas_lamports, BigInt(tx.meta?.fee ?? 0));
        run.txs.push(st.sig);
        if (tx.meta?.err) {
          st.status = 'failed'; st.err = JSON.stringify(tx.meta.err);
          this.store.journal({ run_id: run.run_id, stage, status: 'failed', sig: st.sig, err: st.err }); this.save(s);
          throw new FailClosed(stageFail(stage), `${stage} landed with error ${st.err}`);
        }
        return tx; // caller applies the effect and marks confirmed in the same save
      }
      const h = await this.conn.getBlockHeight('confirmed');
      if (!r && h > st.lvbh + 5) {
        st.status = 'expired'; this.store.journal({ run_id: run.run_id, stage, status: 'expired', sig: st.sig }); this.save(s);
        throw new FailClosed('expired', `${stage} sig ${st.sig} expired without landing; will retry with the same amounts`);
      }
      await sleep(2000);
    }
    throw new FailClosed('rpc_error', `${stage} still unresolved; stays pending`);
  }
  private confirm(s: KeeperState, run: RunLog, stage: string, result: Record<string, any>) {
    const st = run.stages[stage]; st.status = 'confirmed'; st.result = result;
    this.store.journal({ run_id: run.run_id, stage, status: 'confirmed', sig: st.sig, result });
    this.save(s);
    if (this.faults.crashAfter === stage) { this.log(`FW_FAULT crash_after:${stage} → exiting (devnet test)`); process.exit(97); }
  }
  private tokenDelta(tx: ParsedTransactionWithMeta, ata: PublicKey): bigint {
    const idx = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.equals(ata));
    if (idx < 0) return 0n;
    const pre = tx.meta?.preTokenBalances?.find(b => b.accountIndex === idx)?.uiTokenAmount.amount ?? '0';
    const post = tx.meta?.postTokenBalances?.find(b => b.accountIndex === idx)?.uiTokenAmount.amount ?? '0';
    return BigInt(post) - BigInt(pre);
  }
  private lamportDelta(tx: ParsedTransactionWithMeta, key: PublicKey): bigint {
    const idx = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.equals(key));
    if (idx < 0) return 0n;
    return BigInt(tx.meta!.postBalances[idx]) - BigInt(tx.meta!.preBalances[idx]);
  }

  // ---------- pinned checks (any mismatch → fail closed + auto-pause)
  private async pinnedChecks() {
    const c = this.cfg;
    const mintAi = await this.conn.getAccountInfo(this.mint, 'confirmed');
    if (!mintAi) throw new FailClosed('rpc_error', 'mint unreadable');
    if (!mintAi.owner.equals(this.mainProg)) throw new FailClosed('mismatch_mint_program', `mint owner ${mintAi.owner.toBase58()} != pinned ${c.main_token_program}`, true);
    const m = await getMint(this.conn, this.mint, 'confirmed', this.mainProg);
    if (m.decimals !== c.main_decimals) throw new FailClosed('mismatch_decimals', `decimals ${m.decimals} != ${c.main_decimals}`, true);
    const mainPool: any = await dbcPool(this.dbc, new PublicKey(c.main_dbc_pool));
    if (!mainPool) throw new FailClosed('mismatch_pool', 'main DBC pool not found', true);
    if (!mainPool.baseMint.equals(this.mint)) throw new FailClosed('mismatch_pool', 'main DBC pool base mint != main mint', true);
    if (c.route_pool) {
      const p: any = await this.cp.fetchPoolState(new PublicKey(c.route_pool)).catch(() => null);
      if (!p) throw new FailClosed('mismatch_pool', `route pool ${c.route_pool} is not a DAMM v2 pool`, true);
      if (!p.tokenAMint.equals(this.mint) || !p.tokenBMint.equals(NATIVE_MINT)) throw new FailClosed('mismatch_pool', 'route pool mints != (main mint, WSOL)', true);
      if (p.tokenAFlag !== (this.mainProg.equals(TOKEN_2022_PROGRAM_ID) ? 1 : 0) || p.tokenBFlag !== 0) throw new FailClosed('mismatch_pool', 'route pool token programs unexpected', true);
    }
    for (const src of c.sources) {
      if (src.kind === 'damm_v2') {
        const pos: any = await this.cp.fetchPositionState(new PublicKey(src.position));
        if (!pos.nftMint.equals(new PublicKey(src.position_nft_mint)) || !pos.pool.equals(new PublicKey(src.pool))) throw new FailClosed('mismatch_position', 'position nft/pool != pinned', true);
        const nftAcc = derivePositionNftAccount(new PublicKey(src.position_nft_mint));
        const ai = await this.conn.getAccountInfo(nftAcc, 'confirmed');
        const acc = ai && unpackAccount(nftAcc, ai, TOKEN_2022_PROGRAM_ID);
        if (!acc || acc.amount !== 1n || !acc.owner.equals(this.keys.claim.publicKey)) throw new FailClosed('mismatch_position', 'position NFT not held by the claim signer', true);
      } else {
        const cfgAcc: any = unwrapAcc(await this.dbc.state.getPoolConfig(new PublicKey(src.config)));
        const sp: any = await dbcPool(this.dbc, new PublicKey(src.pool));
        if (!sp || !sp.config.equals(new PublicKey(src.config)) || !sp.baseMint.equals(new PublicKey(src.base_mint))) throw new FailClosed('mismatch_pool', 'DBC source pool config/base mint != pinned', true);
        if (!cfgAcc.feeClaimer.equals(this.keys.claim.publicKey)) throw new FailClosed('mismatch_fee_claimer', 'DBC config fee_claimer != claim signer', true);
      }
    }
  }

  /** The single pause check, used at run start and immediately before every send. '' = not paused.
   *  Sources: config/env flag (FW_PAUSED, also re-read live), PAUSE file, sticky state pause (auto-pause or an earlier pause). */
  pauseSource(s?: KeeperState): string {
    if (this.cfg.paused || process.env.FW_PAUSED === '1') return 'config/env flag';
    if (this.store.pausedByFile()) return 'PAUSE file';
    if (s?.paused) return `auto-pause: ${s.pause_reason}`;
    return '';
  }

  // ---------- one run
  async runOnce(nowMs = Date.now()): Promise<RunOutcome> {
    const s = this.store.loadState(() => initState(this.cfg));
    const runId = runIdFor(this.cfg.cluster, nowMs, this.cfg.cadence_seconds);
    // pause = zero txs, and no RPC calls that could send anything
    const pausedBy = this.pauseSource(s);
    if (pausedBy) {
      if (!s.runs.some(r => r.run_id === runId)) s.runs.push(newRun(runId, this.overrides, 'paused', pausedBy));
      if (!pausedBy.startsWith('auto-pause')) { s.paused = true; s.pause_reason ||= pausedBy; }
      this.save(s); this.publish(s);
      this.log(`[${runId}] paused (${pausedBy}) — zero txs`);
      return { run_id: runId, status: 'paused', reason: pausedBy, txs: [] };
    }
    let run: RunLog;
    if (s.current) {
      run = s.current; this.log(`[${run.run_id}] resuming in-progress run (status ${run.status}${run.stopped_before ? `, stopped before ${run.stopped_before}` : ''})`);
      if (run.status === 'paused_midrun') { run.status = 'planned'; run.reason = ''; delete run.stopped_before; }   // amounts are re-planned from state below
    }
    else {
      if (s.runs.some(r => r.run_id === runId)) { this.log(`[${runId}] window already ran — no-op, zero txs`); return { run_id: runId, status: 'noop_window_done', reason: 'window already ran', txs: [] }; }
      run = newRun(runId, this.overrides, 'planned', ''); run.warnings.push(...this.startWarnings); s.current = run;
    }
    try {
      this.save(s);   // log must be writable before anything is sent
      this.publish(s);
    } catch (e: any) {
      s.current = null; return this.finishFail(s, run, new FailClosed('failed_log', `log write failed before any tx: ${e.message}`), false);
    }
    try {
      await this.resolvePending(s, run);
      await this.pinnedChecks();
      const gas = BigInt(await this.conn.getBalance(this.keys.gas.publicKey, 'confirmed'));
      if (gas < B(this.cfg.gas_min_lamports)) throw new FailClosed('gas_low', `gas wallet ${fmtSol(gas)} SOL < min ${fmtSol(B(this.cfg.gas_min_lamports))}`);
      if (s.dev_baseline_raw === null) { s.dev_baseline_raw = (await this.tokenAmt(this.dWsol)).toString(); }
      if (s.first_supply_raw === null) { s.first_supply_raw = (await this.supply()).toString(); }
      this.save(s);
      // 1. claims
      for (const src of this.cfg.sources) await this.claim(s, run, src);
      // 2. split
      await this.split(s, run);
      // 3. gate
      const main: any = await dbcPool(this.dbc, new PublicKey(this.cfg.main_dbc_pool));
      if (!main.isMigrated) {
        run.status = 'waiting_for_graduation'; run.reason = 'main token DBC pool isMigrated = 0: no swap, buyback held';
        run.carryover_lamports = s.pending_lamports; run.carryover_reason = 'waiting_for_graduation';
        await this.reconcile(s, run);
        return this.finishOk(s, run);
      }
      // 4. swap + 5. burn
      if (B(s.pending_lamports) > 0n || run.stages.swap) await this.swapAndBurn(s, run);
      else { run.status = run.claims.some(c => !c.skipped) ? 'logged' : 'noop'; run.reason ||= 'nothing pending to swap'; }
      await this.reconcile(s, run);
      if (run.status === 'planned') run.status = 'logged';
      return this.finishOk(s, run);
    } catch (e: any) {
      if (e instanceof PausedMidrun) return this.finishPausedMidrun(s, run, e);
      if (Object.values(run.stages).some(x => x.status === 'pending')) {
        run.status = 'pending'; run.reason = e.message; try { this.save(s); this.publish(s); } catch {}
        this.log(`[${run.run_id}] PENDING: ${e.message}`);
        return { run_id: run.run_id, status: 'pending', reason: e.message, txs: run.txs };
      }
      const fc = e instanceof FailClosed ? e : new FailClosed(/fetch failed|ECONN|timeout|429|50\d|getaddrinfo/i.test(String(e?.message)) ? 'failed_rpc' : 'failed_internal', String(e?.message ?? e).slice(0, 400));
      return this.finishFail(s, run, fc, true);
    }
  }

  private async resolvePending(s: KeeperState, run: RunLog) {
    for (const [stage, st] of Object.entries(run.stages)) {
      if (st.status !== 'pending') continue;
      this.log(`[${run.run_id}] resolving pending ${stage} ${st.sig}`);
      const tx = await this.awaitStage(s, run, stage).catch(e => { if (e instanceof FailClosed && (e.code === 'expired' || e.code.startsWith('failed_'))) return null; throw e; });
      if (tx) this.applyEffect(s, run, stage, tx);
    }
  }
  /** Effects keyed by stage; applied exactly once (stage flips to confirmed in the same durable save). */
  private applyEffect(s: KeeperState, run: RunLog, stage: string, tx: ParsedTransactionWithMeta) {
    const st = run.stages[stage]; const it = st.intent;
    if (stage.startsWith('claim_')) {
      const claimed = this.tokenDelta(tx, this.tWsol);
      const mainDelta = this.tokenDelta(tx, this.tMain);
      if (claimed < 0n) throw new FailClosed('reconcile_mismatch', `${stage}: treasury wSOL went down`, true);
      if (mainDelta !== 0n) throw new FailClosed('direct_burn_input', `${stage}: main-token fee arrived (${mainDelta}); no direct-burn path exists (FW-19)`, true);
      const rent = this.lamportDelta(tx, this.keys.treasury.publicKey); // treasury native lamports: 0 with pre-created ATAs (FW-20)
      if (stage === 'claim_dbc' && claimed !== B(it.max_quote)) throw new FailClosed('claim_mismatch', `claim_dbc moved ${claimed} != max ${it.max_quote}`, true);
      s.unsplit_lamports = add(s.unsplit_lamports, claimed); s.totals.claimed_lamports = add(s.totals.claimed_lamports, claimed);
      s.totals.rent_refund_lamports = add(s.totals.rent_refund_lamports, rent); run.rent_refund_lamports = add(run.rent_refund_lamports, rent);
      const c = run.claims.find(x => x.source === it.source && x.pool === it.pool)!;
      c.claimed_lamports = claimed.toString(); c.claimed_vs_read_lamports = (claimed - B(c.claimable_before)).toString(); c.rent_refund_lamports = rent.toString(); c.sig = st.sig;
      this.confirm(s, run, stage, { claimed_lamports: claimed.toString(), rent_refund_lamports: rent.toString(), slot: tx.slot });
    } else if (stage === 'dev') {
      const dev = B(it.dev), bb = B(it.buyback);
      const dDelta = this.tokenDelta(tx, this.dWsol), tDelta = this.tokenDelta(tx, this.tWsol);
      if (dDelta !== dev || tDelta !== -dev) throw new FailClosed('reconcile_mismatch', `dev transfer deltas dev=${dDelta} treasury=${tDelta} expected ±${dev}`, true);
      s.totals.dev_lamports = add(s.totals.dev_lamports, dev); s.pending_lamports = add(s.pending_lamports, bb); s.unsplit_lamports = (B(s.unsplit_lamports) - dev - bb).toString();
      run.dev_lamports = dev.toString(); run.buyback_lamports = bb.toString(); run.dev_sig = st.sig;
      this.confirm(s, run, stage, { dev, buyback: bb });
    } else if (stage === 'swap') {
      const inL = B(it.in_lamports);
      const w = this.tokenDelta(tx, this.tWsol), out = this.tokenDelta(tx, this.tMain);
      if (w !== -inL) throw new FailClosed('reconcile_mismatch', `swap wSOL delta ${w} != -${inL}`, true);
      if (out < B(it.min_out_raw) || out <= 0n) throw new FailClosed('reconcile_mismatch', `swap out ${out} < min_out ${it.min_out_raw}`, true);
      s.pending_lamports = (B(s.pending_lamports) - inL).toString(); s.totals.spent_lamports = add(s.totals.spent_lamports, inL); s.unburned_raw = add(s.unburned_raw, out);
      s.price_history_x1e9.push(((out * 1_000_000_000n) / inL).toString()); s.price_history_x1e9 = s.price_history_x1e9.slice(-20);
      run.swap!.out_raw = out.toString(); run.swap!.sig = st.sig; run.swap!.status = 'confirmed';
      this.confirm(s, run, stage, { out_raw: out.toString() });
    } else if (stage === 'burn') {
      const amt = B(it.amount);
      const delta = this.tokenDelta(tx, this.tMain);
      const ixs = tx.transaction.message.instructions as any[];
      const burns = ixs.filter(i => i.programId?.equals?.(TOKEN_2022_PROGRAM_ID) && i.parsed?.type === 'burnChecked');
      const others = ixs.filter(i => i.programId?.equals?.(TOKEN_2022_PROGRAM_ID) && i.parsed?.type !== 'burnChecked');
      const parsedAmt = burns.length === 1 && burns[0].parsed.info.mint === this.cfg.main_mint ? B(burns[0].parsed.info.tokenAmount.amount) : -1n;
      const verified = parsedAmt === amt && delta === -amt && others.length === 0;
      run.burn = { ...run.burn!, burned_raw: amt.toString(), tx_supply_change_raw: (parsedAmt >= 0n ? -parsedAmt : 0n).toString(), token_delta_raw: delta.toString(), verified, sig: st.sig };
      if (!verified) { this.confirm(s, run, stage, { verified: false }); throw new FailClosed('burn_mismatch', `burn tx not a single exact BurnChecked: parsed=${parsedAmt} delta=${delta} expected=${amt}`, true); }
      s.unburned_raw = (B(s.unburned_raw) - amt).toString(); s.totals.burned_raw = add(s.totals.burned_raw, amt);
      s.burns.push({ at: new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString(), tokens: fmtTokens(amt, this.cfg.main_decimals), sol: fmtSol(B(run.swap!.in_lamports)), sig: st.sig, run_id: run.run_id, burned_raw: amt.toString(), in_lamports: run.swap!.in_lamports });
      this.confirm(s, run, stage, { burned_raw: amt.toString(), verified });
    } else throw new Error(`unknown stage ${stage}`);
  }

  /** One claim per source. The DBC partner claim (`claim_trading_fee2`) works both before and after graduation (devnet TDT:
   *  claimed after migration); the DAMM v2 position claim collects the post-graduation pool's LP fees. */
  private async claim(s: KeeperState, run: RunLog, src: SourceDbc | SourceDamm) {
    const stage = src.kind === 'dbc' ? 'claim_dbc' : 'claim_damm';
    if (run.stages[stage]?.status === 'confirmed' || run.claims.find(c => c.source === src.kind && c.skipped)) return;
    const min = B(this.cfg.min_claim_lamports);
    let claimable: bigint; let ixs: TransactionInstruction[]; let intent: Record<string, string>;
    if (src.kind === 'dbc') {
      const pool: any = await dbcPool(this.dbc, new PublicKey(src.pool));
      claimable = BigInt(pool.partnerQuoteFee.toString());
      ixs = [await this.dbcClaimIx(src, claimable)];
      intent = { source: 'dbc', pool: src.pool, max_quote: claimable.toString() };
    } else {
      const pool: any = await this.cp.fetchPoolState(new PublicKey(src.pool));
      const pos: any = await this.cp.fetchPositionState(new PublicKey(src.position));
      const fee = getUnClaimLpFee(pool, pos);
      claimable = BigInt(fee.feeTokenB.toString());
      if (BigInt(fee.feeTokenA.toString()) !== 0n) run.warnings.push(`damm_v2 fee A ${fee.feeTokenA.toString()} != 0 (unexpected for OnlyB)`);
      ixs = [await this.dammClaimIx(src, pool)];
      intent = { source: 'damm_v2', pool: src.pool, claimable_before: claimable.toString() };
    }
    const entry: ClaimLog = { source: src.kind, pool: src.pool, claimable_before: claimable.toString(), claimed_lamports: '0', claimed_vs_read_lamports: '0', rent_refund_lamports: '0', sig: '' };
    run.claims = run.claims.filter(c => !(c.source === src.kind && c.pool === src.pool)); run.claims.push(entry);
    if (claimable < min || claimable === 0n) { entry.skipped = `below minimum (${claimable} < ${min})`; this.save(s); return; }
    if (run.stages[stage]?.status === 'expired' || run.stages[stage]?.status === 'failed') delete run.stages[stage];
    const tx = await this.sendStage(s, run, stage, ixs, [this.keys.claim], intent);
    this.applyEffect(s, run, stage, tx);
    // claimable at/after the claim slot
    if (src.kind === 'dbc') { const p: any = await dbcPool(this.dbc, new PublicKey(src.pool)); entry.claimable_after = p.partnerQuoteFee.toString(); }
    else { const p: any = await this.cp.fetchPoolState(new PublicKey(src.pool)); const pos: any = await this.cp.fetchPositionState(new PublicKey(src.position)); entry.claimable_after = getUnClaimLpFee(p, pos).feeTokenB.toString(); }
    this.save(s);
  }
  async dbcClaimIx(src: SourceDbc, maxQuote: bigint): Promise<TransactionInstruction> {
    const partner: any = this.dbc.partner;
    const pool: any = await dbcPool(this.dbc, new PublicKey(src.pool));
    const baseMint = new PublicKey(src.base_mint);
    const baseAta = getAssociatedTokenAddressSync(baseMint, this.keys.treasury.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const { info, accounts } = await partner.getRemainingAccountsForTransferHook(baseMint);
    return partner.program.methods.claimTradingFee2(new BN(0), new BN(maxQuote.toString()), info).accountsPartial({
      poolAuthority: partner.poolAuthority, config: new PublicKey(src.config), pool: new PublicKey(src.pool),
      tokenAAccount: baseAta, tokenBAccount: this.tWsol, baseVault: pool.baseVault, quoteVault: pool.quoteVault,
      baseMint, quoteMint: NATIVE_MINT, feeClaimer: this.keys.claim.publicKey, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
    }).remainingAccounts(accounts).instruction();
  }
  async dammClaimIx(src: SourceDamm, pool: any): Promise<TransactionInstruction> {
    return (this.cp as any).buildClaimPositionFeeInstruction({
      owner: this.keys.claim.publicKey, poolAuthority: (this.cp as any).poolAuthority, pool: new PublicKey(src.pool), position: new PublicKey(src.position),
      positionNftAccount: derivePositionNftAccount(new PublicKey(src.position_nft_mint)),
      tokenAAccount: this.tMain, tokenBAccount: this.tWsol, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault,
      tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
    });
  }

  private async split(s: KeeperState, run: RunLog) {
    if (run.stages.dev?.status === 'confirmed') return;
    const unsplit = B(s.unsplit_lamports);
    if (unsplit === 0n) return;
    const { dev, buyback } = splitFees(unsplit);
    if (dev === 0n) { s.pending_lamports = add(s.pending_lamports, buyback); s.unsplit_lamports = '0'; run.buyback_lamports = buyback.toString(); this.save(s); return; }
    if (run.stages.dev && run.stages.dev.status !== 'pending') delete run.stages.dev;
    const ix = createTransferCheckedInstruction(this.tWsol, NATIVE_MINT, this.dWsol, this.keys.treasury.publicKey, dev, 9, [], TOKEN_PROGRAM_ID);
    const tx = await this.sendStage(s, run, 'dev', [ix], [this.keys.treasury], { dev: dev.toString(), buyback: buyback.toString(), unsplit: unsplit.toString() });
    this.applyEffect(s, run, 'dev', tx);
  }

  /** Quote via the SDK on a fresh pool read; spot from an independent fresh read immediately before (hard check). */
  async quote(inLamports: bigint): Promise<{ out: bigint; impactBps: number; spotOut: bigint; pool: any }> {
    const poolPk = new PublicKey(this.cfg.route_pool!);
    const spotPool: any = await this.cp.fetchPoolState(poolPk);
    let sqrtP = BigInt(spotPool.sqrtPrice.toString());
    if (this.faults.spotSkew) sqrtP = (sqrtP * 90n) / 100n;   // devnet fault injection: spot read off by ~23%
    const spotOut = spotOutBtoA(inLamports, sqrtP);
    const pool: any = await this.cp.fetchPoolState(poolPk);
    const slot = await this.conn.getSlot('confirmed');
    const time = (await this.conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    const q = this.cp.getQuote({ inAmount: new BN(inLamports.toString()), inputTokenMint: NATIVE_MINT, slippage: 0, poolState: pool, currentTime: time, currentSlot: slot, tokenADecimal: this.cfg.main_decimals, tokenBDecimal: 9 } as any);
    const out = BigInt(q.swapOutAmount.toString());
    const impactBps = Math.ceil(Number(q.priceImpact.toString()) * 100);
    return { out, impactBps, spotOut, pool };
  }

  private async swapAndBurn(s: KeeperState, run: RunLog) {
    const c = this.cfg;
    if (run.stages.swap?.status !== 'confirmed') {
      if (run.stages.swap && run.stages.swap.status !== 'pending') delete run.stages.swap;
      const pending = B(s.pending_lamports);
      let last: Awaited<ReturnType<Keeper['quote']>> | null = null;
      const plan = await planSwap(pending, B(c.max_swap_lamports_per_run), c.max_price_impact_bps, c.max_halvings, async inL => { last = await this.quote(inL); return { out: last.out, impactBps: last.impactBps }; })
        .catch(e => { throw new FailClosed('failed_price', String(e.message)); });
      const q = last!;
      const spotDev = deviationBps(q.spotOut, plan.quoteOut);
      const limit = c.max_slippage_bps + c.max_price_impact_bps;
      run.swap = { route: c.route, pool: c.route_pool!, in_lamports: plan.inLamports.toString(), min_out_raw: '0', out_raw: '0', quote_out_raw: plan.quoteOut.toString(), spot_out_raw: q.spotOut.toString(), slippage_bps: c.max_slippage_bps, price_impact_bps: plan.impactBps, spot_deviation_bps: spotDev, halvings: plan.halvings, forced_fail: !!c.force_fail_swap, sig: '', status: 'planned' };
      run.carryover_lamports = plan.carryover.toString(); run.carryover_reason = plan.reason;
      if (spotDev > limit) throw new FailClosed('failed_price', `quote ${plan.quoteOut} is ${spotDev} bps from spot ${q.spotOut} (> ${limit})`);
      const w = historyWarning((plan.quoteOut * 1_000_000_000n) / plan.inLamports, s.price_history_x1e9.map(BigInt), c.price_band_pct);
      if (w) run.warnings.push(w);
      const mo = c.force_fail_swap ? plan.quoteOut * 2n + 1n : minOut(plan.quoteOut, c.max_slippage_bps);
      run.swap.min_out_raw = mo.toString();
      const built = await this.cp.swap({ payer: this.keys.treasury.publicKey, pool: new PublicKey(c.route_pool!), inputTokenMint: NATIVE_MINT, outputTokenMint: this.mint,
        amountIn: new BN(plan.inLamports.toString()), minimumAmountOut: new BN(mo.toString()), tokenAMint: q.pool.tokenAMint, tokenBMint: q.pool.tokenBMint,
        tokenAVault: q.pool.tokenAVault, tokenBVault: q.pool.tokenBVault, tokenAProgram: this.mainProg, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, poolState: q.pool } as any);
      // keep only the cp-amm swap ix: treasury ATAs are pre-created, no wrap/unwrap (no rent or native lamports touched)
      const swapIxs = built.instructions.filter(i => i.programId.equals(CP_AMM_PROGRAM_ID));
      if (swapIxs.length !== 1) throw new FailClosed('failed_internal', `expected 1 swap ix, got ${swapIxs.length}`);
      const k = swapIxs[0].keys.map(x => x.pubkey.toBase58());
      if (!k.includes(this.tWsol.toBase58()) || !k.includes(this.tMain.toBase58())) throw new FailClosed('failed_internal', 'swap ix does not use treasury ATAs');
      const tx = await this.sendStage(s, run, 'swap', swapIxs, [this.keys.treasury], { in_lamports: plan.inLamports.toString(), min_out_raw: mo.toString() }, { skipPreflight: !!c.force_fail_swap })
        .catch(e => { if (run.swap) { if (e instanceof PausedMidrun) run.swap.status = 'not_sent'; else { run.swap.status = 'failed'; run.swap.sig = run.stages.swap?.sig ?? ''; } } throw e; });
      this.applyEffect(s, run, 'swap', tx);
    }
    // burn only what this run's swap produced (FW-19: never a burn without a swap in the same run)
    if (run.stages.burn?.status === 'confirmed') return;
    if (run.stages.swap?.status !== 'confirmed') throw new FailClosed('failed_burn', 'no confirmed swap in this run → no burn');
    if (run.stages.burn && run.stages.burn.status !== 'pending') delete run.stages.burn;
    const amt = B(run.swap!.out_raw);
    const supplyBefore = await this.supply();
    run.burn = { burned_raw: amt.toString(), tx_supply_change_raw: '0', token_delta_raw: '0', supply_before: supplyBefore.toString(), supply_after: '', verified: false, sig: '' };
    const ix = createBurnCheckedInstruction(this.tMain, this.mint, this.keys.treasury.publicKey, amt, c.main_decimals, [], this.mainProg);
    const tx = await this.sendStage(s, run, 'burn', [ix], [this.keys.treasury], { amount: amt.toString() });
    this.applyEffect(s, run, 'burn', tx);
    const after = await this.supply();
    run.burn!.supply_after = after.toString(); s.last_supply_raw = after.toString();
    if (supplyBefore - after < amt) run.warnings.push(`supply read before/after differs from burn (${supplyBefore - after} vs ${amt}); in-tx check is authoritative`);
    run.status = 'logged';
    this.save(s);
  }

  private async reconcile(s: KeeperState, run: RunLog) {
    const tw = await this.tokenAmt(this.tWsol), tm = await this.tokenAmt(this.tMain, this.mainProg), dw = await this.tokenAmt(this.dWsol);
    const tNative = BigInt(await this.conn.getBalance(this.keys.treasury.publicKey, 'confirmed'));
    const supply = await this.supply();
    const expT = B(s.pending_lamports) + B(s.unsplit_lamports), expM = B(s.unburned_raw), expD = B(s.dev_baseline_raw) + B(s.totals.dev_lamports);
    const supplyDrop = B(s.first_supply_raw) - supply;
    const r = {
      treasury_wsol_raw: tw.toString(), expected_treasury_wsol_raw: expT.toString(), treasury_main_raw: tm.toString(), expected_treasury_main_raw: expM.toString(),
      dev_wsol_raw: dw.toString(), expected_dev_wsol_raw: expD.toString(), treasury_native_lamports: tNative.toString(),
      supply_raw: supply.toString(), supply_drop_since_first_run: supplyDrop.toString(), burned_raw_total: s.totals.burned_raw,
      ok: tw === expT && tm === expM && dw === expD && supplyDrop >= B(s.totals.burned_raw),
    };
    run.reconcile = r; s.last_supply_raw = supply.toString();
    if (!r.ok) throw new FailClosed('reconcile_mismatch', `reconciliation failed: ${JSON.stringify(r)}`, true);
  }

  private finishOk(s: KeeperState, run: RunLog): RunOutcome {
    run.finished_at = new Date().toISOString(); s.consecutive_failures = 0;
    s.runs.push(run); s.current = null;
    this.save(s); this.publish(s);
    this.log(`[${run.run_id}] ${run.status} ${run.reason} txs=${run.txs.length}`);
    return { run_id: run.run_id, status: run.status, reason: run.reason, txs: run.txs };
  }
  /** Mid-run pause: nothing further is sent. The run stays open (s.current) so that after a manual unpause it resumes:
   *  confirmed stages are never repeated, unsplit/pending amounts are re-planned from state, and a confirmed swap is still
   *  burned inside the same run (FW-19). Not a failure: the auto-pause counter is untouched. */
  private finishPausedMidrun(s: KeeperState, run: RunLog, e: PausedMidrun): RunOutcome {
    run.status = 'paused_midrun'; run.reason = e.message; run.stopped_before = e.stage;
    (run.midrun_pauses ??= []).push({ at: new Date().toISOString(), before: e.stage, by: e.by });
    run.carryover_lamports = s.pending_lamports; run.carryover_reason = 'paused_midrun';
    s.paused = true; s.pause_reason ||= `${e.by} (mid-run, before ${e.stage})`;
    s.current = run;
    try { this.save(s); this.publish(s); } catch (we: any) { this.log(`log write failed: ${we.message}`); }
    this.log(`[${run.run_id}] PAUSED MID-RUN before ${e.stage} (${e.by}) — nothing further sent; txs this run=${run.txs.length}`);
    return { run_id: run.run_id, status: 'paused_midrun', reason: e.message, txs: run.txs };
  }
  private finishFail(s: KeeperState, run: RunLog, e: FailClosed, persist: boolean): RunOutcome {
    run.status = e.code.startsWith('failed_') || ['burn_mismatch', 'reconcile_mismatch', 'claim_mismatch'].includes(e.code) ? e.code : `failed_${e.code}`;
    run.reason = e.message; run.finished_at = new Date().toISOString();
    s.consecutive_failures++;
    if (e.pause || s.consecutive_failures >= this.cfg.auto_pause_after_failures) {
      s.paused = true; s.pause_reason = e.pause ? `${run.status}: ${e.message.slice(0, 200)}` : `${s.consecutive_failures} consecutive failed runs (last: ${run.status})`;
    }
    s.runs.push(run); s.current = null;
    if (persist) { try { this.save(s); this.publish(s); } catch (we: any) { this.log(`log write failed: ${we.message}`); } }
    else { try { this.save(s); } catch {} }
    this.log(`[${run.run_id}] FAILED ${run.status}: ${run.reason}${s.paused ? ` → PAUSED (${s.pause_reason})` : ''}`);
    return { run_id: run.run_id, status: run.status, reason: run.reason, txs: run.txs };
  }
}

export function newRun(runId: string, overrides: string[], status: string, reason: string): RunLog {
  return { run_id: runId, started_at: new Date().toISOString(), status, reason, overrides, warnings: [], claims: [], dev_lamports: '0', dev_sig: '', buyback_lamports: '0',
    carryover_lamports: '0', carryover_reason: 'none', rent_refund_lamports: '0', gas_lamports: '0', txs: [], stages: {} };
}

/** §10 public log: HookedPad-compatible top level + per-run detail. Addresses and sigs only (FW-17). */
export function publicLog(s: KeeperState, cfg: KeeperConfig) {
  const supply = B(s.last_supply_raw ?? s.first_supply_raw);
  const redact = (t: string) => t.replace(/(?<![:\w/])\/(?:[\w.\-]+\/)+[\w.\-]+/g, '<path>');   // FW-17: no internal paths in the public log
  const strip = (r: RunLog) => { const { stages, overrides, ...rest } = r; return { ...rest, reason: redact(rest.reason), test_knobs: overrides.map(redact) }; };
  return {
    cluster: s.cluster, mint: s.mint, decimals: s.decimals, live: !s.paused, paused: s.paused, pause_reason: s.pause_reason.replace(/(?<![:\w/])\/(?:[\w.\-]+\/)+[\w.\-]+/g, '<path>'),
    state: s.paused ? 'paused' : s.runs.at(-1)?.status === 'waiting_for_graduation' ? 'waiting_for_graduation' : 'active',
    claimedSol: fmtSol(B(s.totals.claimed_lamports)), devSol: fmtSol(B(s.totals.dev_lamports)), spentSol: fmtSol(B(s.totals.spent_lamports)), reserveSol: fmtSol(B(s.pending_lamports)),
    burnedTokens: fmtTokens(B(s.totals.burned_raw), s.decimals), supplyTokens: fmtTokens(supply, s.decimals), pctOfSupply: pctOf(B(s.totals.burned_raw), B(s.first_supply_raw)),
    totals_raw: { ...s.totals, pending_lamports: s.pending_lamports, unsplit_lamports: s.unsplit_lamports, unburned_raw: s.unburned_raw },
    burns: s.burns.map(b => ({ at: b.at, tokens: b.tokens, sol: b.sol, sig: b.sig, run_id: b.run_id })),
    runs: s.runs.map(strip), current_run: s.current ? strip(s.current) : null, route_pool: cfg.route_pool, main_dbc_pool: cfg.main_dbc_pool,
  };
}
/** DBC SDK getPool returns { poolState } (1.5.13); unwrap defensively. */
const unwrapAcc = (x: any) => (x && x.poolState ? x.poolState : x);
export async function dbcPool(dbc: DynamicBondingCurveClient, pk: PublicKey): Promise<any> { return unwrapAcc(await dbc.state.getPool(pk)); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

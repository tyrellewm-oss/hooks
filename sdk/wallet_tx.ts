// Browser-wallet signing (AC-21): the server builds an UNSIGNED swap for the user's wallet, the wallet signs it, and the
// server relays only transactions it built itself. The server never holds or sees the user's key.
//
//   build  -> same swap2_with_transfer_hook as Launchpad.swap(), fee payer = the user, hook gate first (blocker #7);
//             simulated before it is returned, so a cap hit is explained BEFORE the user signs
//   submit -> the signed bytes must carry exactly a message this server issued (sha256 of the message, one use,
//             short expiry), signed by the issued owner; then sendRawTransaction + the same TradeResult as sendTx()
//
// LOCAL/devnet only like everything else here (cluster.ts refuses mainnet).
import BN from 'bn.js';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ComputeBudgetProgram, PublicKey, SendTransactionError, Transaction, VersionedTransaction } from '@solana/web3.js';
import { SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, getCurrentPoint, SwapMode as CpSwapMode } from '@meteora-ag/cp-amm-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { capHitDetails, hookCodeFromLogs, hookErrorFromLogs, parseRestrictionsLifted, TOKEN_2022 } from './hook.js';
import { explorerTx, nowIct, type Cluster } from './cluster.js';
import { assertPoolMintHook, txlogFile, type TxRecord } from './launch.js';

/** How long a built transaction may be submitted (a blockhash lives ~60-90 s). */
export const BUILD_TTL_MS = 90_000;
/** SOL kept back for fees and account rent when bounding a buy's maximum input (same rule as Launchpad.swap()). */
const SOL_RESERVE = 30_000_000n;
const MAX_SOL_IN = 2_000_000_000n;

export class WalletTxRefusal extends Error { constructor(m: string) { super(m); this.name = 'WalletTxRefusal'; } }

export const messageHash = (message: Uint8Array) => createHash('sha256').update(message).digest('hex');

interface Issued { owner: string; mint: string; side: 'buy' | 'sell'; amount: string; blockhash: string; lastValidBlockHeight: number; expires: number }

/** In-memory list of messages this server built. Pure (clock injectable) so the rules are unit-tested. */
export class WalletRelay {
  private issued = new Map<string, Issued>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = BUILD_TTL_MS) {}
  issue(message: Uint8Array, e: Omit<Issued, 'expires'>): string {
    this.sweep();
    const h = messageHash(message);
    this.issued.set(h, { ...e, expires: this.now() + this.ttlMs });
    return h;
  }
  /** Check a signed legacy transaction against what was issued, and consume it (one use). Throws WalletTxRefusal. */
  take(tx: Transaction): Issued {
    this.sweep();
    const h = messageHash(tx.serializeMessage());
    const e = this.issued.get(h);
    if (!e) throw new WalletTxRefusal('refusing: this transaction was not built by this page, was changed after it was built, or has expired. Build it again.');
    if (!tx.feePayer || tx.feePayer.toBase58() !== e.owner) throw new WalletTxRefusal('refusing: the fee payer is not the wallet the transaction was built for');
    const sig = tx.signatures.find((s) => s.publicKey.toBase58() === e.owner)?.signature;
    if (!sig || sig.every((b) => b === 0)) throw new WalletTxRefusal('refusing: the transaction is not signed by the wallet it was built for');
    if (!tx.verifySignatures(true)) throw new WalletTxRefusal('refusing: a signature on the transaction does not verify');
    this.issued.delete(h);
    return e;
  }
  get size() { this.sweep(); return this.issued.size; }
  private sweep() { const t = this.now(); for (const [k, v] of this.issued) if (v.expires <= t) this.issued.delete(k); }
}

export interface Simulation { ok: boolean; err: string | null; hookError: string | null; hookCode: number | null; capHit: ReturnType<typeof capHitDetails> | null; unitsConsumed: number | null }
/** `tx` is HEX on purpose: every JSON body goes through redactDeep (FW-17), whose path rules corrupt base64 ('+/x'
 *  reads as a POSIX path). Hex has no separators, so it passes unchanged (tests/wallet_tx.test.ts). */
export interface BuiltSwap {
  tx: string; encoding: 'hex'; owner: string; side: 'buy' | 'sell'; amount: string; lastValidBlockHeight: number; expiresInMs: number; simulation: Simulation;
  /** 'curve' = DBC bonding curve (cap applies); 'pool' = DAMM v2 after graduation (no cap, quoted with a slippage limit) */
  venue: 'curve' | 'pool';
  /** pool only: the quote and the limit written into the swap (buy: most SOL in; sell: least SOL out), lamports */
  quote?: { expectedLamports: string; limitLamports: string; slippageBps: number; priceImpactPct: string };
}

/** Pool trades: slippage limit in bps (cp-amm getQuote2 takes bps), default 1%, allowed 0.1% to 10%. */
export const POOL_SLIPPAGE_DEFAULT_BPS = 100, POOL_SLIPPAGE_MIN_BPS = 10, POOL_SLIPPAGE_MAX_BPS = 1000;
export function parseSlippageBps(v: unknown): number {
  if (v === undefined || v === null || v === '') return POOL_SLIPPAGE_DEFAULT_BPS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < POOL_SLIPPAGE_MIN_BPS || n > POOL_SLIPPAGE_MAX_BPS) throw new WalletTxRefusal(`slippage must be a whole number of bps from ${POOL_SLIPPAGE_MIN_BPS} to ${POOL_SLIPPAGE_MAX_BPS}`);
  return n;
}

/** Which side of a (token, wSOL) DAMM v2 pool is which, for a trade of `mint`. Refuses any other pair. Pure. */
export function poolSides(pool: { tokenAMint: PublicKey; tokenBMint: PublicKey }, mint: string, side: 'buy' | 'sell') {
  const a = pool.tokenAMint.toBase58(), b = pool.tokenBMint.toBase58(), wsol = NATIVE_MINT.toBase58();
  if (!((a === mint && b === wsol) || (a === wsol && b === mint))) throw new WalletTxRefusal(`refusing: the pool is not ${mint.slice(0, 6)}…/wSOL (it holds ${a.slice(0, 6)}… and ${b.slice(0, 6)}…)`);
  const prog = (m: string) => (m === wsol ? TOKEN_PROGRAM_ID : TOKEN_2022);
  const [input, output] = side === 'buy' ? [wsol, mint] : [mint, wsol];
  return { inputTokenMint: new PublicKey(input), outputTokenMint: new PublicKey(output), tokenAProgram: prog(a), tokenBProgram: prog(b) };
}

/** Minimal view of Launchpad that the build needs (tests can stub it). */
export interface SwapBuilder { c: Cluster; dbc: any; hook: any; requestedHookProgram?: PublicKey }

/** Build the unsigned swap for `owner`, simulate it, and register it with the relay. Same instruction set as
 *  Launchpad.swap(): buy = ExactOut `tokens` bounded by the wallet's SOL; sell = ExactIn `tokens`. */
export async function buildUserSwap(lp: SwapBuilder, relay: WalletRelay, owner: PublicKey, pool: PublicKey, mint: string, side: 'buy' | 'sell', tokens: bigint): Promise<BuiltSwap> {
  if (tokens <= 0n) throw new WalletTxRefusal('amount must be > 0');
  await assertPoolMintHook(lp as any, pool, 'pre', { wallet: owner.toBase58() });   // hook gate; blocker #7
  const conn = lp.c.connection;
  let params: any;
  if (side === 'buy') {
    const bal = BigInt(await conn.getBalance(owner, 'confirmed'));
    let maxSolIn = bal > SOL_RESERVE ? bal - SOL_RESERVE : 1n; if (maxSolIn > MAX_SOL_IN) maxSolIn = MAX_SOL_IN;
    params = { owner, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.ExactOut, amountOut: new BN(tokens.toString()), maximumAmountIn: new BN(maxSolIn.toString()) };
  } else {
    params = { owner, pool, swapBaseForQuote: true, referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn: new BN(tokens.toString()), minimumAmountOut: new BN(0) };
  }
  const tx: Transaction = await lp.dbc.pool.swap2WithTransferHook(params);
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  return finishBuild(lp.c, relay, tx, owner, mint, side, tokens, { venue: 'curve' });
}

/** After graduation (AC-21, same relay rules): swap on the token's DAMM v2 pool. `pool` comes from the server (derived
 *  from the mint), never from the browser. The mint must be past graduation (hook removed) and the pool must be exactly
 *  (mint, wSOL). Buy = ExactOut `tokens`, sell = ExactIn `tokens`, both quoted with a slippage limit. */
export async function buildUserPoolSwap(lp: SwapBuilder, relay: WalletRelay, owner: PublicKey, dbcPool: PublicKey, pool: PublicKey, mint: string, side: 'buy' | 'sell', tokens: bigint, slippageBps: number): Promise<BuiltSwap> {
  if (tokens <= 0n) throw new WalletTxRefusal('amount must be > 0');
  parseSlippageBps(slippageBps);
  await assertPoolMintHook(lp as any, dbcPool, 'post', { wallet: owner.toBase58() });   // hook gate: graduated, hook removed
  const conn = lp.c.connection;
  const cp = new CpAmm(conn);
  let poolState: any;
  try { poolState = await cp.fetchPoolState(pool); } catch { throw new WalletTxRefusal(`refusing: no DAMM v2 pool at ${pool.toBase58()} on this cluster`); }
  const ps = poolSides(poolState, mint, side);
  const currentPoint = await getCurrentPoint(conn, poolState.activationType);
  const decimals = (m: PublicKey) => (m.equals(NATIVE_MINT) ? 9 : 6);
  const common = { inputTokenMint: ps.inputTokenMint, slippage: slippageBps, currentPoint, poolState, tokenADecimal: decimals(poolState.tokenAMint), tokenBDecimal: decimals(poolState.tokenBMint), hasReferral: false };
  let swapAmounts: any, expected: bigint, limit: bigint;
  const q: any = side === 'buy'
    ? cp.getQuote2({ ...common, swapMode: CpSwapMode.ExactOut, amountOut: new BN(tokens.toString()) } as any)
    : cp.getQuote2({ ...common, swapMode: CpSwapMode.ExactIn, amountIn: new BN(tokens.toString()) } as any);
  if (side === 'buy') {
    expected = BigInt((q.includedFeeInputAmount ?? q.inputAmount ?? 0).toString()); limit = BigInt(q.maximumAmountIn.toString());
    swapAmounts = { swapMode: CpSwapMode.ExactOut, amountOut: new BN(tokens.toString()), maximumAmountIn: q.maximumAmountIn };
  } else {
    expected = BigInt(q.outputAmount.toString()); limit = BigInt(q.minimumAmountOut.toString());
    swapAmounts = { swapMode: CpSwapMode.ExactIn, amountIn: new BN(tokens.toString()), minimumAmountOut: q.minimumAmountOut };
  }
  if (limit <= 0n) throw new WalletTxRefusal('refusing: the quote gives no usable limit for this amount');
  const tx: Transaction = await cp.swap2({
    payer: owner, pool, inputTokenMint: ps.inputTokenMint, outputTokenMint: ps.outputTokenMint,
    tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
    tokenAProgram: ps.tokenAProgram, tokenBProgram: ps.tokenBProgram, referralTokenAccount: null, poolState, ...swapAmounts,
  } as any);
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  return finishBuild(lp.c, relay, tx, owner, mint, side, tokens, { venue: 'pool', quote: { expectedLamports: expected.toString(), limitLamports: limit.toString(), slippageBps, priceImpactPct: String(q.priceImpact ?? '') } });
}

/** Shared tail of every build: blockhash, the wallet as sole signer and fee payer, simulation, then the relay entry. */
async function finishBuild(c: Cluster, relay: WalletRelay, tx: Transaction, owner: PublicKey, mint: string, side: 'buy' | 'sell', tokens: bigint, extra: Pick<BuiltSwap, 'venue' | 'quote'>): Promise<BuiltSwap> {
  const { blockhash, lastValidBlockHeight } = await c.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash; tx.feePayer = owner;
  if (tx.signatures.some((s) => s.publicKey.toBase58() !== owner.toBase58())) throw new WalletTxRefusal('refusing: the swap needs a signer other than the wallet');
  const message = tx.serializeMessage();
  const simulation = await simulateSwap(c, tx);
  relay.issue(message, { owner: owner.toBase58(), mint, side, amount: tokens.toString(), blockhash, lastValidBlockHeight });
  return {
    tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('hex'), encoding: 'hex',
    owner: owner.toBase58(), side, amount: tokens.toString(), lastValidBlockHeight, expiresInMs: BUILD_TTL_MS, simulation, ...extra,
  };
}

/** Pre-sign simulation (exported for tests): sigVerify off, same blockhash; parses our hook's error and cap hit. */
export async function simulateSwap(c: Pick<Cluster, 'connection' | 'hookProgram'>, tx: Transaction): Promise<Simulation> {
  try {
    const r = await c.connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' });
    const logs = r.value.logs ?? [];
    let err = r.value.err ? JSON.stringify(r.value.err) : null;
    // a wallet with no SOL at all doesn't exist on chain yet: say so in the words the page's explainer keys on
    // (app/public/explainer.js -> SlippageOrBalance, "not enough devnet SOL for fees and account rent")
    if (err === '"AccountNotFound"') err = 'insufficient funds: this wallet has no devnet SOL yet (AccountNotFound)';
    return { ok: !r.value.err, err, hookError: hookErrorFromLogs(logs, c.hookProgram), hookCode: hookCodeFromLogs(logs, c.hookProgram), capHit: capHitDetails(logs), unitsConsumed: r.value.unitsConsumed ?? null };
  } catch (e: any) {
    return { ok: false, err: String(e?.message ?? e).slice(0, 300), hookError: null, hookCode: null, capHit: null, unitsConsumed: null };
  }
}

/** Relay a wallet-signed transaction this server built, wait for it, and return the same record as sendTx()
 *  (hookError / capHit drive the "Why did my trade fail?" text). skipPreflight so a failing trade still lands with a
 *  signature to link to, like the server-signed path. Appended to the tx log. */
export async function submitSigned(c: Cluster, relay: WalletRelay, raw: Uint8Array): Promise<TxRecord> {
  let tx: Transaction;
  try { tx = Transaction.from(raw); }
  catch { throw new WalletTxRefusal('refusing: not a valid signed transaction'); }
  const e = relay.take(tx);
  const purpose = `page (browser wallet ${e.owner.slice(0, 6)}): ${e.side} ${e.amount} ${e.mint.slice(0, 6)}`;
  let rec: TxRecord; let sig = '';
  try {
    sig = await c.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
    await c.connection.confirmTransaction({ signature: sig, blockhash: e.blockhash, lastValidBlockHeight: e.lastValidBlockHeight }, 'confirmed');
    let info = null;
    for (let i = 0; i < 10 && !info; i++) { info = await c.connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!info) await new Promise((r) => setTimeout(r, 800)); }
    const logs = info?.meta?.logMessages ?? [];
    const ok = !!info && !info.meta?.err;
    rec = { time: nowIct(), cluster: c.name, label: c.label, purpose, sig, ok, err: ok ? undefined : info ? JSON.stringify(info.meta?.err) : 'not confirmed in time', hookError: hookErrorFromLogs(logs, c.hookProgram), hookCode: hookCodeFromLogs(logs, c.hookProgram), link: explorerTx(sig, c.name), capHit: capHitDetails(logs) ?? undefined, events: parseRestrictionsLifted(logs).map((x) => ({ ...x, mint: x.mint.toBase58(), signer: x.signer.toBase58(), slot: x.slot.toString() })) };
  } catch (err: any) {
    const logs = err instanceof SendTransactionError ? (err.logs ?? []) : [];
    rec = { time: nowIct(), cluster: c.name, label: c.label, purpose, sig, ok: false, err: String(err?.message ?? err).slice(0, 500), hookError: hookErrorFromLogs(logs, c.hookProgram), hookCode: hookCodeFromLogs(logs, c.hookProgram), link: sig ? explorerTx(sig, c.name) : '' };
  }
  const file = txlogFile(c.name);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(rec, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
  return rec;
}

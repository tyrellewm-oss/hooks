// Open launch: anyone launches from their own wallet, which pays for everything. The server builds the launch with the
// wallet as fee payer and pool creator and co-signs only with the keys it must hold: the fresh config and mint keypairs
// (thrown away after signing) and the launch key that ticket 8.3 requires on every launch. Nothing is kept between
// requests (signatures and an HMAC ticket carry the state), so this also runs on a serverless host.
//
// Three requests, two wallet approvals (each transaction simulates cleanly in the wallet, because the config exists by
// the time the wallet sees the launch transaction):
//   1. config  -> DBC create_config_with_transfer_hook: payer = the wallet; fee claimer + leftover receiver = the platform
//                 partner key. Simulated, then signed by the fresh config key. Returned with a ticket: an HMAC binding
//                 the wallet, the config address and the launch options (keyed from the launch key, so only this server
//                 can issue one). The wallet signs (approval 1 of 2).
//   2. build   -> the signed config tx (checked: exactly one DBC create_config_with_transfer_hook, signed by the config
//                 key the ticket names, this site's partner, SOL quote, our hook, paid by the wallet) is sent and
//                 confirmed; then the pool tx (DBC create pool + hook config, one tx, as Launchpad.launch()) is built,
//                 simulated with blocker #7's mint check, and co-signed by the mint and launch keys. The wallet signs
//                 (approval 2 of 2). A retried build finds the config already created and skips the send.
//   3. submit  -> the signed pool tx must carry a valid launch-key signature (only this server holds that key: that is
//                 what proves it built the tx), every other signature, only the expected programs; then it is sent and
//                 confirmed, and the post-send checks of Launchpad.launch() run.
// Devnet/local only, like the rest of this repo (launchKeypairsFor refuses any other genesis).
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { utils } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, VersionedTransaction, type Connection } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { DBC_PROGRAM_ID, readHookAuthorities } from './hook.js';
import { MintHookRefusal, assertMintHook, graduationPhase, poolTxBaseMint, DBC_INIT_POOL_T22_HOOK_DISC } from './mint_hook.js';
import { launchConfigChecks, type Authorities } from './keyrules.js';
import { gateHook, assertLaunchSigner, launchKeypairsFor, buildCreatePoolTx, mintHookExpectationFor, preSendMintHookCheck, curveConfigParams, resolveCreatorLock, launchFeeConfig, type Launchpad, type LaunchOpts } from './launch.js';
import { explorerTx } from './cluster.js';

export class OpenLaunchRefusal extends Error { constructor(m: string) { super(m); this.name = 'OpenLaunchRefusal'; } }

/** How long each signed step stays usable: about one blockhash lifetime. */
export const OPEN_LAUNCH_TTL_MS = 75_000;
/** A launch costs the wallet ~0.02 SOL on devnet (rent for the config, pool, vaults, mint and hook accounts, plus fees;
 *  measured on the TTEST launch). Below this the first step refuses before anything is signed. */
export const OPEN_LAUNCH_MIN_LAMPORTS = 50_000_000n;
/** A legacy transaction's wire limit. */
export const TX_LIMIT = 1232;
/** DBC create_config_with_transfer_hook: Anchor discriminator; accounts config 0, fee_claimer 1, leftover_receiver 2,
 *  quote_mint 3, transfer_hook_program 4, payer 5 (DBC IDL in @meteora-ag/dynamic-bonding-curve-sdk). */
export const DBC_CREATE_CONFIG_HOOK_DISC = createHash('sha256').update('global:create_config_with_transfer_hook').digest().subarray(0, 8);
const CFG_IX = { config: 0, feeClaimer: 1, leftoverReceiver: 2, quoteMint: 3, hookProgram: 4, payer: 5 };
/** DBC initialize_virtual_pool_with_token2022_transfer_hook accounts: config 0, pool_authority 1, creator 2, base_mint 3. */
const POOL_IX = { config: 0, creator: 2 };

const hex = (t: Transaction) => t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('hex');
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(4).replace(/\.?0+$/, '');
const authoritiesOf = ({ upgradeAuthority, liftAuthority, launchAuthority }: Authorities): Authorities => ({ upgradeAuthority, liftAuthority, launchAuthority });
const forbiddenKeys = (partner: PublicKey, owner: PublicKey, auth: Authorities) =>
  ({ partner: partner.toBase58(), wallet: owner.toBase58(), upgrade: auth.upgradeAuthority, lift: auth.liftAuthority, launch: auth.launchAuthority ?? null });
const refusal = (m: string): never => { throw new OpenLaunchRefusal(`refusing: ${m}. Nothing was sent; press Launch to start again`); };

// ---------------------------------------------------------------- ticket (HMAC, stateless)
/** A server-side MAC key derived (HKDF) from the launch key's seed, so every instance of this server agrees on it and
 *  nobody else can make one. One key per purpose; the seed never leaves this function. */
export function derivedKey(launchKey: Keypair, purpose: 'open-launch-ticket-v1' | 'studio-session-v1'): Buffer {
  return Buffer.from(hkdfSync('sha256', launchKey.secretKey.subarray(0, 32), 'hookd', purpose, 32));
}
export const ticketKeyFrom = (launchKey: Keypair) => derivedKey(launchKey, 'open-launch-ticket-v1');
/** Every launch option that reaches the chain, in a fixed order: the ticket binds them, so the pool built in step 2 uses
 *  exactly the options the config of step 1 was built from. */
export function optsDigest(o: LaunchOpts): string {
  const f = launchFeeConfig(o), lock = resolveCreatorLock(o);
  // the URI is not bound: it names the mint, which only exists from step 2 (buildOpenPool's uriFor)
  const canon = [o.name, o.symbol, o.steps.map((s) => [s.slotOffset.toString(), s.maxBps]), o.uncappedAfter.toString(), o.totalSupply ?? null,
    o.migrationQuoteThresholdSol ?? null, f, lock ? [lock.pct, lock.slots] : null,
    o.rules ? [o.rules.maxBuyTokens.toString(), o.rules.maxPerSlotTokens.toString(), o.rules.windowSlots.toString(), o.rules.potEvery, o.rules.potMinTokens.toString(), o.rules.cooldownSlots.toString()] : null];
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}
const mac = (key: Buffer, owner: string, config: string, digest: string, exp: number) =>
  createHmac('sha256', key).update(`open-launch-v1|${owner}|${config}|${digest}|${exp}`).digest('hex');
export function issueTicket(key: Buffer, owner: string, config: string, digest: string, exp: number): string { return `${exp}.${mac(key, owner, config, digest, exp)}`; }
/** Throws OpenLaunchRefusal unless `ticket` was issued by this server for this wallet, config and options, and is current. */
export function checkTicket(key: Buffer, ticket: unknown, owner: string, config: string, digest: string, now = Date.now()): void {
  const m = typeof ticket === 'string' ? /^(\d{13})\.([0-9a-f]{64})$/.exec(ticket) : null;
  if (!m) refusal('the launch ticket is missing or malformed');
  const exp = Number(m![1]);
  const want = Buffer.from(mac(key, owner, config, digest, exp), 'hex'), got = Buffer.from(m![2], 'hex');
  if (!timingSafeEqual(want, got)) refusal('the launch ticket does not match this wallet, config and launch options (were they changed between the two approvals?)');
  if (exp <= now) refusal('the signing window has passed (about a minute)');
}

// ---------------------------------------------------------------- step 1: the config
export interface OpenConfigStep { configTx: string; config: string; owner: string; ticket: string; expiresInMs: number }

export async function buildOpenConfig(lp: Launchpad, launchAuthority: PublicKey, partner: PublicKey, owner: PublicKey, o: LaunchOpts, ticketKey: Buffer, now = Date.now()): Promise<OpenConfigStep> {
  const gate = await gateHook(lp);
  const auth = authoritiesOf(await readHookAuthorities(lp.c.connection, gate.programId));
  assertLaunchSigner(launchAuthority, auth);   // 8.3: this server's launch key is the on-chain one, before anything is built
  for (const w of launchConfigChecks(gate.clusterClass, partner.toBase58(), auth)) console.warn(w);
  await mintHookExpectationFor(lp, forbiddenKeys(partner, owner, auth), gate);   // blocker #7: the pinned signer is none of these keys
  const conn = lp.c.connection;
  const lamports = BigInt(await conn.getBalance(owner, 'confirmed'));
  if (lamports < OPEN_LAUNCH_MIN_LAMPORTS) throw new OpenLaunchRefusal(`this wallet has ${sol(lamports)} devnet SOL. A launch costs about 0.02 SOL in account rent and fees; keep at least ${sol(OPEN_LAUNCH_MIN_LAMPORTS)} SOL. Get devnet SOL at faucet.solana.com, then try again.`);

  const configKp = launchKeypairsFor(gate.clusterClass).config;   // the mint keypair is made in step 2
  const tx: Transaction = await lp.dbc.partner.createConfigWithTransferHook({
    config: configKp.publicKey, feeClaimer: partner, leftoverReceiver: partner, payer: owner,
    quoteMint: NATIVE_MINT, transferHookProgram: lp.hook.programId, ...curveConfigParams(o),
  } as any);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.feePayer = owner; tx.recentBlockhash = blockhash;
  assertFits(tx, 'config');
  let sim: any;
  try { sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }); }
  catch (e: any) { throw new OpenLaunchRefusal(`couldn't check the launch before signing (RPC error: ${String(e?.message ?? e).slice(0, 200)}). Nothing was signed; try again.`); }
  if (sim?.value?.err) throw new OpenLaunchRefusal(`the launch would fail at its first step: ${simError(sim.value)}. Nothing was signed.`);
  tx.partialSign(configKp);
  const exp = now + OPEN_LAUNCH_TTL_MS;
  return { configTx: hex(tx), config: configKp.publicKey.toBase58(), owner: owner.toBase58(), ticket: issueTicket(ticketKey, owner.toBase58(), configKp.publicKey.toBase58(), optsDigest(o), exp), expiresInMs: OPEN_LAUNCH_TTL_MS };
}

/** Wire size of `t` once signed (a placeholder blockhash when none is set yet: the size doesn't depend on it). */
function txBytes(t: Transaction, payer: PublicKey): number {
  const c = new Transaction({ feePayer: t.feePayer ?? payer, recentBlockhash: t.recentBlockhash ?? PublicKey.default.toBase58() }).add(...t.instructions);
  return c.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}
function assertFits(t: Transaction, what: string) {
  const size = t.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  if (size > TX_LIMIT) throw new OpenLaunchRefusal(`the ${what} transaction would be ${size} bytes (limit ${TX_LIMIT}). Use a shorter name or fewer cap steps and try again.`);
}
function simError(v: { err: unknown; logs?: string[] | null }): string {
  const e = JSON.stringify(v.err);
  if (e === '"AccountNotFound"') return 'this wallet has no devnet SOL yet';
  const logs = v.logs ?? [];
  if (logs.some((l) => /insufficient lamports|insufficient funds/i.test(l))) return 'not enough devnet SOL in this wallet';
  return `${e.slice(0, 160)}${logs.length ? ` (last log: ${String(logs[logs.length - 1]).slice(0, 160)})` : ''}`;
}

/** Step 2's check of the signed config tx, pure: one DBC create_config_with_transfer_hook for this site's partner, SOL
 *  quote and hook, paid by `owner`, every signature present and valid (so the config key signed these exact bytes).
 *  Returns the config address (the ticket then proves this server made that key). */
export function checkOpenConfigTx(tx: Transaction, k: { owner: PublicKey; partner: PublicKey; dbc: PublicKey; hook: PublicKey }): PublicKey {
  if (!tx.feePayer?.equals(k.owner)) refusal('the config transaction is not paid by the launching wallet');
  checkSigned(tx, 'config', [ComputeBudgetProgram.programId, k.dbc]);
  const ixs = tx.instructions.filter((ix) => ix.programId.equals(k.dbc));
  if (ixs.length !== 1 || !Buffer.from(ixs[0].data.subarray(0, 8)).equals(DBC_CREATE_CONFIG_HOOK_DISC)) refusal('the config transaction is not one DBC create_config_with_transfer_hook');
  const a = ixs[0].keys, config = a[CFG_IX.config]?.pubkey;
  if (!config || !tx.signatures.some((s) => s.publicKey.equals(config))) refusal('the config transaction is not signed by its config key');
  if (!a[CFG_IX.feeClaimer]?.pubkey.equals(k.partner) || !a[CFG_IX.leftoverReceiver]?.pubkey.equals(k.partner)) refusal("the config's fee claimer is not this site's partner key");
  if (!a[CFG_IX.quoteMint]?.pubkey.equals(NATIVE_MINT) || !a[CFG_IX.hookProgram]?.pubkey.equals(k.hook)) refusal('the config is not a SOL-quoted config for this transfer hook');
  if (!a[CFG_IX.payer]?.pubkey.equals(k.owner)) refusal('the config is not paid for by the launching wallet');
  return config!;
}
function checkSigned(t: Transaction, what: string, programs: PublicKey[]) {
  if (t.signatures.some((s) => s.signature === null)) refusal(`the ${what} transaction is missing a signature`);
  let ok = false;
  try { ok = t.verifySignatures(true); } catch { ok = false; }
  if (!ok) refusal(`a signature on the ${what} transaction does not verify`);
  if (!t.instructions.every((ix) => programs.some((p) => ix.programId.equals(p)))) refusal(`the ${what} transaction calls a program this site doesn't use`);
}
function parseTx(h: unknown, what: string): Transaction {
  if (typeof h !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(h) || h.length > 2 * TX_LIMIT) refusal(`the ${what} transaction must be the signed transaction as hex`);
  try { return Transaction.from(Buffer.from(h as string, 'hex')); } catch { return refusal(`the ${what} transaction is not a parseable signed transaction`); }
}

// ---------------------------------------------------------------- step 2: send the config, build the pool tx
export interface OpenPoolStep { poolTx: string; owner: string; mint: string; config: string; pool: string; createConfig: string | null; lastValidBlockHeight: number; expiresInMs: number }

/** `uriFor(mint)`: the token's metadata URI (immutable once launched); omitted = the devnet placeholder. */
export async function buildOpenPool(lp: Launchpad, launchKey: Keypair, partner: PublicKey, owner: PublicKey, o: LaunchOpts, signedConfigHex: unknown, ticket: unknown, ticketKey: Buffer, uriFor?: (mint: string) => string, deadlineMs = 40_000): Promise<OpenPoolStep> {
  const gate = await gateHook(lp);
  const configTx = parseTx(signedConfigHex, 'config');
  const config = checkOpenConfigTx(configTx, { owner, partner, dbc: DBC_PROGRAM_ID, hook: gate.programId });
  checkTicket(ticketKey, ticket, owner.toBase58(), config.toBase58(), optsDigest(o));
  const auth = authoritiesOf(await readHookAuthorities(lp.c.connection, gate.programId));
  assertLaunchSigner(launchKey.publicKey, auth);   // 8.3
  const exp = await mintHookExpectationFor(lp, forbiddenKeys(partner, owner, auth), gate);
  const conn = lp.c.connection;

  // the config: sent and confirmed, unless a retried step already created it
  let createConfig: string | null = null;
  const existing = await conn.getAccountInfo(config, 'confirmed');
  if (!existing) createConfig = (await sendAndConfirm(conn, configTx, 'config', Date.now() + deadlineMs)).sig;
  else if (!existing.owner.equals(DBC_PROGRAM_ID)) refusal(`account ${config.toBase58()} exists but is not a DBC config`);

  // the pool tx, exactly as Launchpad.launch() builds it, now that its config exists
  const mintKp = launchKeypairsFor(gate.clusterClass).mint;
  const keys = { payer: owner, config, mint: mintKp.publicKey, launchAuthority: launchKey.publicKey };
  let poolTx = await buildCreatePoolTx(lp, uriFor ? { ...o, uri: uriFor(mintKp.publicKey.toBase58()) } : o, keys, auth);
  // the URI rides in this tx: with 8 cap steps, the optional hooks and a 32-byte name it can tip the tx past the limit,
  // and then the token keeps the placeholder URI instead (wallets show no image; the site still shows everything)
  if (uriFor && txBytes(poolTx, owner) > TX_LIMIT) poolTx = await buildCreatePoolTx(lp, o, keys, auth);
  // blocker #7: simulated (unsigned bytes) and the mint's TransferHook checked BEFORE any co-signature; also sets the
  // fee payer and the blockhash the wallet signs over
  const sim = await preSendMintHookCheck(conn, poolTx, owner, mintKp.publicKey, exp);
  assertFits(poolTx, 'launch');
  poolTx.partialSign(mintKp, launchKey);   // partial signing never changes the message bytes
  return {
    poolTx: hex(poolTx), owner: owner.toBase58(), mint: mintKp.publicKey.toBase58(), config: config.toBase58(),
    pool: deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, config).toBase58(), createConfig,
    lastValidBlockHeight: sim.lastValidBlockHeight, expiresInMs: OPEN_LAUNCH_TTL_MS,
  };
}

// ---------------------------------------------------------------- step 3: relay the pool tx
export interface OpenPoolTx { owner: PublicKey; mint: PublicKey; config: PublicKey; pool: PublicKey }
/** Step 3's check, pure: every signature present and valid, among them the launch key's (only this server holds it, so
 *  this proves the server built these exact bytes); only the expected programs; one DBC create-pool whose creator is
 *  the fee payer. */
export function checkOpenPoolTx(tx: Transaction, k: { launchAuthority: PublicKey; dbc: PublicKey; hook: PublicKey }): OpenPoolTx {
  const owner = tx.feePayer;
  if (!owner) return refusal('the launch transaction has no fee payer');
  checkSigned(tx, 'launch', [ComputeBudgetProgram.programId, k.dbc, k.hook]);
  if (!tx.signatures.some((s) => s.publicKey.equals(k.launchAuthority))) refusal("this launch isn't co-signed by this site's launch key");
  let mint: PublicKey;
  try { mint = poolTxBaseMint(tx, k.dbc); } catch (e: any) { return refusal(String(e.message).replace(/^refusing: /, '')); }
  const ix = tx.instructions.find((i) => i.programId.equals(k.dbc) && Buffer.from(i.data.subarray(0, 8)).equals(DBC_INIT_POOL_T22_HOOK_DISC))!;
  const config = ix.keys[POOL_IX.config]?.pubkey;
  if (!config) return refusal('the launch transaction names no config');
  if (!ix.keys[POOL_IX.creator]?.pubkey.equals(owner)) refusal('the pool creator is not the wallet paying for the launch');
  return { owner, mint, config, pool: deriveDbcPoolAddress(NATIVE_MINT, mint, config) };
}

export interface OpenLaunchResult {
  ok: true; owner: string; mint: string; config: string; pool: string; sig: string; link: string;
  /** true when THIS request's send landed the launch (a tx lands once); false when a retry found it already landed */
  sentHere: boolean;
}

export async function submitOpenPool(lp: Launchpad, launchAuthority: PublicKey, partner: PublicKey, signedPoolHex: unknown, deadlineMs = 40_000): Promise<OpenLaunchResult> {
  const gate = await gateHook(lp);
  const tx = parseTx(signedPoolHex, 'launch');
  const p = checkOpenPoolTx(tx, { launchAuthority, dbc: DBC_PROGRAM_ID, hook: gate.programId });
  const conn = lp.c.connection;
  const auth = authoritiesOf(await readHookAuthorities(conn, gate.programId));
  const exp = await mintHookExpectationFor(lp, forbiddenKeys(partner, p.owner, auth), gate);
  const { sig, sentHere } = await sendAndConfirm(conn, tx, 'launch', Date.now() + deadlineMs);
  // the post-send checks of Launchpad.launch(): our pool, pre-graduation, and the live mint hook
  let st: any;
  try { st = await lp.dbc.state.getPool(p.pool); }
  catch (e: any) { throw new MintHookRefusal(`launched (${explorerTx(sig, lp.c.name)}), but the new DBC pool ${p.pool.toBase58()} can't be read yet: ${String(e?.message ?? e).slice(0, 200)}`); }
  const ps = st?.poolState ?? st;
  if (!ps?.baseMint || !new PublicKey(ps.baseMint).equals(p.mint)) throw new MintHookRefusal(`refusing: new DBC pool ${p.pool.toBase58()} does not hold mint ${p.mint.toBase58()}`);
  if (!new PublicKey(ps.config).equals(p.config)) throw new MintHookRefusal(`refusing: new DBC pool ${p.pool.toBase58()} config is not ${p.config.toBase58()}`);
  if (graduationPhase(ps) !== 'pre') throw new MintHookRefusal(`refusing: new DBC pool ${p.pool.toBase58()} is already past graduation`);
  await assertMintHook(conn, p.mint, 'pre', exp);
  return { ok: true, owner: p.owner.toBase58(), mint: p.mint.toBase58(), config: p.config.toBase58(), pool: p.pool.toBase58(), sig, link: explorerTx(sig, lp.c.name), sentHere };
}

/** Send (with preflight, so a failing tx is refused with its reason and never lands) and confirm by polling the
 *  signature status, re-sending the same bytes every ~2 s until it confirms, fails, its blockhash expires or `until`.
 *  Polling, not a websocket subscription: serverless hosts drop sockets between requests. A tx that already landed
 *  (a retried request) is confirmed, with sentHere false. */
export async function sendAndConfirm(conn: Pick<Connection, 'sendRawTransaction' | 'getSignatureStatuses' | 'isBlockhashValid'>, tx: Transaction, what: string, until: number): Promise<{ sig: string; sentHere: boolean }> {
  const raw = tx.serialize();
  const sig = utils.bytes.bs58.encode(tx.signature!);   // the fee payer's signature is the transaction id
  let sentHere = true;
  try { await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }); }
  catch (e: any) {
    const text = `${String(e?.message ?? e)}\n${(e?.logs ?? e?.transactionLogs ?? []).join('\n')}`;
    if (/already been processed/i.test(text)) sentHere = false;
    else if (/insufficient (lamports|funds)|debit an account but found no record/i.test(text)) throw new OpenLaunchRefusal(`the ${what} transaction was not accepted: not enough devnet SOL in this wallet`);
    else if (/blockhash not found/i.test(text)) throw new OpenLaunchRefusal(`the ${what} transaction expired before it was sent (the wallet took longer than about a minute). Nothing was sent; press Launch to start again`);
    else throw new OpenLaunchRefusal(`the ${what} transaction was not accepted: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  for (let i = 0; ; i++) {
    const s = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
    if (s?.err) throw new OpenLaunchRefusal(`the ${what} transaction failed on chain: ${JSON.stringify(s.err).slice(0, 200)} (${sig})`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { sig, sentHere };
    if (Date.now() > until) throw new OpenLaunchRefusal(`the ${what} transaction was sent but not confirmed in time (${sig}). It may still land; check the explorer before launching again`);
    if (i % 3 === 2) {
      const valid = await conn.isBlockhashValid(tx.recentBlockhash!, { commitment: 'confirmed' }).then((r) => r.value, () => true);
      if (!valid && !s) throw new OpenLaunchRefusal(`the ${what} transaction expired before it confirmed (${sig}). Nothing more was sent; press Launch to start again`);
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

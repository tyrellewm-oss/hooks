// AC-21 for the studio: a launch signed in the user's own browser wallet. The server builds the create-pool tx with
// the STUDIO WALLET as fee payer and pool creator, co-signs with the keys 8.3 forces it to hold (the launch key, plus
// the fresh config/mint keypairs), and relays only transactions it built itself - the same relay discipline as
// trades (sdk/wallet_tx.ts): sha256 of the exact message, one use, short expiry, every signature verified.
//
// What the server still signs, and why:
//   - the launch key: ticket 8.3 pins launches to ONE on-chain launch authority, which the server holds. AC-21's
//     "no server-side keys" line predates 8.3; this is the closest conforming reading (flagged for King).
//   - the config + mint keypairs: generated fresh per launch (devnet/local only), never persisted, thrown away
//     after the send. Only their signatures travel; secret keys never leave this process.
//   - the config-creation tx (deployer pays): a leftover config from an abandoned launch is harmless and reusable.
// The user's wallet is the fee payer and pool creator of the launch tx itself, and nothing is sent without it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { readHookAuthorities } from './hook.js';
import { assertMintHook, type MintHookExpectation } from './mint_hook.js';
import { launchConfigChecks } from './keyrules.js';
import {
  Launchpad, gateHook, assertLaunchKeygenAllowed, assertLaunchSigner, launchKeypairsFor, buildCreatePoolTx,
  preSendMintHookCheck, mintHookExpectationFor, curveConfigParams, launchFeeConfig, resolveCreatorLock, sendTx,
  type LaunchOpts, type LaunchRecord,
} from './launch.js';
import { explorerTx, nowIct, type Cluster } from './cluster.js';

export class LaunchUserRefusal extends Error { constructor(m: string) { super(m); this.name = 'LaunchUserRefusal'; } }

/** How long a built launch tx may be submitted (one blockhash lifetime, same as the trade relay). */
export const LAUNCH_BUILD_TTL_MS = 90_000;

export interface PendingLaunch {
  owner: string;
  opts: LaunchOpts;
  config: string;
  mint: string;
  pool: string;
  createConfigSig: string;
  simulationNote: string;
  exp: MintHookExpectation;
  lastValidBlockHeight: number;
  expires: number;
}

const msgHash = (m: Uint8Array) => createHash('sha256').update(m).digest('hex');

/** One-use store of launch messages this server built. Pure rules (clock injectable) so they are unit-tested. */
export class StudioLaunchRelay {
  private pending = new Map<string, PendingLaunch>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = LAUNCH_BUILD_TTL_MS) {}
  issue(message: Uint8Array, p: Omit<PendingLaunch, 'expires'>): string {
    this.sweep();
    const h = msgHash(message);
    this.pending.set(h, { ...p, expires: this.now() + this.ttlMs });
    return h;
  }
  /** Check a signed launch tx against what was issued and consume it (one use). Throws LaunchUserRefusal.
   *  Unlike the trade relay, a launch tx has co-signers, so EVERY signature must be present and valid. */
  take(tx: Transaction): PendingLaunch {
    this.sweep();
    const h = msgHash(tx.serializeMessage());
    const p = this.pending.get(h);
    if (!p) throw new LaunchUserRefusal('refusing: this is not a launch this server built — the signing window (90 s) has likely expired. Nothing was sent; press Launch again to rebuild');
    this.pending.delete(h);   // one use, also on failure below
    if (!tx.feePayer || tx.feePayer.toBase58() !== p.owner) throw new LaunchUserRefusal('refusing: the fee payer is not the wallet this launch was built for');
    if (tx.signatures.some((s) => s.signature === null)) throw new LaunchUserRefusal('refusing: the launch tx is missing a signature');
    let ok = false;
    try { ok = tx.verifySignatures(); } catch { ok = false; }
    if (!ok) throw new LaunchUserRefusal('refusing: a signature on the launch tx does not verify');
    return p;
  }
  private sweep() { const t = this.now(); for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k); }
}

export interface BuiltLaunch {
  /** the partially signed create-pool tx (mint + launch key signed; the wallet signs as fee payer), hex */
  tx: string;
  mint: string;
  config: string;
  pool: string;
  createConfigSig: string;
  simulation: string;
  expiresInMs: number;
}

/** Build the browser-signed launch: create the config (server pays, harmless if abandoned), then the create-pool +
 *  hook-config tx with `owner` as payer and pool creator, simulated (blocker #7) and co-signed with the mint and
 *  launch keys. Registered with the relay; nothing on chain changes until the wallet signs and submits. */
export async function buildUserLaunch(lp: Launchpad, relay: StudioLaunchRelay, deployer: Keypair, launchKey: Keypair, owner: PublicKey, o: LaunchOpts): Promise<BuiltLaunch> {
  const gate = await gateHook(lp);
  assertLaunchKeygenAllowed(gate.clusterClass);
  const auth = (({ upgradeAuthority, liftAuthority, launchAuthority }) => ({ upgradeAuthority, liftAuthority, launchAuthority }))(await readHookAuthorities(lp.c.connection, gate.programId));
  assertLaunchSigner(launchKey.publicKey, auth);   // 8.3: before any tx is built
  for (const w of launchConfigChecks(gate.clusterClass, deployer.publicKey.toBase58(), auth)) console.warn(w);
  // blocker #7: the pinned signer must be none of our keys - including the launching wallet
  const exp = await mintHookExpectationFor(lp, { dev: deployer.publicKey.toBase58(), wallet: owner.toBase58(), upgrade: auth.upgradeAuthority, lift: auth.liftAuthority, launch: auth.launchAuthority ?? null }, gate);

  const { config: configKp, mint: mintKp } = launchKeypairsFor(gate.clusterClass);
  // config first, its own tx, server-paid: same reasoning as Launchpad.launch() (size limit; leftovers harmless)
  const cfgTx = await lp.dbc.partner.createConfigWithTransferHook({
    config: configKp.publicKey, feeClaimer: deployer.publicKey, leftoverReceiver: deployer.publicKey, payer: deployer.publicKey,
    quoteMint: NATIVE_MINT, transferHookProgram: lp.hook.programId, ...curveConfigParams(o),
  } as any);
  const r1 = await sendTx(lp.c, cfgTx, [deployer, configKp], `dbc: create_config_with_transfer_hook (${o.symbol}, studio wallet launch)`);
  if (!r1.ok) throw new LaunchUserRefusal('create config failed: ' + r1.err);

  const poolTx = await buildCreatePoolTx(lp, o, { payer: owner, config: configKp.publicKey, mint: mintKp.publicKey, launchAuthority: launchKey.publicKey }, auth);
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, configKp.publicKey);
  // blocker #7 pre-send check on the exact unsigned bytes (also sets the fee payer and a fresh blockhash)
  const sim = await preSendMintHookCheck(lp.c.connection, poolTx, owner, mintKp.publicKey, exp);
  const { lastValidBlockHeight } = sim;   // of the blockhash the check put in the tx: the one the wallet signs over
  // co-sign with the keys the server must hold; partial signing never changes the message bytes
  poolTx.partialSign(mintKp, ...(launchKey.publicKey.equals(deployer.publicKey) ? [] : [launchKey]));
  const message = poolTx.serializeMessage();
  const simulation = `ok before signing (mint hook checked in simulation)`;
  relay.issue(message, {
    owner: owner.toBase58(), opts: o, config: configKp.publicKey.toBase58(), mint: mintKp.publicKey.toBase58(),
    pool: pool.toBase58(), createConfigSig: r1.sig, simulationNote: simulation, exp, lastValidBlockHeight,
  });
  return {
    tx: poolTx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('hex'),
    mint: mintKp.publicKey.toBase58(), config: configKp.publicKey.toBase58(), pool: pool.toBase58(),
    createConfigSig: r1.sig, simulation, expiresInMs: LAUNCH_BUILD_TTL_MS,
  };
}

export interface LaunchedReply { ok: true; record: LaunchRecord; sig: string; link: string }

/** Relay the wallet-signed launch tx (must be one this server built; every signature verified), then run the same
 *  post-send checks as Launchpad.launch() and write the launch record. */
export async function submitUserLaunch(lp: Launchpad, relay: StudioLaunchRelay, signedHex: string): Promise<LaunchedReply> {
  let tx: Transaction;
  try { tx = Transaction.from(Buffer.from(signedHex, 'hex')); } catch { throw new LaunchUserRefusal('refusing: not a parseable signed transaction'); }
  const p = relay.take(tx);
  const conn = lp.c.connection;
  let sig: string;
  try { sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false }); }
  catch (e: any) { throw new LaunchUserRefusal(`the launch tx was not accepted: ${String(e?.message ?? e).slice(0, 300)}`); }
  let confErr: unknown = null;
  try {
    const conf = await conn.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: p.lastValidBlockHeight }, 'confirmed');
    confErr = conf.value.err;
  } catch (e) {
    // confirmation can time out or the subscription can drop while the tx still lands; one direct status
    // check decides, so a landed launch is recorded instead of orphaned
    const st = await conn.getSignatureStatuses([sig]).catch(() => null);
    const s = st?.value?.[0];
    if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) confErr = null;
    else if (s?.err) confErr = s.err;
    else throw new LaunchUserRefusal(`the launch was sent but not confirmed in time (${String((e as any)?.message ?? e).slice(0, 200)}). It may still land — check ${explorerTx(sig, lp.c.name)} before launching again`);
  }
  if (confErr) throw new LaunchUserRefusal(`the launch tx failed on chain: ${JSON.stringify(confErr)} (${sig})`);

  const o = p.opts;
  const rec: LaunchRecord = {
    name: o.name, symbol: o.symbol, cluster: lp.c.name, label: lp.c.label, time: nowIct(), programId: lp.hook.programId.toBase58(),
    config: p.config, pool: p.pool, mint: p.mint, quoteMint: NATIVE_MINT.toBase58(),
    steps: o.steps.map((s) => ({ slotOffset: s.slotOffset.toString(), maxBps: s.maxBps })), uncappedAfter: o.uncappedAfter.toString(),
    migrationQuoteThresholdSol: o.migrationQuoteThresholdSol ?? 1, fee: { mode: 'FeeSchedulerLinear (anti-sniper fee schedule)', ...launchFeeConfig(o) }, creatorLock: resolveCreatorLock(o),
    txs: { createConfig: p.createConfigSig, createPoolAndHookConfig: sig },
  };
  rec.mintHookSimulation = p.simulationNote;
  // same post-send checks as Launchpad.launch(): the pool at the derived address is ours and still pre-graduation,
  // and the live mint's TransferHook is the gated program with the pinned signer
  let mintHookErr: Error | null = null;
  try {
    let st: any;
    try { st = await lp.dbc.state.getPool(new PublicKey(p.pool)); }
    catch (e: any) { throw new LaunchUserRefusal(`cannot read the new DBC pool ${p.pool} (RPC error: ${String(e?.message ?? e).slice(0, 200)})`); }
    const ps = st?.poolState ?? st;
    if (!ps?.baseMint || !ps?.config) throw new LaunchUserRefusal(`new DBC pool ${p.pool} not found`);
    if (new PublicKey(ps.baseMint).toBase58() !== p.mint) throw new LaunchUserRefusal(`new DBC pool base mint ${new PublicKey(ps.baseMint).toBase58()} != our mint ${p.mint}`);
    if (new PublicKey(ps.config).toBase58() !== p.config) throw new LaunchUserRefusal(`new DBC pool config ${new PublicKey(ps.config).toBase58()} != our config ${p.config}`);
    await assertMintHook(conn, new PublicKey(p.mint), 'pre', p.exp);
    rec.mintHookCheck = 'ok';
  } catch (e: any) { mintHookErr = e; rec.mintHookCheck = `FAILED: ${e.message}`; }
  mkdirSync(`launches/${lp.c.name}`, { recursive: true });
  writeFileSync(`launches/${lp.c.name}/${rec.mint}.json`, JSON.stringify(rec, null, 2));
  if (mintHookErr) throw mintHookErr;
  return { ok: true, record: rec, sig, link: explorerTx(sig, lp.c.name) };
}

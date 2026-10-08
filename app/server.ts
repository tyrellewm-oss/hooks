// Minimal launch page backend. Binds 127.0.0.1 only. Cluster: LOCAL by default, DEVNET with `--cluster devnet`.
// Signs ONLY with throwaway test keypairs from the gitignored key dir (no real wallet; King's devnet-only grant).
// Browser wallets (AC-21): /api/wallet/build returns an UNSIGNED swap for the user's wallet; /api/wallet/submit relays
// only transactions this server built (sdk/wallet_tx.ts). The server never holds a user key.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { utils as anchorUtils } from '@coral-xyz/anchor';
import { resolveCluster, parseClusterArg, explorerAddr, explorerTx, assertNotMainnet } from '../sdk/cluster.js';
import { defaultSchedule, scheduleJson, resolveSchedule } from '../sdk/schedules.js';
import { loadOrCreate, deployerName } from '../sdk/keys.js';
import { Launchpad, listLaunches, gateHook, DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION, resolvePercentageSupplyOnMigration, resolveCreatorLock, CreatorLockRefusal, dammV2MigrationConfigFor, type CreatorLock } from '../sdk/launch.js';
import { validate, RELEASE_LIMITS, type Step } from '../sdk/capMath.js';
import { decodeRules, readHookAuthorities, type BuyRules } from '../sdk/hook.js';
import { switchHistoryReader } from './switch_history.js';
import { parseBuyRules, buyRulesBps, rulesUnsupportedHint, BuyRulesRefusal } from '../sdk/buy_rules.js';
import { redactDeep } from '../sdk/redact.js';
import { serverError } from './errors.js';
import { siteRoute, createReply, type Reply } from './site_registry.js';
import { WalletRelay, WalletTxRefusal, buildUserSwap, buildUserPoolSwap, parseSlippageBps, submitSigned } from '../sdk/wallet_tx.js';
import { MintHookRefusal } from '../sdk/mint_hook.js';
import { KeyRuleRefusal } from '../sdk/keyrules.js';
import { StudioLaunchRelay, buildUserLaunch, submitUserLaunch, LaunchUserRefusal } from '../sdk/launch_user.js';
import { staticReply, uiModeFromArgs, assertUiBuilt } from './static.js';
import { loadPublicKeepers } from './flywheel_public.js';
import { readIndex, candles, dammPoolFor } from '../sdk/indexer.js';
import { validateMetadata, MetadataRefusal } from '../sdk/metadata.js';
import { StudioAuth, StudioAuthError, parseAllowlist } from '../sdk/studio_auth.js';
import { buildOpenConfig, buildOpenPool, submitOpenPool, derivedKey, OpenLaunchRefusal, OPEN_LAUNCH_MIN_LAMPORTS } from '../sdk/launch_open.js';
import { ChainLaunches, type ChainLaunch } from '../sdk/chain_launches.js';
import { detailsStoreFor } from '../sdk/details_store.js';
import type { LaunchRecord } from '../sdk/launch.js';

const argv = process.argv.slice(2);
/** Vercel sets VERCEL=1. The hosted site runs on devnet with no key file: the deployer and the test wallets are never
 *  there. Its one key is the launch key, from the HOOKD_LAUNCH_KEY secret; with it, anyone can launch from their own
 *  wallet (open launch, sdk/launch_open.ts). Every other write (server-signed launches and trades) stays on the
 *  operator's machine: hosted, only the open-launch routes, studio sign-in and token-details saves take a POST. */
const HOSTED = process.env.VERCEL === '1';
const PORT = Number(process.env.PORT ?? 5175);
const UI = uiModeFromArgs(argv);   // --web: serve the new front end from web/dist (build it first)
if (!HOSTED) assertUiBuilt(UI);   // hosted: the CDN serves web/dist
const content = JSON.parse(readFileSync('research/page_content.json', 'utf8'));
// AC-30: refuse to start if anything mainnet-like is configured.
for (const v of [process.env.DEVNET_RPC, process.env.LOCAL_RPC]) if (v) assertNotMainnet(v);

const c = await resolveCluster(HOSTED ? 'devnet' : parseClusterArg(argv));
const lp = new Launchpad(c);
const deployer = HOSTED ? null : loadOrCreate(c.name, deployerName(c.name));
// 8.3: the separate launch key (devnet/local throwaway). Hosted it comes from the HOOKD_LAUNCH_KEY secret; there it can
// only approve launches (the launching wallet pays for everything), never administer the hook or pay.
const launchKey = HOSTED ? keyFromSecret(process.env.HOOKD_LAUNCH_KEY) : loadOrCreate(c.name, 'launch');
/** Open launch: any wallet launches and pays, the server co-signs. Hosted: on whenever the launch key is configured.
 *  Locally: HOOKD_OPEN_LAUNCH=1 (the studio flow stays the default there). */
const OPEN_LAUNCH = !!launchKey && (HOSTED || process.env.HOOKD_OPEN_LAUNCH === '1');
const ticketKey = OPEN_LAUNCH ? derivedKey(launchKey!, 'open-launch-ticket-v1') : null;
const wallets: Record<string, ReturnType<typeof loadOrCreate>> = HOSTED ? {} : { A: loadOrCreate(c.name, 'buyerA'), B: loadOrCreate(c.name, 'buyerB') };
/** A keypair from a secret env value (the key file's JSON array of 64 bytes, or base58). Unset -> null. A malformed value
 *  stops the server at start; the error never repeats the value. */
function keyFromSecret(v: string | undefined): Keypair | null {
  const s = v?.trim(); if (!s) return null;
  let bytes: Uint8Array;
  try { bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : anchorUtils.bytes.bs58.decode(s); }
  catch { throw new Error("HOOKD_LAUNCH_KEY is not a keypair (expected the key file's JSON array, or base58)"); }
  if (bytes.length !== 64) throw new Error('HOOKD_LAUNCH_KEY is not a 64-byte keypair');
  try { return Keypair.fromSecretKey(bytes); } catch { throw new Error("HOOKD_LAUNCH_KEY is not a valid keypair (its public half doesn't match)"); }
}
/** The fee claimer + leftover receiver of every open-launch config: HOOKD_PARTNER if set, else the deployer (locally the
 *  key itself; hosted, the hook's upgrade authority on chain, which is the devnet deployer). The same partner as the
 *  studio launches, so the keeper's claim key collects their fees too. */
let partnerKey: Promise<PublicKey> | null = null;
const partner = (): Promise<PublicKey> => (partnerKey ??= (async () => {
  if (process.env.HOOKD_PARTNER) return new PublicKey(process.env.HOOKD_PARTNER);
  if (deployer) return deployer.publicKey;
  const a = await readHookAuthorities(c.connection, (await gateHook(lp)).programId);
  if (!a.upgradeAuthority) throw new Error('no partner key: the hook upgrade authority is unknown and HOOKD_PARTNER is not set');
  return new PublicKey(a.upgradeAuthority);
})().catch((e) => { partnerKey = null; throw e; }));
/** Token details (image, description, links): Vercel Blob when BLOB_READ_WRITE_TOKEN is set, else files (read-only hosted). */
const details = detailsStoreFor(c.name, process.env, HOSTED);
let commit = process.env.HOOKD_COMMIT ?? 'unknown';
if (!process.env.HOOKD_COMMIT) try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}
/** The lift authority is the deployer key locally; hosted (no keys), it is read from the hook's Global account. */
let chainLiftAuthority: Promise<string> | null = null;
const liftAuthority = (): string | Promise<string> => deployer ? deployer.publicKey.toBase58()
  : (chainLiftAuthority ??= readHookAuthorities(c.connection, lp.hook.programId).then(a => a.liftAuthority ?? 'none', e => { chainLiftAuthority = null; throw e; }));
/** Host only: an RPC URL can carry an API key in its query string. */
const rpcHost = (u: string) => { try { return new URL(u).host; } catch { return 'unknown'; } };

// Ship the SAME cap math to the browser (AC-2): sdk/capMath.ts, bundled on first request.
let capMathJs: string | null = null;

/** AC-29 switch history (app/switch_history.ts): cached per transaction, read a few at a time. */
const readSwitchHistory = switchHistoryReader(c.connection, { link: sig => explorerTx(sig, c.name) });
const switchHistory = (mint: PublicKey) => readSwitchHistory(mint, [lp.hook.liftPda(mint), lp.hook.globalPda()]);
async function feeInfo(config: PublicKey) {
  const cfg: any = await lp.dbc.state.getPoolConfig(config);
  const bf = cfg.poolFees.baseFee;
  const cliff = Number(bf.cliffFeeNumerator.toString()) / 1e7; // numerator / 1e9 * 100 = %
  const periods = Number(bf.firstFactor); const freq = Number(bf.secondFactor.toString()); const red = Number(bf.thirdFactor.toString());
  const mode = Number(bf.baseFeeMode);
  const end = mode === 0 ? cliff - (periods * red) / 1e7 : cliff * Math.pow(1 - red / 10_000, periods);
  // what a launch record also holds, read back from the config (a launch found on chain has no record)
  const supply = BigInt(cfg.preMigrationTokenSupply.toString());
  const pctOf = (x: bigint) => (supply > 0n ? Number((x * 10_000n) / supply) / 100 : 0);
  const lv = cfg.lockedVestingConfig;
  const locked = lv ? BigInt(lv.cliffUnlockAmount.toString()) + BigInt(lv.amountPerPeriod.toString()) * BigInt(lv.numberOfPeriod.toString()) : 0n;
  return { mode: mode === 0 ? 'linear fee scheduler' : mode === 1 ? 'exponential fee scheduler' : 'other', cliffPct: cliff, endPct: Math.round(end * 1000) / 1000, periods, periodSlots: freq, totalSlots: periods * freq, collectFeeMode: Number(cfg.collectFeeMode), migrationFeeOption: Number(cfg.migrationFeeOption), creatorTradingFeePercentage: Number(cfg.creatorTradingFeePercentage), migrationQuoteThresholdSol: Number(cfg.migrationQuoteThreshold.toString()) / LAMPORTS_PER_SOL,
    percentageSupplyOnMigration: Math.round(pctOf(BigInt(cfg.migrationBaseThreshold.toString()))),
    creatorLock: locked > 0n ? { pct: Math.round(pctOf(locked)), slots: Number(lv.cliffDurationFromMigrationTime.toString()) } : null };
}

/** A token the site lists: a local launch record (registry-gated), or a launch found on chain (a user's wallet made it). */
type SiteRec = (LaunchRecord & { source?: 'record' }) | (ChainLaunch & { source: 'chain' });
/** Launch records carry nowIct()'s "YYYY-MM-DD HH:MM:SS ICT"; the page sorts with Date.parse, which needs ISO 8601. */
const isoTime = (t: string | undefined) => { const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ICT$/.exec(t ?? ''); return m ? `${m[1]}T${m[2]}+07:00` : t ?? ''; };
/** Launches found on chain (sdk/chain_launches.ts: the launch key's history). Listed without the registry when a user's
 *  wallet created them; the operator's own launches (creator = the partner key) still need the registry, as before. */
let launchAuthorityKey: Promise<PublicKey | null> | null = null;
const chainLaunches = new ChainLaunches(c.connection, () => (launchAuthorityKey ??= gateHook(lp)
  .then((g) => readHookAuthorities(c.connection, g.programId))
  .then((a) => (a.launchAuthority ? new PublicKey(a.launchAuthority) : null))
  .catch((e) => { launchAuthorityKey = null; throw e; })));
async function userLaunches(want?: string): Promise<SiteRec[]> {
  const [list, p] = await Promise.all([chainLaunches.get(want), partner().then((k) => k.toBase58(), () => null)]);
  if (!p) return [];   // the partner is unknown (RPC trouble): list none rather than the operator's test launches
  return list.filter((l) => l.creator !== p).map((l) => ({ ...l, source: 'chain' as const }));
}

const relay = new WalletRelay();
const launchRelay = new StudioLaunchRelay();
/** token details given at build time, saved only once that mint's launch confirms (keyed by mint, like the relay: short-lived) */
const pendingLaunchMeta = new Map<string, ReturnType<typeof validateMetadata>>();

/** Shared validation for /api/create and /api/studio/launch/build: same rules as the program (AC-4/AC-21), QA L-16. */
function parseLaunchBody(b: any): { error: string } | { opts: { name: string; symbol: string; steps: Step[]; uncappedAfter: bigint; migrationQuoteThresholdSol: number; percentageSupplyOnMigration: number; rules?: BuyRules; creatorLockPct?: number; creatorLockSlots?: number }; meta: ReturnType<typeof validateMetadata> | null } {
  const name = String(b.name ?? '').slice(0, 32), symbol = String(b.symbol ?? '').toUpperCase().slice(0, 10);
  if (!name || !/^[A-Z0-9]{2,10}$/.test(symbol)) return { error: 'name and 2-10 char ticker required' };
  // Either explicit steps, or a named schedule (strict|balanced|loose|demo). Unknown names are a 400, never a silent fallback (QA L-16).
  let steps: Step[]; let uncappedAfter: bigint;
  if (b.schedule !== undefined && !b.steps) {
    try { const sch = resolveSchedule(b.schedule, c.name); steps = sch.steps; uncappedAfter = sch.uncappedAfter; }
    catch (e: any) { return { error: e.message }; }
  } else {
    steps = (b.steps ?? []).map((s: any) => ({ slotOffset: BigInt(s.slotOffset), maxBps: Number(s.maxBps) }));
    uncappedAfter = BigInt(b.uncappedAfter ?? 0);
  }
  const err = validate({ launchSlot: 0n, supply: 1n, steps, uncappedAfter }, RELEASE_LIMITS);
  if (err) return { error: `InvalidCapSchedule: ${err}` };
  let percentageSupplyOnMigration: number; // optional; default 20 (validated before any tx)
  try { percentageSupplyOnMigration = resolvePercentageSupplyOnMigration(b.percentageSupplyOnMigration); }
  catch (e: any) { return { error: e.message }; }
  let rules: BuyRules | null;   // optional hooks (max single buy, max per slot, Nth-buy pot, slow mode); none = the v1 hook config
  try { rules = parseBuyRules(b.rules); } catch (e: any) { if (e instanceof BuyRulesRefusal) return { error: e.message }; throw e; }
  let lock: CreatorLock | null;   // creator lock (DBC locked vesting): validated here so a bad value is a 400, not a thrown 500
  try { lock = resolveCreatorLock(b); } catch (e: any) { if (e instanceof CreatorLockRefusal) return { error: e.message }; throw e; }
  let meta: ReturnType<typeof validateMetadata> | null = null;   // optional token details, validated before any tx
  if (b.metadata !== undefined) { try { meta = validateMetadata(b.metadata); } catch (e: any) { return { error: e.message }; } }
  return { opts: { name, symbol, steps, uncappedAfter, migrationQuoteThresholdSol: Number(b.thresholdSol ?? 1), percentageSupplyOnMigration, ...(rules ? { rules } : {}), ...(lock ? { creatorLockPct: lock.pct, creatorLockSlots: lock.slots } : {}) }, meta };
}
// Studio sign-in (sdk/studio_auth.ts): the create and token-details routes need a session from an allowlisted wallet.
// Fails closed on devnet (no STUDIO_WALLETS -> studio closed); a local validator without a list stays open.
// Open launch: every wallet may sign in, and the token-details route lets a wallet edit the tokens it created (an
// allowlisted studio wallet: any token). Hosted, sessions are stateless (HMAC keyed from the launch key) across instances.
const studio = new StudioAuth(parseAllowlist(process.env.STUDIO_WALLETS), c.label, c.name === 'local', Date.now,
  OPEN_LAUNCH ? { anyWallet: true, ...(HOSTED ? { secret: derivedKey(launchKey!, 'studio-session-v1') } : {}) } : {});
if (OPEN_LAUNCH) console.log(`launch: OPEN (any wallet launches and pays; launch key ${launchKey!.publicKey.toBase58()} co-signs); token details: ${details.kind}${details.writable ? '' : ' (read-only)'}`);
else if (HOSTED) console.log('launch: OFF (HOOKD_LAUNCH_KEY is not set)');
if (studio.open) console.log('studio: OPEN (local cluster, no STUDIO_WALLETS); create and token-details edits need no sign-in');
else if (!studio.status().configured) console.log('studio: CLOSED (no STUDIO_WALLETS); create and token-details edits are refused');
/** The studio wallet for this request, or the error reply to send. */
function studioCheck(req: http.IncomingMessage): { wallet: string } | Reply {
  try { return { wallet: studio.require(req.headers['x-studio-session']) }; }
  catch (e: any) { if (e instanceof StudioAuthError) return { code: e.code, body: { error: e.message } }; throw e; }
}
/** A wallet address from a query/body value, or null (never throws). */
function walletKey(v: unknown): PublicKey | null { try { return typeof v === 'string' && v.length >= 32 && v.length <= 44 ? new PublicKey(v) : null; } catch { return null; } }

/** card = the listing's read: no switch-history scan and no test-wallet balances (marked partial). `given` = the record
 *  the route already found (a launch record or a launch found on chain). */
async function tokenView(mintStr: string, owner: PublicKey | null = null, card = false, given?: SiteRec) {
  const mint = new PublicKey(mintStr);
  const rec: SiteRec | undefined = given ?? listLaunches(c.name).find(l => l.mint === mintStr);
  // independent chain reads, side by side
  const [st, fee, p, metadata, rules] = await Promise.all([
    lp.status(mint),
    rec ? feeInfo(new PublicKey(rec.config)) : null,
    rec ? lp.dbc.state.getPool(new PublicKey(rec.pool)).then((x: any) => x.poolState ?? x) : null,
    details.view(mintStr),
    rulesView(mint),
  ]);
  const bal: Record<string, string> = {};
  if (!card) for (const [k, w] of Object.entries(wallets)) bal[k] = (await lp.tokenBalance(mint, w.publicKey)).toString();
  const pool = p ? { quoteReserveSol: Number(p.quoteReserve.toString()) / LAMPORTS_PER_SOL, isMigrated: Number(p.isMigrated) === 1, curveComplete: st.transferHookProgram === null, creator: p.creator ? new PublicKey(p.creator).toBase58() : null } : null;
  // Fee config shown on the page = what the launch used (launch record); what a record lacks (older records, and every
  // launch found on chain) comes from the on-chain DBC config.
  const rf: any = rec?.source === 'chain' ? undefined : rec?.fee;
  const feeConfig = rec ? { startBps: rf?.startBps ?? (fee ? Math.round(fee.cliffPct * 100) : undefined), endBps: rf?.endBps ?? (fee ? Math.round(fee.endPct * 100) : undefined), durationSlots: rf?.durationSlots ?? fee?.totalSlots,
    migrationFeeOption: rf?.migrationFeeOption ?? fee?.migrationFeeOption, creatorTradingFeePercentage: rf?.creatorTradingFeePercentage ?? fee?.creatorTradingFeePercentage,
    // records made before this option existed were all built with the then hard-coded 20; a chain launch reads its config
    percentageSupplyOnMigration: rf?.percentageSupplyOnMigration ?? (rec.source === 'chain' ? fee?.percentageSupplyOnMigration : DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION) } : null;
  // a launch found on chain: the record fields the page reads, from the chain (config, hook config)
  const launch = !rec ? null : rec.source === 'chain'
    ? { ...rec, time: isoTime(rec.time), cluster: c.name, label: c.label, quoteMint: 'So11111111111111111111111111111111111111112', migrationQuoteThresholdSol: fee?.migrationQuoteThresholdSol ?? null, creatorLock: fee?.creatorLock ?? null, steps: st.steps ?? [], uncappedAfter: st.uncappedAfter ?? null, txs: { createPoolAndHookConfig: rec.sig } }
    : { ...rec, time: isoTime(rec.time) };
  // the connected browser wallet, when the page passes ?owner=<pubkey>: its token balance and SOL (read only)
  const wallet = owner ? { owner: owner.toBase58(), tokens: (await lp.tokenBalance(mint, owner)).toString(), sol: (await c.connection.getBalance(owner, 'confirmed')) / LAMPORTS_PER_SOL } : null;
  return { status: st, launch, rules, metadata, fee, feeConfig, pool, balances: bal, wallet, switchHistory: card ? [] : await switchHistory(mint), ...(card ? { partial: true } : {}), explorer: { mint: explorerAddr(mintStr, c.name), pool: rec ? explorerAddr(rec.pool, c.name) : null, program: explorerAddr(lp.hook.programId.toBase58(), c.name) } };
}

/** The token's optional hooks (rules PDA), or null for a token launched without them. Shares are bps of supply. */
async function rulesView(mint: PublicKey) {
  const a = await c.connection.getAccountInfo(lp.hook.rulesPda(mint), 'confirmed');
  if (!a || !a.owner.equals(lp.hook.programId)) return null;
  const r = decodeRules(a.data);   // winners: the last 16, newest first
  return { ...buyRulesBps(r), launchSlot: r.launchSlot.toString(), buyCount: r.buyCount.toString(), wins: r.wins.toString(),
    winners: r.winners.map((w) => ({ owner: w.owner.toBase58(), tokenAccount: w.tokenAccount.toBase58(), buyIndex: w.buyIndex.toString(), slot: w.slot.toString() })) };
}

async function trade(b: any, rec: { mint: string; pool: string }): Promise<Reply> {
  const w = wallets[b.wallet]; if (!w) return { code: 400, body: { error: 'wallet must be A or B' } };
  const tokens = BigInt(Math.round(Number(b.amount) * 1e6));
  if (tokens <= 0n) return { code: 400, body: { error: 'amount must be > 0' } };
  return { code: 200, body: await lp.swap(w, new PublicKey(rec.pool), b.side === 'sell' ? 'sell' : 'buy', tokens, `page: wallet ${b.wallet} ${b.side} ${b.amount} ${rec.mint.slice(0, 6)}`) };
}

/** Price chart + trades feed from the indexer's file (scripts/indexer.ts keeps it fresh). No chain call. */
const INTERVALS = new Set([60, 300, 900, 3600]);
function tradesView(mint: string, interval: number) {
  const ix = readIndex(c.name, mint);
  const iv = INTERVALS.has(interval) ? interval : 300;
  if (!ix) return { indexed: false, updatedAt: null, decimals: null, interval: iv, trades: [], candles: [] };
  return { indexed: true, updatedAt: ix.updatedAt, decimals: ix.decimals, interval: iv, trades: ix.trades.slice(0, 100), candles: candles(ix.trades, iv).slice(-300) };
}

/** AC-21 build: an unsigned swap for the user's wallet, simulated first. Never signs or sends. */
/** The DAMM v2 pool a launch migrates into: derived here from the mint and the cluster's pinned migration config.
 *  The browser never names the pool. Resolved once (the config check reads the chain). */
let dammConfig: Promise<string> | null = null;
async function dammPoolOf(mint: string): Promise<PublicKey> {
  dammConfig ??= dammV2MigrationConfigFor(c).then(r => r.config.toBase58()).catch(e => { dammConfig = null; throw e; });
  return new PublicKey(dammPoolFor(mint, await dammConfig));
}

/** AC-21 build: an unsigned swap for the user's wallet, simulated first. Never signs or sends.
 *  venue 'curve' (default): the DBC bonding curve, cap applies. venue 'pool': the DAMM v2 pool after graduation. */
async function build(b: any, rec: { mint: string; pool: string }): Promise<Reply> {
  const owner = walletKey(b.owner); if (!owner) return { code: 400, body: { error: 'owner must be a wallet address' } };
  if (b.side !== 'buy' && b.side !== 'sell') return { code: 400, body: { error: 'side must be buy or sell' } };
  const tokens = BigInt(Math.round(Number(b.amount) * 1e6));
  if (!(tokens > 0n)) return { code: 400, body: { error: 'amount must be > 0' } };
  const venue = b.venue === undefined || b.venue === 'curve' ? 'curve' : b.venue === 'pool' ? 'pool' : null;
  if (!venue) return { code: 400, body: { error: 'venue must be curve or pool' } };
  try {
    if (venue === 'pool') {
      const slippageBps = parseSlippageBps(b.slippageBps);
      return { code: 200, body: await buildUserPoolSwap(lp, relay, owner, new PublicKey(rec.pool), await dammPoolOf(rec.mint), rec.mint, b.side, tokens, slippageBps) };
    }
    return { code: 200, body: await buildUserSwap(lp, relay, owner, new PublicKey(rec.pool), rec.mint, b.side, tokens, parseSlippageBps(b.slippageBps)) };
  } catch (e: any) {
    if (e instanceof WalletTxRefusal) return { code: 400, body: { error: e.message } };
    // hook gate (blocker #7): curve after graduation, or the pool before graduation
    if (e instanceof MintHookRefusal) return { code: 409, body: { error: venue === 'curve' ? `this token can't be traded on the curve: ${e.message}` : `this token hasn't graduated yet, so it has no pool: ${e.message}` } };
    throw e;
  }
}

const MAX_BODY = 1_000_000;   // the largest legitimate body is a token image (512 KB as base64)
async function body(req: http.IncomingMessage): Promise<any> { let d = ''; for await (const ch of req) { d += ch; if (d.length > MAX_BODY) throw new Error('request body too large'); } return d ? JSON.parse(d) : {}; }
const send = (res: http.ServerResponse, code: number, obj: any, type = 'application/json') => {
  if (type === 'application/json') obj = redactDeep(obj);   // FW-17: every JSON body is public; all strings (keys too) are redacted
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(type === 'application/json' ? JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : obj); };

// ---- open launch (sdk/launch_open.ts): any wallet launches from the page and pays; the server only co-signs
/** The graduation threshold a public launch may pick (SOL in the curve). */
const OPEN_THRESHOLD_SOL = { min: 0.1, max: 100 } as const;
/** What the page needs to know about launching here. */
const launchInfo = () => ({ mode: OPEN_LAUNCH ? 'open' : studio.status().configured || studio.open ? 'studio' : 'closed', minSol: Number(OPEN_LAUNCH_MIN_LAMPORTS) / LAMPORTS_PER_SOL, details: details.writable, thresholdSol: OPEN_THRESHOLD_SOL });
/** The studio's option checks (parseLaunchBody), plus what a public form needs: the wallet, a name that fits on chain and
 *  a graduation threshold in range. */
function parseOpenLaunch(b: any) {
  const owner = walletKey(b?.owner); if (!owner) return { error: 'owner must be the connected wallet address' };
  const p = parseLaunchBody(b ?? {}); if ('error' in p) return p;
  if (Buffer.byteLength(p.opts.name) > 32 || /[\u0000-\u001f\u007f]/.test(p.opts.name)) return { error: 'name: at most 32 bytes, no control characters' };
  const t = p.opts.migrationQuoteThresholdSol;
  if (!(Number.isFinite(t) && t >= OPEN_THRESHOLD_SOL.min && t <= OPEN_THRESHOLD_SOL.max)) return { error: `graduation threshold: ${OPEN_THRESHOLD_SOL.min} to ${OPEN_THRESHOLD_SOL.max} SOL` };
  return { owner, ...p };
}
/** The site's public address for a token's metadata URI (immutable once launched): HOOKD_PUBLIC_URL, else hosted the
 *  project's production address (Vercel's VERCEL_PROJECT_PRODUCTION_URL) or the address the request came to. Locally
 *  there is none, and the devnet placeholder stays. */
function publicBase(req: http.IncomingMessage): string | null {
  const host = (h: unknown) => { const v = String(h ?? '').split(',')[0].trim().toLowerCase(); return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? `https://${v}` : null; };
  const env = process.env.HOOKD_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (env) return /^https:\/\/[a-z0-9.-]+$/i.test(env) ? env : null;
  if (!HOSTED) return null;
  return host(process.env.VERCEL_PROJECT_PRODUCTION_URL) ?? host(req.headers['x-forwarded-host'] ?? req.headers.host);
}
async function openLaunchRoute(path: string, b: any, req: http.IncomingMessage): Promise<Reply> {
  if (!OPEN_LAUNCH) return { code: 403, body: { error: 'launching from any wallet is not switched on for this server' } };
  try {
    if (path === '/api/launch/config' || path === '/api/launch/build') {
      const p = parseOpenLaunch(b); if ('error' in p) return { code: 400, body: { error: p.error } };
      if (path === '/api/launch/config') return { code: 200, body: await buildOpenConfig(lp, launchKey!.publicKey, await partner(), p.owner, p.opts, ticketKey!) };
      const base = publicBase(req);
      // short on purpose (/api/m/<mint>): the URI rides in the launch tx, which must stay under 1232 bytes with 8 cap steps,
      // the optional hooks and a 32-byte name
      return { code: 200, body: await buildOpenPool(lp, launchKey!, await partner(), p.owner, p.opts, b.configTx, b.ticket, ticketKey!, base ? (m) => `${base}/api/m/${m}` : undefined) };
    }
    if (path === '/api/launch/submit') {
      let meta: ReturnType<typeof validateMetadata> | null = null;   // details given with the launch, checked before anything is sent
      if (b?.metadata !== undefined && b?.metadata !== null) { try { meta = validateMetadata(b.metadata); } catch (e: any) { if (e instanceof MetadataRefusal) return { code: 400, body: { error: e.message } }; throw e; } }
      const out = await submitOpenPool(lp, launchKey!.publicKey, await partner(), b?.poolTx);
      chainLaunches.invalidate();   // list it on the next read
      // saved by the request that landed the launch, or (a retry) when the token has no details yet; the creator can
      // always edit them later from the token page
      let detailsNote: string | null = null;
      if (meta && !details.writable) detailsNote = "this server can't store token details yet, so the image and links weren't saved";
      else if (meta) {
        try { if (out.sentHere || !(await details.view(out.mint))) await details.save(out.mint, meta); }
        catch (e: any) { detailsNote = `the token launched, but its details weren't saved (${String(e?.message ?? e).slice(0, 160)}); add them from the token page`; }
      }
      return { code: 200, body: { ...out, detailsNote } };
    }
    return { code: 404, body: { error: 'not found' } };
  } catch (e: any) {
    const hint = rulesUnsupportedHint(String(e?.message ?? e)); if (hint) return { code: 400, body: { error: hint } };
    if (e instanceof OpenLaunchRefusal || e instanceof KeyRuleRefusal || e instanceof MintHookRefusal || e instanceof CreatorLockRefusal) return { code: 400, body: { error: e.message } };
    throw e;
  }
}
/** A listed token's record: a launch record, or a launch found on chain. */
async function findRecord(mint: string): Promise<SiteRec | undefined> {
  return listLaunches(c.name).find((l) => l.mint === mint) ?? (await userLaunches(mint)).find((l) => l.mint === mint);
}
/** Token-details edit. A studio (allowlisted) wallet edits any token; with open launch, a signed-in wallet edits only the
 *  tokens it created (the DBC pool's creator). */
async function saveDetails(mint: string, b: any, wallet: string): Promise<Reply> {
  if (!details.writable) return { code: 403, body: { error: "token details can't be saved on this server yet" } };
  if (OPEN_LAUNCH && wallet !== 'local-open' && !studio.isStudioWallet(wallet)) {
    const rec = await findRecord(mint);
    const creator = rec?.source === 'chain' ? rec.creator
      : rec ? await lp.dbc.state.getPool(new PublicKey(rec.pool)).then((x: any) => { const ps = x?.poolState ?? x; return ps?.creator ? new PublicKey(ps.creator).toBase58() : null; }) : null;
    if (!creator || creator !== wallet) return { code: 403, body: { error: 'only the wallet that launched this token can edit its details' } };
  }
  try { return { code: 200, body: await details.save(mint, validateMetadata(b ?? {})) }; }
  catch (e: any) { if (e instanceof MetadataRefusal) return { code: 400, body: { error: e.message } }; throw e; }
}
/** The token's metadata JSON (its on-chain URI points here for launches from the hosted site): what wallets and
 *  explorers read for the image and links. */
async function tokenJson(mint: string, rec: SiteRec, req: http.IncomingMessage): Promise<Reply> {
  const d = await details.view(mint);
  const base = publicBase(req) ?? '';
  const image = d?.image ? (d.image.startsWith('/') ? `${base}${d.image}` : d.image) : null;
  return { code: 200, body: { name: rec.name ?? '', symbol: rec.symbol ?? '', description: d?.description ?? '', image, external_url: base ? `${base}/token/${mint}` : undefined,
    extensions: d ? Object.fromEntries(Object.entries({ website: d.website, twitter: d.x, telegram: d.telegram, discord: d.discord, tiktok: d.tiktok, instagram: d.instagram, youtube: d.youtube }).filter(([, v]) => !!v)) : {} } };
}

/** Hosted with open launch on, the only POST routes: the three open-launch steps, studio sign-in/out (token-details edits)
 *  and the token-details save. Everything else on the hosted site is GET. */
const HOSTED_POST = /^\/api\/(launch\/(config|build|submit)|studio\/(session|signout)|token\/[1-9A-HJ-NP-Za-km-z]{32,44}\/metadata)$/;
/** The site's one request listener; app/vercel.ts hands Vercel's requests to it (hosted: GET plus HOSTED_POST). */
export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    // hosted, the only POSTs: the open-launch steps, studio sign-in and token-details saves (open launch on)
    if (HOSTED && req.method !== 'GET' && !(OPEN_LAUNCH && HOSTED_POST.test(url.pathname))) return send(res, 403, { error: OPEN_LAUNCH ? 'not available on the hosted site' : 'this hosted site is read-only: launching is not switched on here yet' });
    // ticket 8.5b: the listing, /api/token and /api/trade serve registry mints only (app/site_registry.ts); the registry
    // is read once per request, before any local-record lookup or chain access. Launches a user's wallet made are found
    // on chain and listed too (userLaunches: they carry the on-chain launch key's signature).
    // /api/m/<mint> (a token's metadata URI, kept short) = /api/token/<mint>/metadata.json
    const short = /^\/api\/m\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
    const routed = await siteRoute<SiteRec>(short ? `/api/token/${short[1]}/metadata.json` : url.pathname, req.method ?? 'GET', () => body(req), {
      cluster: c.name,
      launches: () => listLaunches(c.name),
      discovered: userLaunches,
      meta: async listing => ({ defaultSchedule: scheduleJson(defaultSchedule(c.name)), cluster: c.label, rpc: rpcHost(c.url), programId: lp.hook.programId.toBase58(), commit, content, liftAuthority: await liftAuthority(), wallets: Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, w.publicKey.toBase58()])), launches: await Promise.all(listing.map(async l => ({ mint: l.mint, pool: l.pool, time: isoTime(l.time), name: l.name ?? null, symbol: l.symbol ?? null, image: (await details.view(l.mint).catch(() => null))?.image ?? null }))), studio: studio.status(), launch: launchInfo() }),
      token: (mint, rec) => tokenView(mint, walletKey(url.searchParams.get('owner')), url.searchParams.get('view') === 'card', rec),
      // server-signed test-wallet trades: open on local, studio-only elsewhere (gate before hosting; flagged in the studio PR)
      trade: (b, rec) => { if (c.name !== 'local') { const who = studioCheck(req); if ('code' in who) return Promise.resolve(who as Reply); } return trade(b, rec); },
      build,
      image: async mint => { const im = await details.image(mint); return im ? { code: 200, body: im.data, type: im.type } : { code: 404, body: { error: 'no image' } }; },
      metadata: (mint, b) => { const who = studioCheck(req); if ('code' in who) return who; return saveDetails(mint, b, who.wallet); },
      tokenJson: (mint, rec) => tokenJson(mint, rec, req),
      trades: mint => tradesView(mint, Number(url.searchParams.get('interval') ?? 300)),
      flywheel: registered => ({ cluster: c.label, ...loadPublicKeepers(c.name, registered) }),
    });
    if (routed?.type) return send(res, routed.code, routed.body, routed.type);   // the token image (binary)
    if (routed) return send(res, routed.code, routed.body);
    if (url.pathname === '/api/wallets') { const o: any = {}; for (const [k, w] of Object.entries(wallets)) o[k] = { pubkey: w.publicKey.toBase58(), sol: (await c.connection.getBalance(w.publicKey)) / LAMPORTS_PER_SOL }; return send(res, 200, o); }
    if (url.pathname === '/api/wallet/submit' && req.method === 'POST') {
      const b = await body(req);
      if (typeof b.tx !== 'string' || b.tx.length > 2000) return send(res, 400, { error: 'tx must be a base64 signed transaction' });
      try { return send(res, 200, await submitSigned(c, relay, Buffer.from(b.tx, 'base64'))); }
      catch (e: any) { if (e instanceof WalletTxRefusal) return send(res, 400, { error: e.message }); throw e; }
    }
    // studio sign-in: status, challenge, session, sign-out. The launch routes also live under /api/studio/ and are
    // handled below, so they must be excluded here — this block 404s every other /api/studio path.
    if (url.pathname.startsWith('/api/studio') && !url.pathname.startsWith('/api/studio/launch/')) {
      try {
        if (url.pathname === '/api/studio' && req.method === 'GET') { let wallet: string | null = null; try { wallet = studio.require(req.headers['x-studio-session']); } catch {} return send(res, 200, { ...studio.status(), wallet }); }
        if (url.pathname === '/api/studio/challenge' && req.method === 'GET') return send(res, 200, studio.challenge(url.searchParams.get('wallet')));
        if (url.pathname === '/api/studio/session' && req.method === 'POST') { const b = await body(req); return send(res, 200, studio.signIn(b.wallet, b.nonce, b.signature)); }
        if (url.pathname === '/api/studio/signout' && req.method === 'POST') { studio.signOut(req.headers['x-studio-session']); return send(res, 200, { ok: true }); }
        return send(res, 404, { error: 'not found' });
      } catch (e: any) { if (e instanceof StudioAuthError) return send(res, e.code, { error: e.message }); throw e; }
    }
    // open launch (sdk/launch_open.ts): config -> build -> submit; the connected wallet pays and signs twice
    if (url.pathname.startsWith('/api/launch/') && req.method === 'POST') { const r = await openLaunchRoute(url.pathname, await body(req), req); return send(res, r.code, r.body); }
    if (url.pathname === '/api/create' && req.method === 'POST') {
      const who = studioCheck(req); if ('code' in who) return send(res, who.code, who.body);   // studio only
      const p = parseLaunchBody(await body(req));
      if ('error' in p) return send(res, 400, p);
      await lp.ensureGlobal(deployer!, deployer!.publicKey);
      await lp.ensureLaunchAuthority(deployer!, launchKey!.publicKey);   // 8.3: launches are signed by the launch key, never the admin
      let rec;
      try { rec = await lp.launch(deployer!, p.opts, launchKey!); }
      catch (e: any) { const hint = p.opts.rules && rulesUnsupportedHint(String(e?.message ?? e)); if (hint) return send(res, 400, { error: hint }); throw e; }
      if (p.meta) await details.save(rec.mint, p.meta);
      return send(res, 200, createReply(rec));   // ticket 8.5b: registered: false + note; the registry is never written
    }
    // AC-21 for the studio: the launch tx is signed in the user's own browser wallet. The server co-signs with the
    // launch key (8.3 pins launches to the one on-chain launch authority) and the per-launch config/mint keypairs,
    // and relays only what it built (sdk/launch_user.ts: one use, 90 s, every signature verified).
    if (url.pathname === '/api/studio/launch/build' && req.method === 'POST') {
      const who = studioCheck(req); if ('code' in who) return send(res, who.code, who.body);   // studio only
      const b = await body(req);
      const p = parseLaunchBody(b);
      if ('error' in p) return send(res, 400, p);
      // the wallet that pays and signs: the signed-in studio wallet, or on an open studio (LOCAL, no allowlist, so
      // there is no session wallet) the connected wallet the page names in the request
      const owner = studio.open ? walletKey(b.owner) : walletKey(who.wallet);
      if (!owner) return send(res, 400, { error: studio.open ? 'owner must be the connected wallet address (open studio)' : 'the studio session wallet is not a valid key' });
      await lp.ensureGlobal(deployer!, deployer!.publicKey);
      await lp.ensureLaunchAuthority(deployer!, launchKey!.publicKey);
      try {
        const built = await buildUserLaunch(lp, launchRelay, deployer!, launchKey!, owner, p.opts);
        if (p.meta) pendingLaunchMeta.set(built.mint, p.meta);   // saved only if the launch confirms
        return send(res, 200, built);
      } catch (e: any) {
        const hint = p.opts.rules && rulesUnsupportedHint(String(e?.message ?? e));
        if (hint) return send(res, 400, { error: hint });
        if (e instanceof LaunchUserRefusal || e instanceof KeyRuleRefusal || e instanceof MintHookRefusal) return send(res, 400, { error: e.message });
        throw e;
      }
    }
    if (url.pathname === '/api/studio/launch/submit' && req.method === 'POST') {
      const who = studioCheck(req); if ('code' in who) return send(res, who.code, who.body);   // studio only
      const b = await body(req);
      if (typeof b.tx !== 'string' || !/^[0-9a-f]+$/.test(b.tx)) return send(res, 400, { error: 'tx must be the signed transaction as hex' });
      try {
        const out = await submitUserLaunch(lp, launchRelay, b.tx);
        const meta = pendingLaunchMeta.get(out.record.mint);
        if (meta) { pendingLaunchMeta.delete(out.record.mint); await details.save(out.record.mint, meta); }
        return send(res, 200, { ...createReply(out.record), sig: out.sig, link: out.link });
      } catch (e: any) {
        if (e instanceof LaunchUserRefusal || e instanceof MintHookRefusal) return send(res, 400, { error: e.message });
        throw e;
      }
    }
    if (url.pathname === '/capMath.js') {
      capMathJs ??= (await import('esbuild')).buildSync({ entryPoints: ['sdk/capMath.ts'], bundle: true, format: 'esm', write: false, target: 'es2020' }).outputFiles[0].text;
      return send(res, 200, capMathJs, 'text/javascript');
    }
    const st = staticReply(url.pathname, UI);   // app/static.ts: classic page or, with --web, the new UI (web/dist)
    return send(res, st.code, st.body, st.type);
  } catch (e: any) { return send(res, 500, serverError(e)); }   // FW-17: the console line is redacted too (app/errors.ts)
});
if (!HOSTED) server.listen(PORT, '127.0.0.1', () => console.log(`launch page [${c.label}${UI === 'web' ? ', new UI' : ''}] http://127.0.0.1:${PORT}  program ${lp.hook.programId.toBase58()}`));

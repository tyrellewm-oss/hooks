// Minimal launch page backend. Binds 127.0.0.1 only. Cluster: LOCAL by default, DEVNET with `--cluster devnet`.
// Signs ONLY with throwaway test keypairs from the gitignored key dir (no real wallet; King's devnet-only grant).
// Browser wallets (AC-21): /api/wallet/build returns an UNSIGNED swap for the user's wallet; /api/wallet/submit relays
// only transactions this server built (sdk/wallet_tx.ts). The server never holds a user key.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { resolveCluster, parseClusterArg, explorerAddr, explorerTx, assertNotMainnet } from '../sdk/cluster.js';
import { defaultSchedule, scheduleJson, resolveSchedule } from '../sdk/schedules.js';
import { loadOrCreate, deployerName } from '../sdk/keys.js';
import { Launchpad, listLaunches, DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION, resolvePercentageSupplyOnMigration } from '../sdk/launch.js';
import { validate, RELEASE_LIMITS, type Step } from '../sdk/capMath.js';
import { parseRestrictionsLifted } from '../sdk/hook.js';
import { redactDeep } from '../sdk/redact.js';
import { serverError } from './errors.js';
import { siteRoute, createReply, type Reply } from './site_registry.js';
import { WalletRelay, WalletTxRefusal, buildUserSwap, submitSigned } from '../sdk/wallet_tx.js';
import { MintHookRefusal } from '../sdk/mint_hook.js';
import { staticReply, uiModeFromArgs, assertUiBuilt } from './static.js';
import { loadPublicKeepers } from './flywheel_public.js';
import { readIndex, candles } from '../sdk/indexer.js';

const argv = process.argv.slice(2);
const PORT = Number(process.env.PORT ?? 5175);
const UI = uiModeFromArgs(argv);   // --web: serve the new front end from web/dist (build it first)
assertUiBuilt(UI);
const content = JSON.parse(readFileSync('research/page_content.json', 'utf8'));
// AC-30: refuse to start if anything mainnet-like is configured.
for (const v of [process.env.DEVNET_RPC, process.env.LOCAL_RPC]) if (v) assertNotMainnet(v);

const c = await resolveCluster(parseClusterArg(argv));
const lp = new Launchpad(c);
const deployer = loadOrCreate(c.name, deployerName(c.name));
const launchKey = loadOrCreate(c.name, 'launch');   // 8.3: separate throwaway launch key (devnet/local only)
const wallets: Record<string, ReturnType<typeof loadOrCreate>> = { A: loadOrCreate(c.name, 'buyerA'), B: loadOrCreate(c.name, 'buyerB') };
let commit = 'unknown'; try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}

// Ship the SAME cap math to the browser (AC-2): bundle sdk/capMath.ts.
const capMathJs = buildSync({ entryPoints: ['sdk/capMath.ts'], bundle: true, format: 'esm', write: false, target: 'es2020' }).outputFiles[0].text;

async function switchHistory(mint: PublicKey) {
  const out: any[] = []; const seen = new Set<string>();
  for (const addr of [lp.hook.liftPda(mint), lp.hook.globalPda()]) {
    const sigs = await c.connection.getSignaturesForAddress(addr, { limit: 50 }, 'confirmed').catch(() => []);
    for (const s of sigs) {
      if (s.err || seen.has(s.signature)) continue; seen.add(s.signature);
      const tx = await c.connection.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      for (const e of parseRestrictionsLifted(tx?.meta?.logMessages ?? [])) {
        if (e.scope === 0 || e.mint.equals(mint)) out.push({ scope: e.scopeName, oldMinCapBps: e.oldFloorBps, newMinCapBps: e.newFloorBps, lifted: e.lifted, slot: e.slot.toString(), signer: e.signer.toBase58(), link: explorerTx(s.signature, c.name) });
      }
    }
  }
  return out.sort((a, b) => Number(BigInt(b.slot) - BigInt(a.slot)));
}
async function feeInfo(config: PublicKey) {
  const cfg: any = await lp.dbc.state.getPoolConfig(config);
  const bf = cfg.poolFees.baseFee;
  const cliff = Number(bf.cliffFeeNumerator.toString()) / 1e7; // numerator / 1e9 * 100 = %
  const periods = Number(bf.firstFactor); const freq = Number(bf.secondFactor.toString()); const red = Number(bf.thirdFactor.toString());
  const mode = Number(bf.baseFeeMode);
  const end = mode === 0 ? cliff - (periods * red) / 1e7 : cliff * Math.pow(1 - red / 10_000, periods);
  return { mode: mode === 0 ? 'linear fee scheduler' : mode === 1 ? 'exponential fee scheduler' : 'other', cliffPct: cliff, endPct: Math.round(end * 1000) / 1000, periods, periodSlots: freq, totalSlots: periods * freq, collectFeeMode: Number(cfg.collectFeeMode), migrationFeeOption: Number(cfg.migrationFeeOption), creatorTradingFeePercentage: Number(cfg.creatorTradingFeePercentage), migrationQuoteThresholdSol: Number(cfg.migrationQuoteThreshold.toString()) / LAMPORTS_PER_SOL };
}

const relay = new WalletRelay();
/** A wallet address from a query/body value, or null (never throws). */
function walletKey(v: unknown): PublicKey | null { try { return typeof v === 'string' && v.length >= 32 && v.length <= 44 ? new PublicKey(v) : null; } catch { return null; } }

async function tokenView(mintStr: string, owner: PublicKey | null = null) {
  const mint = new PublicKey(mintStr);
  const rec = listLaunches(c.name).find(l => l.mint === mintStr);
  const st = await lp.status(mint);
  const fee = rec ? await feeInfo(new PublicKey(rec.config)) : null;
  const bal: Record<string, string> = {};
  for (const [k, w] of Object.entries(wallets)) bal[k] = (await lp.tokenBalance(mint, w.publicKey)).toString();
  let pool: any = null;
  if (rec) { const p: any = ((await lp.dbc.state.getPool(new PublicKey(rec.pool))) as any).poolState; pool = { quoteReserveSol: Number(p.quoteReserve.toString()) / LAMPORTS_PER_SOL, isMigrated: Number(p.isMigrated) === 1, curveComplete: st.transferHookProgram === null }; }
  // Fee config shown on the page = what the launch used (launch record); fields older records lack come from the on-chain DBC config.
  const feeConfig = rec ? { startBps: rec.fee?.startBps, endBps: rec.fee?.endBps, durationSlots: rec.fee?.durationSlots,
    migrationFeeOption: (rec.fee as any)?.migrationFeeOption ?? fee?.migrationFeeOption, creatorTradingFeePercentage: (rec.fee as any)?.creatorTradingFeePercentage ?? fee?.creatorTradingFeePercentage,
    // records made before this option existed were all built with the then hard-coded 20
    percentageSupplyOnMigration: (rec.fee as any)?.percentageSupplyOnMigration ?? DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION } : null;
  // the connected browser wallet, when the page passes ?owner=<pubkey>: its token balance and SOL (read only)
  const wallet = owner ? { owner: owner.toBase58(), tokens: (await lp.tokenBalance(mint, owner)).toString(), sol: (await c.connection.getBalance(owner, 'confirmed')) / LAMPORTS_PER_SOL } : null;
  return { status: st, launch: rec, fee, feeConfig, pool, balances: bal, wallet, switchHistory: await switchHistory(mint), explorer: { mint: explorerAddr(mintStr, c.name), pool: rec ? explorerAddr(rec.pool, c.name) : null, program: explorerAddr(lp.hook.programId.toBase58(), c.name) } };
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
async function build(b: any, rec: { mint: string; pool: string }): Promise<Reply> {
  const owner = walletKey(b.owner); if (!owner) return { code: 400, body: { error: 'owner must be a wallet address' } };
  if (b.side !== 'buy' && b.side !== 'sell') return { code: 400, body: { error: 'side must be buy or sell' } };
  const tokens = BigInt(Math.round(Number(b.amount) * 1e6));
  if (!(tokens > 0n)) return { code: 400, body: { error: 'amount must be > 0' } };
  try { return { code: 200, body: await buildUserSwap(lp, relay, owner, new PublicKey(rec.pool), rec.mint, b.side, tokens) }; }
  catch (e: any) {
    if (e instanceof WalletTxRefusal) return { code: 400, body: { error: e.message } };
    // hook gate (blocker #7): e.g. the pool has graduated, so there is no curve to trade on
    if (e instanceof MintHookRefusal) return { code: 409, body: { error: `this token can't be traded on the curve: ${e.message}` } };
    throw e;
  }
}

async function body(req: http.IncomingMessage): Promise<any> { let d = ''; for await (const ch of req) d += ch; return d ? JSON.parse(d) : {}; }
const send = (res: http.ServerResponse, code: number, obj: any, type = 'application/json') => {
  if (type === 'application/json') obj = redactDeep(obj);   // FW-17: every JSON body is public; all strings (keys too) are redacted
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : obj); };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    // ticket 8.5b: the listing, /api/token and /api/trade serve registry mints only (app/site_registry.ts); the registry
    // is read once per request, before any local-record lookup or chain access
    const routed = await siteRoute(url.pathname, req.method ?? 'GET', () => body(req), {
      cluster: c.name,
      launches: () => listLaunches(c.name),
      meta: listing => ({ defaultSchedule: scheduleJson(defaultSchedule(c.name)), cluster: c.label, rpc: c.url, programId: lp.hook.programId.toBase58(), commit, content, liftAuthority: deployer.publicKey.toBase58(), wallets: Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, w.publicKey.toBase58()])), launches: listing.map(l => ({ mint: l.mint, pool: l.pool, time: l.time })) }),
      token: mint => tokenView(mint, walletKey(url.searchParams.get('owner'))),
      trade,
      build,
      trades: mint => tradesView(mint, Number(url.searchParams.get('interval') ?? 300)),
      flywheel: registered => ({ cluster: c.label, ...loadPublicKeepers(c.name, registered) }),
    });
    if (routed) return send(res, routed.code, routed.body);
    if (url.pathname === '/api/wallets') { const o: any = {}; for (const [k, w] of Object.entries(wallets)) o[k] = { pubkey: w.publicKey.toBase58(), sol: (await c.connection.getBalance(w.publicKey)) / LAMPORTS_PER_SOL }; return send(res, 200, o); }
    if (url.pathname === '/api/wallet/submit' && req.method === 'POST') {
      const b = await body(req);
      if (typeof b.tx !== 'string' || b.tx.length > 2000) return send(res, 400, { error: 'tx must be a base64 signed transaction' });
      try { return send(res, 200, await submitSigned(c, relay, Buffer.from(b.tx, 'base64'))); }
      catch (e: any) { if (e instanceof WalletTxRefusal) return send(res, 400, { error: e.message }); throw e; }
    }
    if (url.pathname === '/api/create' && req.method === 'POST') {
      const b = await body(req);
      const name = String(b.name ?? '').slice(0, 32), symbol = String(b.symbol ?? '').toUpperCase().slice(0, 10);
      if (!name || !/^[A-Z0-9]{2,10}$/.test(symbol)) return send(res, 400, { error: 'name and 2-10 char ticker required' });
      // Either explicit steps, or a named schedule (strict|balanced|loose|demo). Unknown names are a 400, never a silent fallback (QA L-16).
      let steps: Step[]; let uncappedAfter: bigint;
      if (b.schedule !== undefined && !b.steps) {
        try { const sch = resolveSchedule(b.schedule, c.name); steps = sch.steps; uncappedAfter = sch.uncappedAfter; }
        catch (e: any) { return send(res, 400, { error: e.message }); }
      } else {
        steps = (b.steps ?? []).map((s: any) => ({ slotOffset: BigInt(s.slotOffset), maxBps: Number(s.maxBps) }));
        uncappedAfter = BigInt(b.uncappedAfter ?? 0);
      }
      const err = validate({ launchSlot: 0n, supply: 1n, steps, uncappedAfter }, RELEASE_LIMITS); // same rules as the program (AC-4/AC-21)
      if (err) return send(res, 400, { error: `InvalidCapSchedule: ${err}` });
      let percentageSupplyOnMigration: number; // optional; default 20 (validated before any tx)
      try { percentageSupplyOnMigration = resolvePercentageSupplyOnMigration(b.percentageSupplyOnMigration); }
      catch (e: any) { return send(res, 400, { error: e.message }); }
      await lp.ensureGlobal(deployer, deployer.publicKey);
      await lp.ensureLaunchAuthority(deployer, launchKey.publicKey);   // 8.3: launches are signed by the launch key, never the admin
      const rec = await lp.launch(deployer, { name, symbol, steps, uncappedAfter, migrationQuoteThresholdSol: Number(b.thresholdSol ?? 1), percentageSupplyOnMigration }, launchKey);
      return send(res, 200, createReply(rec));   // ticket 8.5b: registered: false + note; the registry is never written
    }
    if (url.pathname === '/capMath.js') return send(res, 200, capMathJs, 'text/javascript');
    const st = staticReply(url.pathname, UI);   // app/static.ts: classic page or, with --web, the new UI (web/dist)
    return send(res, st.code, st.body, st.type);
  } catch (e: any) { return send(res, 500, serverError(e)); }   // FW-17: the console line is redacted too (app/errors.ts)
}).listen(PORT, '127.0.0.1', () => console.log(`launch page [${c.label}${UI === 'web' ? ', new UI' : ''}] http://127.0.0.1:${PORT}  program ${lp.hook.programId.toBase58()}`));

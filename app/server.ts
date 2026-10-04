// Minimal launch page backend. Binds 127.0.0.1 only. Cluster: LOCAL by default, DEVNET with `--cluster devnet`.
// Signs ONLY with throwaway test keypairs from the gitignored key dir (no real wallet; King's devnet-only grant).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, extname } from 'node:path';
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

const argv = process.argv.slice(2);
const PORT = Number(process.env.PORT ?? 5175);
const content = JSON.parse(readFileSync('research/page_content.json', 'utf8'));
// AC-30: refuse to start if anything mainnet-like is configured.
for (const v of [process.env.DEVNET_RPC, process.env.LOCAL_RPC]) if (v) assertNotMainnet(v);

const c = await resolveCluster(parseClusterArg(argv));
const lp = new Launchpad(c);
const deployer = loadOrCreate(c.name, deployerName(c.name));
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

async function tokenView(mintStr: string) {
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
  return { status: st, launch: rec, fee, feeConfig, pool, balances: bal, switchHistory: await switchHistory(mint), explorer: { mint: explorerAddr(mintStr, c.name), pool: rec ? explorerAddr(rec.pool, c.name) : null, program: explorerAddr(lp.hook.programId.toBase58(), c.name) } };
}

async function trade(b: any, rec: { mint: string; pool: string }): Promise<Reply> {
  const w = wallets[b.wallet]; if (!w) return { code: 400, body: { error: 'wallet must be A or B' } };
  const tokens = BigInt(Math.round(Number(b.amount) * 1e6));
  if (tokens <= 0n) return { code: 400, body: { error: 'amount must be > 0' } };
  return { code: 200, body: await lp.swap(w, new PublicKey(rec.pool), b.side === 'sell' ? 'sell' : 'buy', tokens, `page: wallet ${b.wallet} ${b.side} ${b.amount} ${rec.mint.slice(0, 6)}`) };
}

async function body(req: http.IncomingMessage): Promise<any> { let d = ''; for await (const ch of req) d += ch; return d ? JSON.parse(d) : {}; }
const send = (res: http.ServerResponse, code: number, obj: any, type = 'application/json') => {
  if (type === 'application/json') obj = redactDeep(obj);   // FW-17: every JSON body is public; all strings (keys too) are redacted
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : obj); };
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    // ticket 8.5b: the listing, /api/token and /api/trade serve registry mints only (app/site_registry.ts); the registry
    // is read once per request, before any local-record lookup or chain access
    const routed = await siteRoute(url.pathname, req.method ?? 'GET', () => body(req), {
      cluster: c.name,
      launches: () => listLaunches(c.name),
      meta: listing => ({ defaultSchedule: scheduleJson(defaultSchedule(c.name)), cluster: c.label, rpc: c.url, programId: lp.hook.programId.toBase58(), commit, content, liftAuthority: deployer.publicKey.toBase58(), wallets: Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, w.publicKey.toBase58()])), launches: listing.map(l => ({ mint: l.mint, pool: l.pool, time: l.time })) }),
      token: mint => tokenView(mint),
      trade,
    });
    if (routed) return send(res, routed.code, routed.body);
    if (url.pathname === '/api/wallets') { const o: any = {}; for (const [k, w] of Object.entries(wallets)) o[k] = { pubkey: w.publicKey.toBase58(), sol: (await c.connection.getBalance(w.publicKey)) / LAMPORTS_PER_SOL }; return send(res, 200, o); }
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
      const rec = await lp.launch(deployer, { name, symbol, steps, uncappedAfter, migrationQuoteThresholdSol: Number(b.thresholdSol ?? 1), percentageSupplyOnMigration });
      return send(res, 200, createReply(rec));   // ticket 8.5b: registered: false + note; the registry is never written
    }
    if (url.pathname === '/capMath.js') return send(res, 200, capMathJs, 'text/javascript');
    const file = url.pathname === '/' || url.pathname.startsWith('/token/') ? 'index.html' : url.pathname.slice(1);
    const p = join('app/public', file);
    if (!p.startsWith('app/public') || !existsSync(p)) return send(res, 404, { error: 'not found' });
    return send(res, 200, readFileSync(p, 'utf8'), MIME[extname(p)] ?? 'text/plain');
  } catch (e: any) { return send(res, 500, serverError(e)); }   // FW-17: the console line is redacted too (app/errors.ts)
}).listen(PORT, '127.0.0.1', () => console.log(`launch page [${c.label}] http://127.0.0.1:${PORT}  program ${lp.hook.programId.toBase58()}`));

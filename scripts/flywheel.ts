// Flywheel keeper CLI (DEVNET ONLY). Never prints key material.
//   tsx scripts/flywheel.ts <cmd> [--config keeper/devnet.tdt.json] ...
//   setup [--gas-sol 0.05]        fund gas wallet from deployer, pre-create treasury/dev token accounts (gas pays rent)
//   simulate                      build both claim txs and simulate them (no send)
//   run [--send]                  one keeper run (current cadence window). DRY RUN by default: every step is built and
//                                 simulated, nothing is broadcast, saved state/journal/public log are not changed.
//                                 --send broadcasts for real.
//   loop --runs N [--send] [--trade-lamports L]   N scheduled runs, one per window (dry run unless --send;
//                                 scripted trades send txs, so --trade-lamports requires --send)
//   trade --lamports L            scripted trade on route pool by buyerB: buy L lamports of main token, then sell all back
//   pause | unpause               PAUSE file on/off (unpause also clears auto-pause)
//   balances                      throwaway wallet totals (native + wSOL) and main-token holdings
//   verify                        every sig in the public log resolves on devnet; totals == sum of runs
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, unpackAccount } from '@solana/spl-token';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { existsSync, unlinkSync, writeFileSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { loadConfig, type KeeperConfig } from '../sdk/flywheel/config.js';
import { startKeeper, Keeper, MEMO_PROGRAM_ID, initState, dbcPool } from '../sdk/flywheel/keeper.js';
import { Store } from '../sdk/flywheel/store.js';
import { fmtSol } from '../sdk/flywheel/math.js';
import { loadOrCreate } from '../sdk/keys.js';
import { parseSendMode, banner, isolateState, dryRunConnection } from '../sdk/flywheel/dryrun.js';
import { DEVNET_GENESIS, DEVNET_RPC_DEFAULT, assertNotMainnet, explorerTx } from '../sdk/cluster.js';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const { cfg, overrides } = loadConfig(arg('--config', 'keeper/devnet.tdt.json')!);
const evlog = 'flywheel/devnet-events.jsonl'; // CLI-level evidence log (addresses + sigs only)
const MODE = parseSendMode(argv);
const ev = (o: Record<string, unknown>) => { mkdirSync('flywheel', { recursive: true }); appendFileSync(evlog, JSON.stringify({ at: new Date().toISOString(), config: cfg.name, ...o }).replace(/(?<![:\w/])\/(?:[\w.\-]+\/)+[\w.\-]+/g, '<path>') + '\n'); };

const rpcUrl = () => { const u = process.env.FW_RPC_URL ?? process.env.DEVNET_RPC ?? DEVNET_RPC_DEFAULT; assertNotMainnet(u); return u; };
const loadKey = (name: string) => { if (!existsSync(`.devnet-keys/${name}.json`) && !name.startsWith('fw_')) throw new Error(`missing key ${name}`); return loadOrCreate('devnet', name); };
async function devnetConn(): Promise<Connection> {
  if (cfg.cluster !== 'devnet') throw new Error('devnet only');
  const c = new Connection(rpcUrl(), 'confirmed');
  const g = await c.getGenesisHash();
  if (g !== DEVNET_GENESIS) throw new Error(`refusing: genesis ${g} is not devnet`);
  return c;
}
async function keeper(): Promise<Keeper> { return startKeeper(cfg, overrides, { loadKey, connect: async () => devnetConn() }); }
/** Dry-run keeper: same code path, throwaway state copy, connection that only simulates (see sdk/flywheel/dryrun.ts). */
async function dryKeeper() {
  const iso = isolateState(cfg); let dry!: ReturnType<typeof dryRunConnection>;
  const k = await startKeeper(iso.cfg, overrides, { loadKey, connect: async () => { dry = dryRunConnection(await devnetConn(), iso.cfg.state_dir); return dry.conn; } });
  dry.bind({ feePayer: k.keys.gas.publicKey, tWsol: k.tWsol, tMain: k.tMain, dWsol: k.dWsol, mint: k.mint, mainProg: k.mainProg, mainMint: cfg.main_mint });
  return { k, dry, iso };
}
async function dryRunOnce(): Promise<number> {
  const { k, dry, iso } = await dryKeeper();
  try {
    const r = await k.runOnce();
    const unchanged = iso.realUnchanged();
    console.log(JSON.stringify({ dry_run: true, ...r, txs: r.txs.map(x => `(simulated) ${x}`), steps: dry.steps, real_state_unchanged: unchanged }, null, 1));
    for (const st of dry.steps) console.log(`DRY ${st.stage.padEnd(10)} ${st.simulated.padEnd(9)} ${st.units ?? '-'} CU ${JSON.stringify(st.effect)}${st.err ? ` err=${JSON.stringify(st.err)}` : ''}`);
    console.log(`DRY RUN complete: nothing broadcast; real state ${unchanged ? 'unchanged' : 'CHANGED (bug)'}. Re-run with --send to broadcast.`);
    if (!unchanged) return 4;
    return r.status.startsWith('failed') || r.status.includes('mismatch') || dry.steps.some(x => x.simulated === 'error') ? 3 : 0;
  } finally { iso.cleanup(); }
}

async function send(c: Connection, ixs: TransactionInstruction[], signers: Keypair[], purpose: string, skipPreflight = false) {
  const tx = new Transaction().add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(`flywheel:${purpose}`) }), ...ixs);
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash; tx.feePayer = signers[0].publicKey; tx.sign(...signers);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight, maxRetries: 5 });
  for (let i = 0; i < 60; i++) { const st = (await c.getSignatureStatuses([sig])).value[0]; if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break; if ((await c.getBlockHeight()) > lastValidBlockHeight) throw new Error(`${purpose}: expired ${sig}`); await new Promise(r => setTimeout(r, 2000)); }
  let t = null; for (let i = 0; i < 10 && !t; i++) { t = await c.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!t) await new Promise(r => setTimeout(r, 1000)); }
  const ok = !t?.meta?.err;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${purpose} ${explorerTx(sig, 'devnet')}`);
  ev({ kind: 'tx', purpose, sig, ok, fee: t?.meta?.fee, link: explorerTx(sig, 'devnet') });
  return { sig, ok, fee: t?.meta?.fee ?? 0 };
}

async function balances(c: Connection) {
  // signing wallets by key name (pubkey read from the key file); the dev payout by its configured pubkey (no key file)
  const names = ['deployer', 'buyerA', 'buyerB', 'fw_treasury', 'fw_gas', 'fw15_treasury'];
  const wallets: [string, PublicKey][] = names.filter(n => existsSync(`.devnet-keys/${n}.json`)).map(n => [n, loadOrCreate('devnet', n).publicKey]);
  wallets.push(['dev_payout', new PublicKey(cfg.dev_payout)]);
  let native = 0n, wsol = 0n; const rows: any[] = [];
  const mints = [...new Set([cfg.main_mint, ...cfg.sources.filter(s => s.kind === 'dbc').map((s: any) => s.base_mint)])];
  for (const [n, pk] of wallets) {
    const b = BigInt(await c.getBalance(pk, 'confirmed'));
    const wa = getAssociatedTokenAddressSync(NATIVE_MINT, pk, true, TOKEN_PROGRAM_ID);
    const wi = await c.getAccountInfo(wa, 'confirmed');
    const w = wi ? unpackAccount(wa, wi, TOKEN_PROGRAM_ID).amount : 0n;
    const toks: Record<string, string> = {};
    for (const m of mints) { const a = getAssociatedTokenAddressSync(new PublicKey(m), pk, true, TOKEN_2022_PROGRAM_ID); const i = await c.getAccountInfo(a, 'confirmed'); if (i) toks[m.slice(0, 4)] = unpackAccount(a, i, TOKEN_2022_PROGRAM_ID).amount.toString(); }
    native += b; wsol += w; rows.push({ wallet: n, pubkey: pk.toBase58(), native_lamports: b.toString(), wsol_raw: w.toString(), tokens: toks });
  }
  return { rows, native_total: native.toString(), wsol_total: wsol.toString(), total_lamports: (native + wsol).toString(), total_sol: fmtSol(native + wsol) };
}

async function trade(c: Connection, lamports: bigint) {
  const Bk = loadKey('buyerB'); const cp = new CpAmm(c); const pool = new PublicKey(cfg.route_pool!); const mint = new PublicKey(cfg.main_mint);
  const ps: any = await cp.fetchPoolState(pool);
  const common = { payer: Bk.publicKey, pool, tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null };
  const ata = getAssociatedTokenAddressSync(mint, Bk.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const bal = async () => { const i = await c.getAccountInfo(ata, 'confirmed'); return i ? unpackAccount(ata, i, TOKEN_2022_PROGRAM_ID).amount : 0n; };
  const before = await bal();
  const buy = await cp.swap({ ...common, inputTokenMint: NATIVE_MINT, outputTokenMint: mint, amountIn: new BN(lamports.toString()), minimumAmountOut: new BN(1), poolState: ps } as any);
  buy.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const r1 = await send(c, buy.instructions, [Bk], `test-trade:buy:${lamports}`);
  const got = (await bal()) - before;
  const ps2: any = await cp.fetchPoolState(pool);
  const sell = await cp.swap({ ...common, inputTokenMint: mint, outputTokenMint: NATIVE_MINT, amountIn: new BN(got.toString()), minimumAmountOut: new BN(1), poolState: ps2 } as any);
  sell.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const r2 = got > 0n ? await send(c, sell.instructions, [Bk], `test-trade:sell:${got}`) : null;
  return { buy: r1.sig, sell: r2?.sig, tokens: got.toString() };
}

async function tradeOne(c: Connection, side: 'buy' | 'sell', amount: bigint) {
  const Bk = loadKey('buyerB'); const cp = new CpAmm(c); const pool = new PublicKey(cfg.route_pool!); const mint = new PublicKey(cfg.main_mint);
  const ps: any = await cp.fetchPoolState(pool);
  const ata = getAssociatedTokenAddressSync(mint, Bk.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const bal = async () => { const i = await c.getAccountInfo(ata, 'confirmed'); return i ? unpackAccount(ata, i, TOKEN_2022_PROGRAM_ID).amount : 0n; };
  const before = await bal();
  const tx = await cp.swap({ payer: Bk.publicKey, pool, tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    inputTokenMint: side === 'buy' ? NATIVE_MINT : mint, outputTokenMint: side === 'buy' ? mint : NATIVE_MINT, amountIn: new BN(amount.toString()), minimumAmountOut: new BN(1), poolState: ps } as any);
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  const r = await send(c, tx.instructions, [Bk], `test-trade:${side}:${amount}`);
  return { side, amount: amount.toString(), sig: r.sig, token_delta: ((await bal()) - before).toString() };
}

(async () => {
  if (cmd === 'pause') { const st = new Store(cfg.state_dir); mkdirSync(cfg.state_dir, { recursive: true }); writeFileSync(st.pauseFile, `paused ${new Date().toISOString()}\n`); console.log('PAUSE file set'); ev({ kind: 'pause' }); return; }
  if (cmd === 'unpause') {
    const st = new Store(cfg.state_dir); if (existsSync(st.pauseFile)) unlinkSync(st.pauseFile);
    const s = st.loadState(() => initState(cfg)); s.paused = false; s.pause_reason = ''; s.consecutive_failures = 0; st.saveState(s); console.log('unpaused (manual)'); ev({ kind: 'unpause' }); return;
  }
  if (cmd === 'balances') { const c = await devnetConn(); const b = await balances(c); console.log(JSON.stringify(b, null, 1)); ev({ kind: 'balances', label: arg('--label', ''), ...b }); return; }
  if (cmd === 'setup') {
    const c = await devnetConn();
    const dep = loadKey(cfg.keys.claim_signer), T = loadKey(cfg.keys.treasury), G = loadKey(cfg.keys.gas);
    const D = { publicKey: new PublicKey(cfg.dev_payout) };   // payout destination only: no dev key is loaded
    console.log(JSON.stringify({ treasury: T.publicKey.toBase58(), dev_payout: D.publicKey.toBase58(), gas: G.publicKey.toBase58(), claim_signer: dep.publicKey.toBase58() }));
    const gasTarget = BigInt(Math.round(Number(arg('--gas-sol', '0.05')) * 1e9));
    const gb = BigInt(await c.getBalance(G.publicKey));
    if (gb < gasTarget) await send(c, [SystemProgram.transfer({ fromPubkey: dep.publicKey, toPubkey: G.publicKey, lamports: gasTarget - gb })], [dep], `setup:fund-gas:${gasTarget - gb}`);
    const ixs: TransactionInstruction[] = [];
    const want: [PublicKey, PublicKey, PublicKey][] = [[NATIVE_MINT, T.publicKey, TOKEN_PROGRAM_ID], [NATIVE_MINT, D.publicKey, TOKEN_PROGRAM_ID]];
    for (const m of new Set([cfg.main_mint, ...cfg.sources.filter(s => s.kind === 'dbc').map((s: any) => s.base_mint)])) want.push([new PublicKey(m), T.publicKey, TOKEN_2022_PROGRAM_ID]);
    for (const [m, o, p] of want) { const a = getAssociatedTokenAddressSync(m, o, false, p); if (!(await c.getAccountInfo(a))) ixs.push(createAssociatedTokenAccountIdempotentInstruction(G.publicKey, a, o, m, p)); }
    if (ixs.length) await send(c, ixs, [G], `setup:create-token-accounts:${ixs.length}`); else console.log('token accounts exist');
    return;
  }
  if (cmd === 'simulate') {
    const k = await keeper(); const c = k.conn;
    for (const src of cfg.sources) {
      let ix: TransactionInstruction; let claimable = '';
      if (src.kind === 'dbc') { const p: any = await dbcPool(k.dbc, new PublicKey(src.pool)); claimable = p.partnerQuoteFee.toString(); ix = await k.dbcClaimIx(src, BigInt(claimable)); }
      else { const p: any = await k.cp.fetchPoolState(new PublicKey(src.pool)); ix = await k.dammClaimIx(src, p); }
      const tx = new Transaction().add(ix); tx.feePayer = k.keys.gas.publicKey; tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
      const sim = await c.simulateTransaction(tx, undefined, [k.tWsol]);
      const post = sim.value.accounts?.[0] ? unpackAccount(k.tWsol, { ...sim.value.accounts[0], data: Buffer.from(sim.value.accounts[0].data[0], 'base64'), owner: new PublicKey(sim.value.accounts[0].owner) } as any, TOKEN_PROGRAM_ID).amount.toString() : null;
      const out = { source: src.kind, claimable_read: claimable || undefined, err: sim.value.err, units: sim.value.unitsConsumed, treasury_wsol_after_sim: post, logs_tail: sim.value.logs?.slice(-4) };
      console.log(JSON.stringify(out, null, 1)); ev({ kind: 'simulate', ...out });
    }
    // also show v1 claim_trading_fee rejects the transfer-hook pool (spec v1.2 correction)
    const src: any = cfg.sources.find(s => s.kind === 'dbc');
    if (src) {
      const v1 = await (k.dbc.partner as any).claimPartnerTradingFeeToReceiver({ feeClaimer: k.keys.claim.publicKey, payer: k.keys.gas.publicKey, pool: new PublicKey(src.pool), maxBaseAmount: new BN(0), maxQuoteAmount: new BN(1), receiver: k.keys.treasury.publicKey });
      v1.feePayer = k.keys.gas.publicKey; v1.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
      const sim = await c.simulateTransaction(v1);
      const out = { source: 'dbc v1 claim_trading_fee (expected to fail)', err: sim.value.err, logs_tail: sim.value.logs?.filter(l => /Error|mismatch/i.test(l)).slice(-3) };
      console.log(JSON.stringify(out, null, 1)); ev({ kind: 'simulate', ...out });
    }
    return;
  }
  if (cmd === 'sigs') { // FW-13 evidence: newest signature per keeper address
    const c = await devnetConn(); const out: Record<string, any> = {};
    for (const n of [cfg.keys.claim_signer, cfg.keys.treasury, cfg.keys.gas]) { const pk = loadKey(n).publicKey; const s = await c.getSignaturesForAddress(pk, { limit: 1 }); out[n] = { pubkey: pk.toBase58(), newest: s[0]?.signature ?? null, slot: s[0]?.slot ?? null }; }
    console.log(JSON.stringify(out)); ev({ kind: 'sigs', label: arg('--label', ''), ...out }); return;
  }
  if (cmd === 'quote') { const k = await keeper(); for (const l of (arg('--lamports', '1000000')!).split(',')) { const q = await k.quote(BigInt(l)); console.log(JSON.stringify({ in: l, out: q.out.toString(), impact_bps: q.impactBps, spot_out: q.spotOut.toString() })); } return; }
  if (cmd === 'trade-buy') { const c = await devnetConn(); const r = await tradeOne(c, 'buy', BigInt(arg('--lamports')!)); console.log(JSON.stringify(r)); ev({ kind: 'scripted_trade', ...r }); return; }
  if (cmd === 'trade-sell') { const c = await devnetConn(); const r = await tradeOne(c, 'sell', BigInt(arg('--tokens')!)); console.log(JSON.stringify(r)); ev({ kind: 'scripted_trade', ...r }); return; }
  if (cmd === 'trade') { const c = await devnetConn(); const r = await trade(c, BigInt(arg('--lamports', '100000000')!)); console.log(JSON.stringify(r)); return; }
  if (cmd === 'run') {
    console.log(banner(MODE, cfg, 'run'));
    if (MODE === 'dry_run') process.exit(await dryRunOnce());
    const k = await keeper(); const r = await k.runOnce(); console.log(JSON.stringify(r)); ev({ kind: 'run', ...r, overrides });
    process.exit(r.status.startsWith('failed') || r.status.includes('mismatch') ? 3 : 0);
  }
  if (cmd === 'loop') {
    const runs = Number(arg('--runs', '5')); const tradeL = arg('--trade-lamports');
    console.log(banner(MODE, cfg, `loop --runs ${runs}`));
    if (MODE === 'dry_run') {
      if (tradeL) throw new Error('--trade-lamports sends scripted trades; it requires --send');
      let worst = 0;
      for (let i = 0; i < runs; i++) {
        const w = cfg.cadence_seconds * 1000; const next = Math.floor(Date.now() / w) * w + w;
        if (i > 0) { const wait = next - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait + 1500)); }
        worst = Math.max(worst, await dryRunOnce());   // each iteration starts from a fresh copy of the (unchanged) real state
      }
      process.exit(worst);
    }
    const k = await keeper();
    for (let i = 0; i < runs; i++) {
      // wait for the next cadence window (unattended schedule)
      const w = cfg.cadence_seconds * 1000; const next = Math.floor(Date.now() / w) * w + w; 
      if (tradeL) { const r = await trade(k.conn, BigInt(tradeL)); ev({ kind: 'scripted_trade', ...r }); }
      const wait = next - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait + 1500));
      const r = await k.runOnce(); console.log(JSON.stringify(r)); ev({ kind: 'run', ...r, overrides, loop_index: i });
    }
    return;
  }
  if (cmd === 'verify') {
    const c = await devnetConn(); const log = JSON.parse(readFileSync(cfg.public_log, 'utf8'));
    if (log.current_run) log.runs = [...log.runs, log.current_run];   // an open (e.g. paused mid-run) run already moved totals
    const sigs = new Set<string>(); for (const r of log.runs) { for (const t of r.txs ?? []) sigs.add(t); } for (const b of log.burns) sigs.add(b.sig);
    const arr = [...sigs]; let bad: string[] = [];
    for (let i = 0; i < arr.length; i += 100) { const st = await c.getSignatureStatuses(arr.slice(i, i + 100), { searchTransactionHistory: true }); st.value.forEach((v, j) => { if (!v) bad.push(arr[i + j]); }); }
    const sum = (f: (r: any) => string | undefined) => log.runs.reduce((a: bigint, r: any) => a + BigInt(f(r) ?? '0'), 0n);
    const claimed = log.runs.reduce((a: bigint, r: any) => a + r.claims.reduce((x: bigint, cl: any) => x + BigInt(cl.claimed_lamports), 0n), 0n);
    const dev = sum(r => r.dev_lamports), spent = log.runs.reduce((a: bigint, r: any) => a + (r.swap?.status === 'confirmed' ? BigInt(r.swap.in_lamports) : 0n), 0n);
    const burned = log.runs.reduce((a: bigint, r: any) => a + (r.burn?.verified ? BigInt(r.burn.burned_raw) : 0n), 0n);
    const t = log.totals_raw;
    const out = { sigs: arr.length, unresolved: bad, claimed_ok: claimed.toString() === t.claimed_lamports, dev_ok: dev.toString() === t.dev_lamports, spent_ok: spent.toString() === t.spent_lamports, burned_ok: burned.toString() === t.burned_raw,
      burns_paired_with_swap: log.runs.filter((r: any) => r.burn?.sig).every((r: any) => r.swap?.status === 'confirmed'), totals: t };
    console.log(JSON.stringify(out, null, 1)); ev({ kind: 'verify', ...out }); return;
  }
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(0, 15).join('\n'));
})().catch(e => { console.error(`ERROR: ${e?.message ?? e}`); ev({ kind: 'error', cmd, error: String(e?.message ?? e).slice(0, 300) }); process.exit(1); });

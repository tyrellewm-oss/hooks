// Flywheel keeper offline tests (spec v1.2.1): integer math, swap sizing, three-key refusals (FW-22..FW-25),
// pause = zero RPC/tx (FW-13) and mid-run pause before every send (U-4), window idempotency, fail-closed log write (FW-14), public log hygiene (FW-17).
// No network: every Connection here is a trap that throws on any use.
import { test } from 'node:test';
import { launchCall } from './launch_key.js';
import assert from 'node:assert/strict';
import { Keypair, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import { utils as anchorUtils } from '@coral-xyz/anchor';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFees, minOut, spotOutBtoA, deviationBps, planSwap, runIdFor, historyWarning, fmtSol, pctOf } from '../sdk/flywheel/math.js';
import { keeperStartChecks, launchConfigChecks, KeyRuleRefusal } from '../sdk/keyrules.js';
import { preflightOffline, startKeeper, Keeper, initState, publicLog, newRun, MEMO_PROGRAM_ID, type KeySet } from '../sdk/flywheel/keeper.js';
import { applyOverrides, type KeeperConfig } from '../sdk/flywheel/config.js';
import { Launchpad } from '../sdk/launch.js';
import { HOOK_PROGRAM_ID_DEVNET, HookProgramPinRefusal, BPF_UPGRADEABLE } from '../sdk/hook.js';
import { RegistryRefusal } from '../sdk/registry.js';

const base = JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')) as KeeperConfig;
const trapConn = () => new Proxy({}, { get: (_t, p) => { if (p === 'then') return undefined; throw new Error(`network used: ${String(p)}`); } }) as unknown as Connection;
const keys = (): KeySet => ({ claim: Keypair.generate(), treasury: Keypair.generate(), gas: Keypair.generate() });
const cfgWith = (o: Partial<KeeperConfig>): KeeperConfig => ({ ...base, pinned_pubkeys: undefined, ...o });

// ---------------- math
test('split: dev = floor(x*15/100), buyback gets the dust, exact sum (incl. live run 1 value)', () => {
  assert.deepEqual(splitFees(8_553_996n), { dev: 1_283_099n, buyback: 7_270_897n });
  assert.deepEqual(splitFees(0n), { dev: 0n, buyback: 0n });
  assert.deepEqual(splitFees(6n), { dev: 0n, buyback: 6n });
  for (let i = 0; i < 2000; i++) { const x = BigInt(Math.floor(Math.random() * 1e15)); const { dev, buyback } = splitFees(x); assert.equal(dev + buyback, x); assert.equal(dev, (x * 15n) / 100n); }
  assert.throws(() => splitFees(-1n));
});
test('minOut and spot math are integer and floor', () => {
  assert.equal(minOut(191_561_928_674n, 100), 189_646_309_387n);   // value recorded by the supervised devnet run
  assert.equal(minOut(10_000n, 0), 10_000n);
  assert.throws(() => minOut(1n, 10_000));
  const x64 = 1n << 64n; assert.equal(spotOutBtoA(1000n, x64), 1000n);        // price 1
  assert.equal(spotOutBtoA(1000n, x64 * 2n), 250n);                            // sqrt 2 → price 4
  assert.equal(deviationBps(10_000n, 9_965n), 35); assert.equal(deviationBps(100n, 120n), 0);
});
test('planSwap: max cap carry-over, halving, both, and fail-closed after 3 halvings (FW-4/FW-11/FW-21)', async () => {
  const imp = (perLamport: number) => async (inL: bigint) => ({ out: inL * 1000n, impactBps: Math.ceil(Number(inL) * perLamport) });
  let p = await planSwap(7_270_897n, 1_000_000n, 200, 3, imp(0));
  assert.deepEqual([p.inLamports, p.carryover, p.reason, p.halvings], [1_000_000n, 6_270_897n, 'max_cap', 0]);
  p = await planSwap(800_000n, 1_000_000n, 200, 3, imp(0.0004));            // 320 bps → halve once → 160
  assert.deepEqual([p.inLamports, p.carryover, p.reason, p.halvings], [400_000n, 400_000n, 'impact_halving', 1]);
  p = await planSwap(5_000_000n, 1_000_000n, 200, 3, imp(0.0005));          // 500 → 250 → 125
  assert.deepEqual([p.inLamports, p.carryover, p.reason, p.halvings], [250_000n, 4_750_000n, 'max_cap+impact_halving', 2]);
  p = await planSwap(500n, 1_000_000n, 200, 3, imp(0));
  assert.deepEqual([p.inLamports, p.carryover, p.reason], [500n, 0n, 'none']);
  await assert.rejects(planSwap(1_000_000n, 1_000_000n, 200, 3, imp(0.01)), /impact_too_high/);
  await assert.rejects(planSwap(0n, 1n, 200, 3, imp(0)), /nothing pending/);
});
test('run id is one per cadence window; soft history warning (FW-18) never throws', () => {
  assert.equal(runIdFor('devnet', Date.UTC(2026, 9, 4, 0, 17, 31), 300), 'devnet-2026-10-04T00:15:00Z');
  assert.equal(runIdFor('devnet', Date.UTC(2026, 9, 4, 0, 17, 31), 60), 'devnet-2026-10-04T00:17:00Z');
  assert.equal(historyWarning(100n, [], 10), null);
  assert.equal(historyWarning(105n, [100n, 101n, 99n], 10), null);
  assert.match(historyWarning(120n, [100n, 101n, 99n, 100n, 100n], 10)!, /warn_price_vs_history/);
  assert.equal(fmtSol(1_283_099n), '0.001283099'); assert.equal(pctOf(191_561_928_674n, 1_000_000_000_000_000n), '0.0191');
});

// ---------------- three-key rule (FW-22..FW-25): mainnet refusals offline, before any connection or tx
test('FW-22: force_fail_swap on mainnet → refuses to start, no connect, no tx', async () => {
  let connected = 0; const k = keys();
  const cfg = cfgWith({ cluster: 'mainnet', force_fail_swap: true, hook_upgrade_authority: Keypair.generate().publicKey.toBase58(), hook_lift_authority: Keypair.generate().publicKey.toBase58() });
  await assert.rejects(startKeeper(cfg, [], { loadKey: n => (k as any)[n === 'deployer' ? 'claim' : n.replace('fw_', '')], connect: async () => { connected++; return trapConn(); }, log: () => {} }), (e: any) => e instanceof KeyRuleRefusal && /force_fail_swap is devnet-only/.test(e.message));
  assert.equal(connected, 0);
});
for (const [name, role, which] of [['FW-23a: keeper key = upgrade authority', 'claim', 'upgrade'], ['FW-23b: keeper key = lift authority', 'gas', 'lift']] as const) {
  test(`${name} on mainnet → refuses to start, no connect, no tx`, async () => {
    let connected = 0; const k = keys(); const auth = k[role].publicKey.toBase58(); const other = Keypair.generate().publicKey.toBase58();
    const cfg = cfgWith({ cluster: 'mainnet', hook_upgrade_authority: which === 'upgrade' ? auth : other, hook_lift_authority: which === 'lift' ? auth : other });
    await assert.rejects(startKeeper(cfg, [], { loadKey: n => (k as any)[n === 'deployer' ? 'claim' : n.replace('fw_', '')], connect: async () => { connected++; return trapConn(); }, log: () => {} }), (e: any) => e instanceof KeyRuleRefusal && new RegExp(`${which} authority`).test(e.message));
    assert.equal(connected, 0);
  });
}
// launch(): the hook gate runs first (also with o.authorities); its genesis class, not the Cluster's name, decides §12a
// warn-vs-refuse. On mainnet/testnet/unknown genesis the gate itself refuses first (no pinned hook there yet).
const LG = { devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' };
function launchFake(name: string, genesis: string, url?: string) {
  const n = { built: 0, reads: 0 };
  const hook = new PublicKey(process.env.HOOK_PROGRAM_ID && url ? process.env.HOOK_PROGRAM_ID : HOOK_PROGRAM_ID_DEVNET);
  const fake: any = {
    c: { name, url, connection: { getGenesisHash: async () => genesis, getAccountInfo: async (k: PublicKey) => { n.reads++; return k.equals(hook) ? { owner: BPF_UPGRADEABLE, executable: true } : null; } } },
    hook: { programId: hook }, configParams: () => ({}),
    dbc: { partner: { createConfigWithTransferHook: async () => { n.built++; throw new Error('tx built'); } }, creator: {} },
  };
  return { fake, n };
}
const sameKeyOpts = (deployer: Keypair, which: 'upgrade' | 'lift' | 'both') => {
  const other = Keypair.generate().publicKey.toBase58(), d = deployer.publicKey.toBase58();
  const authorities = which === 'both' ? { upgradeAuthority: other, liftAuthority: other } : { upgradeAuthority: which === 'upgrade' ? d : other, liftAuthority: which === 'lift' ? d : Keypair.generate().publicKey.toBase58() };
  return { name: 'x', symbol: 'X', steps: [], uncappedAfter: 1n, authorities } as any;
};
async function quiet<T>(f: () => Promise<T>): Promise<{ r: Promise<T>; warns: string[] }> {
  const warns: string[] = []; const w = console.warn; console.warn = (m: any) => { warns.push(String(m)); };
  try { const r = f(); await r.catch(() => {}); return { r, warns }; } finally { console.warn = w; }
}
for (const [label, which] of [['FW-24a: feeClaimer = upgrade authority', 'upgrade'], ['FW-24b: feeClaimer = lift authority', 'lift'], ['§12a: upgrade == lift', 'both']] as const) {
  test(`${label}: a Cluster NAMED "mainnet" on devnet genesis → devnet rules (warn, reaches the build); the name never decides`, async () => {
    const deployer = Keypair.generate(); const { fake, n } = launchFake('mainnet', LG.devnet);
    const { r, warns } = await quiet(() => launchCall(fake, deployer, sameKeyOpts(deployer, which)));
    await assert.rejects(r, /tx built/); assert.equal(n.built, 1);
    assert.ok(warns.some(x => /accepted throwaway exception on devnet/.test(x)), warns.join('\n'));
  });
  test(`${label}: reverse, a Cluster NAMED "devnet" on mainnet genesis → refused before any build and before any account read (hook gate first)`, async () => {
    const deployer = Keypair.generate(); const { fake, n } = launchFake('devnet', LG.mainnet);
    await assert.rejects(launchCall(fake, deployer, sameKeyOpts(deployer, which)), HookProgramPinRefusal);
    assert.equal(n.built, 0); assert.equal(n.reads, 0);
  });
  test(`${label}: NAMED "mainnet" on mainnet genesis with o.authorities → the hook gate refuses first (not the §12a check), 0 builds`, async () => {
    const deployer = Keypair.generate(); const { fake, n } = launchFake('mainnet', LG.mainnet);
    await assert.rejects(launchCall(fake, deployer, sameKeyOpts(deployer, which)), (e: any) => e instanceof HookProgramPinRefusal && !(e instanceof KeyRuleRefusal));
    assert.equal(n.built, 0);
  });
}
test('§12a on a local validator (localhost + unknown genesis) named "mainnet" → local rules (warn), reaches the build', async () => {
  const prev = process.env.HOOK_PROGRAM_ID; const h = Keypair.generate().publicKey.toBase58(); process.env.HOOK_PROGRAM_ID = h;
  try {
    const deployer = Keypair.generate(); const { fake, n } = launchFake('mainnet', Keypair.generate().publicKey.toBase58(), 'http://127.0.0.1:8899');
    const { r, warns } = await quiet(() => launchCall(fake, deployer, sameKeyOpts(deployer, 'both')));
    await assert.rejects(r, /tx built/); assert.equal(n.built, 1);
    assert.ok(warns.some(x => /accepted throwaway exception on local/.test(x)), 'local rules warn (accepted throwaway exception on local)');
  } finally { if (prev === undefined) delete process.env.HOOK_PROGRAM_ID; else process.env.HOOK_PROGRAM_ID = prev; }
});
test('§12a classes: testnet and unknown refuse like mainnet (only devnet/local warn)', () => {
  const k = Keypair.generate().publicKey.toBase58();
  for (const c of ['mainnet', 'testnet', 'unknown']) {
    assert.throws(() => launchConfigChecks(c, Keypair.generate().publicKey.toBase58(), { upgradeAuthority: k, liftAuthority: k }), KeyRuleRefusal, c);
    assert.throws(() => keeperStartChecks(c, {}, { upgradeAuthority: k, liftAuthority: k }), KeyRuleRefusal, c);
  }
  for (const c of ['devnet', 'local']) assert.equal(launchConfigChecks(c, Keypair.generate().publicKey.toBase58(), { upgradeAuthority: k, liftAuthority: k }).length, 1);
});
test('FW-24: distinct claimer passes the check on mainnet; unknown authorities refuse', () => {
  assert.deepEqual(launchConfigChecks('mainnet', Keypair.generate().publicKey.toBase58(), { upgradeAuthority: Keypair.generate().publicKey.toBase58(), liftAuthority: Keypair.generate().publicKey.toBase58(), launchAuthority: Keypair.generate().publicKey.toBase58() }), []);
  assert.throws(() => launchConfigChecks('mainnet', 'x', { upgradeAuthority: null, liftAuthority: 'y' }), KeyRuleRefusal);
  assert.throws(() => keeperStartChecks('mainnet', {}, { upgradeAuthority: null, liftAuthority: null }), KeyRuleRefusal);
});
test('FW-25: devnet TDT shared key 9DVu… → visible warnings, no refusal', () => {
  const k = keys(); const shared = k.claim.publicKey.toBase58();
  const w = preflightOffline(cfgWith({ cluster: 'devnet', hook_upgrade_authority: shared, hook_lift_authority: shared }), k);
  // 3 warnings: claimer = upgrade authority, claimer = lift authority, upgrade authority = lift authority
  assert.equal(w.length, 3); for (const x of w) assert.match(x, /^WARNING three-key rule \(accepted throwaway exception on devnet\)/);
  assert.ok(w.some(x => /upgrade authority and lift authority are the same key/.test(x)));
  const lw = launchConfigChecks('devnet', shared, { upgradeAuthority: shared, liftAuthority: shared }); assert.equal(lw.length, 3);
  // the real devnet config pins 9DVu… for claimer + both authorities → warns (does not refuse)
  assert.equal(base.hook_upgrade_authority, base.pinned_pubkeys!.claim_signer); assert.equal(base.hook_lift_authority, base.pinned_pubkeys!.claim_signer);
});
test('non-devnet clusters are refused even with clean keys (devnet-only build)', () => {
  const k = keys();
  assert.throws(() => preflightOffline(cfgWith({ cluster: 'mainnet', hook_upgrade_authority: Keypair.generate().publicKey.toBase58(), hook_lift_authority: Keypair.generate().publicKey.toBase58(), hook_launch_authority: Keypair.generate().publicKey.toBase58() }), k), /devnet-only/);
});

// ---------------- keeper behaviour without network
const mkKeeper = (o: Partial<KeeperConfig> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-'));
  const cfg = cfgWith({ state_dir: join(dir, 'state'), public_log: join(dir, 'pub.json'), ...o });
  return { k: new Keeper(cfg, [], trapConn(), keys(), [], () => {}), cfg, dir };
};
test('FW-13: paused (flag, PAUSE file, auto-pause) → zero RPC and zero txs, logged as paused', async () => {
  const a = mkKeeper({ paused: true }); const r = await a.k.runOnce(); assert.equal(r.status, 'paused'); assert.deepEqual(r.txs, []);
  const b = mkKeeper(); mkdirSync(b.cfg.state_dir, { recursive: true }); writeFileSync(join(b.cfg.state_dir, 'PAUSE'), 'x'); const r2 = await b.k.runOnce(); assert.equal(r2.status, 'paused');
  const c = mkKeeper(); const s = initState(c.cfg); s.paused = true; s.pause_reason = '3 consecutive failed runs'; c.k.store.saveState(s);
  for (let i = 0; i < 3; i++) { const r3 = await c.k.runOnce(Date.now() + i * 300_000); assert.equal(r3.status, 'paused'); }
  const pub = JSON.parse(readFileSync(c.cfg.public_log, 'utf8')); assert.equal(pub.paused, true); assert.equal(pub.runs.length, 3);
});
test('same window re-run → noop, zero RPC (FW-8 window idempotency)', async () => {
  const a = mkKeeper(); const s = initState(a.cfg); const now = Date.UTC(2026, 9, 4, 0, 16); s.runs.push(newRun(runIdFor('devnet', now, a.cfg.cadence_seconds), [], 'logged', '')); a.k.store.saveState(s);
  const r = await a.k.runOnce(now + 1000); assert.equal(r.status, 'noop_window_done'); assert.deepEqual(r.txs, []);
});
test('FW-14: public log unwritable → failed_log before any RPC/tx', async () => {
  const d = mkdtempSync(join(tmpdir(), 'fwlog-')); writeFileSync(join(d, 'afile'), 'x');
  const a = mkKeeper({ public_log: join(d, 'afile', 'fw.json') });   // parent is a file → ENOTDIR
  const r = await a.k.runOnce(); assert.equal(r.status, 'failed_log'); assert.deepEqual(r.txs, []);
});
test('FW-22 (devnet side): force_fail_swap allowed on devnet only; test knobs refused elsewhere', () => {
  const k = keys(); const shared = k.claim.publicKey.toBase58();
  assert.doesNotThrow(() => preflightOffline(cfgWith({ cluster: 'devnet', force_fail_swap: true, hook_upgrade_authority: shared, hook_lift_authority: shared }), k));
  const { cfg, overrides } = applyOverrides(base, { FW_FORCE_FAIL_SWAP: '1', FW_MAX_SWAP_LAMPORTS: '1000000' } as any);
  assert.equal(cfg.force_fail_swap, true); assert.equal(cfg.max_swap_lamports_per_run, '1000000'); assert.equal(base.max_swap_lamports_per_run, '500000000');
  assert.deepEqual(overrides, ['FW_MAX_SWAP_LAMPORTS=1000000', 'FW_FORCE_FAIL_SWAP=1']);
});
test('FW-17: public log has addresses/sigs only — no key arrays, no internal paths', () => {
  const s = initState(base); s.runs.push(newRun('devnet-x', ['FW_MAX_SWAP_LAMPORTS=1000000'], 'logged', ''));
  const txt = JSON.stringify(publicLog(s, base));
  assert.doesNotMatch(txt, /\[(\s*\d{1,3}\s*,){31,}/); assert.doesNotMatch(txt, /(?<![:\w/])\/(?:[\w.\-]+\/)+[\w.\-]+|\.devnet-keys|state_dir|journal/);
  for (const k of ['mint', 'burnedTokens', 'pctOfSupply', 'claimedSol', 'devSol', 'spentSol', 'reserveSol', 'burns', 'paused', 'state', 'runs']) assert.ok(k in JSON.parse(txt), k);
  if (existsSync('flywheel/devnet-tdt.json')) { const live = readFileSync('flywheel/devnet-tdt.json', 'utf8'); assert.doesNotMatch(live, /\[(\s*\d{1,3}\s*,){31,}/); assert.doesNotMatch(live, /(?<![:\w/])\/(?:[\w.\-]+\/)+[\w.\-]+|\.devnet-keys/); }
  const s2 = initState(base); s2.paused = true; s2.pause_reason = 'log write failed: EACCES /some/dir/fw.json see https://explorer.solana.com/tx/abc?cluster=devnet';
  const pr = (publicLog(s2, base) as any).pause_reason as string; assert.match(pr, /<path>/); assert.doesNotMatch(pr, /\/some\/dir/); assert.match(pr, /https:\/\/explorer\.solana\.com\/tx\/abc/);
});

// ---------------- U-4: pause checked immediately before EVERY send (claim, dev, swap, burn)
// Offline harness: a fake chain at the RPC boundary. sendRawTransaction applies the stage's effect to an in-memory
// ledger and returns a parsed tx with real pre/post token balances, so the keeper's own effect checks and
// reconciliation run unchanged. No network.
type Ledger = Record<string, bigint>;
function midrun(onSend: (stage: string, h: { pause: () => void; envPause: () => void }) => void = () => {}, over: Partial<KeeperConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-mid-'));
  const ks = keys();
  const dbcSrc = base.sources.find(x => x.kind === 'dbc')!;
  const cfg = cfgWith({ state_dir: join(dir, 'state'), public_log: join(dir, 'pub.json'), sources: [dbcSrc], max_swap_lamports_per_run: '1000000', min_claim_lamports: '1000000', ...over });
  const k = new Keeper(cfg, [], trapConn(), ks, [], () => {});
  const tW = k.tWsol.toBase58(), tM = k.tMain.toBase58(), dW = k.dWsol.toBase58();
  const L: Ledger = { [tW]: 0n, [tM]: 0n, [dW]: 0n, supply: 1_000_000_000_000_000n };
  let dbcFee = 5_000_000n;
  const sent: string[] = []; const parsed = new Map<string, any>();
  const h = { pause: () => { mkdirSync(cfg.state_dir, { recursive: true }); writeFileSync(join(cfg.state_dir, 'PAUSE'), 'x'); }, envPause: () => { process.env.FW_PAUSED = '1'; } };
  (k as any).conn = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }),
    getBlockHeight: async () => 1,
    getBalance: async (pk: PublicKey) => (pk.equals(ks.gas.publicKey) ? 1_000_000_000 : 0),
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(x => (parsed.has(x) ? { confirmationStatus: 'confirmed' } : null)) }),
    getParsedTransaction: async (sig: string) => parsed.get(sig) ?? null,
    sendRawTransaction: async (buf: Buffer) => {
      const tx = Transaction.from(buf); const sig = anchorUtils.bytes.bs58.encode(tx.signature!);
      const memo = tx.instructions.map(i => i.data.toString()).find(d => d.startsWith('flywheel:'))!; const stage = memo.split(':').at(-1)!;
      const it = JSON.parse(readFileSync(join(cfg.state_dir, 'state.json'), 'utf8')).current.stages[stage].intent;
      const pre = { ...L }; const ixs: any[] = [];
      if (stage === 'claim_dbc') { L[tW] += BigInt(it.max_quote); dbcFee = 0n; }
      else if (stage === 'dev') { L[tW] -= BigInt(it.dev); L[dW] += BigInt(it.dev); }
      else if (stage === 'swap') { L[tW] -= BigInt(it.in_lamports); L[tM] += BigInt(it.in_lamports) * 1000n; }
      else if (stage === 'burn') { L[tM] -= BigInt(it.amount); L.supply -= BigInt(it.amount); ixs.push({ programId: TOKEN_2022_PROGRAM_ID, parsed: { type: 'burnChecked', info: { mint: cfg.main_mint, tokenAmount: { amount: it.amount } } } }); }
      const acct = [ks.gas.publicKey, k.tWsol, k.tMain, k.dWsol, ks.treasury.publicKey];
      const bal = (l: Ledger) => [1, 2, 3].map(i => ({ accountIndex: i, uiTokenAmount: { amount: l[acct[i].toBase58()].toString() } }));
      parsed.set(sig, { slot: 1, blockTime: 1_790_000_000, transaction: { message: { accountKeys: acct.map(pubkey => ({ pubkey })), instructions: ixs } },
        meta: { err: null, fee: 5000, preTokenBalances: bal(pre), postTokenBalances: bal(L), preBalances: [0, 0, 0, 0, 0], postBalances: [0, 0, 0, 0, 0] } });
      sent.push(stage); onSend(stage, h); return sig;
    },
  };
  (k as any).pinnedChecks = async () => {};
  (k as any).tokenAmt = async (ata: PublicKey) => L[ata.toBase58()];
  (k as any).supply = async () => L.supply;
  (k as any).dbc = { state: { getPool: async () => ({ partnerQuoteFee: { toString: () => dbcFee.toString() }, isMigrated: 1 }) } };
  (k as any).dbcClaimIx = async () => new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: ks.claim.publicKey, isSigner: true, isWritable: false }], data: Buffer.from('claim') });
  (k as any).quote = async (inL: bigint) => ({ out: inL * 1000n, impactBps: 10, spotOut: inL * 1000n, pool: {} });
  (k as any).priceCheck = async (_s: any, _r: any, plan: any) => minOut(plan.quoteOut, cfg.max_slippage_bps);   // ticket #5 checks are tested in tests/price_source.test.ts
  (k as any).cp = { swap: async () => ({ instructions: [new TransactionInstruction({ programId: CP_AMM_PROGRAM_ID, data: Buffer.alloc(1),
    keys: [{ pubkey: ks.treasury.publicKey, isSigner: true, isWritable: false }, ...[k.tWsol, k.tMain].map(pubkey => ({ pubkey, isSigner: false, isWritable: true }))] })] }) };
  const state = () => k.store.loadState(() => initState(cfg));
  const unpause = () => { try { rmSync(join(cfg.state_dir, 'PAUSE')); } catch {} delete process.env.FW_PAUSED; const s = state(); s.paused = false; s.pause_reason = ''; k.store.saveState(s); };
  return { k, cfg, sent, L, state, unpause, parsed, ks };
}
const T0 = Date.UTC(2026, 9, 4, 1, 0), W = 300_000;

test('U-4: no pause → normal run (claim, dev, swap, burn), reconciled', async () => {
  const m = midrun(); const r = await m.k.runOnce(T0);
  assert.equal(r.status, 'logged'); assert.deepEqual(m.sent, ['claim_dbc', 'dev', 'swap', 'burn']); assert.equal(r.txs.length, 4);
  const s = m.state(); assert.equal(s.consecutive_failures, 0); assert.equal(s.paused, false); assert.equal(s.current, null);
  assert.equal(s.runs.at(-1)!.reconcile!.ok, true);
  assert.deepEqual([s.totals.claimed_lamports, s.totals.dev_lamports, s.totals.spent_lamports, s.pending_lamports, s.totals.burned_raw, s.unburned_raw], ['5000000', '750000', '1000000', '3250000', '1000000000', '0']);
});

test('U-4: PAUSE file set after the claim → stops before the dev payout; nothing else sent; resumes after unpause', async () => {
  const m = midrun((st, h) => { if (st === 'claim_dbc') h.pause(); });
  const r = await m.k.runOnce(T0);
  assert.equal(r.status, 'paused_midrun'); assert.deepEqual(m.sent, ['claim_dbc']); assert.match(r.reason, /PAUSE file.*before dev/);
  let s = m.state();
  assert.equal(s.current!.status, 'paused_midrun'); assert.equal(s.current!.stopped_before, 'dev');
  assert.equal(s.unsplit_lamports, '5000000'); assert.equal(s.pending_lamports, '0'); assert.equal(s.totals.dev_lamports, '0');   // claimed, not split: stays for re-plan
  assert.equal(s.consecutive_failures, 0); assert.equal(s.paused, true);                                                           // not a failure; pause is sticky
  assert.equal(JSON.parse(readFileSync(m.cfg.public_log, 'utf8')).current_run.stopped_before, 'dev');
  const r2 = await m.k.runOnce(T0 + W); assert.equal(r2.status, 'paused'); assert.deepEqual(m.sent, ['claim_dbc']);              // still paused: zero sends
  m.unpause();
  const r3 = await m.k.runOnce(T0 + 2 * W);
  assert.equal(r3.status, 'logged'); assert.equal(r3.run_id, r.run_id); assert.deepEqual(m.sent, ['claim_dbc', 'dev', 'swap', 'burn']);   // no 2nd claim
  s = m.state(); const run = s.runs.find(x => x.run_id === r.run_id)!;
  assert.equal(run.reconcile!.ok, true); assert.equal(run.stopped_before, undefined); assert.deepEqual(run.midrun_pauses!.map(p => p.before), ['dev']);
  assert.deepEqual([s.totals.claimed_lamports, s.totals.dev_lamports, s.totals.spent_lamports, s.pending_lamports, s.unsplit_lamports], ['5000000', '750000', '1000000', '3250000', '0']);
  assert.equal(s.consecutive_failures, 0);
});

test('U-4: env flag set after the dev payout → stops before the swap; buyback stays pending', async () => {
  try {
    const m = midrun((st, h) => { if (st === 'dev') h.envPause(); });
    const r = await m.k.runOnce(T0);
    assert.equal(r.status, 'paused_midrun'); assert.deepEqual(m.sent, ['claim_dbc', 'dev']); assert.match(r.reason, /config\/env flag.*before swap/);
    const s = m.state(); assert.equal(s.current!.stopped_before, 'swap'); assert.equal(s.current!.swap!.status, 'not_sent');
    assert.equal(s.pending_lamports, '4250000'); assert.equal(s.totals.spent_lamports, '0'); assert.equal(s.consecutive_failures, 0);
  } finally { delete process.env.FW_PAUSED; }
});

test('U-4: PAUSE file set after the swap → burn not sent; after unpause the same run burns exactly the swap output', async () => {
  const m = midrun((st, h) => { if (st === 'swap') h.pause(); });
  const r = await m.k.runOnce(T0);
  assert.equal(r.status, 'paused_midrun'); assert.deepEqual(m.sent, ['claim_dbc', 'dev', 'swap']);
  let s = m.state(); assert.equal(s.current!.stopped_before, 'burn'); assert.equal(s.unburned_raw, '1000000000'); assert.equal(s.totals.burned_raw, '0'); assert.equal(s.consecutive_failures, 0);
  m.unpause();
  const r2 = await m.k.runOnce(T0 + W);
  assert.equal(r2.status, 'logged'); assert.deepEqual(m.sent, ['claim_dbc', 'dev', 'swap', 'burn']);   // no 2nd swap
  s = m.state(); assert.equal(s.totals.burned_raw, '1000000000'); assert.equal(s.unburned_raw, '0'); assert.equal(s.burns.at(-1)!.run_id, r.run_id);   // FW-19 pairing kept
  assert.equal(s.runs.at(-1)!.reconcile!.ok, true);
});

test('U-4: three mid-run pauses in a row never trip the 3-failure auto-pause counter', async () => {
  let on = true; const m = midrun((_st, h) => { if (on) h.pause(); });   // pause right after every send
  const outs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await m.k.runOnce(T0 + i * W); outs.push(`${r.status}:${m.state().current?.stopped_before}`);
    const s = m.state(); assert.equal(s.consecutive_failures, 0); assert.ok(!s.pause_reason.includes('consecutive')); m.unpause();
  }
  assert.deepEqual(outs, ['paused_midrun:dev', 'paused_midrun:swap', 'paused_midrun:burn']); assert.deepEqual(m.sent, ['claim_dbc', 'dev', 'swap']);
  on = false; const r = await m.k.runOnce(T0 + 3 * W); assert.equal(r.status, 'logged'); assert.deepEqual(m.sent, ['claim_dbc', 'dev', 'swap', 'burn']);
  assert.deepEqual(m.state().runs.at(-1)!.midrun_pauses!.map(p => p.before), ['dev', 'swap', 'burn']);
});

test('U-4: pause before the swap, pool spot moves while paused → resume re-quotes fresh and fails closed (failed_price), no swap sent', async () => {
  const m = midrun((st, h) => { if (st === 'dev') h.pause(); });
  // use the keeper's real quote() (spot from a fresh pool read vs the SDK quote) instead of the harness stub
  delete (m.k as any).quote;
  const X64 = 1n << 64n; let sqrtPrice = X64; let poolFetches = 0;   // sqrt price 1 → spot out == in
  const cp = (m.k as any).cp;
  cp.fetchPoolState = async () => { poolFetches++; return { sqrtPrice: { toString: () => sqrtPrice.toString() }, tokenAMint: m.k.mint, tokenBMint: NATIVE_MINT, tokenAVault: m.k.tMain, tokenBVault: m.k.tWsol }; };
  cp.getQuote = ({ inAmount }: any) => ({ swapOutAmount: { toString: () => inAmount.toString() }, priceImpact: { toString: () => '0.1' } });
  (m.k as any).conn.getSlot = async () => 1; (m.k as any).conn.getBlockTime = async () => 1_790_000_000;

  const r1 = await m.k.runOnce(T0);
  assert.equal(r1.status, 'paused_midrun'); assert.deepEqual(m.sent, ['claim_dbc', 'dev']);
  let s = m.state(); assert.equal(s.current!.stopped_before, 'swap'); assert.equal(s.current!.swap!.status, 'not_sent');
  const pendingBefore = s.pending_lamports; const savedSpot = s.current!.swap!.spot_out_raw; const fetchesBefore = poolFetches;
  assert.equal(pendingBefore, '4250000'); assert.equal(savedSpot, '1000000');

  sqrtPrice = (X64 * 90n) / 100n;   // pool spot moves ~23% while paused (same shift as the devnet spot_skew fault)
  m.unpause();
  const r2 = await m.k.runOnce(T0 + W);
  assert.equal(r2.run_id, r1.run_id); assert.equal(r2.status, 'failed_price'); assert.match(r2.reason, /bps from spot/);
  assert.deepEqual(m.sent, ['claim_dbc', 'dev']);                                     // no swap (and no burn) tx sent
  s = m.state(); const run = s.runs.find(x => x.run_id === r1.run_id)!;
  assert.equal(s.pending_lamports, pendingBefore); assert.equal(s.totals.spent_lamports, '0'); assert.equal(s.unburned_raw, '0');
  assert.ok(poolFetches > fetchesBefore, 'resume must re-read the pool');            // fresh fetchPoolState on resume
  assert.notEqual(run.swap!.spot_out_raw, savedSpot);                                // the pre-pause quote/spot was not reused
  assert.equal(run.stages.swap, undefined);
  assert.equal(s.consecutive_failures, 1);                                           // a real failure (unlike the pause itself)
});

// QA follow-up (issue 2): §12a also requires the hook upgrade authority and the lift authority to be different keys.
test('§12a: upgrade authority = lift authority → refused off devnet (launch builder and keeper start), warned on devnet/local, distinct keys pass', () => {
  const same = Keypair.generate().publicKey.toBase58(), u = Keypair.generate().publicKey.toBase58(), l = Keypair.generate().publicKey.toBase58(), la = Keypair.generate().publicKey.toBase58();
  const claimer = Keypair.generate().publicKey.toBase58(), keeperKeys = { claim_signer: claimer, treasury: Keypair.generate().publicKey.toBase58() };
  const re = /upgrade authority and lift authority are the same key/;
  assert.throws(() => launchConfigChecks('mainnet', claimer, { upgradeAuthority: same, liftAuthority: same }), (e: any) => e instanceof KeyRuleRefusal && re.test(e.message));
  assert.throws(() => keeperStartChecks('mainnet', keeperKeys, { upgradeAuthority: same, liftAuthority: same }), (e: any) => e instanceof KeyRuleRefusal && re.test(e.message));
  for (const c of ['devnet', 'local'] as const) {
    const lw = launchConfigChecks(c, claimer, { upgradeAuthority: same, liftAuthority: same });
    assert.deepEqual(lw.length, 1); assert.match(lw[0], new RegExp(`^WARNING three-key rule \\(accepted throwaway exception on ${c}\\): hook upgrade authority and lift authority are the same key`));
    const kw = keeperStartChecks(c, keeperKeys, { upgradeAuthority: same, liftAuthority: same });
    assert.equal(kw.length, 1); assert.match(kw[0], re);
  }
  assert.deepEqual(launchConfigChecks('mainnet', claimer, { upgradeAuthority: u, liftAuthority: l, launchAuthority: la }), []);
  assert.deepEqual(keeperStartChecks('mainnet', keeperKeys, { upgradeAuthority: u, liftAuthority: l, launchAuthority: la }), []);
  assert.deepEqual(launchConfigChecks('devnet', claimer, { upgradeAuthority: u, liftAuthority: l }), []);
});
test('§12a same-authority rule end to end: keeper start on mainnet with upgrade = lift refuses before connecting; the devnet TDT config still starts its preflight with warnings', async () => {
  const k = keys(); let connected = 0; const same = Keypair.generate().publicKey.toBase58();
  const cfg = cfgWith({ cluster: 'mainnet', hook_upgrade_authority: same, hook_lift_authority: same });
  await assert.rejects(startKeeper(cfg, [], { loadKey: n => (k as any)[n === 'deployer' ? 'claim' : n.replace('fw_', '')], connect: async () => { connected++; return trapConn(); }, log: () => {} }), (e: any) => e instanceof KeyRuleRefusal && /same key/.test(e.message));
  assert.equal(connected, 0);
  const w = preflightOffline(cfgWith({ cluster: 'devnet' }), k);   // real TDT authorities (9DVu… for both): warns, does not refuse
  assert.ok(w.some(x => /upgrade authority and lift authority are the same key 9DVu/.test(x)));
});

// ---------------- ticket 8.5: the keeper acts on mints in the registry (keeper/registry.json) only
/** A midrun keeper that records every read the claim path could make, per pool. */
function registryRun(sources: any[]) {
  const m = midrun(() => {}, { sources });
  const reads: string[] = []; const pinned: any[][] = [];
  const getPool = (m.k as any).dbc.state.getPool;
  (m.k as any).dbc = { state: { getPool: async (pk: PublicKey) => { reads.push(`dbc:${pk.toBase58()}`); return getPool(pk); }, getPoolConfig: async (pk: PublicKey) => { reads.push(`cfg:${pk.toBase58()}`); return {}; } } };
  const cp = (m.k as any).cp;
  (m.k as any).cp = { ...cp, fetchPoolState: async (pk: PublicKey) => { reads.push(`damm:${pk.toBase58()}`); throw new Error('damm read'); }, fetchPositionState: async (pk: PublicKey) => { reads.push(`pos:${pk.toBase58()}`); throw new Error('pos read'); } };
  const claimIx = (m.k as any).dbcClaimIx; (m.k as any).dbcClaimIx = async (src: any, q: bigint) => { reads.push(`claimix:${src.pool}`); return claimIx(src, q); };
  (m.k as any).pinnedChecks = async (srcs: any[]) => { pinned.push(srcs.map(x => x.pool)); };
  const quote = (m.k as any).quote; (m.k as any).quote = async (l: bigint) => { reads.push('quote'); return quote(l); };
  const conn = (m.k as any).conn;
  (m.k as any).conn = new Proxy(conn, { get: (t, p) => { const v = t[p]; return typeof v === 'function' ? (...a: any[]) => { reads.push(`rpc:${String(p)}`); return v.apply(t, a); } : v; } });
  return { ...m, reads, pinned };
}
/** A temp mint registry file (the keeper reads registryPath fresh on every run). */
const regFile = (content: unknown) => { const p = join(mkdtempSync(join(tmpdir(), 'reg-')), 'registry.json'); writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content)); return p; };
const mainMint = () => base.main_mint as string;
const dbcSource = () => base.sources.find(x => x.kind === 'dbc')! as any;
const foreignDbc = () => ({ kind: 'dbc', pool: Keypair.generate().publicKey.toBase58(), config: dbcSource().config, base_mint: Keypair.generate().publicKey.toBase58() });   // created on OUR config, mint not registered
const foreignDamm = () => ({ kind: 'damm_v2', pool: Keypair.generate().publicKey.toBase58(), position: Keypair.generate().publicKey.toBase58(), position_nft_mint: Keypair.generate().publicKey.toBase58() });

test('8.5: a pool on our config whose mint is not in the registry is ignored: no read, quote, claim, swap or burn; 0 sends; reason logged', async () => {
  const f = foreignDbc(), d = foreignDamm();
  const m = registryRun([f, d]);
  const r = await m.k.runOnce(T0);
  assert.deepEqual(m.sent, [], 'nothing sent'); assert.deepEqual(r.txs, []);
  assert.ok(!m.reads.some(x => x.includes(f.pool) || x.includes(d.pool)), `no read of a skipped pool: ${m.reads.join(', ')}`);
  assert.deepEqual(m.pinned, [[]], 'pinned checks see no skipped source');
  const run = m.state().runs.at(-1)!;
  assert.deepEqual(run.claims, [], 'no claim entry'); assert.equal(m.state().totals.spent_lamports, '0'); assert.equal(m.state().totals.burned_raw, '0');
  assert.ok(run.warnings.includes(`source dbc pool ${f.pool} skipped: base mint ${f.base_mint} is not in the mint registry`), run.warnings.join(' | '));
  assert.ok(run.warnings.includes(`source damm_v2 pool ${d.pool} skipped: not the route pool of a registry mint`), run.warnings.join(' | '));
  assert.ok(JSON.parse(readFileSync(m.cfg.public_log, 'utf8')).runs.at(-1).warnings.some((w: string) => w.includes(f.pool)), 'the reason reaches the public log');
  assert.equal(m.state().consecutive_failures, 0); assert.equal(m.state().paused, false);   // skipping is not a failure
});

test('8.5: a registry mint still runs (claim, dev, swap, burn) next to an ignored foreign pool', async () => {
  const f = foreignDbc(); const m = registryRun([dbcSource(), f]);
  const r = await m.k.runOnce(T0);
  assert.equal(r.status, 'logged'); assert.deepEqual(m.sent, ['claim_dbc', 'dev', 'swap', 'burn']);
  assert.deepEqual(m.pinned, [[dbcSource().pool]]);
  assert.ok(m.reads.includes(`claimix:${dbcSource().pool}`)); assert.ok(!m.reads.some(x => x.includes(f.pool)), m.reads.join(', '));
  const run = m.state().runs.at(-1)!; assert.deepEqual(run.claims.map(c => c.pool), [dbcSource().pool]);
  assert.equal(run.warnings.filter(w => w.includes('skipped')).length, 1);
});

test('8.5: the keeper refuses to start on a main mint that is not in the registry (before any connection)', async () => {
  const k = keys();
  const foreign = Keypair.generate().publicKey.toBase58();
  assert.throws(() => preflightOffline(cfgWith({ cluster: 'devnet', main_mint: foreign }), k), (e: any) => e instanceof RegistryRefusal && e instanceof KeyRuleRefusal && e.message === `refusing: main_mint ${foreign} is not in the mint registry`);
  assert.doesNotThrow(() => preflightOffline(cfgWith({ cluster: 'devnet' }), k));
  let connected = 0;
  await assert.rejects(startKeeper(cfgWith({ cluster: 'devnet', main_mint: foreign, pinned_pubkeys: undefined }), [], { loadKey: n => (k as any)[n === 'deployer' ? 'claim' : n.replace('fw_', '')], connect: async () => { connected++; return trapConn(); }, log: () => {} }),
    (e: any) => e instanceof RegistryRefusal);
  assert.equal(connected, 0);
});

test('8.5: the registry is re-read every run: removing the main mint fails the next run closed (failed_registry, auto-pause) before any read, quote or send', async () => {
  const m = registryRun([dbcSource()]); const path = regFile({ devnet: [mainMint()] }); m.k.registryPath = path;
  const r1 = await m.k.runOnce(T0); assert.equal(r1.status, 'logged'); assert.deepEqual(m.sent, ['claim_dbc', 'dev', 'swap', 'burn']);
  writeFileSync(path, JSON.stringify({ devnet: [] }));                  // main mint removed while the keeper is running
  const n = m.reads.length, sent = m.sent.length;
  const r2 = await m.k.runOnce(T0 + W);
  assert.equal(r2.status, 'failed_registry'); assert.deepEqual(r2.txs, []); assert.match(r2.reason, new RegExp(`main_mint ${mainMint()} is not in the mint registry`));
  assert.deepEqual(m.reads.slice(n), [], 'no read, quote or RPC call'); assert.equal(m.sent.length, sent, 'no send');
  assert.equal(m.state().paused, true); assert.match(m.state().pause_reason, /^failed_registry: /);
});

test('8.5: a missing or unreadable registry pauses the run (failed_registry), with no read or send', async () => {
  const dirAsFile = mkdtempSync(join(tmpdir(), 'regdir-'));
  for (const path of [join(tmpdir(), 'no-such-dir-8-5', 'registry.json'), regFile('{not json'), dirAsFile, regFile({ local: [] })]) {
    const m = registryRun([dbcSource()]); m.k.registryPath = path;
    const r = await m.k.runOnce(T0);
    assert.equal(r.status, 'failed_registry', path); assert.deepEqual(m.reads, [], path); assert.deepEqual(m.sent, []); assert.equal(m.state().paused, true);
  }
});

test('8.5: an edit to the registry applies to the next run (no caching): a newly registered base mint is acted on', async () => {
  const f = foreignDbc(); const m = registryRun([f]); const path = regFile({ devnet: [mainMint()] }); m.k.registryPath = path;   // one DBC claim per run, so f is the only source
  await m.k.runOnce(T0); assert.ok(!m.reads.some(x => x.includes(f.pool)), 'skipped while not registered');
  writeFileSync(path, JSON.stringify({ devnet: [mainMint(), f.base_mint] }));
  await m.k.runOnce(T0 + W); assert.ok(m.reads.includes(`dbc:${f.pool}`), `read once registered: ${m.reads.join(', ')}`);
  assert.ok(!m.state().runs.at(-1)!.warnings.some(w => w.includes(f.pool)), 'no skip warning once registered');
});

test('8.5: matching is exact: an empty list, a case-changed mint, a prefix or a non-string entry never admits the main mint', async () => {
  const mm = mainMint(); const flip = (c: string) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  const i = [...mm].findIndex(c => /[a-km-zA-HJ-NP-Z]/.test(c) && flip(c) !== c && /[1-9A-HJ-NP-Za-km-z]/.test(flip(c)));
  const cased = mm.slice(0, i) + flip(mm[i]) + mm.slice(i + 1);
  const k = keys();
  for (const list of [[], [cased], [mm.slice(0, -1)], [mm + '1'], [123], [mm.toLowerCase()]]) {
    const path = regFile({ devnet: list });
    assert.throws(() => preflightOffline(cfgWith({ cluster: 'devnet' }), k, path), (e: any) => e instanceof RegistryRefusal, JSON.stringify(list));
    const m = registryRun([dbcSource()]); m.k.registryPath = path;
    const r = await m.k.runOnce(T0); assert.equal(r.status, 'failed_registry', JSON.stringify(list)); assert.deepEqual(m.sent, []); assert.deepEqual(m.reads, []);
  }
  assert.doesNotThrow(() => preflightOffline(cfgWith({ cluster: 'devnet' }), k, regFile({ devnet: [mm] })));
});

test('8.5: startKeeper reads the registry at registryPath for the startup check and keeps that path for every run', async () => {
  const k = keys(); let connected = 0;
  const deps = (path: string) => ({ loadKey: (n: string) => (k as any)[n === 'deployer' ? 'claim' : n.replace('fw_', '')], connect: async () => { connected++; return trapConn(); }, log: () => {}, registryPath: path });
  await assert.rejects(startKeeper(cfgWith({ cluster: 'devnet', pinned_pubkeys: undefined }), [], deps(regFile({ devnet: [] }))), (e: any) => e instanceof RegistryRefusal);
  assert.equal(connected, 0);
  // the started keeper keeps that path for every run (source check: a full successful start needs a live cluster)
  assert.match(readFileSync('sdk/flywheel/keeper.ts', 'utf8'), /\n  const keeper = new Keeper\(cfg, overrides, conn, keys, warnings, deps\.log \?\? console\.log\);\n  for \(const w of warnings\) keeper\.log\(w\);[^\n]*\n  if \(deps\.registryPath\) keeper\.registryPath = deps\.registryPath;\n  return keeper;\n/);
});

/** A run left open with a signed swap pending (as after a crash or a confirmation timeout), then the main mint is removed. */
function pendingSwapRemoved() {
  const m = registryRun([]); const path = regFile({ devnet: [] }); m.k.registryPath = path;
  const SIG = anchorUtils.bytes.bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 255));
  const inL = 1_000_000n, out = 900_000_000n;
  const s = m.state(); s.pending_lamports = inL.toString();
  const run = newRun(runIdFor('devnet', T0, m.cfg.cadence_seconds), [], 'pending', 'confirmation timed out');
  run.swap = { route: m.cfg.route, pool: m.cfg.route_pool!, in_lamports: inL.toString(), min_out_raw: '1', out_raw: '0', quote_out_raw: out.toString(), spot_out_raw: out.toString(), slippage_bps: 100, price_impact_bps: 10, spot_deviation_bps: 0, halvings: 0 } as any;
  run.stages.swap = { status: 'pending', sig: SIG, lvbh: 1000, intent: { in_lamports: inL.toString(), min_out_raw: '1' } };
  s.current = run; m.k.store.saveState(s);
  m.k.wait = async () => {};                                            // polling loops end without real waiting (no timeouts)
  const checked: string[] = []; const statusOpts: any[] = []; const heightCommitments: any[] = []; const sendOpts: any[] = [];
  const conn = (m.k as any).conn;                                         // properties set here land on the target behind the read-recording proxy
  const getSt = conn.getSignatureStatuses; conn.getSignatureStatuses = async (sigs: string[], o: any) => { checked.push(...sigs); statusOpts.push(o); return getSt(sigs, o); };
  const getH = conn.getBlockHeight; conn.getBlockHeight = async (c: any) => { heightCommitments.push(c); return getH(c); };
  const sendRaw = conn.sendRawTransaction; conn.sendRawTransaction = async (buf: Buffer, o: any) => { sendOpts.push(o); return sendRaw(buf, o); };
  const builds: any[] = []; const cp = (m.k as any).cp; (m.k as any).cp = { ...cp, swap: async (a: any) => { builds.push(a); return cp.swap(a); } };
  return { ...m, path, SIG, inL, out, run, checked, statusOpts, heightCommitments, sendOpts, builds };
}

test('8.5: a pending swap when the main mint is removed: failed_registry + paused before any RPC call; the stage stays pending; re-registering keeps the keeper paused', async () => {
  const m = pendingSwapRemoved();
  const r = await m.k.runOnce(T0);
  assert.equal(r.status, 'failed_registry'); assert.deepEqual(m.reads, [], 'no RPC call, read or quote'); assert.deepEqual(m.sent, []); assert.deepEqual(m.checked, []); assert.deepEqual(m.builds, []);
  const st = m.state();
  assert.equal(st.paused, true); assert.match(st.pause_reason, /^failed_registry: /); assert.equal(st.consecutive_failures, 1);
  assert.equal(st.current!.stages.swap.status, 'pending'); assert.equal(st.current!.stages.swap.sig, m.SIG);
  assert.ok(!st.runs.some(x => x.run_id === m.run.run_id && x.status === 'failed_registry'), 'the run stays open (s.current)');
  writeFileSync(m.path, JSON.stringify({ devnet: [mainMint()] }));       // re-registered: still paused until an operator resumes
  const r2 = await m.k.runOnce(T0 + W);
  assert.equal(r2.status, 'paused'); assert.deepEqual(m.reads, []); assert.deepEqual(m.sent, []); assert.equal(m.state().current!.stages.swap.status, 'pending');
});

test('8.5: after re-registering and an operator resume, the ORIGINAL pending swap signature is resolved (confirmed case): no new swap is built or sent', async () => {
  const m = pendingSwapRemoved();
  await m.k.runOnce(T0); writeFileSync(m.path, JSON.stringify({ devnet: [mainMint()] })); m.unpause();
  // the original swap landed while the keeper was paused
  const k = m.k as any, acct = [m.ks.gas.publicKey, k.tWsol, k.tMain, k.dWsol, m.ks.treasury.publicKey];
  const pre = { ...m.L, [k.tWsol.toBase58()]: m.inL }; m.L[k.tMain.toBase58()] += m.out;
  const bal = (l: any) => [1, 2, 3].map(i => ({ accountIndex: i, uiTokenAmount: { amount: l[acct[i].toBase58()].toString() } }));
  m.parsed.set(m.SIG, { slot: 1, blockTime: 1_790_000_000, transaction: { message: { accountKeys: acct.map(pubkey => ({ pubkey })), instructions: [] } },
    meta: { err: null, fee: 5000, preTokenBalances: bal(pre), postTokenBalances: bal(m.L), preBalances: [0, 0, 0, 0, 0], postBalances: [0, 0, 0, 0, 0] } });
  const r = await m.k.runOnce(T0 + 2 * W);
  assert.equal(m.checked[0], m.SIG, 'the original signature is the one checked first');
  assert.deepEqual(m.builds, [], 'no new swap built'); assert.ok(!m.reads.includes('quote'), 'no new quote'); assert.ok(!m.sent.includes('swap'), `no swap sent: ${m.sent}`);
  const last = m.state().runs.at(-1)!;
  assert.equal(last.run_id, m.run.run_id); assert.equal(last.stages.swap.status, 'confirmed'); assert.equal(last.stages.swap.sig, m.SIG); assert.equal(last.swap!.out_raw, m.out.toString());
  assert.deepEqual(m.sent, ['burn'], 'only the burn of the swapped tokens follows'); assert.equal(r.status, 'logged');
  assert.doesNotMatch(last.reason, /registry/, 'the resumed run does not carry the registry failure'); assert.equal(m.state().current, null); assert.equal(m.state().paused, false);
});

test('8.5: after re-registering and an operator resume, the ORIGINAL pending swap signature is resolved (expired case): recorded expired, never re-sent', async () => {
  const m = pendingSwapRemoved();
  await m.k.runOnce(T0); writeFileSync(m.path, JSON.stringify({ devnet: [mainMint()] })); m.unpause();
  const s = m.state(); s.current!.stages.swap.lvbh = -10; m.k.store.saveState(s);   // block height (1) is past lvbh + 5: the original can no longer land
  m.L[(m.k as any).tWsol.toBase58()] = m.inL;                                         // the swap input never left the treasury
  const sends: string[] = []; const sendRaw = (m.k as any).conn.sendRawTransaction;
  (m.k as any).conn.sendRawTransaction = async (buf: Buffer, o: any) => { sends.push(anchorUtils.bytes.bs58.encode(Transaction.from(buf).signature!)); return sendRaw(buf, o); };
  await m.k.runOnce(T0 + 2 * W);
  assert.equal(m.checked[0], m.SIG, 'the original signature is the one checked first');
  assert.ok(!sends.includes(m.SIG), 'the original signed swap is never re-sent');
  const journal = readFileSync(join(m.cfg.state_dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(journal.some(j => j.stage === 'swap' && j.status === 'expired' && j.sig === m.SIG), 'the original stage ends expired (journal)');
  // existing keeper behaviour after an expiry (unchanged here): the unspent input is swapped again in the same run as a NEW tx
  // (fresh quote, fresh blockhash). The original can no longer land, so this is not a double swap.
  const last = m.state().runs.at(-1)!;
  assert.equal(m.builds.length, 1, 'exactly one NEW swap is built, from a fresh quote'); assert.deepEqual(m.sent, ['swap', 'burn']);
  assert.equal(last.run_id, m.run.run_id); assert.equal(last.stages.swap.status, 'confirmed'); assert.notEqual(last.stages.swap.sig, m.SIG, 'the confirmed swap is the new tx, not the original');
});

/** Resume an expired pending swap: re-registered, unpaused, original sig past lvbh + 5 (block height is 1). */
async function expiredResume(o: { unspent?: bigint; stored?: bigint } = {}) {
  const m = pendingSwapRemoved();
  await m.k.runOnce(T0); writeFileSync(m.path, JSON.stringify({ devnet: [mainMint()] })); m.unpause();
  const s = m.state(); s.current!.stages.swap.lvbh = -10; if (o.stored !== undefined) s.pending_lamports = o.stored.toString(); m.k.store.saveState(s);
  m.L[(m.k as any).tWsol.toBase58()] = o.unspent ?? m.inL;
  m.checked.length = 0; m.statusOpts.length = 0; m.heightCommitments.length = 0;
  return m;
}
const swapIntent = (m: any) => m.state().runs.at(-1)!.stages.swap?.intent ?? m.state().current?.stages.swap?.intent;

test('8.5 retry rule 1: a null status with the block height NOT past lvbh + 5 is no expiry and no retry (direct, no timeout)', async () => {
  const m = pendingSwapRemoved();
  await m.k.runOnce(T0); writeFileSync(m.path, JSON.stringify({ devnet: [mainMint()] })); m.unpause();
  const conn = (m.k as any).conn; conn.getBlockHeight = async (c: any) => { m.heightCommitments.push(c); return c === 'processed' ? 2000 : 1000; };   // confirmed height = lvbh: not past
  m.checked.length = 0;
  const r = await m.k.runOnce(T0 + 2 * W);
  assert.equal(r.status, 'pending'); assert.equal(m.state().current!.stages.swap.status, 'pending', 'not expired'); assert.equal(m.state().current!.stages.swap.sig, m.SIG);
  assert.equal(m.builds.length, 0, 'no retry built'); assert.deepEqual(m.sent, [], 'nothing sent'); assert.ok(m.checked.length >= 2 && m.checked.every(x => x === m.SIG));
  assert.ok(m.heightCommitments.length > 0 && m.heightCommitments.every(c => c === 'confirmed' || c === 'finalized'), `height read at confirmed/finalized: ${m.heightCommitments}`);
});

test('8.5 retry rule 1b/1c: expiry reads the block height at confirmed or finalized; the final status call before the retry searches history', async () => {
  const m = await expiredResume();
  await m.k.runOnce(T0 + 2 * W);
  assert.ok(m.heightCommitments.length > 0 && m.heightCommitments.every(c => c === 'confirmed' || c === 'finalized'), `height read at: ${m.heightCommitments}`);
  assert.deepEqual(m.checked.slice(0, 2), [m.SIG, m.SIG], 'expiry check, then one last status check of the original sig before building the retry');
  assert.equal(m.statusOpts[1]?.searchTransactionHistory, true, 'the final status call searches transaction history');
  assert.equal(m.builds.length, 1);
});

test('8.5 retry rule 1c: the original landed late (visible only with history search) → confirmed, no new swap', async () => {
  const m = await expiredResume();
  const k = m.k as any, acct = [m.ks.gas.publicKey, k.tWsol, k.tMain, k.dWsol, m.ks.treasury.publicKey];
  let calls = 0;
  k.conn.getSignatureStatuses = async (sigs: string[], o: any) => { calls++; m.checked.push(...sigs); m.statusOpts.push(o);
    if (calls >= 2 && o?.searchTransactionHistory === true && !m.parsed.has(m.SIG)) {   // lands right after the expiry check
      const pre = { ...m.L }; m.L[k.tWsol.toBase58()] -= m.inL; m.L[k.tMain.toBase58()] += m.out;
      const bal = (l: any) => [1, 2, 3].map(i => ({ accountIndex: i, uiTokenAmount: { amount: l[acct[i].toBase58()].toString() } }));
      m.parsed.set(m.SIG, { slot: 1, blockTime: 1_790_000_000, transaction: { message: { accountKeys: acct.map(pubkey => ({ pubkey })), instructions: [] } },
        meta: { err: null, fee: 5000, preTokenBalances: bal(pre), postTokenBalances: bal(m.L), preBalances: [0, 0, 0, 0, 0], postBalances: [0, 0, 0, 0, 0] } });
    }
    return { value: sigs.map(x => (calls >= 2 && o?.searchTransactionHistory === true && m.parsed.has(x) ? { confirmationStatus: 'confirmed' } : null)) }; };
  await m.k.runOnce(T0 + 2 * W);
  const last = m.state().runs.at(-1)!;
  assert.equal(m.builds.length, 0, 'no new swap built'); assert.ok(!m.sent.includes('swap')); assert.deepEqual(m.sent, ['burn']);
  assert.equal(last.stages.swap.status, 'confirmed'); assert.equal(last.stages.swap.sig, m.SIG); assert.equal(last.swap!.out_raw, m.out.toString());
});

test('8.5 retry rule 3: the retry amount is the unspent input re-read from the chain when it is below the stored amount', async () => {
  const m = await expiredResume({ unspent: 700_000n, stored: 1_000_000n });
  await m.k.runOnce(T0 + 2 * W);
  assert.equal(m.builds.length, 1); assert.equal(m.builds[0].amountIn.toString(), '700000'); assert.equal(swapIntent(m).in_lamports, '700000');
  assert.ok(m.state().runs.at(-1)!.warnings.some(w => /re-read from chain 700000 != stored 1000000/.test(w)));
});

test('8.5 retry rule 2: the retry goes through the per-run cap, the price checks and min_out, and the pre-send simulation', async () => {
  // cap: unspent 3 SOL-lamports-units above the per-run cap → the retry swaps at most the cap
  const a = await expiredResume({ unspent: 3_000_000n, stored: 3_000_000n });
  await a.k.runOnce(T0 + 2 * W);
  assert.equal(a.builds.length, 1); assert.equal(swapIntent(a).in_lamports, a.cfg.max_swap_lamports_per_run, 'capped at max_swap_lamports_per_run');
  // min_out: the retry's min_out is the normal minOut of the fresh quote
  const q = BigInt(swapIntent(a).in_lamports) * 1000n;
  assert.equal(swapIntent(a).min_out_raw, minOut(q, a.cfg.max_slippage_bps).toString()); assert.ok(BigInt(swapIntent(a).min_out_raw) > 0n);
  // price check: a fresh quote far from spot blocks the retry (failed_price, nothing built or sent)
  const b = await expiredResume(); (b.k as any).quote = async (inL: bigint) => ({ out: inL * 1000n, impactBps: 10, spotOut: inL * 3000n, pool: {} });
  const rb = await b.k.runOnce(T0 + 2 * W);
  assert.equal(rb.status, 'failed_price'); assert.equal(b.builds.length, 0); assert.ok(!b.sent.includes('swap'));
  // pre-send simulation: the retry is sent with preflight on, and a failing simulation blocks it
  const c = await expiredResume(); const conn = (c.k as any).conn; const send = conn.sendRawTransaction;
  conn.sendRawTransaction = async (buf: Buffer, o: any) => { c.sendOpts.push(o); if (!o?.skipPreflight) throw new Error('Transaction simulation failed: custom program error'); return send(buf, o); };
  const rc = await c.k.runOnce(T0 + 2 * W);
  assert.equal(c.sendOpts[0]?.skipPreflight, false, 'retry sent with the pre-send simulation'); assert.equal(rc.status, 'failed_swap'); assert.ok(!c.sent.includes('swap'), 'nothing landed');
});

test('8.5 retry rule 2: the registry is checked on the resumed run before the retry (main mint removed → failed_registry, no retry)', async () => {
  const m = await expiredResume(); writeFileSync(m.path, JSON.stringify({ devnet: [] }));
  const r = await m.k.runOnce(T0 + 2 * W);
  assert.equal(r.status, 'failed_registry'); assert.deepEqual(m.checked, [], 'not even the expiry check runs'); assert.equal(m.builds.length, 0); assert.deepEqual(m.sent, []);
});

test('8.5 retry rule 3: a negative re-read unspent amount (treasury wSOL below the unsplit claims) fails closed: reconcile_mismatch, paused, no swap built or sent', async () => {
  const m = await expiredResume({ unspent: 1_000_000n });
  const s = m.state(); s.current!.stages.dev = { status: 'confirmed', sig: 'devSig' } as any; s.unsplit_lamports = '2000000'; m.k.store.saveState(s);   // split already done this run, so the claims stay unsplit
  const r = await m.k.runOnce(T0 + 2 * W);
  const st = m.state();
  assert.equal(r.status, 'reconcile_mismatch'); assert.match(r.reason ?? '', /below the unsplit claims \(-1000000\)/);
  assert.equal(st.paused, true); assert.match(st.pause_reason ?? '', /^reconcile_mismatch/);
  assert.equal(m.builds.length, 0, 'no swap built'); assert.deepEqual(m.sent, [], 'nothing sent'); assert.equal(st.pending_lamports, s.pending_lamports, 'stored amount untouched');
});

test('8.5 retry rule 3: more unspent input on chain than stored (later claims or stray wSOL) fails closed before building: reconcile_mismatch, paused, 0 quotes/builds/sends, stage and stored amount untouched', async () => {
  const m = await expiredResume({ unspent: 900_000n, stored: 600_000n });
  let quotes = 0; const q = (m.k as any).quote.bind(m.k); (m.k as any).quote = async (x: bigint) => { quotes++; return q(x); };
  const r = await m.k.runOnce(T0 + 2 * W);
  const st = m.state(), last = st.runs.at(-1)!;
  assert.equal(r.status, 'reconcile_mismatch'); assert.equal(st.paused, true); assert.match(st.pause_reason ?? '', /^reconcile_mismatch/);
  assert.equal(quotes, 0, 'no quote'); assert.equal(m.builds.length, 0, 'no swap built'); assert.deepEqual(m.sent, [], 'nothing sent');
  assert.equal(last.stages.swap.status, 'expired', 'stage untouched'); assert.equal(last.stages.swap.sig, m.SIG); assert.equal(st.pending_lamports, '600000', 'stored amount untouched');
  assert.ok(last.warnings.some(w => /on-chain unspent input 900000 > stored 600000/.test(w)), 'warning names both amounts');
});

/** Expiry margin: the original is expired only once the confirmed block height is past lvbh + 5. */
async function marginResume(over: number) {
  const m = await expiredResume(); const s = m.state(); s.current!.stages.swap.lvbh = 1000; m.k.store.saveState(s);
  (m.k as any).conn.getBlockHeight = async (c: any) => { m.heightCommitments.push(c); return 1000 + over; };
  return m;
}
test('8.5 retry rule 1: the +5 expiry margin: a confirmed height of lvbh + 5 is no expiry, no retry and no swap built', async () => {
  const m = await marginResume(5);
  const r = await m.k.runOnce(T0 + 2 * W);
  assert.equal(r.status, 'pending'); assert.equal(m.state().current!.stages.swap.status, 'pending', 'not expired'); assert.equal(m.state().current!.stages.swap.sig, m.SIG);
  assert.equal(m.builds.length, 0, 'no swap built'); assert.deepEqual(m.sent, []);
});
test('8.5 retry rule 1: the +5 expiry margin: a confirmed height of lvbh + 6 is expiry and exactly one retry', async () => {
  const m = await marginResume(6);
  await m.k.runOnce(T0 + 2 * W);
  const last = m.state().runs.at(-1)!;
  assert.equal(m.builds.length, 1, 'one retry built'); assert.deepEqual(m.sent, ['swap', 'burn']); assert.notEqual(last.stages.swap.sig, m.SIG);
  assert.ok(last.warnings.some(w => /expired without landing; retrying once with a fresh quote/.test(w)));
});

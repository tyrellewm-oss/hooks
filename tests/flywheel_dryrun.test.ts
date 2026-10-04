// Keeper dry-run default (QA mainnet blocker #2): `run`/`loop` simulate unless `--send` is given.
// Offline: a fake chain sits behind the Connection. In send mode its sendRawTransaction applies each step to an
// in-memory ledger and returns a parsed tx with real pre/post token balances; in dry-run mode the dry-run wrapper must
// never call it. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout, MintLayout, ACCOUNT_SIZE, MINT_SIZE, NATIVE_MINT } from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import { utils as anchorUtils } from '@coral-xyz/anchor';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keeper, initState, MEMO_PROGRAM_ID, type KeySet } from '../sdk/flywheel/keeper.js';
import { parseSendMode, banner, isolateState, dryRunConnection } from '../sdk/flywheel/dryrun.js';
import type { KeeperConfig } from '../sdk/flywheel/config.js';

const base = JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')) as KeeperConfig;
const trapConn = () => new Proxy({}, { get: (_t, p) => { if (p === 'then') return undefined; throw new Error(`network used: ${String(p)}`); } }) as unknown as Connection;
const T0 = Date.UTC(2026, 9, 4, 2, 0), W = 300_000;

/** Fake chain + keeper wired like the CLI: mode 'send' uses the chain directly, 'dry_run' goes through dryRunConnection on a state copy. */
function setup(opts: { simErr?: (stage: string) => unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-dry-'));
  const ks: KeySet = { claim: Keypair.generate(), treasury: Keypair.generate(), dev: Keypair.generate(), gas: Keypair.generate() };
  const dbcSrc = base.sources.find(x => x.kind === 'dbc')!;
  const cfg: KeeperConfig = { ...base, pinned_pubkeys: undefined, state_dir: join(dir, 'state'), public_log: join(dir, 'pub.json'), sources: [dbcSrc], max_swap_lamports_per_run: '1000000', min_claim_lamports: '1000000' };
  const probe = new Keeper(cfg, [], trapConn(), ks, [], () => {});
  const tW = probe.tWsol, tM = probe.tMain, dW = probe.dWsol, mint = probe.mint;
  const amt: Record<string, bigint> = { [tW.toBase58()]: 0n, [tM.toBase58()]: 0n, [dW.toBase58()]: 0n };
  let supply = 1_000_000_000_000_000n; let dbcFee = 5_000_000n;
  const chain = { sent: [] as string[], simulated: [] as string[], parsed: new Map<string, any>() };
  const tokenAcc = (pk: PublicKey, m: PublicKey, owner: PublicKey, prog: PublicKey) => { const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode({ mint: m, owner, amount: amt[pk.toBase58()], delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default } as any, data);
    return { data, owner: prog, lamports: 2_039_280, executable: false, rentEpoch: 0 }; };
  const stageOf = (tx: Transaction) => tx.instructions.map(i => i.data.toString()).find(d => d.startsWith('flywheel:'))!.split(':').at(-1)!;
  const real: any = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }),
    getBlockHeight: async () => 1,
    getBalance: async (pk: PublicKey) => (pk.equals(ks.gas.publicKey) ? 1_000_000_000 : 0),
    getAccountInfo: async (pk: PublicKey) => {
      if (pk.equals(tW)) return tokenAcc(tW, NATIVE_MINT, ks.treasury.publicKey, TOKEN_PROGRAM_ID);
      if (pk.equals(dW)) return tokenAcc(dW, NATIVE_MINT, ks.dev.publicKey, TOKEN_PROGRAM_ID);
      if (pk.equals(tM)) return tokenAcc(tM, mint, ks.treasury.publicKey, TOKEN_2022_PROGRAM_ID);
      if (pk.equals(mint)) { const data = Buffer.alloc(MINT_SIZE); MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals: cfg.main_decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default } as any, data); return { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 }; }
      return null;
    },
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(x => (chain.parsed.has(x) ? { confirmationStatus: 'confirmed', err: null } : null)) }),
    getParsedTransaction: async (sig: string) => chain.parsed.get(sig) ?? null,
    simulateTransaction: async (vt: any) => {
      const tx = Transaction.populate(vt.message); const stage = stageOf(tx); chain.simulated.push(stage);
      return { context: { slot: 7 }, value: { err: opts.simErr?.(stage) ?? null, unitsConsumed: 12_345, logs: ['Program log: test'] } };
    },
    sendRawTransaction: async (buf: Buffer) => {
      const tx = Transaction.from(buf); const sig = anchorUtils.bytes.bs58.encode(tx.signature!); const stage = stageOf(tx);
      const st = JSON.parse(readFileSync(join(cfg.state_dir, 'state.json'), 'utf8')).current; const it = st.stages[stage].intent;
      const pre = { ...amt }; const ixs: any[] = []; const k = (p: PublicKey) => p.toBase58();
      if (stage === 'claim_dbc') { amt[k(tW)] += BigInt(it.max_quote); dbcFee = 0n; }
      else if (stage === 'dev') { amt[k(tW)] -= BigInt(it.dev); amt[k(dW)] += BigInt(it.dev); }
      else if (stage === 'swap') { amt[k(tW)] -= BigInt(it.in_lamports); amt[k(tM)] += BigInt(st.swap.quote_out_raw); }
      else if (stage === 'burn') { amt[k(tM)] -= BigInt(it.amount); supply -= BigInt(it.amount); ixs.push({ programId: TOKEN_2022_PROGRAM_ID, parsed: { type: 'burnChecked', info: { mint: cfg.main_mint, tokenAmount: { amount: it.amount } } } }); }
      const acct = [ks.gas.publicKey, tW, tM, dW];
      const bal = (l: Record<string, bigint>) => [1, 2, 3].map(i => ({ accountIndex: i, uiTokenAmount: { amount: l[k(acct[i])].toString() } }));
      chain.parsed.set(sig, { slot: 1, blockTime: 1_790_000_000, transaction: { message: { accountKeys: acct.map(pubkey => ({ pubkey })), instructions: ixs } },
        meta: { err: null, fee: 5000, preTokenBalances: bal(pre), postTokenBalances: bal(amt), preBalances: [0, 0, 0, 0], postBalances: [0, 0, 0, 0] } });
      chain.sent.push(stage); return sig;
    },
  };
  const stub = (k: Keeper) => {
    (k as any).pinnedChecks = async () => {};
    (k as any).dbc = { state: { getPool: async () => ({ partnerQuoteFee: { toString: () => dbcFee.toString() }, isMigrated: 1 }) } };
    (k as any).dbcClaimIx = async () => new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: ks.claim.publicKey, isSigner: true, isWritable: false }, { pubkey: tW, isSigner: false, isWritable: true }], data: Buffer.from('claim') });
    (k as any).quote = async (inL: bigint) => ({ out: inL * 1000n, impactBps: 10, spotOut: inL * 1000n, pool: {} });
    (k as any).cp = { swap: async () => ({ instructions: [new TransactionInstruction({ programId: CP_AMM_PROGRAM_ID, data: Buffer.alloc(1),
      keys: [{ pubkey: ks.treasury.publicKey, isSigner: true, isWritable: false }, ...[tW, tM].map(pubkey => ({ pubkey, isSigner: false, isWritable: true }))] })] }) };
    return k;
  };
  /** The CLI's `run` in either mode. */
  const run = async (mode: 'send' | 'dry_run', now: number) => {
    if (mode === 'send') { const k = stub(new Keeper(cfg, [], real as Connection, ks, [], () => {})); return { r: await k.runOnce(now) }; }
    const iso = isolateState(cfg); const dry = dryRunConnection(real as Connection, iso.cfg.state_dir);
    const k = stub(new Keeper(iso.cfg, [], dry.conn, ks, [], () => {}));
    dry.bind({ feePayer: ks.gas.publicKey, tWsol: k.tWsol, tMain: k.tMain, dWsol: k.dWsol, mint: k.mint, mainProg: k.mainProg, mainMint: cfg.main_mint });
    try { const r = await k.runOnce(now); return { r, steps: dry.steps, unchanged: iso.realUnchanged(), blocked: dry.blockedBroadcasts() }; } finally { iso.cleanup(); }
  };
  const snap = () => [join(cfg.state_dir, 'state.json'), join(cfg.state_dir, 'journal.jsonl'), cfg.public_log].map(p => (existsSync(p) ? readFileSync(p, 'utf8') : null));
  return { cfg, chain, run, snap, amt, tW, tM, dW };
}

test('dry-run default: no flag → dry_run; only an explicit --send sends; banners say which', () => {
  assert.equal(parseSendMode(['run']), 'dry_run');
  assert.equal(parseSendMode(['loop', '--runs', '5']), 'dry_run');
  assert.equal(parseSendMode(['run', '--sendx']), 'dry_run');
  assert.equal(parseSendMode(['run', '--send']), 'send');
  assert.match(banner('dry_run', base, 'run'), /DRY RUN.*nothing is broadcast[\s\S]*--send/);
  assert.match(banner('send', base, 'run'), /SENDING.*WILL be broadcast/);
});

test('dry run (no flag): every step simulated, nothing sent, chain untouched', async () => {
  const f = setup(); const before = { ...f.amt };
  const { r, steps, unchanged, blocked } = await f.run('dry_run', T0);
  assert.deepEqual(f.chain.sent, []); assert.equal(blocked, 0);
  assert.deepEqual(f.chain.simulated, ['claim_dbc', 'dev', 'swap', 'burn']);
  assert.deepEqual(steps!.map(s => `${s.stage}:${s.simulated}`), ['claim_dbc:ok', 'dev:ok', 'swap:ok', 'burn:ok']);
  assert.equal(r.status, 'logged');                       // the planned run would complete and reconcile (overlay)
  assert.deepEqual(f.amt, before); assert.equal(unchanged, true);
});

test('--send: the same run broadcasts claim, dev, swap, burn', async () => {
  const f = setup(); const { r } = await f.run('send', T0);
  assert.equal(r.status, 'logged'); assert.deepEqual(f.chain.sent, ['claim_dbc', 'dev', 'swap', 'burn']); assert.deepEqual(f.chain.simulated, []);
  assert.equal(f.amt[f.tM.toBase58()], 0n); assert.equal(f.amt[f.dW.toBase58()], 750_000n);
});

test('dry run leaves saved state, journal and public log byte-identical; a later --send run in the same window still runs', async () => {
  const f = setup();
  await f.run('send', T0);                                  // real history exists
  const snap0 = f.snap(); const sent0 = f.chain.sent.length;
  const d = await f.run('dry_run', T0 + W);
  assert.equal(d.unchanged, true); assert.deepEqual(f.snap(), snap0); assert.equal(f.chain.sent.length, sent0);
  const s = JSON.parse(snap0[0]!); assert.equal(s.runs.length, 1); assert.equal(s.current, null);
  const live = await f.run('send', T0 + W);                 // dry run did not consume the window or move accounting
  assert.equal(live.r.status, 'logged'); assert.deepEqual(f.chain.sent.slice(sent0), ['swap', 'burn']);   // carry-over swapped for real
});

test('dry run: a step that needs an earlier dry step to land is reported `dependent`, an independent failure is `error`', async () => {
  const f = setup({ simErr: st => (st === 'burn' ? { InstructionError: [2, { Custom: 1 }] } : null) });
  const d = await f.run('dry_run', T0);
  assert.equal(d.steps!.find(s => s.stage === 'burn')!.simulated, 'dependent'); assert.equal(d.r.status, 'logged'); assert.deepEqual(f.chain.sent, []);
  const g = setup({ simErr: st => (st === 'claim_dbc' ? { InstructionError: [2, { Custom: 6076 }] } : null) });
  const e = await g.run('dry_run', T0);
  assert.equal(e.steps![0].simulated, 'error'); assert.equal(e.r.status, 'failed_claim'); assert.deepEqual(g.chain.sent, []); assert.equal(e.unchanged, true);
});

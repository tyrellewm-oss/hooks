// Keeper pot stage, offline: whole keeper runs against a fake chain at the RPC boundary (like the U-4 harness in
// flywheel.test.ts), with lamport balances added so the payout's effect check runs unchanged: treasury wSOL down by
// the prize, winner up by exactly the prize, gas down by only the fee. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import { utils as anchorUtils } from '@coral-xyz/anchor';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keeper, initState, publicLog, MEMO_PROGRAM_ID, type KeySet, type KeeperState } from '../sdk/flywheel/keeper.js';
import { minOut } from '../sdk/flywheel/math.js';
import { ACC, POT_WINNERS } from '../sdk/hook.js';
import type { KeeperConfig } from '../sdk/flywheel/config.js';

const base = JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')) as KeeperConfig;
const trapConn = () => new Proxy({}, { get: (_t, p) => { if (p === 'then') return undefined; throw new Error(`network used: ${String(p)}`); } }) as unknown as Connection;
const FEE = 5000n, GAS0 = 1_000_000_000n;
const T0 = Date.UTC(2026, 9, 6, 20, 0), W = 300_000;

function harness(o: { open: boolean; wins: number; minPayout?: string; pot?: boolean; onSend?: (stage: string, pause: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-pot-'));
  const ks: KeySet = { claim: Keypair.generate(), treasury: Keypair.generate(), gas: Keypair.generate() };
  const cfg: KeeperConfig = { ...base, pinned_pubkeys: undefined, state_dir: join(dir, 'state'), public_log: join(dir, 'pub.json'), sources: [base.sources.find(x => x.kind === 'dbc')!],
    max_swap_lamports_per_run: '1000000', min_claim_lamports: '1000000', ...(o.pot === false ? {} : { pot: { share_pct: 10, min_payout_lamports: o.minPayout ?? '100000' } }) };
  const k = new Keeper(cfg, [], trapConn(), ks, [], () => {});
  const owners = Array.from({ length: 40 }, () => Keypair.generate().publicKey);   // owners[n - 1] made win n
  const tW = k.tWsol.toBase58(), tM = k.tMain.toBase58(), dW = k.dWsol.toBase58(), g = ks.gas.publicKey.toBase58();
  const L: Record<string, bigint> = { [tW]: 0n, [tM]: 0n, [dW]: 0n, supply: 1_000_000_000_000_000n };
  const lam: Record<string, bigint> = { [g]: GAS0 };
  const chain = { claimable: 5_000_000n, wins: o.wins, open: o.open };
  const sent: string[] = []; const parsed = new Map<string, any>();
  const pause = () => { mkdirSync(cfg.state_dir, { recursive: true }); writeFileSync(join(cfg.state_dir, 'PAUSE'), 'x'); };
  (k as any).conn = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }),
    getBlockHeight: async () => 1,
    getBalance: async (pk: PublicKey) => Number(lam[pk.toBase58()] ?? 0n),
    getMinimumBalanceForRentExemption: async () => 2_039_280,
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(x => (parsed.has(x) ? { confirmationStatus: 'confirmed' } : null)) }),
    getParsedTransaction: async (sig: string) => parsed.get(sig) ?? null,
    sendRawTransaction: async (buf: Buffer) => {
      const tx = Transaction.from(buf); const sig = anchorUtils.bytes.bs58.encode(tx.signature!);
      const stage = tx.instructions.map(i => i.data.toString()).find(d => d.startsWith('flywheel:'))!.split(':').at(-1)!;
      const it = JSON.parse(readFileSync(join(cfg.state_dir, 'state.json'), 'utf8')).current.stages[stage].intent;
      const keysIn = [ks.gas.publicKey, k.tWsol, k.tMain, k.dWsol, ks.treasury.publicKey, ...(it.owner ? [new PublicKey(it.owner)] : [])];
      const preT = { ...L }, preL = keysIn.map(x => lam[x.toBase58()] ?? 0n); const ixs: any[] = [];
      lam[g] -= FEE;
      if (stage === 'claim_dbc') { L[tW] += BigInt(it.max_quote); chain.claimable = 0n; }
      else if (stage === 'dev') { L[tW] -= BigInt(it.dev); L[dW] += BigInt(it.dev); }
      else if (stage.startsWith('pot_w')) {
        assert.equal(tx.instructions.length, 7, 'compute budget, memo, create temp, init, transfer, close to gas, pay winner');
        assert.ok(tx.instructions[5].keys.some(a => a.pubkey.toBase58() === g), 'temp account closes to gas, not to the winner');
        L[tW] -= BigInt(it.lamports); lam[it.owner] = (lam[it.owner] ?? 0n) + BigInt(it.lamports);   // rent goes out of gas and comes back in the same tx
      }
      else if (stage === 'swap') { L[tW] -= BigInt(it.in_lamports); L[tM] += BigInt(it.in_lamports) * 1000n; }
      else if (stage === 'burn') { L[tM] -= BigInt(it.amount); L.supply -= BigInt(it.amount); ixs.push({ programId: TOKEN_2022_PROGRAM_ID, parsed: { type: 'burnChecked', info: { mint: cfg.main_mint, tokenAmount: { amount: it.amount } } } }); }
      const bal = (l: Record<string, bigint>) => [1, 2, 3].map(i => ({ accountIndex: i, uiTokenAmount: { amount: l[keysIn[i].toBase58()].toString() } }));
      parsed.set(sig, { slot: 1, blockTime: 1_790_000_000, transaction: { message: { accountKeys: keysIn.map(pubkey => ({ pubkey })), instructions: ixs } },
        meta: { err: null, fee: Number(FEE), preTokenBalances: bal(preT), postTokenBalances: bal(L), preBalances: preL.map(Number), postBalances: keysIn.map(x => Number(lam[x.toBase58()] ?? 0n)) } });
      sent.push(stage); o.onSend?.(stage, pause); return sig;
    },
  };
  (k as any).pinnedChecks = async () => {};
  (k as any).tokenAmt = async (ata: PublicKey) => L[ata.toBase58()];
  (k as any).supply = async () => L.supply;
  (k as any).dbc = { state: { getPool: async () => ({ partnerQuoteFee: { toString: () => chain.claimable.toString() }, isMigrated: chain.open ? 0 : 1 }) } };
  (k as any).dbcClaimIx = async () => new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: ks.claim.publicKey, isSigner: true, isWritable: false }], data: Buffer.from('claim') });
  (k as any).quote = async (inL: bigint) => ({ out: inL * 1000n, impactBps: 10, spotOut: inL * 1000n, pool: {} });
  (k as any).priceCheck = async (_s: any, _r: any, plan: any) => minOut(plan.quoteOut, cfg.max_slippage_bps);
  (k as any).cp = { swap: async () => ({ instructions: [new TransactionInstruction({ programId: CP_AMM_PROGRAM_ID, data: Buffer.alloc(1),
    keys: [{ pubkey: ks.treasury.publicKey, isSigner: true, isWritable: false }, ...[k.tWsol, k.tMain].map(pubkey => ({ pubkey, isSigner: false, isWritable: true }))] })] }) };
  // the rules account as decodeRules returns it: newest win first, at most 16 still in the ring
  if (o.pot !== false) (k as any).readPot = async () => ({
    open: chain.open,
    rules: { potEvery: 10, wins: BigInt(chain.wins), winners: Array.from({ length: Math.min(chain.wins, 16) }, (_, i) => ({ owner: owners[chain.wins - i - 1] })) },
  });
  const state = () => k.store.loadState(() => initState(cfg)) as KeeperState;
  const seed = (f: (s: KeeperState) => void) => { const s = state(); f(s); k.store.saveState(s); };
  const unpause = () => { try { rmSync(join(cfg.state_dir, 'PAUSE')); } catch {} const s = state(); s.paused = false; s.pause_reason = ''; k.store.saveState(s); };
  const got = (win: number) => lam[owners[win - 1].toBase58()] ?? 0n;
  return { k, cfg, sent, L, lam, chain, state, seed, unpause, got, gasSpent: () => GAS0 - lam[g] };
}

test('open pot: 15% dev, 10% pot paid to the new winner (exactly the prize), 75% held for the buyback', async () => {
  const h = harness({ open: true, wins: 1 });
  const r = await h.k.runOnce(T0);
  assert.equal(r.status, 'waiting_for_graduation');
  assert.deepEqual(h.sent, ['claim_dbc', 'dev', 'pot_w1']);
  const s = h.state();
  assert.deepEqual([s.totals.claimed_lamports, s.totals.dev_lamports, s.totals.pot_lamports, s.pending_lamports, s.pot_pending_lamports, s.pot_paid_wins, s.unsplit_curve_lamports],
    ['5000000', '750000', '500000', '3750000', '0', '1', '0']);
  assert.equal(h.got(1), 500_000n, 'winner receives exactly the prize, no rent on top');
  assert.equal(h.gasSpent(), 3n * FEE, 'gas pays only the three tx fees');
  const run = s.runs.at(-1)!;
  assert.equal(run.reconcile!.ok, true); assert.equal(run.pot_lamports, '500000');
  assert.deepEqual(run.pot_payouts!.map(p => [p.win, p.lamports]), [[1, '500000']]);
  const pub: any = publicLog(s, h.cfg);
  assert.equal(pub.potSol, '0.000500000'); assert.equal(pub.pot_payouts.length, 1); assert.equal(pub.runs.at(-1).pot_payouts[0].sig, run.pot_payouts![0].sig);
});

test('several new winners split the pot equally; dust stays in the pot for the next winner', async () => {
  const h = harness({ open: true, wins: 3 });
  h.chain.claimable = 5_000_030n;   // pot = 500,003 → 166,667 each, 2 lamports of dust held
  await h.k.runOnce(T0);
  assert.deepEqual(h.sent, ['claim_dbc', 'dev', 'pot_w1', 'pot_w2', 'pot_w3']);
  for (const n of [1, 2, 3]) assert.equal(h.got(n), 166_667n);
  const s = h.state();
  assert.deepEqual([s.pot_pending_lamports, s.pot_paid_wins, s.totals.pot_lamports], ['2', '3', '500001']);
  assert.equal(s.runs.at(-1)!.reconcile!.ok, true);
});

test('below the minimum: nobody is paid, the pot stays in the treasury (reconciled) and pays once it has grown', async () => {
  const h = harness({ open: true, wins: 1, minPayout: '600000' });
  await h.k.runOnce(T0);
  assert.deepEqual(h.sent, ['claim_dbc', 'dev']);
  let s = h.state();
  assert.deepEqual([s.pot_pending_lamports, s.pot_paid_wins], ['500000', '0']);
  assert.equal(s.runs.at(-1)!.reconcile!.ok, true, 'treasury wSOL = buyback reserve + pot');
  assert.ok(s.runs.at(-1)!.warnings.some(x => /below the minimum payout/.test(x)));
  h.chain.claimable = 5_000_000n;
  await h.k.runOnce(T0 + W);
  assert.deepEqual(h.sent, ['claim_dbc', 'dev', 'claim_dbc', 'dev', 'pot_w1']);
  s = h.state();
  assert.equal(h.got(1), 1_000_000n); assert.deepEqual([s.pot_pending_lamports, s.pot_paid_wins], ['0', '1']);
  // a later run with no new win pays nobody, even with money in the pot
  h.chain.claimable = 5_000_000n;
  await h.k.runOnce(T0 + 2 * W);
  assert.deepEqual(h.sent.slice(5), ['claim_dbc', 'dev']);
  assert.equal(h.got(1), 1_000_000n); assert.equal(h.state().pot_pending_lamports, '500000');
});

test('graduated: the minimum is waived for the last unpaid winner, then buyback and burn run as usual', async () => {
  const h = harness({ open: false, wins: 2, minPayout: '10000000' });
  h.seed(s => { s.pot_paid_wins = '1'; s.pot_pending_lamports = '300000'; }); h.L[h.k.tWsol.toBase58()] = 300_000n;
  const r = await h.k.runOnce(T0);
  assert.equal(r.status, 'logged');
  assert.deepEqual(h.sent, ['claim_dbc', 'dev', 'pot_w2', 'swap', 'burn']);
  assert.equal(h.got(2), 800_000n, 'held 300,000 + 10% of the final curve claim');
  const s = h.state();
  assert.deepEqual([s.pot_pending_lamports, s.pot_paid_wins, s.totals.pot_released_lamports], ['0', '2', '0']);
  assert.equal(s.runs.at(-1)!.reconcile!.ok, true);
});

test('graduated with nobody left to pay: the pot moves to the buyback instead of sitting in the treasury', async () => {
  const h = harness({ open: false, wins: 2 });
  h.seed(s => { s.pot_paid_wins = '2'; s.pot_pending_lamports = '300000'; }); h.L[h.k.tWsol.toBase58()] = 300_000n;
  await h.k.runOnce(T0);
  assert.deepEqual(h.sent, ['claim_dbc', 'dev', 'swap', 'burn']);
  const s = h.state();
  // 5,000,000 claimed: 750,000 dev, 500,000 pot; pot 800,000 released → reserve 3,750,000 + 800,000 − 1,000,000 swapped
  assert.deepEqual([s.pot_pending_lamports, s.totals.pot_released_lamports, s.pending_lamports, s.totals.pot_lamports], ['0', '800000', '3550000', '0']);
  assert.ok(s.runs.at(-1)!.warnings.some(x => /closed at graduation; 0\.000800000 SOL/.test(x)));
  assert.equal(s.runs.at(-1)!.reconcile!.ok, true);
});

test('PAUSE between the dev payout and the pot payout: stops before pot_w1; after unpause the winner is paid exactly once', async () => {
  const h = harness({ open: true, wins: 1, onSend: (st, pause) => { if (st === 'dev') pause(); } });
  const r1 = await h.k.runOnce(T0);
  assert.equal(r1.status, 'paused_midrun'); assert.deepEqual(h.sent, ['claim_dbc', 'dev']);
  assert.equal(h.state().current!.stopped_before, 'pot_w1'); assert.equal(h.got(1), 0n);
  h.unpause();
  await h.k.runOnce(T0 + W);
  assert.deepEqual(h.sent, ['claim_dbc', 'dev', 'pot_w1'], 'resumed run: no second claim or dev transfer');
  await h.k.runOnce(T0 + 2 * W);
  assert.deepEqual(h.sent, ['claim_dbc', 'dev', 'pot_w1'], 'nothing new to claim or pay');
  assert.equal(h.got(1), 500_000n);
  assert.equal(h.state().runs.at(-1)!.reconcile!.ok, true);
});

test('a keeper without a pot config never reads the rules account and keeps the plain 15/85 split', async () => {
  const h = harness({ open: true, wins: 1, pot: false });
  const r = await h.k.runOnce(T0);   // the fake connection has no getAccountInfo: any rules read would fail the run
  assert.equal(r.status, 'waiting_for_graduation'); assert.deepEqual(h.sent, ['claim_dbc', 'dev']);
  const s = h.state();
  assert.deepEqual([s.totals.dev_lamports, s.pending_lamports, s.pot_pending_lamports ?? '0'], ['750000', '4250000', '0']);
});

// readPot itself: the rules PDA of the configured hook program, owner-checked, decoded with the program's layout
function rulesAccount(mint: PublicKey, potEvery: number, wins: number, owners: PublicKey[]) {
  const head = Buffer.alloc(8 + 32 + 1 + 8 * 4 + 4 + 8 * 8);
  ACC.RulesState.copy(head, 0); mint.toBuffer().copy(head, 8);
  let o = 8 + 32 + 1 + 8 * 4; head.writeUInt32LE(potEvery, o); o += 4;
  o += 8 * 6; head.writeBigUInt64LE(BigInt(wins), o);   // potMin, cooldown, curSlot, boughtInSlot, buyCount, lastCountedSlot, then wins
  const ring = Buffer.alloc(POT_WINNERS * 80);
  for (let n = Math.max(1, wins - POT_WINNERS + 1); n <= wins; n++) {
    const at = ((n - 1) % POT_WINNERS) * 80;
    owners[n - 1].toBuffer().copy(ring, at); ring.writeBigUInt64LE(BigInt(n * potEvery), at + 64); ring.writeBigUInt64LE(BigInt(1000 + n), at + 72);
  }
  return Buffer.concat([head, ring]);
}
test('readPot: rules PDA of the hook program, owner checked, potEvery 0 means no pot, open until the curve migrates', async () => {
  const hook = new PublicKey(base.hook_program), mint = new PublicKey(base.main_mint);
  const owners = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('rules'), mint.toBuffer()], hook);
  const mk = (acct: { owner: PublicKey; data: Buffer } | null, migrated: number) => {
    const cfg: KeeperConfig = { ...base, pinned_pubkeys: undefined, pot: { share_pct: 10, min_payout_lamports: '100000' } };
    const k = new Keeper(cfg, [], trapConn(), { claim: Keypair.generate(), treasury: Keypair.generate(), gas: Keypair.generate() }, [], () => {});
    (k as any).conn = { getAccountInfo: async (pk: PublicKey) => { assert.ok(pk.equals(pda), 'reads the rules PDA'); return acct; } };
    (k as any).dbc = { state: { getPool: async () => ({ isMigrated: migrated }) } };
    return k as any;
  };
  const p = await mk({ owner: hook, data: rulesAccount(mint, 10, 20, owners) }, 0).readPot();
  assert.equal(p.open, true); assert.equal(p.rules.wins, 20n); assert.equal(p.rules.winners.length, 16);
  assert.ok(p.rules.winners[0].owner.equals(owners[19]), 'newest win first'); assert.ok(p.rules.winners[15].owner.equals(owners[4]));
  assert.equal((await mk({ owner: hook, data: rulesAccount(mint, 10, 2, owners) }, 1).readPot()).open, false);
  assert.equal(await mk({ owner: hook, data: rulesAccount(mint, 0, 0, owners) }, 0).readPot(), null);
  assert.equal(await mk(null, 0).readPot(), null);
  await assert.rejects(mk({ owner: Keypair.generate().publicKey, data: rulesAccount(mint, 10, 1, owners) }, 0).readPot(), /not the hook program/);
});

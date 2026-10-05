// sdk/indexer.ts: swaps parsed from the POOL side, blocked (cap-hit) rows, non-swaps ignored, incremental runs with
// no duplicates, candles. No chain access (a stub connection serves recorded-shape transactions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair, PublicKey } from '@solana/web3.js';
import { parseTrade, indexToken, readIndex, candles, WSOL, dammPoolFor } from '../sdk/indexer.ts';
import { DEFAULT_PROGRAM_ID } from '../sdk/hook.ts';

const MINT = 'Mint111111111111111111111111111111111111111';
const DBC_AUTH = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
const TRADER = Keypair.generate().publicKey;
const bal = (i: number, mint: string, owner: string, amount: bigint) => ({ accountIndex: i, mint, owner, uiTokenAmount: { amount: amount.toString() } });
/** A swap: pool base vault (idx 2), pool wSOL vault (idx 3), trader's token account (idx 4). */
function swapTx(slot: number, dBase: bigint, dQuote: bigint, extra: any = {}) {
  return {
    slot, blockTime: 1_700_000_000 + slot,
    transaction: { message: { staticAccountKeys: [TRADER] } },
    meta: {
      err: null, logMessages: [],
      preTokenBalances: [bal(2, MINT, DBC_AUTH, 1_000_000_000n), bal(3, WSOL, DBC_AUTH, 5_000_000_000n), bal(4, MINT, TRADER.toBase58(), 0n)],
      postTokenBalances: [bal(2, MINT, DBC_AUTH, 1_000_000_000n + dBase), bal(3, WSOL, DBC_AUTH, 5_000_000_000n + dQuote), bal(4, MINT, TRADER.toBase58(), -dBase)],
      ...extra,
    },
  };
}

test('buy and sell from the pool side, price in SOL per whole token', () => {
  const buy = parseTrade(swapTx(10, -2_000_000n, 1_000_000n), 'sigB', MINT, 'P', 'curve', 6)!;
  assert.deepEqual([buy.side, buy.baseRaw, buy.quoteLamports, buy.trader], ['buy', '2000000', '1000000', TRADER.toBase58()]);
  assert.equal(buy.price, 0.0005);   // 0.001 SOL for 2 tokens
  const sell = parseTrade(swapTx(11, 4_000_000n, -1_000_000n), 'sigS', MINT, 'P', 'curve', 6)!;
  assert.equal(sell.side, 'sell'); assert.equal(sell.price, 0.00025);
});

test('the trader paying rent or wrapping SOL does not change the swap amounts (pool side only)', () => {
  const tx = swapTx(12, -2_000_000n, 1_000_000n);
  tx.meta.preTokenBalances.push(bal(5, WSOL, TRADER.toBase58(), 0n));
  tx.meta.postTokenBalances.push(bal(5, WSOL, TRADER.toBase58(), 99_999n));   // leftover wSOL in the trader's account
  (tx.meta as any).preBalances = [10_000_000_000]; (tx.meta as any).postBalances = [9_996_000_000];   // includes ATA rent
  assert.equal(parseTrade(tx, 's', MINT, 'P', 'curve', 6)!.quoteLamports, '1000000');
});

test('non-swaps are ignored: claims, burns, same-direction moves, other mints', () => {
  assert.equal(parseTrade(swapTx(1, 0n, -5_000n), 's', MINT, 'P', 'pool', 6), null, 'fee claim: quote leaves, no base');
  assert.equal(parseTrade(swapTx(1, 5n, 5n), 's', MINT, 'P', 'pool', 6), null, 'both up: not a swap');
  assert.equal(parseTrade(swapTx(1, -2n, 1n), 's', 'OtherMint1111111111111111111111111111111111', 'P', 'pool', 6), null);
  assert.equal(parseTrade(null, 's', MINT, 'P', 'pool', 6), null);
});

test('a failed swap is a blocked row only when OUR hook rejected it', () => {
  const ours = DEFAULT_PROGRAM_ID.toBase58();
  const capHit = swapTx(20, 0n, 0n, { err: { InstructionError: [2, { Custom: 6000 }] }, logMessages: [
    `Program ${ours} invoke [2]`, 'Program log: AnchorError thrown in programs/trenches-hook/src/lib.rs:190. Error Code: WalletCapExceeded. Error Number: 6000. Error Message: x.', `Program ${ours} failed: custom program error: 0x1770`] });
  const b = parseTrade(capHit, 'sigX', MINT, 'P', 'curve', 6)!;
  assert.deepEqual([b.side, b.error, b.price, b.baseRaw], ['blocked', 'WalletCapExceeded', null, '0']);
  const slippage = swapTx(21, 0n, 0n, { err: { InstructionError: [2, { Custom: 6004 }] }, logMessages: ['Program dbc failed: custom program error: 0x1774'] });
  assert.equal(parseTrade(slippage, 's', MINT, 'P', 'curve', 6), null, 'other failures are not trades');
});

test('incremental indexing: second run adds only new signatures, no duplicates, newest first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ix-'));
  const chain: Record<string, any> = { s1: swapTx(1, -1_000_000n, 500n), s2: swapTx(2, -1_000_000n, 600n), s3: swapTx(3, 1_000_000n, -550n), claim: swapTx(4, 0n, -10n) };
  let sigs = ['claim', 's3', 's2', 's1'];   // RPC order: newest first
  const conn: any = {
    getSignaturesForAddress: async (_p: PublicKey, o: any) => { const stop = o.until ? sigs.indexOf(o.until) : sigs.length; return sigs.slice(0, stop < 0 ? sigs.length : stop).map((signature) => ({ signature })); },
    getTransaction: async (s: string) => chain[s],
  };
  const target = { mint: MINT, decimals: 6, pools: [{ address: Keypair.generate().publicKey.toBase58(), venue: 'curve' as const }] };
  assert.deepEqual(await indexToken(conn, 'devnet', target, { dir }), { added: 3, total: 3 });
  assert.deepEqual(await indexToken(conn, 'devnet', target, { dir }), { added: 0, total: 3 }, 'nothing new');
  chain.s5 = swapTx(5, -2_000_000n, 1_200n); sigs = ['s5', ...sigs];
  assert.deepEqual(await indexToken(conn, 'devnet', target, { dir }), { added: 1, total: 4 });
  const ix = readIndex('devnet', MINT, dir)!;
  assert.deepEqual(ix.trades.map((t) => t.sig), ['s5', 's3', 's2', 's1']);
  assert.equal(new Set(ix.trades.map((t) => t.sig)).size, ix.trades.length);
});

test('candles: open/high/low/close per interval from priced trades only', () => {
  const t = (time: number, price: number | null, side: any = 'buy') => ({ sig: String(time), slot: time, time, pool: 'P', venue: 'curve' as const, side, trader: 'x', baseRaw: '1', quoteLamports: '1', price });
  const cs = candles([t(100, 1), t(130, 3), t(150, 2), t(170, null, 'blocked'), t(200, 5)], 60);
  assert.deepEqual(cs, [{ t: 60, o: 1, h: 1, l: 1, c: 1, n: 1 }, { t: 120, o: 3, h: 3, l: 2, c: 2, n: 2 }, { t: 180, o: 5, h: 5, l: 5, c: 5, n: 1 }]);
});

test('DAMM v2 pool derivation matches the committed devnet keeper config (TDT route pool)', async () => {
  const { readFileSync } = await import('node:fs');
  const { DAMM_V2_MIGRATION_CONFIG } = await import('../sdk/launch.ts');
  const k = JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8'));
  assert.equal(dammPoolFor(k.main_mint, DAMM_V2_MIGRATION_CONFIG.devnet), k.route_pool);
});

test('/api/token/<mint>/trades: registry + launch-record gated like the token view; unknown sub-paths 404', async () => {
  const { siteRoute } = await import('../app/site_registry.ts');
  const A = 'So11111111111111111111111111111111111111112', B = 'Aaaa1111111111111111111111111111111111111111';
  let tokenCalls = 0, tradeCalls = 0;
  const deps: any = { cluster: 'devnet', load: () => new Set([A, B]), launches: () => [{ mint: A }], meta: () => ({}), trade: async () => ({ code: 200, body: 0 }),
    token: async () => { tokenCalls++; return { view: true }; }, trades: (m: string) => { tradeCalls++; return { trades: m }; } };
  assert.deepEqual(await siteRoute(`/api/token/${A}/trades`, 'GET', async () => ({}), deps), { code: 200, body: { trades: A } });
  assert.equal((await siteRoute(`/api/token/${B}/trades`, 'GET', async () => ({}), deps))!.code, 404, 'no launch record');
  assert.equal((await siteRoute('/api/token/Nope1111111111111111111111111111111111111111/trades', 'GET', async () => ({}), deps))!.code, 404);
  assert.equal((await siteRoute(`/api/token/${A}/other`, 'GET', async () => ({}), deps))!.code, 404);
  assert.deepEqual(await siteRoute(`/api/token/${A}`, 'GET', async () => ({}), deps), { code: 200, body: { view: true } });
  assert.deepEqual([tokenCalls, tradeCalls], [1, 1]);
});

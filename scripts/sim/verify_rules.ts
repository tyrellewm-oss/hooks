// End-to-end check of the v2 buy rules: the hook program BUILT FROM THIS BRANCH (SIM_HOOK_SO) with the deployed
// devnet DBC program, real curve buys through the Meteora SDK. Proves, for v2 tokens:
//   1. max single buy: a buy over the limit fails (MaxBuyExceeded); a buy under it lands
//   2. max bought per slot: buys in one slot stop at the limit (SlotBuyLimitExceeded); the next slot is fresh
//   3. both limits end with the opening window
//   4. Nth-buy pot: every Nth qualifying buy is recorded as a winner; at most one count per slot; small buys don't count
//   5. sells are never blocked, and the cap per token account still applies
// and that a v1 token (no rules) launched by the same build still behaves as before.
// Run: SIM_HOOK_SO=target/deploy/trenches_hook.so node --import tsx scripts/sim/verify_rules.ts   (Linux/macOS)
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { simEnv } from './env.js';
import { hookAdmin, launchToken, trader, buy, tokenBalance } from './launch.js';
import { BALANCED } from '../../sdk/schedules.js';
import { decodeRules, type BuyRules } from '../../sdk/hook.js';
import type { Keypair } from '@solana/web3.js';

const log = (...a: unknown[]) => console.log('[rules]', ...a);
if (!process.env.SIM_HOOK_SO) throw new Error('set SIM_HOOK_SO to the hook program built from this branch (target/deploy/trenches_hook.so)');
const sim = await simEnv();
const keys = hookAdmin(sim);
const D = 1_000_000n;                 // 6 decimals
const SUPPLY = 1_000_000_000n * D;
const pct = (bps: bigint) => (SUPPLY * bps) / 10_000n;

const rules: BuyRules = {
  maxBuyTokens: pct(30n),             // 0.3% of supply per buy (below the 1% launch cap)
  maxPerSlotTokens: pct(50n),         // 0.5% of supply per slot, all buyers together
  windowSlots: 300n,                  // ~2 minutes
  potEvery: 10,                       // every 10th qualifying buy wins
  potMinTokens: pct(1n),              // a buy qualifies from 0.01% of supply
};
const o: any = { name: 'Sim Rules', symbol: 'RULE', steps: BALANCED.steps, uncappedAfter: BALANCED.uncappedAfter, migrationQuoteThresholdSol: 500, rules };
const l = await launchToken(sim, keys, o);
const readRules = () => decodeRules(sim.env.accountData(sim.env.hook.rulesPda(l.mint))!);
log('v2 token launched', l.mint.toBase58(), 'rules', JSON.stringify(readRules(), (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 160));
sim.warp(200n);                       // past the 50% opening fee so SOL amounts map to tokens predictably (rules window is 300)

/** SOL for a buy that returns about `tokens` at the current price (quote from the SDK, plus a margin either way). */
async function solFor(tokens: bigint) {
  const pool: any = await sim.dbc.state.getPool(l.pool); const config: any = await sim.dbc.state.getPoolConfig(l.config);
  const q: any = (sim.dbc.pool as any).swapQuote2 ? await (sim.dbc.pool as any).swapQuote2({ virtualPool: pool, config, swapBaseForQuote: false, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: new BN(sim.slot.toString()), slippageBps: 0, swapMode: 2, amountOut: new BN(tokens.toString()) }) : null;
  return BigInt((q?.maximumAmountIn ?? q?.inputAmount ?? q?.includedFeeInputAmount).toString());
}
const failsWith = (r: { ok: boolean; logs: string[] }, name: string) => !r.ok && r.logs.some((x) => x.includes(name));

// 1. max single buy
const big = await buy(sim, l, trader(sim), (await solFor(pct(40n))));
assert.ok(failsWith(big, 'MaxBuyExceeded'), 'a 0.4% buy fails on the 0.3% max single buy: ' + big.logs.slice(-4).join(' | '));
const okBuy = await buy(sim, l, trader(sim), (await solFor(pct(20n))));
assert.ok(okBuy.ok, 'a 0.2% buy lands: ' + okBuy.logs.slice(-4).join(' | '));
log(`max single buy: 0.4% refused, 0.2% landed (${okBuy.tokens} raw)`);

// 2. max bought per slot (same slot: litesvm does not advance slots between sends)
const r2 = await buy(sim, l, trader(sim), (await solFor(pct(20n))));   // slot total now ~0.4%
assert.ok(r2.ok, 'second 0.2% buy in the slot lands (total ~0.4% <= 0.5%)');
const r3 = await buy(sim, l, trader(sim), (await solFor(pct(20n))));   // would make ~0.6%
assert.ok(failsWith(r3, 'SlotBuyLimitExceeded'), 'third 0.2% buy in the same slot fails on the 0.5% per-slot limit: ' + r3.logs.slice(-4).join(' | '));
sim.warp(1n);
const r4 = await buy(sim, l, trader(sim), (await solFor(pct(20n))));
assert.ok(r4.ok, 'the next slot starts fresh');
log('max per slot: 3rd buy in a slot refused, next slot fresh');

// 3. after the window both limits are gone (the cap per token account still applies)
sim.warp(rules.windowSlots + 5n);
const afterWin = await buy(sim, l, trader(sim, 200n), (await solFor(pct(60n))));
assert.ok(afterWin.ok, 'after the window a 0.6% buy (over both limits, under the cap) lands: ' + afterWin.logs.slice(-4).join(' | '));
const overCap = await buy(sim, l, trader(sim, 500n), (await solFor(pct(300n))));
assert.ok(failsWith(overCap, 'WalletCapExceeded'), 'a 3% buy still fails on the cap per token account');
log('after the window: 0.6% buy landed; 3% buy still refused by the cap');

// 4. Nth-buy pot
const before = readRules();
const buyers: Keypair[] = [];
for (let i = 0; i < 25; i++) {
  sim.warp(1n);
  const who = trader(sim);
  const r = await buy(sim, l, who, (await solFor(pct(2n))));     // 0.02% qualifies
  assert.ok(r.ok, `pot buy ${i} lands`);
  buyers.push(who);
  if (i === 4) {                                                  // same slot, second qualifying buy: must not count
    const dup = await buy(sim, l, trader(sim), (await solFor(pct(2n))));
    assert.ok(dup.ok, 'a second buy in the same slot lands');
  }
  if (i === 7) {                                                  // too small to qualify: must not count
    sim.warp(1n);
    const small = await buy(sim, l, trader(sim), 1_000n);
    assert.ok(small.ok, 'a tiny buy lands');
  }
}
const after = readRules();
const counted = after.buyCount - before.buyCount;
assert.equal(counted, 25n, `exactly the 25 one-per-slot qualifying buys counted (got ${counted})`);
const expectedWins = after.buyCount / 10n - before.buyCount / 10n;
assert.equal(after.wins - before.wins, expectedWins, 'one win per 10 counted buys');
for (const w of after.winners.slice(0, Number(expectedWins))) {
  assert.equal(w.buyIndex % 10n, 0n, 'winners are exactly the 10th, 20th, ... qualifying buys');
  assert.ok(buyers.some((b) => b.publicKey.equals(w.owner)), 'the recorded winner is the buyer who made that buy');
}
log(`pot: ${counted} qualifying buys counted, ${after.wins - before.wins} winners recorded (buy #${after.winners.map((w) => w.buyIndex).join(', #')})`);

// 5. sells are never blocked
const seller = buyers[0];
const held = tokenBalance(sim, l.mint, seller.publicKey);
const sellTx = await (sim.dbc.pool as any).swap2WithTransferHook({ owner: seller.publicKey, pool: l.pool, swapBaseForQuote: true, referralTokenAccount: null, amountIn: new BN(held.toString()), minimumAmountOut: new BN(0), swapMode: 0 });
const sell = sim.send(sellTx, [seller]);
assert.ok(sell.ok, 'selling back into the curve works: ' + sell.logs.slice(-4).join(' | '));
log('sell back into the curve: ok');

// v1 token on the same build: no rules account, behaves as before
const v1 = await launchToken(sim, keys, { ...o, symbol: 'RUL1', rules: undefined });
sim.warp(200n);
const v1buy = await buy(sim, v1, trader(sim), 50_000_000n);
assert.ok(v1buy.ok, 'a v1 token (no rules) still trades on this build');
assert.equal(sim.env.accountData(sim.env.hook.rulesPda(v1.mint)), null, 'v1 tokens have no rules account');
log('v1 token on the new build: ok');
log('PASS');

// Baseline check of the local simulation against the DEPLOYED devnet programs (DBC + Hookd hook), as the site
// launches today: a launch succeeds, buys land under the cap, a buy over the cap fails with the hook's error, and the
// anti-sniper fee falls from its start to its end value. Every new hook gets a script like this next to it.
// Run: node --import tsx scripts/sim/verify_baseline.ts   (Linux/macOS: litesvm has no Windows build)
import assert from 'node:assert/strict';
import { simEnv } from './env.js';
import { hookAdmin, launchToken, trader, buy, tokenBalance } from './launch.js';
import { BALANCED } from '../../sdk/schedules.js';
import { DEFAULT_LAUNCH_FEES } from '../../sdk/launch.js';

const log = (...a: unknown[]) => console.log('[baseline]', ...a);
const sim = await simEnv();
const keys = hookAdmin(sim);
const o: any = { name: 'Sim Baseline', symbol: 'SIMB', steps: BALANCED.steps, uncappedAfter: BALANCED.uncappedAfter, migrationQuoteThresholdSol: 50 };
const l = await launchToken(sim, keys, o);
log('launched', l.mint.toBase58(), 'at slot', l.launchSlot);

// 1. first buy, in the opening window: lands, pays roughly the starting anti-sniper fee
const a = trader(sim);
const first = await buy(sim, l, a, 10_000_000n);   // 0.01 SOL
assert.ok(first.ok, 'a small first buy lands: ' + first.logs.slice(-6).join(' | '));
log(`first buy 0.01 SOL -> ${first.tokens} raw tokens, fee ${first.feePct}%`);
assert.ok(first.feePct > 45 && first.feePct <= 50.5, `the opening fee is near ${DEFAULT_LAUNCH_FEES.feeStartBps / 100}% (got ${first.feePct}%)`);

// 2. a buy that would put one token account over the 1% launch cap fails with the hook's cap error
const whale = trader(sim, 100n);
const big = await buy(sim, l, whale, 30_000_000_000n);  // 30 SOL into a 50 SOL curve at launch: far over 1% of supply
assert.equal(big.ok, false, 'an over-cap buy must fail');
assert.ok(big.logs.some((x) => /WalletCapExceeded|cap/i.test(x)), 'it fails on the hook cap: ' + big.logs.slice(-6).join(' | '));
assert.equal(tokenBalance(sim, l.mint, whale.publicKey), 0n, 'nothing moved');
log('over-cap buy refused by the hook (nothing moved)');

// 3. after the fee window, a buy pays about the end fee
sim.warp(BigInt(DEFAULT_LAUNCH_FEES.feeDurationSlots + 5));
const later = await buy(sim, l, trader(sim), 10_000_000n);
assert.ok(later.ok, 'a later small buy lands');
log(`buy after ${DEFAULT_LAUNCH_FEES.feeDurationSlots} slots -> fee ${later.feePct}%`);
assert.ok(later.feePct <= DEFAULT_LAUNCH_FEES.feeEndBps / 100 + 0.2, `the fee has fallen to ~${DEFAULT_LAUNCH_FEES.feeEndBps / 100}% (got ${later.feePct}%)`);

log('PASS');

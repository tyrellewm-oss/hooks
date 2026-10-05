// web/ front end: pure token-page logic (web/src/lib/token.ts). No DOM, no chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capConfigOf, phaseOf, liveCap, liveNextChange, curveFeePctAt, estimateSlot, parseTokenAmount, formatTokenAmount, buyPreview, elapsedSlots,
} from '../web/src/lib/token.ts';

const SUPPLY = 1_000_000_000n * 1_000_000n;
const FEE = { mode: 'linear fee scheduler', cliffPct: 50, endPct: 1, periods: 10, periodSlots: 15, totalSlots: 150, collectFeeMode: 0, migrationFeeOption: 0, creatorTradingFeePercentage: 0, migrationQuoteThresholdSol: 1 };
// Balanced (approved): 1% from +0, 2% from +150, 4% from +1500, no cap from +4500. Launch at slot 1000.
function view(over: Record<string, unknown> = {}, pool: any = { quoteReserveSol: 0.1, isMigrated: false, curveComplete: false }): any {
  return {
    status: {
      cluster: 'LOCAL', slot: 1000, mint: 'M', supply: SUPPLY.toString(), decimals: 6, mintAuthority: null, freezeAuthority: null,
      transferHookProgram: 'HOOK', transferHookAuthority: 'DBC', launchSlot: '1000',
      steps: [{ slotOffset: '0', maxBps: 100 }, { slotOffset: '150', maxBps: 200 }, { slotOffset: '1500', maxBps: 400 }],
      uncappedAfter: '4500', globalLifted: false, mintLifted: false, raisedFloorBps: 0, ...over,
    },
    launch: null, fee: FEE, feeConfig: null, pool, balances: {}, switchHistory: [], explorer: { mint: '', pool: '', program: '' },
  };
}

test('phase follows the lifecycle: early fee -> capped -> no cap; graduated wins', () => {
  assert.equal(phaseOf(view(), 1050n), 'early');
  assert.equal(phaseOf(view(), 1149n), 'early');
  assert.equal(phaseOf(view(), 1150n), 'capped');
  assert.equal(phaseOf(view(), 5499n), 'capped');
  assert.equal(phaseOf(view(), 5500n), 'uncapped');
  assert.equal(phaseOf(view({ transferHookProgram: null }), 1050n), 'graduated');
  assert.equal(phaseOf(view({}, { quoteReserveSol: 1, isMigrated: true, curveComplete: true }), 1050n), 'graduated');
  assert.equal(phaseOf(view({ steps: undefined }), 1050n), 'unknown');
});

test('lift switch: a lifted mint or global lift means no cap; a raised minimum cap only raises it', () => {
  assert.equal(phaseOf(view({ mintLifted: true }), 1700n), 'uncapped');
  assert.equal(liveCap(view({ globalLifted: true }), 1700n), null);
  assert.equal(liveCap(view(), 1700n), SUPPLY * 200n / 10_000n);
  assert.equal(liveCap(view({ raisedFloorBps: 500 }), 1700n), SUPPLY * 500n / 10_000n);
  assert.equal(liveCap(view({ raisedFloorBps: 100 }), 1700n), SUPPLY * 200n / 10_000n, 'a lower raised minimum never tightens');
  assert.equal(liveCap(view({ transferHookProgram: null }), 1700n), null, 'no cap after graduation');
});

test('next change matches the schedule and stops after the ramp', () => {
  assert.deepEqual(liveNextChange(view(), 1100n), { slot: 1150n, bps: 200 });
  assert.deepEqual(liveNextChange(view(), 2600n), { slot: 5500n, bps: null });
  assert.equal(liveNextChange(view(), 5500n), null);
  assert.equal(capConfigOf(view({ launchSlot: undefined }).status), null);
  assert.equal(elapsedSlots(view().status, 900n), 0n, 'before launch counts as 0');
});

test('approximate curve fee follows the linear scheduler, then holds the end fee', () => {
  assert.equal(curveFeePctAt(FEE, 0n), 50);
  assert.equal(curveFeePctAt(FEE, 14n), 50);
  assert.equal(curveFeePctAt(FEE, 15n), 45.1);
  assert.equal(curveFeePctAt(FEE, 149n), 5.9);
  assert.equal(curveFeePctAt(FEE, 150n), 1);
  assert.equal(curveFeePctAt(FEE, 1_000_000n), 1);
  assert.equal(curveFeePctAt(null, 0n), null);
  const exp = { ...FEE, mode: 'exponential fee scheduler' };
  assert.equal(curveFeePctAt(exp, 0n), 50);
  assert.ok(curveFeePctAt(exp, 75n)! < 50 && curveFeePctAt(exp, 75n)! > 1);
});

test('slot estimate between polls never goes backwards', () => {
  assert.equal(estimateSlot(100, 10_000, 11_000), 102n);
  assert.equal(estimateSlot(100, 10_000, 9_000), 100n);
});

test('token amounts parse exactly (no float) and round-trip', () => {
  assert.equal(parseTokenAmount('1.5', 6), 1_500_000n);
  assert.equal(parseTokenAmount('1,000', 6), 1_000_000_000n);
  assert.equal(parseTokenAmount(' 7600000 ', 6), 7_600_000_000_000n);
  assert.equal(parseTokenAmount('0.000001', 6), 1n);
  assert.throws(() => parseTokenAmount('1.1234567', 6), /decimals/);
  assert.throws(() => parseTokenAmount('abc', 6));
  assert.throws(() => parseTokenAmount('-1', 6));
  for (const s of ['1.5', '7600000', '0.000001', '123.45']) assert.equal(formatTokenAmount(parseTokenAmount(s, 6), 6), s);
});

test('buy preview: room under the cap and how far over it a buy goes', () => {
  const cap = 20_000_000n;
  assert.deepEqual(buyPreview(12_400_000n, 10_000_000n, cap), { balance: 12_400_000n, after: 22_400_000n, cap, room: 7_600_000n, overBy: 2_400_000n });
  assert.equal(buyPreview(12_400_000n, 7_600_000n, cap).overBy, 0n, 'exactly at the cap is allowed (post-balance <= cap)');
  assert.deepEqual(buyPreview(5n, 1n, null), { balance: 5n, after: 6n, cap: null, room: null, overBy: 0n });
  assert.equal(buyPreview(30n, 1n, 20n).room, 0n);
});

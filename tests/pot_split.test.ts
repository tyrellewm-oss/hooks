// Pot payout math (pure): the 15 / pot / buyback split and the per-run payout plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFees, splitWithPot, planPotPayouts } from '../sdk/flywheel/math.js';

test('splitWithPot with no pot gives exactly splitFees', () => {
  for (const x of [0n, 6n, 8_553_996n, 1_940_954n]) {
    const { dev, buyback } = splitFees(x);
    assert.deepEqual(splitWithPot(x, 0n, x), { dev, pot: 0n, buyback });
  }
});

test('splitWithPot 10% of curve fees: 15 dev / 10 pot / 75 buyback (live HKRUL claim), dust to buyback', () => {
  assert.deepEqual(splitWithPot(1_940_954n, 10n, 1_940_954n), { dev: 291_143n, pot: 194_095n, buyback: 1_455_716n });
  const r = splitWithPot(1_000_001n, 10n, 1_000_001n);
  assert.equal(r.dev + r.pot + r.buyback, 1_000_001n);
  for (let i = 0; i < 2000; i++) {
    const x = BigInt(Math.floor(Math.random() * 1e15)), base = (x * BigInt(Math.floor(Math.random() * 101))) / 100n;
    const s = splitWithPot(x, 10n, base);
    assert.equal(s.dev + s.pot + s.buyback, x); assert.equal(s.dev, (x * 15n) / 100n); assert.equal(s.pot, (base * 10n) / 100n);
  }
});

test('splitWithPot takes the pot share from curve fees only', () => {
  // 1,000,000 claimed of which 400,000 came from the curve: pot = 10% of 400,000
  assert.deepEqual(splitWithPot(1_000_000n, 10n, 400_000n), { dev: 150_000n, pot: 40_000n, buyback: 810_000n });
  assert.deepEqual(splitWithPot(1_000_000n, 10n, 0n), { dev: 150_000n, pot: 0n, buyback: 850_000n });
});

test('splitWithPot refuses bad shares and bases', () => {
  assert.throws(() => splitWithPot(100n, 86n, 100n));
  assert.throws(() => splitWithPot(100n, -1n, 100n));
  assert.throws(() => splitWithPot(100n, 10n, 101n));
  assert.throws(() => splitWithPot(100n, 10n, -1n));
  assert.throws(() => splitWithPot(-1n, 10n, 0n));
});

const w = (win: number) => ({ win, owner: `owner${win}` });
const ring = (newest: number, n = 16) => Array.from({ length: Math.min(n, newest) }, (_, i) => w(newest - i));

test('open pot: equal split among unpaid wins in win order, dust held, cursor to the newest win', () => {
  const p = planPotPayouts(1_000_001n, 3n, 1n, ring(3), 100_000n);
  assert.equal(p.reason, 'none');
  assert.deepEqual(p.payouts, [{ win: 2, owner: 'owner2', lamports: 500_000n }, { win: 3, owner: 'owner3', lamports: 500_000n }]);
  assert.deepEqual([p.held, p.release, p.paidThrough, p.overwritten], [1n, 0n, 3n, 0]);
});

test('open pot: no new wins holds the whole pot (it rolls over to the next winner)', () => {
  assert.deepEqual(planPotPayouts(500_000n, 2n, 2n, ring(2), 100_000n), { payouts: [], overwritten: 0, held: 500_000n, release: 0n, paidThrough: 2n, reason: 'no_new_wins' });
});

test('open pot: a share below the minimum pays nobody yet and keeps the cursor', () => {
  const p = planPotPayouts(150_000n, 2n, 0n, ring(2), 100_000n);
  assert.deepEqual([p.reason, p.payouts.length, p.held, p.release, p.paidThrough], ['below_min', 0, 150_000n, 0n, 0n]);
});

test('open pot: wins pushed out of the ring are counted and skipped; their money stays for the visible winners', () => {
  const p = planPotPayouts(16_000_000n, 20n, 0n, ring(20), 100_000n);   // ring holds wins 5..20
  assert.equal(p.overwritten, 4);
  assert.deepEqual(p.payouts.map(x => x.win), Array.from({ length: 16 }, (_, i) => i + 5));
  assert.ok(p.payouts.every(x => x.lamports === 1_000_000n));
  assert.deepEqual([p.held, p.paidThrough], [0n, 20n]);
  const gone = planPotPayouts(1_000_000n, 20n, 0n, [], 100_000n);
  assert.deepEqual([gone.reason, gone.overwritten, gone.held, gone.paidThrough], ['all_unpaid_overwritten', 20, 1_000_000n, 20n]);
});

test('closed pot (graduated): minimum waived, unpaid winners get the pot, dust goes to the buyback', () => {
  const p = planPotPayouts(150_001n, 2n, 0n, ring(2), 1_000_000n, false);
  assert.deepEqual(p.payouts.map(x => [x.win, x.lamports]), [[1, 75_000n], [2, 75_000n]]);
  assert.deepEqual([p.held, p.release, p.paidThrough, p.reason], [0n, 1n, 2n, 'none']);
});

test('closed pot with nobody left to pay releases everything to the buyback', () => {
  assert.deepEqual(planPotPayouts(300_000n, 2n, 2n, ring(2), 100_000n, false), { payouts: [], overwritten: 0, held: 0n, release: 300_000n, paidThrough: 2n, reason: 'no_new_wins' });
  const dust = planPotPayouts(1n, 3n, 1n, ring(3), 100_000n, false);   // 1 lamport for 2 winners: nothing payable
  assert.deepEqual([dust.reason, dust.payouts.length, dust.release, dust.paidThrough], ['pot_empty', 0, 1n, 3n]);
});

test('planPotPayouts refuses impossible inputs', () => {
  assert.throws(() => planPotPayouts(0n, 1n, 2n, [], 100_000n), /ahead/);
  assert.throws(() => planPotPayouts(-1n, 1n, 0n, [], 100_000n));
  assert.throws(() => planPotPayouts(10n, 2n, 0n, [w(2), w(2)], 1n), /duplicate/);
  // win numbers of 0 or above the chain's counter are never paid
  assert.deepEqual(planPotPayouts(10n, 1n, 0n, [w(1), w(0), w(5)], 1n).payouts.map(x => x.win), [1]);
});

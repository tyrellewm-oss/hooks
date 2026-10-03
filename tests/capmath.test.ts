// TS mirror parity with crates/cap-math (same table as the Rust tests) + randomized parity vs the on-chain program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cm from '../sdk/capMath.js';

const cfg = (steps: [number, number][], end: number): cm.CapConfig => ({ launchSlot: 1000n, supply: 1_000_000_000n, steps: steps.map(([o, b]) => ({ slotOffset: BigInt(o), maxBps: b })), uncappedAfter: BigInt(end) });
test('table parity with Rust', () => {
  const c = cfg([[0, 100], [150, 200]], 1500);
  assert.equal(cm.validate(c, cm.RELEASE_LIMITS), null);
  assert.equal(cm.capAt(c, 0n), 10_000_000n); assert.equal(cm.capAt(c, 1149n), 10_000_000n);
  assert.equal(cm.capAt(c, 1150n), 20_000_000n); assert.equal(cm.capAt(c, 2499n), 20_000_000n); assert.equal(cm.capAt(c, 2500n), null);
  assert.deepEqual(cm.nextChange(c, 1000n), { slot: 1150n, bps: 200 }); assert.deepEqual(cm.nextChange(c, 1200n), { slot: 2500n, bps: null });
  assert.equal(cm.validate(cfg([[0, 200], [150, 100]], 1500), cm.RELEASE_LIMITS), 'Decreasing');
  assert.equal(cm.validate(cfg([[0, 5]], 1500), cm.RELEASE_LIMITS), 'OutOfRange');
  assert.equal(cm.validate(cfg([[0, 100]], 20), cm.RELEASE_LIMITS), 'BadEnd');
  assert.equal(cm.validate(cfg([[0, 100]], 20), cm.TEST_SLOTS_LIMITS), null);
  // QA H-3 max ramp + QA L-1 saturating nextChange (matches Rust u64::saturating_add)
  assert.equal(cm.validate(cfg([[0, 100]], 6_480_000), cm.RELEASE_LIMITS), null);
  assert.equal(cm.validate(cfg([[0, 100]], 6_480_001), cm.RELEASE_LIMITS), 'BadEnd');
  { const big = { launchSlot: cm.U64_MAX - 5n, supply: 1n, steps: [{ slotOffset: 0n, maxBps: 100 }, { slotOffset: 100n, maxBps: 200 }], uncappedAfter: 1000n };
    assert.deepEqual(cm.nextChange(big, cm.U64_MAX - 5n), { slot: cm.U64_MAX, bps: 200 }); }
  assert.equal(cm.bpsToAmount(2n ** 64n - 1n, 10_000), 2n ** 64n - 1n);
});
test('effective cap / lift-only (random 20k)', () => {
  let x = 7n; const r = (n: number) => { x = (x * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n; return Number((x >> 33n) % BigInt(n)); };
  for (let i = 0; i < 20_000; i++) {
    const c = cfg([[0, 10 + r(500)], [10 + r(300), 600 + r(400)]], 2000 + r(100));
    const s1 = BigInt(r(5000)), s2 = s1 + BigInt(r(5000));
    const a = cm.capAt(c, s1), b = cm.capAt(c, s2);
    if (a !== null && b !== null) assert.ok(b >= a); if (a === null) assert.equal(b, null);
    assert.deepEqual(cm.decide(true, a, 2n ** 63n), { allow: true });
  }
});

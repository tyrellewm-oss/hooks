// LOCAL cap-math simulation (NOT on-chain): Research's sniper fixtures replayed per token account.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { FIXTURE_NAMES, SCHEDULES, EXEMPT_OWNERS, parseCsv, fromSnapshot, toSnapshot, replay, summarize, SUPPLY, type Fixture, type Row } from '../sdk/replay.js';
import { BALANCED, defaultSchedule } from '../sdk/schedules.js';
import { DBC_POOL_AUTHORITY, DAMM_V2_POOL_AUTHORITY } from '../sdk/hook.js';

const SNAP = JSON.parse(readFileSync('tests/fixtures/replay_v0.min.json', 'utf8'));
const fixtures: Fixture[] = SNAP.fixtures.map(fromSnapshot);
const F = (n: string) => fixtures.find(f => f.name === n)!;
const S = (n: string) => SCHEDULES.find(s => s.name === n)!;
const PCT = SUPPLY / 100n;

test('exempt owners mirror the program (DBC + DAMM v2 pool authorities only)', () => {
  assert.deepEqual([...EXEMPT_OWNERS].sort(), [DBC_POOL_AUTHORITY.toBase58(), DAMM_V2_POOL_AUTHORITY.toBase58()].sort());
});
test('devnet default schedule is Balanced, labelled "approved by King (Oct 4, 2026)"; LOCAL default is the demo schedule', () => {
  assert.equal(defaultSchedule('devnet'), BALANCED); assert.equal(BALANCED.label, 'approved by King (Oct 4, 2026)');
  assert.deepEqual(BALANCED.steps.map(s => [Number(s.slotOffset), s.maxBps]), [[0, 100], [150, 200], [1500, 400]]); assert.equal(BALANCED.uncappedAfter, 4500n);
  assert.equal(defaultSchedule('local').name, 'Current test (demo)');
});
const FULL = process.env.REPLAY_FIXTURES_DIR ?? '../replay_fixtures_v0';
test('committed snapshot matches anonymised full fixtures (<dir>/A.csv … E.csv) when they are present', { skip: !existsSync(`${FULL}/A.csv`) && 'anonymised full fixtures not on this machine' }, () => {
  for (const n of FIXTURE_NAMES) assert.deepEqual(toSnapshot(parseCsv(n, readFileSync(`${FULL}/${n}.csv`, 'utf8'))), SNAP.fixtures.find((x: any) => x.name === n), n);
});

describe('fixtures x schedules (crew numbers)', () => {
  for (const f of FIXTURE_NAMES) for (const s of SCHEDULES) {
    test(`${f} / ${s.name}: every crew curve buy over the slot-0 cap is blocked; post-graduation stays uncapped`, () => {
      const x = summarize(F(f), s); const res = replay(F(f), s);
      for (const r of res) if (r.phase === 'curve' && r.requested > 0n && r.outcome !== 'blocked') assert.ok(r.cap !== null && r.received <= r.cap, `${r.row.label} over cap`);
      for (const r of res) if (r.phase === 'post-graduation' && r.requested > 0n) assert.equal(r.outcome, 'uncapped-post-graduation');
      assert.equal(x.blockedCurvePct, x.originalCurvePct); // all crew curve buys are far above any slot-0 cap
      assert.equal(x.replayAsIsPct, x.postGraduationPct);
      assert.ok(x.resizedCurvePct <= (x.capAtBuyBps! / 100) * F(f).crew.length + 1e-9);
    });
  }
  test('key numbers (Balanced): A/B need 79/78 accounts; C, D and E keep ~20% post-graduation', () => {
    const b = summarize(F('A'), S('Balanced')); assert.equal(b.originalCurvePct, 78.0284); assert.equal(b.accountsNeeded, 79); assert.equal(b.resizedCurvePct, 4);
    assert.equal(summarize(F('B'), S('Balanced')).accountsNeeded, 78);
    assert.equal(summarize(F('B'), S('Strict')).accountsNeeded, 156);
    assert.equal(summarize(F('A'), S('Loose')).accountsNeeded, 40);
    const d = summarize(F('C'), S('Balanced')); assert.equal(d.postGraduationPct, 20.2544); assert.equal(d.accountsNeeded, 80);
    assert.equal(summarize(F('D'), S('Balanced')).postGraduationPct, 20.34);
    assert.equal(summarize(F('E'), S('Balanced')).postGraduationPct, 20.1127);
  });
});

describe('per token account semantics', () => {
  test('C: 2 owners + 2 token accounts in one tx are checked per account, and the tx reverts as a whole', () => {
    const res = replay(F('C'), S('Balanced'));
    const tx947 = res.filter(r => r.row.blockIndex === 947); assert.equal(tx947.length, 2);
    assert.notEqual(tx947[0].row.tokenAccount, tx947[1].row.tokenAccount); assert.notEqual(tx947[0].row.owner, tx947[1].row.owner);
    assert.ok(tx947.every(r => r.outcome === 'blocked' && r.txReverted && r.received === 0n));
    // per-account check: a small second buy in the same tx is fine on its own but rolls back with the tx
    const mk = (owner: string, acct: string, pct: bigint): Row => ({ slotOffset: 0, blockIndex: 1, label: owner, owner, tokenAccount: acct, kind: 'buy', venue: 'dbc', tokensRaw: pct, sig: 'tx1' });
    const fx: Fixture = { name: 'syn', file: '', crew: ['A', 'B'], rows: [mk('A', 'a1', PCT / 2n), mk('B', 'b1', 2n * PCT)] };
    const r2 = replay(fx, S('Balanced'));
    assert.equal(r2[0].outcome, 'allowed'); assert.equal(r2[1].outcome, 'blocked'); assert.ok(r2.every(r => r.txReverted && r.received === 0n));
  });
  test('synthetic AC-6: 1 owner with 2 token accounts holds 2x cap; a 3rd over-cap buy is blocked', () => {
    const mk = (acct: string, amt: bigint, sig: string, bi: number): Row => ({ slotOffset: 0, blockIndex: bi, label: 'OWNER', owner: 'Owner1111', tokenAccount: acct, kind: 'buy', venue: 'dbc', tokensRaw: amt, sig });
    for (const s of SCHEDULES) {
      const cap = (SUPPLY * BigInt(s.steps[0].maxBps)) / 10_000n;
      const fx: Fixture = { name: 'syn', file: '', crew: ['OWNER'], rows: [mk('acct1', cap, 't1', 1), mk('acct2', cap, 't2', 2), mk('acct1', 1n, 't3', 3)] };
      const r = replay(fx, s);
      assert.deepEqual(r.map(x => x.outcome), ['allowed', 'allowed', 'blocked'], s.name);
      assert.equal(r.reduce((a, x) => a + x.received, 0n), 2n * cap, s.name);
    }
  });
  test('cumulative per account: A completer curve buy then same-account buy in the migration tx (post-graduation)', () => {
    const res = replay(F('A'), S('Balanced')).filter(r => r.row.label === 'COMPLETER_MIGRATOR');
    assert.equal(res.length, 2); assert.equal(res[0].row.tokenAccount, res[1].row.tokenAccount);
    assert.equal(res[0].phase, 'curve'); assert.equal(res[0].outcome, 'allowed'); // 0.925% < 1% cap
    assert.equal(res[1].outcome, 'uncapped-post-graduation');
  });
  test('sells are never blocked (receiver is a pool vault)', () => {
    for (const f of fixtures) for (const s of SCHEDULES) for (const r of replay(f, s)) if (r.requested < 0n) assert.equal(r.outcome, 'sell');
  });
  test('an exempt receiver (DBC pool authority owner) is never capped', () => {
    const fx: Fixture = { name: 'syn', file: '', crew: [], rows: [{ slotOffset: 0, blockIndex: 1, label: 'VAULT', owner: DBC_POOL_AUTHORITY.toBase58(), tokenAccount: 'vault', kind: 'transfer', venue: 'dbc', tokensRaw: 90n * PCT, sig: 'v' }] };
    assert.equal(replay(fx, S('Strict'))[0].outcome, 'exempt');
  });
});

test('snapshot is anonymised: fixtures A-E, ids are per-fixture labels (no base58 addresses)', () => {
  assert.deepEqual(SNAP.fixtures.map((f: any) => f.name), ['A', 'B', 'C', 'D', 'E']);
  for (const f of SNAP.fixtures) for (const r of f.rows) {
    const [, , , owner, acct, , , , sig] = r;
    assert.match(owner, new RegExp(`^${f.name}-W\\d+$`)); if (acct) assert.match(acct, new RegExp(`^${f.name}-T\\d+$`)); assert.match(sig, new RegExp(`^${f.name}-TX\\d+$`));
  }
});

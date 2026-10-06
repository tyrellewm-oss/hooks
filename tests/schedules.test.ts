// QA L-16 (schedule names never fall back silently) and L-17 (step-boundary semantics per schedule).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveSchedule, scheduleFlag, UnknownScheduleError, SCHEDULE_IDS, BALANCED, LOCAL_DEMO, STRICT, LOOSE, SCHEDULE_BY_ID, type NamedSchedule } from '../sdk/schedules.js';
import { capBpsAt, effectiveCap, validate, RELEASE_LIMITS } from '../sdk/capMath.js';
import { replay, SUPPLY, type Fixture, type Row } from '../sdk/replay.js';

describe('L-16: schedule name resolution', () => {
  test('valid names (case-insensitive) and defaults', () => {
    assert.deepEqual([...SCHEDULE_IDS], ['strict', 'balanced', 'loose', 'demo']);
    for (const id of SCHEDULE_IDS) assert.equal(resolveSchedule(id, 'devnet'), SCHEDULE_BY_ID[id]);
    assert.equal(resolveSchedule('Balanced', 'local'), BALANCED);
    assert.equal(resolveSchedule(undefined, 'devnet'), BALANCED);
    assert.equal(resolveSchedule(undefined, 'local'), LOCAL_DEMO);
  });
  test('typos and empty values throw with the list of valid names (no silent Balanced fallback)', () => {
    for (const bad of ['balnced', 'strct', '', ' ', 'production', 'test-slots']) {
      assert.throws(() => resolveSchedule(bad, 'devnet'), (e: any) => e instanceof UnknownScheduleError && /valid names: strict\|balanced\|loose\|demo/.test(e.message), JSON.stringify(bad));
    }
  });
  test('scheduleFlag: absent -> undefined; flag without value -> "" (rejected)', () => {
    assert.equal(scheduleFlag(['demo']), undefined);
    assert.equal(scheduleFlag(['demo', '--schedule', 'loose']), 'loose');
    assert.equal(scheduleFlag(['demo', '--schedule']), '');
    assert.equal(scheduleFlag(['demo', '--schedule', '--cluster', 'local']), '');
  });
  test('dbc_flow.ts exits 2 on an unknown --schedule before touching any cluster (LOCAL, offline)', () => {
    for (const args of [['--schedule', 'balnced'], ['--schedule']]) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/dbc_flow.ts', 'demo', ...args], { encoding: 'utf8', env: { ...process.env, DEVNET_RPC: 'http://127.0.0.1:9' } });
      assert.equal(r.status, 2, r.stderr + r.stdout);
      assert.match(r.stderr, /unknown schedule .*valid names: strict\|balanced\|loose\|demo/);
      assert.doesNotMatch(r.stdout, /cluster:/); // never reached cluster resolution
    }
  });
  test('page server rejects an unknown schedule name with 400 (code check: resolveSchedule + 400)', () => {
    const src = readFileSync('app/server.ts', 'utf8');
    // parseLaunchBody (shared by /api/create and the wallet launch route) turns the refusal into { error }, and both
    // routes answer that with 400 before building anything
    const start = src.indexOf('function parseLaunchBody');
    const parse = src.slice(start, src.indexOf('\n}\n', start));
    assert.match(parse, /try \{ const sch = resolveSchedule\(b\.schedule, c\.name\);[^\n]*\}\s*catch \(e: any\) \{ return \{ error: e\.message \}; \}/);
    for (const route of ['/api/create', '/api/studio/launch/build']) {
      const r = src.slice(src.indexOf(`url.pathname === '${route}'`)).slice(0, 600);
      // /api/create parses the body inline; the wallet launch route reads it first (it also needs b.owner on an open studio)
      assert.match(r, /const p = parseLaunchBody\((await body\(req\)|b)\);\s*if \('error' in p\) return send\(res, 400, p\);/, route);
    }
  });
});

// Rust boundary rule (crates/cap-math cap_bps_at): elapsed = slot.saturating_sub(launch_slot);
// elapsed >= uncapped_after -> None (no cap); otherwise the LAST step with slot_offset <= elapsed applies.
function expectedBps(s: NamedSchedule, elapsed: bigint): number | null {
  if (elapsed >= s.uncappedAfter) return null;
  let bps = s.steps[0].maxBps; for (const st of s.steps) if (st.slotOffset <= elapsed) bps = st.maxBps; return bps;
}
describe('L-17: step boundaries per schedule (mirrors Rust cap_bps_at)', () => {
  test('Rust source still has the >= uncapped_after / <= step-offset rule', () => {
    const rs = readFileSync('crates/cap-math/src/lib.rs', 'utf8');
    assert.match(rs, /if elapsed >= cfg\.uncapped_after \{\s*return None;/);
    assert.match(rs, /slot_offset <= elapsed/);
  });
  for (const s of [STRICT, BALANCED, LOOSE, LOCAL_DEMO]) {
    test(`${s.name}: offset-1 / offset / offset+1 for each step and uncapped_after-1 / = / +1`, () => {
      const L = 1_000_000n; // arbitrary launch slot
      const cfg = { launchSlot: L, supply: SUPPLY, steps: s.steps, uncappedAfter: s.uncappedAfter };
      assert.equal(validate(cfg, RELEASE_LIMITS), null);
      const points = new Set<bigint>();
      for (const st of s.steps) for (const d of [-1n, 0n, 1n]) if (st.slotOffset + d >= 0n) points.add(st.slotOffset + d);
      for (const d of [-1n, 0n, 1n]) points.add(s.uncappedAfter + d);
      for (const e of points) {
        const exp = expectedBps(s, e);
        assert.equal(capBpsAt(cfg, L + e), exp, `elapsed ${e}`);
        const cap = effectiveCap(cfg, { lifted: false, raisedFloorBps: 0 }, false, L + e);
        assert.equal(cap, exp === null ? null : (SUPPLY * BigInt(exp)) / 10_000n, `cap at elapsed ${e}`);
      }
      // explicit spot checks of the rule
      for (let i = 1; i < s.steps.length; i++) {
        assert.equal(capBpsAt(cfg, L + s.steps[i].slotOffset - 1n), s.steps[i - 1].maxBps);
        assert.equal(capBpsAt(cfg, L + s.steps[i].slotOffset), s.steps[i].maxBps);
      }
      assert.equal(capBpsAt(cfg, L + s.uncappedAfter - 1n), s.steps[s.steps.length - 1].maxBps);
      assert.equal(capBpsAt(cfg, L + s.uncappedAfter), null);
      assert.equal(capBpsAt(cfg, L + s.uncappedAfter + 1n), null);
    });
    test(`${s.name}: synthetic buys at each boundary are allowed exactly up to the cap (replay, per token account)`, () => {
      const pts: bigint[] = [];
      for (const st of s.steps) for (const d of [-1n, 0n, 1n]) if (st.slotOffset + d >= 0n) pts.push(st.slotOffset + d);
      for (const d of [-1n, 0n, 1n]) pts.push(s.uncappedAfter + d);
      let n = 0;
      for (const e of pts) {
        const exp = expectedBps(s, e); const cap = exp === null ? null : (SUPPLY * BigInt(exp)) / 10_000n;
        const amt = cap ?? SUPPLY / 2n; // at/after uncapped_after: a large buy must pass
        const mk = (acct: string, tokens: bigint, sig: string): Row => ({ slotOffset: Number(e), blockIndex: n++, label: 'X', owner: 'Owner' + acct, tokenAccount: acct, kind: 'buy', venue: 'dbc', tokensRaw: tokens, sig });
        const fx: Fixture = { name: 'b', file: '', crew: [], rows: [mk(`a${e}`, amt, `t${e}a`), mk(`b${e}`, amt + 1n, `t${e}b`)] };
        const r = replay(fx, s);
        if (cap === null) { assert.deepEqual(r.map(x => x.outcome), ['uncapped-schedule', 'uncapped-schedule'], `elapsed ${e}`); }
        else { assert.deepEqual(r.map(x => x.outcome), ['allowed', 'blocked'], `elapsed ${e}`); assert.equal(r[0].cap, cap); }
      }
    });
  }
});

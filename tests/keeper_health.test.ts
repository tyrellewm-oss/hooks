// Keeper monitoring (G7 detection): the pure health rules in sdk/keeper_health.ts. No chain, no files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keeperHealth, runFailed, DEFAULT_HEALTH, type HealthInput } from '../sdk/keeper_health.ts';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const run = (minAgo: number, status = 'logged', reason = '') => ({ runId: `r${minAgo}`, startedAt: at(minAgo), status, reason });
const base = (over: Partial<HealthInput> = {}): HealthInput => ({ name: 'devnet-tdt', mint: 'M'.repeat(32), state: 'ready', paused: false, pauseReason: '', runs: [run(5), run(10), run(15)], ...over });

test('healthy: recent successful runs, not paused', () => {
  const h = keeperHealth(base(), NOW);
  assert.deepEqual([h.healthy, h.problems, h.minutesSinceLastRun, h.consecutiveFailures], [true, [], 5, 0]);
});

test('stale: newest run older than the limit, boundary exact = still fine', () => {
  assert.equal(keeperHealth(base({ runs: [run(DEFAULT_HEALTH.maxAgeMin)] }), NOW).healthy, true, 'exactly at the limit is fine');
  const h = keeperHealth(base({ runs: [run(DEFAULT_HEALTH.maxAgeMin + 1)] }), NOW);
  assert.equal(h.healthy, false);
  assert.match(h.problems[0], /stale: newest run started 21 min ago/);
});

test('consecutive failures: newest backwards, reset by a success; unknown statuses count as failed', () => {
  assert.equal(runFailed('logged'), false);
  assert.equal(runFailed('failed_price'), true);
  assert.equal(runFailed('something_new'), true, 'a new status can never read as healthy');
  const ok = keeperHealth(base({ runs: [run(1, 'failed_price', 'spot vs avg'), run(2, 'failed_price'), run(3), run(4, 'failed_price')] }), NOW);
  assert.deepEqual([ok.healthy, ok.consecutiveFailures], [true, 2], 'a success resets the streak');
  const bad = keeperHealth(base({ runs: [run(1, 'failed_price', 'spot vs avg'), run(2, 'failed_swap'), run(3, 'failed_price')] }), NOW);
  assert.equal(bad.healthy, false);
  assert.match(bad.problems[0], /3 failed runs in a row \(newest: failed_price - spot vs avg\)/);
});

test('paused, no runs, unreadable time: each is its own problem', () => {
  const p = keeperHealth(base({ paused: true, pauseReason: 'R4 stop rule' }), NOW);
  assert.deepEqual([p.healthy, p.problems[0], p.paused], [false, 'paused: R4 stop rule', true]);
  const n = keeperHealth(base({ runs: [] }), NOW);
  assert.deepEqual([n.healthy, n.problems, n.lastRunAt], [false, ['no runs recorded'], null]);
  const u = keeperHealth(base({ runs: [{ runId: 'x', startedAt: 'not-a-date', status: 'logged', reason: '' }] }), NOW);
  assert.equal(u.healthy, false);
  assert.match(u.problems[0], /no readable start time/);
});

test('thresholds must be sane; the watcher is read-only (no keys, no chain, webhook only from env over https)', () => {
  assert.throws(() => keeperHealth(base(), NOW, { maxAgeMin: 0, maxConsecutiveFailures: 3 }));
  const w = readFileSync('scripts/keeper_watch.ts', 'utf8');
  assert.doesNotMatch(w, /loadOrCreate|Keypair|sendTransaction|Connection\(/, 'the watcher never touches keys or the chain');
  assert.match(w, /KEEPER_ALERT_WEBHOOK/, 'alert destination comes from the env');
  assert.match(w, /startsWith\('https:\/\/'\)/, 'webhook must be https');
  assert.match(w, /loadPublicKeepers\(cluster, registered\)/, 'same registry-gated loader as the transparency page');
});

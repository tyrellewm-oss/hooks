// Transparency page data (app/flywheel_public.ts) against the committed devnet keeper logs, and the /api/flywheel
// route's registry gate (app/site_registry.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPublicKeepers, shapeKeeperLog } from '../app/flywheel_public.ts';
import { siteRoute } from '../app/site_registry.ts';

const TDT = '3Ut8PuPt3G21GBth84SdqjWxMAoSp5yjSfQFKM9aMmtE';
const ALL = new Set([TDT, '7bRdzRKq5GUw4y5K9gmYu1ECrg5jWYapKhykrQ3mkz8W', '89BfATjv5WEP3Jrdd3ZndkvACY4zo8XAVhW6ZXM45KmD']);

test('committed devnet logs: totals, burns and run links match the raw log', () => {
  const raw = JSON.parse(readFileSync('flywheel/devnet-tdt.json', 'utf8'));
  const k = loadPublicKeepers('devnet', ALL).keepers.find((x) => x.mint === TDT)!;
  assert.ok(k, 'tdt keeper present');
  assert.equal(k.claimedSol, raw.claimedSol); assert.equal(k.devSol, raw.devSol); assert.equal(k.spentSol, raw.spentSol);
  assert.equal(k.burnedTokens, raw.burnedTokens); assert.equal(k.pctOfSupply, raw.pctOfSupply);
  assert.equal(k.burns.length, raw.burns.length);
  assert.equal(k.burns[0].sig, raw.burns[raw.burns.length - 1].sig, 'newest burn first');
  for (const b of k.burns) assert.match(b.link, /^https:\/\/explorer\.solana\.com\/tx\/\w+\?cluster=devnet$/);
  const full = k.runs.find((r) => r.links.length === 4)!;
  assert.deepEqual(full.links.map((l) => l.what), ['claim (damm_v2)', 'dev payout (15%)', 'buyback swap', 'burn']);
  const rawRun = raw.runs.find((r: any) => r.run_id === full.runId);
  assert.equal(full.links[3].sig, rawRun.burn.sig); assert.equal(full.links[1].sig, rawRun.dev_sig); assert.equal(full.links[2].sig, rawRun.swap.sig);
  assert.ok(k.runs.length <= 30, 'capped'); assert.ok(Date.parse(k.runs[0].startedAt) >= Date.parse(k.runs[k.runs.length - 1].startedAt), 'newest run first');
  // the dev share really is ~15% of claimed in the public log
  assert.ok(Math.abs(Number(k.devSol) / Number(k.claimedSol) - 0.15) < 0.001);
});

test('registry gate: only registered mints, other clusters ignored, unreadable files reported', () => {
  assert.deepEqual(loadPublicKeepers('devnet', new Set([TDT])).keepers.map((k) => k.mint), [TDT]);
  assert.deepEqual(loadPublicKeepers('devnet', new Set()).keepers, []);
  assert.deepEqual(loadPublicKeepers('local', ALL).keepers, []);
  const d = mkdtempSync(join(tmpdir(), 'fw-'));
  copyFileSync('flywheel/devnet-tdt.json', join(d, 'devnet-tdt.json'));
  writeFileSync(join(d, 'devnet-broken.json'), '{ not json');
  writeFileSync(join(d, 'devnet-events.jsonl'), '{}');   // not a public log
  const r = loadPublicKeepers('devnet', ALL, d);
  assert.deepEqual(r.keepers.map((k) => k.name), ['devnet-tdt']); assert.deepEqual(r.skipped, ['devnet-broken.json']);
  assert.deepEqual(loadPublicKeepers('devnet', ALL, join(d, 'missing')), { keepers: [], skipped: [] });
});

test('shape tolerates partial logs (no runs, no burns, odd fields)', () => {
  const k = shapeKeeperLog('devnet-x', { mint: 'M', state: 'waiting_for_graduation', runs: [{ run_id: 'r', status: 'logged', claims: [{ source: 'dbc', claimed_lamports: 'x' }] }] }, 'devnet');
  assert.equal(k.burns.length, 0); assert.equal(k.runs[0].claimedLamports, '0'); assert.equal(k.claimedSol, '0'); assert.equal(k.paused, false);
});

test('/api/flywheel goes through siteRoute: one registry read, 503 when unreadable, GET only', async () => {
  let reads = 0; let got: ReadonlySet<string> | null = null;
  const deps: any = { cluster: 'devnet', load: () => { reads++; return new Set([TDT]); }, launches: () => [], meta: () => ({}), token: async () => ({}), trade: async () => ({ code: 200, body: 0 }),
    flywheel: (reg: ReadonlySet<string>) => { got = reg; return { ok: true }; } };
  assert.deepEqual(await siteRoute('/api/flywheel', 'GET', async () => ({}), deps), { code: 200, body: { ok: true } });
  assert.equal(reads, 1); assert.deepEqual([...got!], [TDT]);
  assert.equal(await siteRoute('/api/flywheel', 'POST', async () => ({}), deps), null);
  assert.equal((await siteRoute('/api/flywheel', 'GET', async () => ({}), { ...deps, load: () => { throw new Error('x'); } }))!.code, 503);
  assert.match(readFileSync('app/server.ts', 'utf8'), /flywheel: registered => \(\{ cluster: c\.label, \.\.\.loadPublicKeepers\(c\.name, registered\) \}\)/);
});

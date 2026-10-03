// Page copy v0d: every placeholder in Research's copy has a fill derived from the launch config; rendering the
// full copy with the default devnet config and with a non-default fee config leaves no raw {...}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { feeVars, poolFeeBps, MIGRATION_FEE_OPTION_BPS, MIGRATION_FEE_CUSTOMIZABLE } from '../app/public/format.js';
import { pageVars, explainVars, fill } from '../app/public/pagevars.js';
import { BALANCED } from '../sdk/schedules.js';
import { DEFAULT_LAUNCH_FEES, launchFeeConfig } from '../sdk/launch.js';

const COPY = JSON.parse(readFileSync('research/page_content.json', 'utf8'));
const NOT_RENDERED = new Set(['version', 'placeholders', 'error_code_notes']);
const strings = (v: any): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
const rendered = Object.entries(COPY).filter(([k]) => !NOT_RENDERED.has(k)).flatMap(([, v]) => strings(v));
const PH = /\{([A-Z_]+)\}/g;
const names = (ss: string[]) => [...new Set(ss.flatMap(s => [...s.matchAll(PH)].map(m => m[1])))].sort();

const META = { cluster: 'DEVNET', liftAuthority: 'AuthTestKey1111111111111111111111111111111', programId: 'FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz', commit: 'abc1234' };
const view = (feeConfig: any) => ({
  status: { slot: '1000', steps: BALANCED.steps.map(s => ({ slotOffset: s.slotOffset.toString(), maxBps: s.maxBps })), uncappedAfter: BALANCED.uncappedAfter.toString(), nextChange: { slot: '1150', bps: 200 } },
  launch: { symbol: 'TEST', mint: 'MintTest11111111111111111111111111111111111' }, balances: { alice: '5000000' }, switchHistory: [], feeConfig,
});
const TRADE = { capHit: { balance: '12000000', cap: '10000000' }, hookError: 'WalletCapExceeded', link: 'https://explorer.solana.com/tx/x?cluster=devnet' };
const vars = (fc: any) => { const v = view(fc); return { ...pageVars(META, v), ...explainVars(TRADE, v, 'alice') }; };
const renderAll = (fc: any) => rendered.map(s => fill(s, vars(fc))).join('\n');

test('SDK MigrationFeeOption order matches MIGRATION_FEE_OPTION_BPS', () => {
  const m: any = MigrationFeeOption;
  assert.deepEqual([m.FixedBps25, m.FixedBps30, m.FixedBps100, m.FixedBps200, m.FixedBps400, m.FixedBps600], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(MIGRATION_FEE_OPTION_BPS, [25, 30, 100, 200, 400, 600]);
  assert.equal(m.Customizable, MIGRATION_FEE_CUSTOMIZABLE);
});

test('poolFeeBps maps options; customizable needs bps; unknown throws', () => {
  assert.equal(poolFeeBps(0), 25); assert.equal(poolFeeBps(2), 100); assert.equal(poolFeeBps(5), 600);
  assert.equal(poolFeeBps(6, 150), 150);
  assert.throws(() => poolFeeBps(6)); assert.throws(() => poolFeeBps(7)); assert.throws(() => poolFeeBps(-1));
});

test('feeVars: missing config gives n/a, never a made-up number', () => {
  for (const v of Object.values(feeVars(null))) assert.equal(v, 'n/a');
  assert.equal(feeVars({ startBps: 5000 }).POOL_FEE, 'n/a');
});

test('every placeholder in page_content.json (rendered fields and placeholders dict) has a fill', () => {
  const v = vars(launchFeeConfig({}));
  const dictKeys = Object.keys(COPY.placeholders).map((k: string) => k.replace(/[{}]/g, ''));
  for (const n of new Set([...names(rendered), ...dictKeys])) assert.ok(n in v, `no fill for {${n}}`);
  for (const n of names(rendered)) assert.ok(dictKeys.includes(n), `{${n}} rendered but not documented in placeholders`);
});

test('default devnet config renders with no raw placeholders and the launch defaults', () => {
  const out = renderAll(launchFeeConfig({}));
  assert.doesNotMatch(out, /\{[A-Z_]+\}/);
  const f = feeVars(launchFeeConfig({}));
  assert.equal(f.SNIPER_FEE_START, `${DEFAULT_LAUNCH_FEES.feeStartBps / 100}%`);
  assert.equal(f.SNIPER_FEE_END, `${DEFAULT_LAUNCH_FEES.feeEndBps / 100}%`);
  assert.equal(f.POOL_FEE, '0.25%');
  assert.match(f.SNIPER_FEE_DURATION, /^~60 s \(approx\., 150 slots\)/);
  assert.match(f.FEE_SPLIT, /100%; creator share 0%/);
  for (const s of [f.SNIPER_FEE_START, f.SNIPER_FEE_END, f.POOL_FEE, f.FEE_SPLIT, f.SNIPER_FEE_DURATION]) assert.ok(out.includes(s), s);
  assert.ok(out.includes(vars(launchFeeConfig({})).CAP_RAMP));
});

test('non-default fee config renders the overridden values', () => {
  const fc = launchFeeConfig({ feeStartBps: 3000, feeEndBps: 200, feeDurationSlots: 300, migrationFeeOption: MigrationFeeOption.FixedBps100, creatorTradingFeePercentage: 20 });
  const out = renderAll(fc);
  assert.doesNotMatch(out, /\{[A-Z_]+\}/);
  const f = feeVars(fc);
  assert.deepEqual([f.SNIPER_FEE_START, f.SNIPER_FEE_END, f.POOL_FEE], ['30%', '2%', '1%']);
  assert.match(f.SNIPER_FEE_DURATION, /^~2 min \(approx\., 300 slots\)/);
  assert.match(f.FEE_SPLIT, /80%; creator share 20%/);
  for (const s of Object.values(f)) assert.ok(out.includes(s), s);
});

test('old placeholder names are gone from app code', () => {
  for (const f of readdirSync('app/public').filter(f => /\.(js|html)$/.test(f))) {
    const s = readFileSync(`app/public/${f}`, 'utf8');
    for (const old of ['CLIFF_FEE', 'BASE_FEE', 'FEE_PERIOD']) assert.ok(!s.includes(old), `${old} in app/public/${f}`);
  }
  assert.ok(!readFileSync('app/server.ts', 'utf8').match(/CLIFF_FEE|BASE_FEE|FEE_PERIOD/));
});

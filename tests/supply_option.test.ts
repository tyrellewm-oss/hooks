// percentageSupplyOnMigration: optional launch option (default 20 = unchanged behaviour), validated, threaded into
// the DBC config builder and the launch record, and rendered on the page as "% of supply sold on the curve".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchFeeConfig, curveConfigParams, resolvePercentageSupplyOnMigration, DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION,
  PERCENTAGE_SUPPLY_ON_MIGRATION_MIN, PERCENTAGE_SUPPLY_ON_MIGRATION_MAX } from '../sdk/launch.js';
import { supplySold, supplySoldText } from '../app/public/format.js';

test('default is 20 (unchanged): launch config records 20 and the page renders 80% sold', () => {
  assert.equal(DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION, 20);
  const f = launchFeeConfig({});
  assert.equal(f.percentageSupplyOnMigration, 20);
  assert.deepEqual(supplySold(f.percentageSupplyOnMigration), { soldPct: 80, migrationPct: 20 });
  assert.match(supplySoldText(f.percentageSupplyOnMigration), /^80% of supply sold on the curve; 20% goes to the DAMM v2 pool/);
});

test('override 30 renders 70% sold / 30% to the pool', () => {
  const f = launchFeeConfig({ percentageSupplyOnMigration: 30 });
  assert.equal(f.percentageSupplyOnMigration, 30);
  assert.match(supplySoldText(f.percentageSupplyOnMigration), /^70% of supply sold on the curve; 30% goes to the DAMM v2 pool/);
});

test('builder: default and override reach buildCurve and produce different curves', () => {
  const d: any = curveConfigParams({}); const o: any = curveConfigParams({ percentageSupplyOnMigration: 30 });
  assert.equal(d.sqrtStartPrice.toString(), (curveConfigParams({ percentageSupplyOnMigration: 20 }) as any).sqrtStartPrice.toString(), 'default == explicit 20');
  assert.notEqual(d.sqrtStartPrice.toString(), o.sqrtStartPrice.toString());
});

test('validation: integer within DBC-builder range; bad values throw before any tx', () => {
  assert.equal(resolvePercentageSupplyOnMigration(undefined), 20);
  assert.equal(resolvePercentageSupplyOnMigration(null), 20);
  for (const bad of [0, -1, 20.5, 50, 99, 100, '30', NaN]) assert.throws(() => resolvePercentageSupplyOnMigration(bad), RangeError, String(bad));
  assert.throws(() => launchFeeConfig({ percentageSupplyOnMigration: 50 }), RangeError);
  // the accepted bounds really build with our config (50+ throws inside the SDK, hence MAX = 49)
  for (const p of [PERCENTAGE_SUPPLY_ON_MIGRATION_MIN, PERCENTAGE_SUPPLY_ON_MIGRATION_MAX]) assert.doesNotThrow(() => curveConfigParams({ percentageSupplyOnMigration: p }), String(p));
});

test('missing value renders n/a; page and server use the option', () => {
  assert.equal(supplySoldText(undefined), 'n/a');
  assert.match(readFileSync('app/public/app.js', 'utf8'), /supplySoldText\(view\.feeConfig\?\.percentageSupplyOnMigration\)/);
  const srv = readFileSync('app/server.ts', 'utf8');
  assert.match(srv, /resolvePercentageSupplyOnMigration\(b\.percentageSupplyOnMigration\)/);
  assert.doesNotMatch(readFileSync('sdk/launch.ts', 'utf8'), /percentageSupplyOnMigration: 20\b/);
});

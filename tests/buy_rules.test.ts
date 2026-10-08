// sdk/buy_rules.ts: the launch form's optional hooks -> the program's RulesArgs (raw token amounts), with the program's
// own limits (validate_rules) checked first; and the server wiring (parseLaunchBody, both launch routes, token view).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBuyRules, buyRulesBps, rulesUnsupportedHint, BuyRulesRefusal, LAUNCH_SUPPLY_RAW, POT_EVERY_MIN, POT_EVERY_MAX, RULES_WINDOW_MAX, COOLDOWN_MAX } from '../sdk/buy_rules.ts';

test('all off (absent, null, zeros) -> null: the launch keeps the v1 hook config', () => {
  assert.equal(parseBuyRules(undefined), null);
  assert.equal(parseBuyRules(null), null);
  assert.equal(parseBuyRules({}), null);
  assert.equal(parseBuyRules({ maxBuyBps: 0, maxPerSlotBps: null, potEvery: 0, windowSlots: 1500 }), null);
  assert.equal(parseBuyRules({ cooldownSlots: 0 }), null);
});

test('bps of supply -> raw tokens (1e9 tokens x 1e6)', () => {
  const r = parseBuyRules({ maxBuyBps: 50, maxPerSlotBps: 150, windowSlots: 1500, potEvery: 50, potMinBps: 1, cooldownSlots: 25 })!;
  assert.equal(LAUNCH_SUPPLY_RAW, 1_000_000_000_000_000n);
  assert.equal(r.maxBuyTokens, 5_000_000n * 1_000_000n);        // 0.5% = 5M tokens
  assert.equal(r.maxPerSlotTokens, 15_000_000n * 1_000_000n);   // 1.5%
  assert.equal(r.windowSlots, 1500n);
  assert.equal(r.potEvery, 50);
  assert.equal(r.potMinTokens, 100_000n * 1_000_000n);          // 0.01%
  assert.equal(r.cooldownSlots, 25n);
  assert.deepEqual(buyRulesBps(r), { maxBuyBps: 50, maxPerSlotBps: 150, windowSlots: '1500', potEvery: 50, potMinBps: 1, cooldownSlots: 25 });
});

test('each hook on its own', () => {
  assert.deepEqual(parseBuyRules({ maxBuyBps: 30 }), { maxBuyTokens: LAUNCH_SUPPLY_RAW * 30n / 10_000n, maxPerSlotTokens: 0n, windowSlots: 0n, potEvery: 0, potMinTokens: 0n, cooldownSlots: 0n });
  // slow mode alone is a valid rule set
  assert.deepEqual(parseBuyRules({ cooldownSlots: COOLDOWN_MAX, windowSlots: 1500 }), { maxBuyTokens: 0n, maxPerSlotTokens: 0n, windowSlots: 1500n, potEvery: 0, potMinTokens: 0n, cooldownSlots: BigInt(COOLDOWN_MAX) });
  assert.equal(parseBuyRules({ maxPerSlotBps: 100, windowSlots: '150' })!.windowSlots, 150n);
  const pot = parseBuyRules({ potEvery: POT_EVERY_MIN })!;
  assert.equal(pot.potEvery, 10); assert.equal(pot.maxBuyTokens, 0n); assert.equal(pot.potMinTokens, 0n);
  // pot min only counts when the pot is on
  assert.equal(parseBuyRules({ maxBuyBps: 10, potMinBps: 5 })!.potMinTokens, 0n);
});

test('the program limits are refused before any tx (validate_rules mirror)', () => {
  for (const bad of [
    { potEvery: POT_EVERY_MIN - 1 }, { potEvery: POT_EVERY_MAX + 1 }, { potEvery: 12.5 }, { potEvery: '50' },
    { maxBuyBps: 10_001 }, { maxBuyBps: -1 }, { maxBuyBps: 0.5 }, { maxPerSlotBps: 'x' },
    { maxBuyBps: 10, windowSlots: RULES_WINDOW_MAX + 1 }, { maxBuyBps: 10, windowSlots: -1 }, { maxBuyBps: 10, windowSlots: 'soon' },
    { maxBuyBps: 100, maxPerSlotBps: 50 },   // per-slot below one buy would make the max buy meaningless
    { cooldownSlots: COOLDOWN_MAX + 1 }, { cooldownSlots: -1 }, { cooldownSlots: 2.5 }, { cooldownSlots: '10' },
    [], 'rules',
  ]) assert.throws(() => parseBuyRules(bad), BuyRulesRefusal, JSON.stringify(bad));
  assert.ok(parseBuyRules({ maxBuyBps: 10, windowSlots: RULES_WINDOW_MAX }));
  assert.ok(parseBuyRules({ potEvery: POT_EVERY_MAX }));
});

test('an old hook program (no v2 instruction) gets a plain explanation', () => {
  assert.match(rulesUnsupportedHint('refusing: create-pool simulation failed: {"InstructionError":[2,{"Custom":101}]}')!, /program upgrade/);
  assert.equal(rulesUnsupportedHint('refusing: create-pool simulation failed: {"InstructionError":[2,{"Custom":6001}]}'), null);
});

test('server: rules parsed in parseLaunchBody (both launch routes), hint on an old program, rules in the token view', () => {
  const src = readFileSync('app/server.ts', 'utf8');
  const start = src.indexOf('function parseLaunchBody');
  const parse = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(parse, /rules = parseBuyRules\(b\.rules\)/);
  assert.match(parse, /\.\.\.\(rules \? \{ rules \} : \{\}\)/);
  for (const route of ['/api/create', '/api/studio/launch/build']) {
    const r = src.slice(src.indexOf(`url.pathname === '${route}'`)).slice(0, 1600);
    assert.match(r, /rulesUnsupportedHint\(/, route);
  }
  // read alongside the token's other chain reads, returned in the view
  assert.match(src, /lp\.status\(mint\),[\s\S]{0,200}rulesView\(mint\),\s*\]\);/);
  assert.match(src, /return \{ status: st, launch(: rec)?, rules, /);   // launch: the record, or built from the chain for a launch found there
});

test('creator lock: whole percents 1-10 with a duration; bad values are CreatorLockRefusal, off is null', async () => {
  const { resolveCreatorLock, CreatorLockRefusal, curveConfigParams, CREATOR_LOCK_PCT_MAX, CREATOR_LOCK_SLOTS_MAX } = await import('../sdk/launch.ts');
  assert.equal(resolveCreatorLock({}), null);
  assert.equal(resolveCreatorLock({ creatorLockPct: 0 }), null);
  assert.deepEqual(resolveCreatorLock({ creatorLockPct: 5, creatorLockSlots: 216_000 }), { pct: 5, slots: 216_000 });
  for (const bad of [
    { creatorLockPct: CREATOR_LOCK_PCT_MAX + 1, creatorLockSlots: 10 }, { creatorLockPct: 0.5, creatorLockSlots: 10 }, { creatorLockPct: -1, creatorLockSlots: 10 },
    { creatorLockPct: 5 }, { creatorLockPct: 5, creatorLockSlots: 0 }, { creatorLockPct: 5, creatorLockSlots: CREATOR_LOCK_SLOTS_MAX + 1 }, { creatorLockPct: 5, creatorLockSlots: 1.5 },
    { creatorLockSlots: 216_000 },   // a duration without a percent is refused, never silently no lock
  ]) assert.throws(() => resolveCreatorLock(bad as any), CreatorLockRefusal, JSON.stringify(bad));
  // the DBC config carries the lock as all-at-cliff locked vesting of exactly pct% of supply, in slots after migration
  const p: any = curveConfigParams({ creatorLockPct: 5, creatorLockSlots: 216_000 });
  const lv = p.lockedVesting;
  const total = BigInt(lv.cliffUnlockAmount.toString()) + BigInt(lv.amountPerPeriod.toString()) * BigInt(lv.numberOfPeriod.toString());
  assert.equal(total, 50_000_000n * 1_000_000n, '5% of 1e9 supply at 6 decimals');
  assert.equal(lv.cliffDurationFromMigrationTime.toString(), '216000');
  // without a lock the vesting stays all-zero (isDefaultLockedVesting in the SDK)
  const none: any = curveConfigParams({});
  for (const k of ['amountPerPeriod', 'cliffDurationFromMigrationTime', 'frequency', 'numberOfPeriod', 'cliffUnlockAmount']) assert.equal(none.lockedVesting[k].toString(), '0', k);
});

test('server: creator lock parsed on both launch routes and recorded in the launch record', () => {
  const src = readFileSync('app/server.ts', 'utf8');
  const start = src.indexOf('function parseLaunchBody');
  const parse = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(parse, /lock = resolveCreatorLock\(b\)/);
  assert.match(parse, /creatorLockPct: lock\.pct, creatorLockSlots: lock\.slots/);
  const launch = readFileSync('sdk/launch.ts', 'utf8');
  assert.match(launch, /creatorLock: resolveCreatorLock\(o\), txs,/, 'server-signed launch record carries the lock');
  const user = readFileSync('sdk/launch_user.ts', 'utf8');
  assert.match(user, /creatorLock: resolveCreatorLock\(o\),/, 'wallet-signed launch record carries the lock');
});

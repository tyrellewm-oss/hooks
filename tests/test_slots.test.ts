// LOCAL ONLY: the `test-slots` build (target/deploy-test-slots) accepts a ramp of a few slots (AC-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { Env, TEST_SLOTS_SO } from './env.js';
import { decodeMintConfig } from '../sdk/hook.js';

const SUPPLY = 1_000_000_000n;
test('test-slots build: 5-slot ramp accepted, flagged in config, cap rises per slot', { skip: !existsSync(TEST_SLOTS_SO) && 'run scripts/build.sh first' }, () => {
  const env = new Env(TEST_SLOTS_SO);
  const launcher = Keypair.generate(), admin = Keypair.generate(); env.fund(launcher.publicKey); env.fund(admin.publicKey); assert.ok(env.initGlobalV2(admin, launcher).ok);   // 8.3: separate admin and launch keys
  const curve = Keypair.generate(); env.fund(curve.publicKey);
  const { mint, decimals } = env.createHookMint({ supply: SUPPLY, holderOwner: curve.publicKey });
  const r = env.send([env.hook.initializeExtraAccountMetaList({ payer: env.payer.publicKey, authority: launcher.publicKey, mint,
    steps: [{ slotOffset: 0n, maxBps: 100 }, { slotOffset: 2n, maxBps: 200 }], uncappedAfter: 5n, supplyRef: SUPPLY })], [env.payer, launcher]);
  assert.ok(r.ok, r.logs.join('\n'));
  const cfg = decodeMintConfig(env.accountData(env.hook.configPda(mint))!);
  assert.equal(cfg.testSlotsBuild, true);
  const w = Keypair.generate(); env.fund(w.publicKey);
  assert.ok(env.transfer(mint, decimals, curve, w.publicKey, SUPPLY / 100n).ok);
  assert.equal(env.transfer(mint, decimals, curve, w.publicKey, 1n).hookError, 'WalletCapExceeded');
  env.warp(cfg.launchSlot + 2n); assert.ok(env.transfer(mint, decimals, curve, w.publicKey, SUPPLY / 100n).ok);
  env.warp(cfg.launchSlot + 5n); assert.ok(env.transfer(mint, decimals, curve, w.publicKey, SUPPLY / 10n).ok);
  const v = env.send([env.hook.viewSchedule(mint)], [env.payer], true);
  assert.ok(v.logs.some(l => l.includes('test_slots_build=true')));
  assert.ok(v.logs.some(l => l.includes('build: profile=TEST-SLOTS(local only) min_step_slots=1 min_ramp_slots=2')));
});

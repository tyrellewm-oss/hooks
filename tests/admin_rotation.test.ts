// Ticket 8.3b: rotate_admin replaces Global bytes 8..40 only. LOCAL (litesvm), release build (test-slots OFF).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Env } from './env.js';
import { GLOBAL_V1_LEN, GLOBAL_V2_LEN, decodeGlobal, decodeMintConfig } from '../sdk/hook.js';

const SUPPLY = 1_000_000_000_000_000n;
const STEPS = [{ slotOffset: 0n, maxBps: 100 }, { slotOffset: 150n, maxBps: 200 }];
const UNCAPPED = 1500n;

const key = () => Keypair.generate();
function world() {
  const env = new Env();
  const admin = key(), launch = key(); env.fund(admin.publicKey); env.fund(launch.publicKey);
  assert.ok(env.initGlobal(admin.publicKey).ok);
  const m = env.migrateGlobal(admin, launch.publicKey); assert.ok(m.ok, m.logs.join('\n'));
  const G = env.hook.globalPda();
  const bytes = () => env.accountData(G)!;
  const holder = key(); env.fund(holder.publicKey);
  const newMint = () => env.createHookMint({ supply: SUPPLY, holderOwner: holder.publicKey });
  const launchWith = (signer: Keypair, mint = newMint().mint) => ({ mint, r: env.send([env.hook.initializeExtraAccountMetaList({
    payer: env.payer.publicKey, authority: signer.publicKey, mint, steps: STEPS, uncappedAfter: UNCAPPED, supplyRef: SUPPLY })], [env.payer, signer]) });
  const rotateAdmin = (signer: Keypair, next: PublicKey, global = G) => {
    const ix = env.hook.rotateAdmin(signer.publicKey, next);
    if (!global.equals(G)) ix.keys[1] = { ...ix.keys[1], pubkey: global };
    return env.send([ix], [signer]);
  };
  return { env, admin, launch, G, bytes, holder, newMint, launchWith, rotateAdmin };
}
const fails = (r: { ok: boolean; hookError: string | null; logs: string[] }, name: string) => {
  assert.equal(r.ok, false, `expected ${name}`);
  assert.equal(r.hookError, name, r.logs.join('\n'));
};

test('AC-1 wrong signer: the launch key and a random key are Unauthorized and all 74 bytes stay', () => {
  const w = world(); const before = w.bytes(); const next = key().publicKey;
  for (const signer of [w.launch, key()]) { w.env.fund(signer.publicKey); fails(w.rotateAdmin(signer, next), 'Unauthorized'); }
  assert.deepEqual(w.bytes(), before);
});

test('AC-2 the new admin cannot be the launch key, the zero key, or the current admin', () => {
  const w = world(); const before = w.bytes();
  fails(w.rotateAdmin(w.admin, w.launch.publicKey), 'ConfigFrozen');
  fails(w.rotateAdmin(w.admin, PublicKey.default), 'ConfigFrozen');
  fails(w.rotateAdmin(w.admin, w.admin.publicKey), 'ConfigFrozen');
  assert.deepEqual(w.bytes(), before);
});

test('AC-7 a legal rotate changes bytes 8..40 only, with the cap lifted and not lifted', () => {
  for (const lifted of [false, true]) {
    const w = world();
    if (lifted) assert.ok(w.env.send([w.env.hook.liftGlobal(w.admin.publicKey)], [w.admin]).ok);
    const before = w.bytes(); assert.equal(before[40], lifted ? 1 : 0);
    const next = key(); w.env.fund(next.publicKey);
    assert.ok(w.rotateAdmin(w.admin, next.publicKey).ok);
    const after = w.bytes();
    assert.equal(after.length, GLOBAL_V2_LEN);
    assert.deepEqual(after.subarray(0, 8), before.subarray(0, 8));
    assert.deepEqual(after.subarray(8, 40), next.publicKey.toBuffer());
    assert.deepEqual(after.subarray(40), before.subarray(40));
    assert.ok(decodeGlobal(after).authority.equals(next.publicKey));
    assert.ok(decodeGlobal(after).launchAuthority!.equals(w.launch.publicKey));
  }
});

test('AC-5 a 42-byte Global refuses with ConfigFrozen', () => {
  const w = world();
  const short = w.bytes().subarray(0, GLOBAL_V1_LEN);
  w.env.setAccountData(w.G, Buffer.from(short));
  fails(w.rotateAdmin(w.admin, key().publicKey), 'ConfigFrozen');
  assert.equal(w.bytes().length, GLOBAL_V1_LEN);
});

test('AC-6 a 74-byte Global with an all-zero launch tail refuses with ConfigFrozen', () => {
  const w = world();
  const forged = Buffer.concat([w.bytes().subarray(0, GLOBAL_V1_LEN), Buffer.alloc(32)]);
  w.env.setAccountData(w.G, forged);
  fails(w.rotateAdmin(w.admin, key().publicKey), 'ConfigFrozen');
  assert.deepEqual(w.bytes().subarray(GLOBAL_V1_LEN), Buffer.alloc(32));
});

test('AC-8 after rotate the old admin fails lift, raise, set_launch_authority and rotate_admin; the new admin can lift and rotate again', () => {
  const w = world(); const next = key(); w.env.fund(next.publicKey);
  const { mint } = w.launchWith(w.launch);
  assert.ok(w.rotateAdmin(w.admin, next.publicKey).ok);
  const other = key().publicKey;
  fails(w.env.send([w.env.hook.liftGlobal(w.admin.publicKey)], [w.admin]), 'Unauthorized');
  fails(w.env.send([w.env.hook.liftMintCap(w.admin.publicKey, mint)], [w.admin]), 'Unauthorized');
  fails(w.env.send([w.env.hook.raiseMintCap(w.admin.publicKey, mint, 500)], [w.admin]), 'Unauthorized');
  fails(w.env.send([w.env.hook.setLaunchAuthority(w.admin.publicKey, other)], [w.admin]), 'Unauthorized');
  fails(w.rotateAdmin(w.admin, other), 'Unauthorized');
  for (const ix of [
    w.env.hook.liftGlobal(w.launch.publicKey),
    w.env.hook.setLaunchAuthority(w.launch.publicKey, other),
  ]) fails(w.env.send([ix], [w.launch]), 'Unauthorized');
  fails(w.rotateAdmin(w.launch, other), 'Unauthorized');
  assert.ok(w.env.send([w.env.hook.liftGlobal(next.publicKey)], [next]).ok);
  const third = key(); w.env.fund(third.publicKey);
  assert.ok(w.rotateAdmin(next, third.publicKey).ok);
  assert.deepEqual(w.bytes().subarray(8, 40), third.publicKey.toBuffer());
});

test('AC-9 transfers and view_schedule work before the rotate, after it, and after the new admin lifts', () => {
  const w = world();
  const { mint, r } = w.launchWith(w.launch); assert.ok(r.ok, r.logs.join('\n'));
  const tail = () => w.bytes().subarray(GLOBAL_V1_LEN);
  const beforeTail = Buffer.from(tail());
  const check = () => {
    const to = key(); w.env.fund(to.publicKey);
    assert.ok(w.env.transfer(mint, 6, w.holder, to.publicKey, 10n).ok);
    assert.ok(w.env.send([w.env.hook.viewSchedule(mint)], [w.env.payer], true).ok);
  };
  check();
  const next = key(); w.env.fund(next.publicKey);
  assert.ok(w.rotateAdmin(w.admin, next.publicKey).ok);
  assert.deepEqual(tail(), beforeTail);
  check();
  assert.ok(w.env.send([w.env.hook.liftGlobal(next.publicKey)], [next]).ok);
  assert.deepEqual(tail(), beforeTail);
  check();
});

test('AC-10 a mint launched before the rotate keeps its launcher; a later launch still records the launch key', () => {
  const w = world();
  const first = w.launchWith(w.launch); assert.ok(first.r.ok);
  const next = key(); w.env.fund(next.publicKey);
  assert.ok(w.rotateAdmin(w.admin, next.publicKey).ok);
  const cfg = decodeMintConfig(w.env.accountData(w.env.hook.configPda(first.mint))!);
  assert.ok(cfg.launcher.equals(w.launch.publicKey));
  const second = w.launchWith(w.launch); assert.ok(second.r.ok);
  const cfg2 = decodeMintConfig(w.env.accountData(w.env.hook.configPda(second.mint))!);
  assert.ok(cfg2.launcher.equals(w.launch.publicKey));
});

test('AC-11 a non-canonical account, a wrong owner, and a wrong discriminator are Unauthorized', () => {
  const w = world(); const orig = Buffer.from(w.bytes()); const next = key().publicKey;
  const fake = key().publicKey; w.env.setAccountData(fake, orig);
  fails(w.rotateAdmin(w.admin, next, fake), 'Unauthorized');
  w.env.setAccountData(w.G, orig, key().publicKey);
  fails(w.rotateAdmin(w.admin, next), 'Unauthorized');
  const bad = Buffer.from(orig); bad[0] ^= 0xff; w.env.setAccountData(w.G, bad);
  fails(w.rotateAdmin(w.admin, next), 'Unauthorized');
  assert.equal(w.env.accountData(fake)!.length, GLOBAL_V2_LEN);
});

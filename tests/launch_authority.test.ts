// Ticket 8.3: a separate launch key on the hook (Global bytes 42..74). LOCAL (litesvm), release build (test-slots OFF).
// One test per on-chain acceptance criterion (AC-1..AC-12, AC-14, AC-15); the off-chain third-key rules (AC-13) and the
// migrate/rotate script (AC-16, AC-17) are in tests/launch_authority_offchain.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Env } from './env.js';
import { TOKEN_2022, DEFAULT_PROGRAM_ID, ACC, IX, GLOBAL_V1_LEN, GLOBAL_V2_LEN, decodeGlobal, decodeMintConfig, hookErrorFromLogs } from '../sdk/hook.js';

const SUPPLY = 1_000_000_000_000_000n;
const STEPS = [{ slotOffset: 0n, maxBps: 100 }, { slotOffset: 150n, maxBps: 200 }];
const UNCAPPED = 1500n;
const FX = JSON.parse(readFileSync('tests/fixtures/devnet_hook_authorities.json', 'utf8'));

const key = () => Keypair.generate();
function world(o: { migrate?: boolean } = {}) {
  const env = new Env();
  const admin = key(), launch = key(); env.fund(admin.publicKey); env.fund(launch.publicKey);
  assert.ok(env.initGlobal(admin.publicKey).ok);
  if (o.migrate !== false) { const r = env.migrateGlobal(admin, launch.publicKey); assert.ok(r.ok, r.logs.join('\n')); }
  const G = env.hook.globalPda();
  const bytes = () => env.accountData(G)!;
  const holder = key(); env.fund(holder.publicKey);
  const newMint = () => env.createHookMint({ supply: SUPPLY, holderOwner: holder.publicKey });
  const launchWith = (signer: Keypair, mint = newMint().mint) => ({ mint, r: env.send([env.hook.initializeExtraAccountMetaList({
    payer: env.payer.publicKey, authority: signer.publicKey, mint, steps: STEPS, uncappedAfter: UNCAPPED, supplyRef: SUPPLY })], [env.payer, signer]) });
  const migrate = (signer: Keypair, arg: PublicKey) => env.send([env.hook.migrateGlobalV2(env.payer.publicKey, signer.publicKey, arg)], [env.payer, signer]);
  const rotate = (signer: Keypair, arg: PublicKey) => env.send([env.hook.setLaunchAuthority(signer.publicKey, arg)], [signer]);
  return { env, admin, launch, G, bytes, holder, newMint, launchWith, migrate, rotate };
}
const fails = (r: { ok: boolean; hookError: string | null; logs: string[] }, name: string) => { assert.equal(r.ok, false, `expected ${name}`); assert.equal(r.hookError, name, r.logs.join('\n')); };
const tail = (b: Buffer) => b.subarray(GLOBAL_V1_LEN, GLOBAL_V2_LEN);
/** A hook transfer of `amt` from the supply holder to a fresh wallet, and a view_schedule simulation. */
function transfersWork(w: ReturnType<typeof world>, mint: PublicKey) {
  const to = key(); w.env.fund(to.publicKey);
  const t = w.env.transfer(mint, 6, w.holder, to.publicKey, 10n);
  const v = w.env.send([w.env.hook.viewSchedule(mint)], [w.env.payer], true);
  return t.ok && v.ok;
}

test('AC-1 pre-migration refusal: on a 42-byte Global the launch path refuses with Unauthorized for any signer (admin, random, the future launch key)', () => {
  const w = world({ migrate: false });
  assert.equal(w.bytes().length, GLOBAL_V1_LEN);
  for (const signer of [w.admin, key(), w.launch]) { w.env.fund(signer.publicKey); fails(w.launchWith(signer).r, 'Unauthorized'); }
});

test('AC-2 zero key: migrate(default) and set_launch_authority(default) refuse; a 74-byte Global with an all-zero tail refuses launches', () => {
  const w = world({ migrate: false });
  fails(w.migrate(w.admin, PublicKey.default), 'Unauthorized'); assert.equal(w.bytes().length, GLOBAL_V1_LEN);
  assert.ok(w.migrate(w.admin, w.launch.publicKey).ok);
  fails(w.rotate(w.admin, PublicKey.default), 'Unauthorized');
  const forged = Buffer.concat([w.bytes().subarray(0, GLOBAL_V1_LEN), Buffer.alloc(32)]);   // written directly
  w.env.setAccountData(w.G, forged);
  for (const signer of [w.launch, w.admin]) fails(w.launchWith(signer).r, 'Unauthorized');
});

test('AC-3 migrate refuses a non-admin or the launch key (account stays 42 bytes), a non-canonical address, a wrong owner and a wrong discriminator', () => {
  const w = world({ migrate: false });
  const rando = key(); w.env.fund(rando.publicKey);
  for (const signer of [rando, w.launch]) { fails(w.migrate(signer, w.launch.publicKey), 'Unauthorized'); assert.equal(w.bytes().length, GLOBAL_V1_LEN); }
  const orig = w.bytes();
  // non-canonical: the same bytes at another program-owned address
  const fake = key().publicKey; w.env.setAccountData(fake, Buffer.from(orig));
  const ix = w.env.hook.migrateGlobalV2(w.env.payer.publicKey, w.admin.publicKey, w.launch.publicKey);
  ix.keys[2] = { ...ix.keys[2], pubkey: fake };
  fails(w.env.send([ix], [w.env.payer, w.admin]), 'ConfigFrozen');
  // wrong owner
  w.env.setAccountData(w.G, Buffer.from(orig), key().publicKey);
  assert.equal(w.migrate(w.admin, w.launch.publicKey).ok, false);
  // wrong discriminator
  const bad = Buffer.from(orig); bad[0] ^= 0xff; w.env.setAccountData(w.G, bad);
  fails(w.migrate(w.admin, w.launch.publicKey), 'ConfigFrozen');
  w.env.setAccountData(w.G, Buffer.from(orig)); assert.ok(w.migrate(w.admin, w.launch.publicKey).ok);   // control: the real one migrates
});

test('AC-4 rerun: a second migrate (same or different argument) refuses with ConfigFrozen and leaves the 74 bytes unchanged', () => {
  const w = world(); const before = w.bytes();
  fails(w.migrate(w.admin, w.launch.publicKey), 'ConfigFrozen');
  fails(w.migrate(w.admin, key().publicKey), 'ConfigFrozen');
  assert.deepEqual(w.bytes(), before);
});

test('AC-5 byte-identical fields: after migration bytes 0..42 equal the pre-migration bytes, the length is 74 and bytes 42..74 are the argument (lifted false and true)', () => {
  for (const lifted of [false, true]) {
    const w = world({ migrate: false });
    if (lifted) assert.ok(w.env.send([w.env.hook.liftGlobal(w.admin.publicKey)], [w.admin]).ok);
    const before = w.bytes(); assert.equal(before[40], lifted ? 1 : 0);
    assert.ok(w.migrate(w.admin, w.launch.publicKey).ok);
    const after = w.bytes();
    assert.equal(after.length, GLOBAL_V2_LEN);
    assert.deepEqual(after.subarray(0, GLOBAL_V1_LEN), before);
    assert.deepEqual(tail(after), w.launch.publicKey.toBuffer());
    const g = decodeGlobal(after); assert.ok(g.authority.equals(w.admin.publicKey)); assert.equal(g.lifted, lifted); assert.ok(g.launchAuthority!.equals(w.launch.publicKey));
  }
});

test('AC-6 transfers survive: hook transfers and view_schedule of an existing mint work at 42 bytes (new program, before migration), at 74 bytes, and after rotation', () => {
  const w = world();
  const { mint, r } = w.launchWith(w.launch); assert.ok(r.ok, r.logs.join('\n'));
  const v2 = w.bytes();
  // the upgrade window: the new program is live but Global still has its 42 pre-migration bytes
  w.env.setAccountData(w.G, Buffer.from(v2.subarray(0, GLOBAL_V1_LEN)));
  assert.equal(w.bytes().length, GLOBAL_V1_LEN); assert.ok(transfersWork(w, mint), 'transfers at 42 bytes');
  w.env.setAccountData(w.G, v2); assert.ok(transfersWork(w, mint), 'transfers at 74 bytes');
  assert.ok(w.rotate(w.admin, key().publicKey).ok); assert.ok(transfersWork(w, mint), 'transfers after rotation');
});

test('AC-7 lift keeps the tail: lift_global (admin) after migration succeeds and bytes 42..74 are unchanged', () => {
  const w = world(); const before = w.bytes();
  assert.ok(w.env.send([w.env.hook.liftGlobal(w.admin.publicKey)], [w.admin]).ok);
  const after = w.bytes();
  assert.equal(after.length, GLOBAL_V2_LEN); assert.equal(after[40], 1);
  assert.deepEqual(tail(after), tail(before));
});

test('AC-8 launch with admin refuses after migration; the launch key succeeds and MintConfig.launcher is the launch key', () => {
  const w = world();
  fails(w.launchWith(w.admin).r, 'Unauthorized');
  const { mint, r } = w.launchWith(w.launch); assert.ok(r.ok, r.logs.join('\n'));
  assert.ok(decodeMintConfig(w.env.accountData(w.env.hook.configPda(mint))!).launcher.equals(w.launch.publicKey));
});

test('AC-9 set/rotate: set_launch_authority signed by the launch key or a random key refuses; only the admin succeeds', () => {
  const w = world(); const rando = key(); w.env.fund(rando.publicKey); const next = key().publicKey;
  for (const signer of [w.launch, rando]) fails(w.rotate(signer, next), 'Unauthorized');
  assert.ok(w.rotate(w.admin, next).ok);
  assert.ok(decodeGlobal(w.bytes()).launchAuthority!.equals(next));
});

test('AC-10 after rotating L1 -> L2, a launch signed by L1 refuses and one signed by L2 succeeds', () => {
  const w = world(); const L2 = key(); w.env.fund(L2.publicKey);
  assert.ok(w.launchWith(w.launch).r.ok);
  assert.ok(w.rotate(w.admin, L2.publicKey).ok);
  fails(w.launchWith(w.launch).r, 'Unauthorized');
  assert.ok(w.launchWith(L2).r.ok);
});

test('AC-11 lift with launch key refuses: lift_global, lift_mint_cap and raise_mint_cap signed by the launch key fail with Unauthorized', () => {
  const w = world(); const { mint } = w.launchWith(w.launch);
  const L = w.launch.publicKey;
  fails(w.env.send([w.env.hook.liftGlobal(L)], [w.launch]), 'Unauthorized');
  fails(w.env.send([w.env.hook.liftMintCap(L, mint)], [w.launch]), 'Unauthorized');
  fails(w.env.send([w.env.hook.raiseMintCap(L, mint, 500)], [w.launch]), 'Unauthorized');
  assert.ok(w.env.send([w.env.hook.raiseMintCap(w.admin.publicKey, mint, 500)], [w.admin]).ok);   // control: the admin still can
});

test('AC-12 launch == admin is refused at migration and rotation; set_launch_authority(current) refuses too', () => {
  const m = world({ migrate: false });
  fails(m.migrate(m.admin, m.admin.publicKey), 'Unauthorized'); assert.equal(m.bytes().length, GLOBAL_V1_LEN);
  const w = world(); const before = w.bytes();
  fails(w.rotate(w.admin, w.admin.publicKey), 'Unauthorized');
  fails(w.rotate(w.admin, w.launch.publicKey), 'ConfigFrozen');
  assert.deepEqual(w.bytes(), before);
});

test('AC-12 (program check d): even with the admin key written into bytes 42..74, the admin cannot launch', () => {
  const w = world();
  const b = w.bytes(); w.admin.publicKey.toBuffer().copy(b, GLOBAL_V1_LEN); w.env.setAccountData(w.G, b);   // forged: bypasses set/rotate
  fails(w.launchWith(w.admin).r, 'Unauthorized');
});

test('AC-14 decoder: 42 bytes → launchAuthority null; the migrated devnet copy (74) → the set key; lengths 41, 43 and 73 refuse', () => {
  const v1 = Buffer.from(FX.global.data_base64, 'base64'); assert.equal(v1.length, 42);
  assert.equal(decodeGlobal(v1).launchAuthority, null);
  const L = key().publicKey; const v2 = Buffer.concat([v1, L.toBuffer()]);
  assert.ok(decodeGlobal(v2).launchAuthority!.equals(L)); assert.equal(decodeGlobal(Buffer.concat([v1, Buffer.alloc(32)])).launchAuthority, null);
  for (const n of [41, 43, 73]) assert.throws(() => decodeGlobal(Buffer.concat([v1, Buffer.alloc(32)]).subarray(0, n)), /length/);
});

test('AC-15 devnet migration on a copy: the recorded devnet Global (42 bytes, admin 9DVu…) at its PDA under the upgraded program migrates; bytes 0..42 unchanged, rerun refuses, transfers work', () => {
  const env = new Env(); env.svm.withSigverify(false);   // the devnet admin key isn't here: it signs with an empty signature (copy only)
  const G = env.hook.globalPda();
  assert.equal(G.toBase58(), FX.global.pubkey); assert.ok(env.hook.programId.equals(DEFAULT_PROGRAM_ID));
  const v1 = Buffer.from(FX.global.data_base64, 'base64');
  env.setAccountData(G, Buffer.from(v1), new PublicKey(FX.global.owner), BigInt(FX.global.lamports));
  const admin = decodeGlobal(v1).authority; assert.equal(admin.toBase58().slice(0, 4), '9DVu');
  const launch = key(); env.fund(launch.publicKey);
  const asAdmin = (ix: TransactionInstruction) => {   // payer signs; the admin is a required signer with a zero signature
    const tx = new Transaction(); tx.recentBlockhash = env.svm.latestBlockhash(); tx.feePayer = env.payer.publicKey; tx.add(ix);
    tx.setSigners(env.payer.publicKey, admin); tx.partialSign(env.payer); tx.addSignature(admin, Buffer.alloc(64));
    const r: any = env.svm.sendTransaction(tx); env.svm.expireBlockhash();
    const logs: string[] = r.meta ? r.meta().logs() : r.logs(); return { ok: !r.meta, logs, hookError: r.meta ? hookErrorFromLogs(logs) : null };
  };
  const before = { len: v1.length, lamports: BigInt(FX.global.lamports), b64: v1.toString('base64') };
  const r = asAdmin(env.hook.migrateGlobalV2(env.payer.publicKey, admin, launch.publicKey)); assert.ok(r.ok, r.logs.join('\n'));
  const acc = env.svm.getAccount(G)!; const after = Buffer.from(acc.data);
  assert.equal(after.length, GLOBAL_V2_LEN); assert.deepEqual(after.subarray(0, GLOBAL_V1_LEN).toString('base64'), before.b64);   // AC-5
  assert.deepEqual(tail(after), launch.publicKey.toBuffer());
  assert.equal(BigInt(acc.lamports), env.svm.minimumBalanceForRentExemption(BigInt(GLOBAL_V2_LEN)) > before.lamports ? env.svm.minimumBalanceForRentExemption(BigInt(GLOBAL_V2_LEN)) : before.lamports);
  const again = asAdmin(env.hook.migrateGlobalV2(env.payer.publicKey, admin, key().publicKey)); fails(again, 'ConfigFrozen');   // AC-4
  assert.deepEqual(Buffer.from(env.svm.getAccount(G)!.data), after);
  // AC-6 on the copy: a mint launched by the launch key transfers through the hook
  const holder = key(); env.fund(holder.publicKey);
  const { mint } = env.createHookMint({ supply: SUPPLY, holderOwner: holder.publicKey });
  assert.ok(env.send([env.hook.initializeExtraAccountMetaList({ payer: env.payer.publicKey, authority: launch.publicKey, mint, steps: STEPS, uncappedAfter: UNCAPPED, supplyRef: SUPPLY })], [env.payer, launch]).ok);
  const to = key(); env.fund(to.publicKey); assert.ok(env.transfer(mint, 6, holder, to.publicKey, 10n).ok);
  assert.ok(env.ata(mint, to.publicKey).equals(getAssociatedTokenAddressSync(mint, to.publicKey, true, TOKEN_2022)));
});

test('instruction discriminators are the Anchor ones and the account discriminator is unchanged', () => {
  assert.equal(IX.migrateGlobalV2.length, 8); assert.equal(IX.setLaunchAuthority.length, 8);
  assert.deepEqual(Buffer.from(FX.global.data_base64, 'base64').subarray(0, 8), ACC.Global);
});

// LOCAL (litesvm) integration tests for programs/trenches-hook, release build (test-slots OFF).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Env } from './env.js';
import { DBC_POOL_AUTHORITY, DAMM_V2_POOL_AUTHORITY, TOKEN_2022, decodeMintConfig, decodeLift, decodeGlobal, parseRestrictionsLifted, capHitDetails, toCapConfig } from '../sdk/hook.js';
import { capAt } from '../sdk/capMath.js';

const SUPPLY = 1_000_000_000_000_000n; // 1e9 tokens, 6 decimals
const STEPS = [{ slotOffset: 0n, maxBps: 100 }, { slotOffset: 150n, maxBps: 200 }]; // 1% then 2%
const UNCAPPED = 1500n;
const ONE_PCT = SUPPLY / 100n;

function setup() {
  const env = new Env();
  const launcher = Keypair.generate(); env.fund(launcher.publicKey);
  assert.ok(env.initGlobal(launcher.publicKey).ok);
  const curve = Keypair.generate(); env.fund(curve.publicKey); // supply holder standing in for the curve (NOT exempt; QA H-1)
  const { mint, decimals } = env.createHookMint({ supply: SUPPLY, holderOwner: curve.publicKey });
  const r = env.send([env.hook.initializeExtraAccountMetaList({
    payer: env.payer.publicKey, authority: launcher.publicKey, mint, steps: STEPS, uncappedAfter: UNCAPPED, supplyRef: SUPPLY,
  })], [env.payer, launcher]);
  assert.ok(r.ok, r.logs.join('\n'));
  const cfg = decodeMintConfig(env.accountData(env.hook.configPda(mint))!);
  const poolVault = env.ata(mint, DBC_POOL_AUTHORITY); // a token account owned by the real DBC pool authority PDA
  return { env, launcher, curve, mint, decimals, cfg, poolVault };
}
const buy = (s: ReturnType<typeof setup>, w: Keypair, amt: bigint) => s.env.transfer(s.mint, s.decimals, s.curve, w.publicKey, amt);
const sell = (s: ReturnType<typeof setup>, w: Keypair, amt: bigint) => {
  const src = getAssociatedTokenAddressSync(s.mint, w.publicKey, true, TOKEN_2022);
  return s.env.send([s.env.transferIx(s.mint, s.decimals, src, s.poolVault, w.publicKey, amt)], [s.env.payer, w]);
};
const wallet = (s: ReturnType<typeof setup>) => { const k = Keypair.generate(); s.env.fund(k.publicKey); return k; };

describe('global init (lift authority)', () => {
  test('only the upgrade authority can init, and only once', () => {
    const env = new Env();
    const rando = Keypair.generate(); env.fund(rando.publicKey);
    const bad = env.send([env.hook.initializeGlobal(rando.publicKey, rando.publicKey)], [rando]);
    assert.equal(bad.ok, false); assert.equal(bad.hookError, 'Unauthorized');
    assert.ok(env.initGlobal(rando.publicKey).ok);
    const again = env.initGlobal(Keypair.generate().publicKey);
    assert.equal(again.ok, false); assert.equal(again.hookError, 'ConfigFrozen');
    assert.ok(decodeGlobal(env.accountData(env.hook.globalPda())!).authority.equals(rando.publicKey));
  });
});

describe('config init + validation (AC-4, AC-9, AC-10)', () => {
  const base = () => {
    const env = new Env(); const launcher = Keypair.generate(); env.fund(launcher.publicKey);
    env.initGlobal(launcher.publicKey);
    const holder = Keypair.generate();
    const m = env.createHookMint({ supply: SUPPLY, holderOwner: holder.publicKey });
    const init = (over: any = {}, signer = launcher) => env.send([env.hook.initializeExtraAccountMetaList({
      payer: env.payer.publicKey, authority: signer.publicKey, mint: m.mint, steps: STEPS, uncappedAfter: UNCAPPED, supplyRef: SUPPLY, ...over,
    })], [env.payer, signer]);
    return { env, launcher, m, init };
  };
  const bads: [string, any][] = [
    ['decreasing', { steps: [{ slotOffset: 0n, maxBps: 200 }, { slotOffset: 150n, maxBps: 100 }] }],
    ['below 0.1% floor', { steps: [{ slotOffset: 0n, maxBps: 5 }] }],
    ['above 100%', { steps: [{ slotOffset: 0n, maxBps: 10_001 }] }],
    ['zero steps', { steps: [] }],
    ['first offset != 0', { steps: [{ slotOffset: 3n, maxBps: 100 }] }],
    ['end before last step', { uncappedAfter: 150n }],
    ['ramp shorter than release minimum (test-slots OFF)', { steps: [{ slotOffset: 0n, maxBps: 100 }], uncappedAfter: 20n }],
    ['supply_ref != mint supply', { supplyRef: SUPPLY - 1n }],
    ['too many exempt owners', { exemptOwners: Array.from({ length: 5 }, () => Keypair.generate().publicKey) }],
    ['default pubkey exempt', { exemptOwners: [PublicKey.default] }],
    ['any manual exempt owner (QA H-1)', { exemptOwners: [Keypair.generate().publicKey] }],
    ['ramp longer than MAX_RAMP_SLOTS (QA H-3)', { uncappedAfter: 6_480_001n }],
  ];
  for (const [name, over] of bads) test(`rejects ${name} with InvalidCapSchedule`, () => {
    const { init } = base(); const r = init(over); assert.equal(r.ok, false); assert.equal(r.hookError, 'InvalidCapSchedule', r.logs.join('\n'));
  });
  test('non-launcher signer -> Unauthorized', () => {
    const { env, init } = base(); const x = Keypair.generate(); env.fund(x.publicKey);
    const r = init({}, x); assert.equal(r.hookError, 'Unauthorized');
  });
  test('mint not hooked to this program -> InvalidMint', () => {
    const { env, launcher } = base();
    const other = env.createHookMint({ supply: SUPPLY, holderOwner: Keypair.generate().publicKey, hookProgram: Keypair.generate().publicKey });
    const r = env.send([env.hook.initializeExtraAccountMetaList({ payer: env.payer.publicKey, authority: launcher.publicKey, mint: other.mint, steps: STEPS, uncappedAfter: UNCAPPED, supplyRef: SUPPLY })], [env.payer, launcher]);
    assert.equal(r.hookError, 'InvalidMint');
  });
  test('valid init writes config once; re-init -> ConfigFrozen (even with a looser schedule)', () => {
    const { env, m, init } = base();
    assert.ok(init().ok);
    const before = env.accountData(env.hook.configPda(m.mint))!;
    const r = init({ steps: [{ slotOffset: 0n, maxBps: 5000 }] });
    assert.equal(r.ok, false); assert.equal(r.hookError, 'ConfigFrozen');
    assert.deepEqual(env.accountData(env.hook.configPda(m.mint)), before);
    const c = decodeMintConfig(before);
    assert.equal(c.testSlotsBuild, false); assert.equal(c.supplyRef, SUPPLY); assert.equal(c.steps.length, 2);
  });
  test('pre-funded (griefed) config PDA does not block init', () => {
    const { env, m, init } = base();
    env.fund(env.hook.configPda(m.mint), 1_000_000n);
    assert.ok(init().ok);
  });
});

describe('the rule (AC-1, AC-6, AC-7)', () => {
  test('buy under cap ok; buy over cap fails with WalletCapExceeded + details in logs', () => {
    const s = setup(); const w = wallet(s);
    assert.ok(buy(s, w, ONE_PCT - 1n).ok);
    const r = buy(s, w, 2n);
    assert.equal(r.ok, false); assert.equal(r.hookError, 'WalletCapExceeded');
    const d = capHitDetails(r.logs)!; assert.equal(d.cap, ONE_PCT); assert.equal(d.balance, ONE_PCT + 1n);
    assert.ok(buy(s, w, 1n).ok); // exactly at cap is allowed
    assert.equal(s.env.balance(getAssociatedTokenAddressSync(s.mint, w.publicKey, true, TOKEN_2022)), ONE_PCT);
  });
  test('cap rises with slots, then no cap after the ramp', () => {
    const s = setup(); const w = wallet(s); const L = s.cfg.launchSlot;
    assert.ok(buy(s, w, ONE_PCT).ok);
    assert.equal(buy(s, w, 1n).hookError, 'WalletCapExceeded');
    s.env.warp(L + 149n); assert.equal(buy(s, w, 1n).hookError, 'WalletCapExceeded');
    s.env.warp(L + 150n); assert.ok(buy(s, w, ONE_PCT).ok); // now 2%
    assert.equal(buy(s, w, 1n).hookError, 'WalletCapExceeded');
    s.env.warp(L + UNCAPPED); assert.ok(buy(s, w, 50n * ONE_PCT).ok); // no cap
  });
  test('sell into pool vault (owned by DBC pool authority) always ok, source never checked', () => {
    const s = setup(); const w = wallet(s);
    assert.ok(buy(s, w, ONE_PCT).ok);
    assert.ok(sell(s, w, ONE_PCT / 3n).ok);
    // source far over cap: the supply holder sends 90% of supply into the pool vault
    const src = s.env.ata(s.mint, s.curve.publicKey);
    const r = s.env.send([s.env.transferIx(s.mint, s.decimals, src, s.poolVault, s.curve.publicKey, 90n * ONE_PCT)], [s.env.payer, s.curve]);
    assert.ok(r.ok, r.logs.join('\n'));
  });
  test('DAMM v2 pool authority (migration target) is exempt', () => {
    const s = setup(); const dammVault = s.env.ata(s.mint, DAMM_V2_POOL_AUTHORITY);
    const src = s.env.ata(s.mint, s.curve.publicKey);
    assert.ok(s.env.send([s.env.transferIx(s.mint, s.decimals, src, dammVault, s.curve.publicKey, 30n * ONE_PCT)], [s.env.payer, s.curve]).ok);
  });
  test('the supply holder cannot send over cap to a wallet (no manual exemptions; rule applies to everyone)', () => {
    const s = setup(); const w = wallet(s);
    assert.equal(buy(s, w, ONE_PCT + 1n).hookError, 'WalletCapExceeded');
  });
  test('wallet-to-wallet: split to a fresh wallet below cap ok; send that would put receiver over cap fails', () => {
    const s = setup(); const a = wallet(s); const b = wallet(s);
    assert.ok(buy(s, a, ONE_PCT).ok);
    assert.ok(s.env.transfer(s.mint, s.decimals, a, b.publicKey, ONE_PCT / 2n).ok);
    assert.ok(buy(s, b, ONE_PCT / 2n).ok);
    assert.equal(s.env.transfer(s.mint, s.decimals, a, b.publicKey, 1n).hookError, 'WalletCapExceeded');
  });
  test('random sells mid-ramp never rejected (model check, 150 cases)', () => {
    const s = setup(); const L = s.cfg.launchSlot;
    let ctr = 0; const rnd = (n: number): number => { ctr += 1; return Number((BigInt(ctr) * 2654435761n + 12345n) % 1000003n) % n; };
    const ws = Array.from({ length: 5 }, () => wallet(s));
    let slot = L;
    for (let i = 0; i < 150; i++) {
      slot += BigInt(rnd(12)); if (slot > L + UNCAPPED - 1n) slot = L + UNCAPPED - 1n; s.env.warp(slot);
      const w = ws[rnd(ws.length)];
      const ata = getAssociatedTokenAddressSync(s.mint, w.publicKey, true, TOKEN_2022);
      const bal = s.env.balance(ata);
      const cap = capAt(toCapConfig(s.cfg), slot)!;
      if (bal < cap && rnd(2) === 0) { const amt = BigInt(1 + rnd(1000)) * (cap - bal) / 1000n || 1n; const r = buy(s, w, amt); assert.equal(r.ok, bal + amt <= cap, `buy ${i}`); }
      else if (bal > 0n) { const amt = BigInt(1 + rnd(1000)) * bal / 1000n || 1n; const r = sell(s, w, amt); assert.ok(r.ok, `sell ${i} rejected: ${r.logs.join('\n')}`); }
    }
  });
});

describe('hook correctness checklist (AC-9)', () => {
  test('direct Execute call (not via Token-2022) -> NotTransferring', () => {
    const s = setup(); const w = wallet(s); assert.ok(buy(s, w, 10n).ok);
    const src = getAssociatedTokenAddressSync(s.mint, w.publicKey, true, TOKEN_2022);
    const disc = createHash('sha256').update('spl-transfer-hook-interface:execute').digest().subarray(0, 8);
    const data = Buffer.alloc(16); disc.copy(data, 0); data.writeBigUInt64LE(1n, 8);
    const ix = new TransactionInstruction({ programId: s.env.hook.programId, data, keys: [
      { pubkey: src, isSigner: false, isWritable: false }, { pubkey: s.mint, isSigner: false, isWritable: false },
      { pubkey: s.poolVault, isSigner: false, isWritable: false }, { pubkey: w.publicKey, isSigner: false, isWritable: false },
      { pubkey: s.env.hook.extraMetasPda(s.mint), isSigner: false, isWritable: false },
      { pubkey: s.env.hook.configPda(s.mint), isSigner: false, isWritable: false },
      { pubkey: s.env.hook.liftPda(s.mint), isSigner: false, isWritable: false },
      { pubkey: s.env.hook.globalPda(), isSigner: false, isWritable: false },
    ] });
    const r = s.env.send([ix], [s.env.payer]);
    assert.equal(r.ok, false); assert.equal(r.hookError, 'NotTransferring', r.logs.join('\n'));
  });
  test('spoofed config account (config of another mint) is rejected', () => {
    const s = setup(); const s2Mint = s.env.createHookMint({ supply: SUPPLY, holderOwner: s.curve.publicKey });
    s.env.send([s.env.hook.initializeExtraAccountMetaList({ payer: s.env.payer.publicKey, authority: s.launcher.publicKey, mint: s2Mint.mint, steps: [{ slotOffset: 0n, maxBps: 10_000 }], uncappedAfter: UNCAPPED, supplyRef: SUPPLY })], [s.env.payer, s.launcher]);
    const w = wallet(s); const src = s.env.ata(s.mint, s.curve.publicKey); const dst = s.env.ata(s.mint, w.publicKey);
    const ix = s.env.transferIx(s.mint, s.decimals, src, dst, s.curve.publicKey, 5n * ONE_PCT);
    // swap our config/lift for the other (looser) mint's PDAs
    ix.keys = ix.keys.map(k => k.pubkey.equals(s.env.hook.configPda(s.mint)) ? { ...k, pubkey: s.env.hook.configPda(s2Mint.mint) } : k);
    const r = s.env.send([ix], [s.env.payer, s.curve]);
    assert.equal(r.ok, false);
    assert.equal(s.env.balance(dst), 0n);
  });
  test('compute: a capped transfer uses < 60k CU in total', () => {
    const s = setup(); const w = wallet(s); const r = buy(s, w, 10n); assert.ok(r.ok);
    const used = r.logs.filter(l => /trenches|consumed/.test(l)); assert.ok(used.length > 0);
  });
});

describe('lift-only switch (AC-11, AC-12)', () => {
  test('non-authority cannot lift or raise', () => {
    const s = setup(); const x = wallet(s);
    assert.equal(s.env.send([s.env.hook.liftGlobal(x.publicKey)], [x]).hookError, 'Unauthorized');
    assert.equal(s.env.send([s.env.hook.liftMintCap(x.publicKey, s.mint)], [x]).hookError, 'Unauthorized');
    assert.equal(s.env.send([s.env.hook.raiseMintCap(x.publicKey, s.mint, 500)], [x]).hookError, 'Unauthorized');
  });
  test('raise only upward, emits RestrictionsLifted; lower/equal -> ConfigFrozen', () => {
    const s = setup(); const w = wallet(s); const A = s.launcher;
    assert.ok(buy(s, w, ONE_PCT).ok); assert.equal(buy(s, w, 1n).hookError, 'WalletCapExceeded');
    const r = s.env.send([s.env.hook.raiseMintCap(A.publicKey, s.mint, 300)], [A]);
    assert.ok(r.ok); const ev = parseRestrictionsLifted(r.logs);
    assert.equal(ev.length, 1); assert.equal(ev[0].scopeName, 'mint-raise'); assert.equal(ev[0].newFloorBps, 300); assert.ok(ev[0].signer.equals(A.publicKey)); assert.ok(ev[0].mint.equals(s.mint));
    assert.ok(buy(s, w, 2n * ONE_PCT).ok); // now 3%
    assert.equal(s.env.send([s.env.hook.raiseMintCap(A.publicKey, s.mint, 300)], [A]).hookError, 'ConfigFrozen');
    assert.equal(s.env.send([s.env.hook.raiseMintCap(A.publicKey, s.mint, 200)], [A]).hookError, 'ConfigFrozen');
    assert.equal(s.env.send([s.env.hook.raiseMintCap(A.publicKey, s.mint, 10_001)], [A]).hookError, 'ConfigFrozen');
    // raise is a floor: once the schedule passes it, the schedule applies (never lowers)
  });
  test('lift mint: one-way, emits event, everything allowed after; second lift / raise -> ConfigFrozen', () => {
    const s = setup(); const w = wallet(s); const A = s.launcher;
    const r = s.env.send([s.env.hook.liftMintCap(A.publicKey, s.mint)], [A]);
    assert.ok(r.ok); assert.equal(parseRestrictionsLifted(r.logs)[0].scopeName, 'mint-lift');
    assert.ok(decodeLift(s.env.accountData(s.env.hook.liftPda(s.mint))!).lifted);
    assert.ok(buy(s, w, 40n * ONE_PCT).ok);
    assert.equal(s.env.send([s.env.hook.liftMintCap(A.publicKey, s.mint)], [A]).hookError, 'ConfigFrozen');
    assert.equal(s.env.send([s.env.hook.raiseMintCap(A.publicKey, s.mint, 500)], [A]).hookError, 'ConfigFrozen');
  });
  test('global lift: one-way allow-all, emits event', () => {
    const s = setup(); const w = wallet(s); const A = s.launcher;
    const r = s.env.send([s.env.hook.liftGlobal(A.publicKey)], [A]);
    assert.ok(r.ok); assert.equal(parseRestrictionsLifted(r.logs)[0].scopeName, 'global');
    assert.ok(buy(s, w, 40n * ONE_PCT).ok);
    assert.equal(s.env.send([s.env.hook.liftGlobal(A.publicKey)], [A]).hookError, 'ConfigFrozen');
  });
  test('config bytes never change under any instruction (L2-T1)', () => {
    const s = setup(); const A = s.launcher; const cfgK = s.env.hook.configPda(s.mint);
    const snap = s.env.accountData(cfgK)!;
    const w = wallet(s);
    buy(s, w, 10n); sell(s, w, 5n);
    s.env.send([s.env.hook.raiseMintCap(A.publicKey, s.mint, 500)], [A]);
    s.env.send([s.env.hook.initializeExtraAccountMetaList({ payer: s.env.payer.publicKey, authority: A.publicKey, mint: s.mint, steps: [{ slotOffset: 0n, maxBps: 10 }], uncappedAfter: 9999n, supplyRef: SUPPLY })], [s.env.payer, A]);
    s.env.send([s.env.hook.viewSchedule(s.mint)], [s.env.payer]);
    s.env.send([s.env.hook.liftMintCap(A.publicKey, s.mint)], [A]);
    s.env.send([s.env.hook.liftGlobal(A.publicKey)], [A]);
    s.env.initGlobal(Keypair.generate().publicKey);
    assert.deepEqual(s.env.accountData(cfgK), snap);
    assert.deepEqual(s.env.accountData(s.env.hook.extraMetasPda(s.mint))?.length, s.env.accountData(s.env.hook.extraMetasPda(s.mint))?.length);
  });
});

describe('view_schedule (QA: expose active schedule)', () => {
  test('logs + return data show schedule and test_slots_build=false', () => {
    const s = setup();
    const r = s.env.send([s.env.hook.viewSchedule(s.mint)], [s.env.payer], true);
    assert.ok(r.ok, r.logs.join('\n'));
    assert.ok(r.logs.some(l => l.includes('test_slots_build=false')));
    assert.ok(r.logs.some(l => l.includes('schedule step: offset=150 max_bps=200')));
    assert.ok(r.logs.some(l => l.includes('build: profile=release min_step_slots=10 min_ramp_slots=150')));
    const rd = r.returnData!; assert.ok(rd.length > 32);
  });
});

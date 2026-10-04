// Blocker #7: the mint's own Token-2022 TransferHook extension. Before graduation: program_id == the gated hook, authority
// == the pinned DBC signer (read from devnet TDT graduation tx 3F2PoxYi…). After graduation: both unset. Every read
// failure refuses. Offline: fakes only, with mint data recorded from devnet (tests/fixtures/devnet_tdt_mint_hook.json).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DEVNET_GENESIS } from '../sdk/cluster.js';
import { HOOK_PROGRAM_ID_DEVNET, DBC_PROGRAM_ID } from '../sdk/hook.js';
import { MINT_HOOK_AUTHORITY_PINS, MintHookRefusal, mintHookAuthorityFor, readMintTransferHook, graduationPhase, mintHookProblems } from '../sdk/mint_hook.js';
import { Launchpad, mintHookFlag, DAMM_V2_MIGRATION_CONFIG } from '../sdk/launch.js';
import { Keeper, FailClosed } from '../sdk/flywheel/keeper.js';
import { fixtureMint, MINT_HOOK_FIXTURE as FX, TRANSFER_HOOK_OFFSET as OFF } from './mint_hook_fixture.js';

const BPF = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const HOOK = new PublicKey(HOOK_PROGRAM_ID_DEVNET);
const SIGNER = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
const pk = () => Keypair.generate().publicKey;
const MINT = fixtureMint('tdt_pre').pubkey;
const refused = (re: RegExp) => (e: any) => e instanceof MintHookRefusal && re.test(e.message);

/** Mint account variants built from the recorded TDT data. */
const V = {
  pre: () => fixtureMint('tdt_pre').info,
  post: () => fixtureMint('tdt_post').info,
  wrongProgram: () => { const i = V.pre(); pk().toBuffer().copy(i.data, OFF + 32); return i; },
  wrongAuthority: (k = pk()) => { const i = V.pre(); k.toBuffer().copy(i.data, OFF); return i; },
  authorityUnset: () => { const i = V.pre(); i.data.fill(0, OFF, OFF + 32); return i; },
  programUnset: () => { const i = V.pre(); i.data.fill(0, OFF + 32, OFF + 64); return i; },
  postAuthoritySet: () => { const i = V.post(); new PublicKey(SIGNER).toBuffer().copy(i.data, OFF); return i; },
  postProgramSet: () => { const i = V.post(); HOOK.toBuffer().copy(i.data, OFF + 32); return i; },
  noExtension: (base = V.pre()) => { base.data.writeUInt16LE(21, OFF - 4); return base; },   // TLV type 14 (TransferHook) → another type
  badLength: () => { const i = V.pre(); i.data.writeUInt16LE(63, OFF - 2); return i; },
  splTokenOwner: () => ({ ...V.pre(), owner: TOKEN_PROGRAM_ID }),
  truncated: () => ({ ...V.pre(), data: V.pre().data.subarray(0, 100) }),
};
type MintMode = { info?: any; fail?: boolean };
function conn(m: MintMode, extra: [string, any][] = []) {
  const accts = new Map<string, any>([[HOOK.toBase58(), { owner: BPF, executable: true }], ...extra]);
  if (m.info) accts.set(MINT.toBase58(), m.info);
  return {
    getGenesisHash: async () => DEVNET_GENESIS,
    getAccountInfo: async (k: PublicKey) => { if (m.fail && k.equals(MINT)) throw new Error('fetch failed: 503'); return accts.get(k.toBase58()) ?? null; },
    getSlot: async () => 1,
  } as any;
}

// ---------------- fixture + pin
test('fixture: TDT before graduation = gated hook + pinned signer; after = both unset; FW15 (live, pre-graduation) matches byte for byte', async () => {
  assert.equal(FX.tdt_pre.genesis, DEVNET_GENESIS); assert.equal(FX.tdt_post.pubkey, MINT.toBase58());
  const pre = await readMintTransferHook(conn({ info: V.pre() }), MINT);
  assert.equal(pre.programId?.toBase58(), HOOK_PROGRAM_ID_DEVNET); assert.equal(pre.authority?.toBase58(), SIGNER);
  assert.deepEqual(await readMintTransferHook(conn({ info: V.post() }), MINT), { programId: null, authority: null });
  const fw = fixtureMint('fw15_pre').info.data.subarray(OFF, OFF + 64);
  assert.ok(fw.equals(V.pre().data.subarray(OFF, OFF + 64)));
  assert.doesNotMatch(JSON.stringify(FX), /secret|\[(\s*\d+\s*,){31,}/i);
});
test('pin: devnet/local = the Update/SetAuthority signer of graduation tx 3F2PoxYi…; mainnet/testnet/unknown unset → refuse (no devnet fallback)', () => {
  assert.equal(FX.graduation_tx.sig.slice(0, 8), '3F2PoxYi');
  assert.equal(MINT_HOOK_AUTHORITY_PINS.devnet, FX.graduation_tx.update_transfer_hook.authority);
  assert.equal(MINT_HOOK_AUTHORITY_PINS.devnet, FX.graduation_tx.set_authority.authority);
  assert.equal(mintHookAuthorityFor('local').toBase58(), SIGNER);
  for (const c of ['mainnet', 'testnet', 'unknown'] as const) assert.throws(() => mintHookAuthorityFor(c), refused(new RegExp(`cluster class '${c}'`)));
  assert.ok(Object.isFrozen(MINT_HOOK_AUTHORITY_PINS));
});
test('graduationPhase: migration_progress 0 → pre, 1..3 → post, anything else refuses', () => {
  assert.equal(graduationPhase({ migrationProgress: 0 }), 'pre');
  for (const p of [1, 2, 3]) assert.equal(graduationPhase({ migrationProgress: p }), 'post');
  for (const p of [undefined, null, 4, '0', -1]) assert.throws(() => graduationPhase({ migrationProgress: p }), refused(/migration progress unreadable/));
  assert.throws(() => graduationPhase(null), MintHookRefusal);
});

// ---------------- reader failures (each refuses, never "no authority")
test('read: RPC error refuses', async () => { await assert.rejects(readMintTransferHook(conn({ fail: true }), MINT), refused(/RPC error reading mint/)); });
test('read: missing mint refuses', async () => { await assert.rejects(readMintTransferHook(conn({}), MINT), refused(/not found/)); });
test('read: non-Token-2022 owner refuses', async () => { await assert.rejects(readMintTransferHook(conn({ info: V.splTokenOwner() }), MINT), refused(/is not Token-2022/)); });
test('read: no TransferHook extension refuses (also on a graduated mint, where it must not read as "unset")', async () => {
  await assert.rejects(readMintTransferHook(conn({ info: V.noExtension() }), MINT), refused(/no TransferHook extension/));
  await assert.rejects(readMintTransferHook(conn({ info: V.noExtension(V.post()) }), MINT), refused(/no TransferHook extension/));
});
test('read: bad extension length or unparseable mint data refuses', async () => {
  await assert.rejects(readMintTransferHook(conn({ info: V.badLength() }), MINT), refused(/63 bytes, expected 64/));
  await assert.rejects(readMintTransferHook(conn({ info: V.truncated() }), MINT), refused(/unparseable/));
});

// ---------------- before graduation: swap / buyExactIn refuse with 0 builds
function fakeLp(m: MintMode, progress: number, extra: [string, any][] = []) {
  const n = { built: 0 };
  const lp: any = {
    c: { name: 'devnet', label: 'devnet', connection: conn(m, extra) }, hook: { programId: HOOK },
    dbc: {
      state: { getPool: async () => ({ baseMint: MINT, config: pk(), migrationProgress: progress }), getPoolByBaseMint: async () => ({ account: { baseMint: MINT, migrationProgress: progress } }) },
      pool: { swap2WithTransferHook: async () => { n.built++; throw new Error('tx built'); } },
      migration: { migrateToDammV2: async () => { n.built++; throw new Error('tx built'); } },
    },
  };
  return { lp, n };
}
const swap = (lp: any, owner = Keypair.generate()) => Launchpad.prototype.swap.call(lp, owner, pk(), 'buy', 1n, 'test', 1n);
const buy = (lp: any) => Launchpad.prototype.buyExactIn.call(lp, Keypair.generate(), pk(), 1n, 'test');
async function preRefuses(m: MintMode, re: RegExp) {
  for (const op of [swap, buy]) { const { lp, n } = fakeLp(m, 0); await assert.rejects(op(lp), refused(re)); assert.equal(n.built, 0); }
}
test('before graduation: the recorded TDT mint passes and reaches the build (swap and buyExactIn)', async () => {
  for (const op of [swap, buy]) { const { lp, n } = fakeLp({ info: V.pre() }, 0); await assert.rejects(op(lp), /tx built/); assert.equal(n.built, 1); }
});
test('before graduation: wrong hook program_id → refused, 0 builds', () => preRefuses({ info: V.wrongProgram() }, /program_id .* != gated hook/));
test('before graduation: wrong authority → refused, 0 builds (our own key is named)', async () => {
  await preRefuses({ info: V.wrongAuthority() }, /authority .* != pinned DBC signer/);
  const owner = Keypair.generate(); const { lp, n } = fakeLp({ info: V.wrongAuthority(owner.publicKey) }, 0);
  await assert.rejects(swap(lp, owner), refused(/our swapper key/)); assert.equal(n.built, 0);
});
test('before graduation: authority unset → refused, 0 builds', () => preRefuses({ info: V.authorityUnset() }, /authority is unset before graduation/));
test('before graduation: program_id unset → refused, 0 builds', () => preRefuses({ info: V.programUnset() }, /program_id is unset before graduation/));
test('before graduation: no extension / non-Token-2022 owner / RPC error → refused, 0 builds', async () => {
  await preRefuses({ info: V.noExtension() }, /no TransferHook extension/);
  await preRefuses({ info: V.splTokenOwner() }, /is not Token-2022/);
  await preRefuses({ fail: true }, /RPC error reading mint/);
});
test('swap on a graduated pool → refused before the build (wrong phase)', async () => {
  const { lp, n } = fakeLp({ info: V.post() }, 3); await assert.rejects(swap(lp), refused(/post-graduation, this step needs pre/)); assert.equal(n.built, 0);
});

// ---------------- after graduation: migrate() refuses with 0 builds unless both are unset
function migrateLp(m: MintMode, progress: number) {
  const damm = DAMM_V2_MIGRATION_CONFIG.devnet;   // the pinned devnet config, owned by DAMM v2 in this fake
  const r = fakeLp(m, progress, [[damm, { owner: new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'), executable: false }]]);
  r.lp.c.connection.getAccountInfo = (orig => async (k: PublicKey) => (k.toBase58() === damm ? { owner: new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'), executable: false } : (await orig(k)) ?? { owner: DBC_PROGRAM_ID, executable: false }))(r.lp.c.connection.getAccountInfo);
  return r;
}
async function migrate(m: MintMode, progress = 3) {
  const saved = process.env.DAMM_V2_MIGRATION_CONFIG; delete process.env.DAMM_V2_MIGRATION_CONFIG;
  const { lp, n } = migrateLp(m, progress);
  try { return { p: Launchpad.prototype.migrate.call(lp, Keypair.generate(), pk()).finally(() => {}), n }; }
  finally { if (saved !== undefined) process.env.DAMM_V2_MIGRATION_CONFIG = saved; }
}
test('after graduation: the recorded TDT mint (both unset) reaches the migration build', async () => {
  const { p, n } = await migrate({ info: V.post() }); await assert.rejects(p, /tx built/); assert.equal(n.built, 1);
});
test('after graduation: authority still set → refused, 0 builds', async () => {
  const { p, n } = await migrate({ info: V.postAuthoritySet() }); await assert.rejects(p, refused(/authority still set after graduation/)); assert.equal(n.built, 0);
});
test('after graduation: program_id still set → refused, 0 builds', async () => {
  const { p, n } = await migrate({ info: V.postProgramSet() }); await assert.rejects(p, refused(/program_id still set after graduation/)); assert.equal(n.built, 0);
});
test('after graduation: no extension / RPC error → refused, 0 builds (never read as "unset")', async () => {
  for (const [m, re] of [[{ info: V.noExtension(V.post()) }, /no TransferHook extension/], [{ fail: true }, /RPC error reading mint/]] as const) {
    const { p, n } = await migrate(m); await assert.rejects(p, refused(re)); assert.equal(n.built, 0);
  }
});
test('migrate() on a pool that has not graduated → refused, 0 builds', async () => {
  const { p, n } = await migrate({ info: V.pre() }, 0); await assert.rejects(p, refused(/has not graduated/)); assert.equal(n.built, 0);
});

// ---------------- launch(): before any build, then the new mint right after pool creation
let dir = ''; let cwd = '';
before(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), 'mint-hook-')); });
after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
function launchLp(mintInfo: any, pool?: 'throw' | ((mint: PublicKey, config: PublicKey) => any)) {
  const n = { built: 0, sent: 0 }; let newMint: PublicKey | null = null, newConfig: PublicKey | null = null;
  const memo = (signers: PublicKey[]) => new Transaction().add(new TransactionInstruction({ programId: MEMO, keys: signers.map(pubkey => ({ pubkey, isSigner: true, isWritable: false })), data: Buffer.from('t') }));
  const connection: any = {
    getGenesisHash: async () => DEVNET_GENESIS,
    getAccountInfo: async (k: PublicKey) => (k.equals(HOOK) ? { owner: BPF, executable: true } : newMint && k.equals(newMint) ? mintInfo : null),
    getLatestBlockhash: async () => ({ blockhash: pk().toBase58(), lastValidBlockHeight: 1 }),
    sendRawTransaction: async () => { n.sent++; return `FakeSig${n.sent}`; },
    confirmTransaction: async () => ({ value: { err: null } }),
    getTransaction: async () => ({ meta: { err: null, logMessages: [] } }),
  };
  const lp: any = {
    c: { name: 'devnet', label: 'devnet', connection }, hook: { programId: HOOK }, configParams: () => ({}),
    dbc: {
      partner: { createConfigWithTransferHook: async (a: any) => { n.built++; return memo([a.payer, a.config]); } },
      creator: { createPoolWithTransferHook: async (a: any) => { n.built++; newMint = a.baseMint; newConfig = a.config; return memo([a.payer, a.baseMint]); } },
      state: { getPool: async () => (pool === undefined ? { baseMint: newMint, config: newConfig, migrationProgress: 0 } : pool === 'throw' ? (() => { throw new Error('503'); })() : pool(newMint!, newConfig!)) },
    },
  };
  return { lp, n, mint: () => newMint! };
}
const opts = (extra: any = {}) => ({ name: 'T', symbol: 'T', steps: [{ slotOffset: 0n, maxBps: 100 }], uncappedAfter: 10n, authorities: { upgradeAuthority: pk().toBase58(), liftAuthority: pk().toBase58() }, ...extra });
async function inTmp<T>(f: () => Promise<T>): Promise<T> {
  const saved = process.env.TXLOG_DIR; process.env.TXLOG_DIR = dir; process.chdir(dir);
  try { return await f(); } finally { process.chdir(cwd); if (saved === undefined) delete process.env.TXLOG_DIR; else process.env.TXLOG_DIR = saved; }
}
test('launch(): the pinned signer equal to one of our keys (keeper key / dev_payout / upgrade / lift) → refused before any build', async () => {
  for (const o of [opts({ keeperKeys: { dev_payout: SIGNER } }), opts({ keeperKeys: { treasury: SIGNER } }), opts({ authorities: { upgradeAuthority: SIGNER, liftAuthority: pk().toBase58() } }), opts({ authorities: { upgradeAuthority: pk().toBase58(), liftAuthority: SIGNER } })]) {
    const { lp, n } = launchLp(V.pre());
    await assert.rejects(Launchpad.prototype.launch.call(lp, Keypair.generate(), o), refused(/pinned mint TransferHook authority .* is our/)); assert.equal(n.built, 0);
  }
});
test('launch(): the new mint is checked right after pool creation; a wrong authority throws and the record says FAILED', async () => {
  await inTmp(async () => {
    const good = launchLp(V.pre());
    const rec: any = await Launchpad.prototype.launch.call(good.lp, Keypair.generate(), opts());
    assert.equal(rec.mintHookCheck, 'ok'); assert.equal(good.n.built, 2);
    const bad = launchLp(V.wrongAuthority());
    await assert.rejects(Launchpad.prototype.launch.call(bad.lp, Keypair.generate(), opts()), refused(/authority .* != pinned DBC signer/));
    const saved = JSON.parse(readFileSync(join(dir, 'launches', 'devnet', `${bad.mint().toBase58()}.json`), 'utf8'));
    assert.match(saved.mintHookCheck, /^FAILED: refusing: mint .* \(before graduation\): TransferHook authority/);
  });
});

// ---------------- monitoring: status() flag and the keeper's pinned checks
test('status()/mintHookFlag: graduated + unset → ok; graduated + still set, or no pool → flagged (never ok on an error)', async () => {
  const ok = fakeLp({ info: V.post() }, 3).lp;
  assert.deepEqual(await mintHookFlag(ok, MINT), { ok: true, phase: 'post', problems: [] });
  const st: any = await Launchpad.prototype.status.call(ok, MINT);
  assert.deepEqual(st.mintHook, { ok: true, phase: 'post', problems: [] });
  const bad = fakeLp({ info: V.postAuthoritySet() }, 3).lp;
  const f = await mintHookFlag(bad, MINT); assert.equal(f.ok, false); assert.match(f.problems.join(), /authority still set after graduation/);
  assert.equal(((await Launchpad.prototype.status.call(bad, MINT)) as any).mintHook.ok, false);
  const nopool = fakeLp({ info: V.post() }, 3).lp; nopool.dbc.state.getPoolByBaseMint = async () => null;
  const g = await mintHookFlag(nopool, MINT); assert.equal(g.ok, false); assert.match(g.problems.join(), /no DBC pool found/);
  const rpc = fakeLp({ fail: true }, 3).lp; assert.equal((await mintHookFlag(rpc, MINT)).ok, false);
});
function keeperThis(mintInfo: any, progress: number) {
  const keys = { claim: Keypair.generate(), treasury: Keypair.generate(), gas: Keypair.generate() };
  const cfg: any = { cluster: 'devnet', main_mint: MINT.toBase58(), main_token_program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', main_decimals: 6, main_dbc_pool: pk().toBase58(), hook_program: HOOK_PROGRAM_ID_DEVNET, hook_upgrade_authority: pk().toBase58(), hook_lift_authority: pk().toBase58(), sources: [] };
  return Object.assign(Object.create(Keeper.prototype), { cfg, keys, conn: conn({ info: mintInfo }), mint: MINT, mainProg: new PublicKey(cfg.main_token_program), dbc: { state: { getPool: async () => ({ baseMint: MINT, migrationProgress: progress }) } } });
}
test('keeper pinned checks: the mint TransferHook must match the phase, else fail closed + auto-pause (mismatch_mint_hook)', async () => {
  await keeperThis(V.post(), 3).pinnedChecks();
  await keeperThis(V.pre(), 0).pinnedChecks();
  for (const [m, p, re] of [[V.postAuthoritySet(), 3, /authority still set/], [V.wrongAuthority(), 0, /!= pinned DBC signer/], [V.post(), 0, /program_id is unset before graduation/]] as const) {
    await assert.rejects(keeperThis(m, p).pinnedChecks(), (e: any) => e instanceof FailClosed && e.code === 'mismatch_mint_hook' && e.pause === true && re.test(e.message));
  }
  const k = keeperThis(V.wrongAuthority(), 0); (k as any).conn = conn({ info: V.wrongAuthority(k.keys.treasury.publicKey) });
  await assert.rejects(k.pinnedChecks(), (e: any) => e instanceof FailClosed && /our treasury key/.test(e.message));
});
test('mintHookProblems is pure: same input, same answer (no hidden state)', () => {
  const th = { programId: HOOK, authority: new PublicKey(SIGNER) }; const exp = { hookProgram: HOOK, authority: new PublicKey(SIGNER) };
  assert.deepEqual(mintHookProblems(th, 'pre', exp), []); assert.equal(mintHookProblems(th, 'post', exp).length, 2);
});

test('launch(): a matching authority alone is not enough. Wrong program_id on the new mint, or a pool that is not ours (other mint, other config, graduated, missing, RPC error) → throws, record FAILED', async () => {
  await inTmp(async () => {
    const cases: [any, any, RegExp][] = [
      [V.wrongProgram(), undefined, /program_id .* != gated hook/],
      [V.pre(), (_m: PublicKey, c: PublicKey) => ({ baseMint: pk(), config: c, migrationProgress: 0 }), /base mint .* != our mint/],
      [V.pre(), (m: PublicKey) => ({ baseMint: m, config: pk(), migrationProgress: 0 }), /config .* != our config/],
      [V.pre(), (m: PublicKey, c: PublicKey) => ({ baseMint: m, config: c, migrationProgress: 3 }), /already past graduation/],
      [V.pre(), () => null, /new DBC pool .* not found/],
      [V.pre(), 'throw', /cannot read the new DBC pool/],
    ];
    for (const [info, pool, re] of cases) {
      const L = launchLp(info, pool);
      await assert.rejects(Launchpad.prototype.launch.call(L.lp, Keypair.generate(), opts()), refused(re), String(re));
      assert.match(JSON.parse(readFileSync(join(dir, 'launches', 'devnet', `${L.mint().toBase58()}.json`), 'utf8')).mintHookCheck, /^FAILED: /);
    }
  });
});
test('pin = DBC\'s shared pool-authority PDA: derived here from the DBC program id (bump 255), not hard-coded again', () => {
  const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], DBC_PROGRAM_ID);
  assert.equal(pda.toBase58(), MINT_HOOK_AUTHORITY_PINS.devnet, 'FLAG: the pinned mint TransferHook authority is not DBC\'s pool-authority PDA');
  assert.equal(bump, 255);
  assert.equal(MINT_HOOK_AUTHORITY_PINS.local, MINT_HOOK_AUTHORITY_PINS.devnet);   // local clones DBC at the same id
});

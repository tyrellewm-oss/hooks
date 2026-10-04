// Blocker #7: the mint's own Token-2022 TransferHook extension. Before graduation: program_id == the gated hook, authority
// == the pinned DBC signer (read from devnet TDT graduation tx 3F2PoxYi…). After graduation: both unset. Every read
// failure refuses. Offline: fakes only, with mint data recorded from devnet (tests/fixtures/devnet_tdt_mint_hook.json).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { DEVNET_GENESIS } from '../sdk/cluster.js';
import { HOOK_PROGRAM_ID_DEVNET, DBC_PROGRAM_ID, DBC_POOL_AUTHORITY } from '../sdk/hook.js';
import { MINT_HOOK_AUTHORITY_PINS, MintHookRefusal, mintHookAuthorityFor, readMintTransferHook, graduationPhase, mintHookProblems, sameMessageExceptBlockhash, DBC_INIT_POOL_T22_HOOK_DISC, decodeMintTransferHookBytes, decodeMintTransferHook } from '../sdk/mint_hook.js';
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
/** Simulation outcome for the create-pool tx: the post-simulation mint account (default: the same mint as on chain),
 *  a simulation error, an RPC error, a null account, or no accounts array at all. `tamper` runs inside the simulation
 *  call (e.g. to change the built tx between simulation and signing). */
type SimMode = { info?: any; err?: any; rpcFail?: boolean; nullAccount?: boolean; noAccounts?: boolean; tamper?: (tx: Transaction) => void };
function launchLp(mintInfo: any, pool?: 'throw' | ((mint: PublicKey, config: PublicKey) => any), sim: SimMode = {}, poolIxMint?: PublicKey) {
  const n = { built: 0, sent: 0, simulated: 0 };
  const seen = { simMessages: [] as Buffer[], simConfigs: [] as any[], sentMessages: [] as Buffer[], events: [] as string[] };
  let newMint: PublicKey | null = null, newConfig: PublicKey | null = null, poolTx: Transaction | null = null;
  const memo = (signers: PublicKey[]) => new Transaction().add(new TransactionInstruction({ programId: MEMO, keys: signers.map(pubkey => ({ pubkey, isSigner: true, isWritable: false })), data: Buffer.from('t') }));
  // The DBC create-pool ix in its IDL account order (config, pool_authority, creator, base_mint, ...), args elided.
  const dbcIx = (a: any) => new TransactionInstruction({ programId: DBC_PROGRAM_ID, data: Buffer.concat([DBC_INIT_POOL_T22_HOOK_DISC, Buffer.from('args')]), keys: [
    { pubkey: a.config, isSigner: false, isWritable: false }, { pubkey: DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: a.poolCreator, isSigner: true, isWritable: false }, { pubkey: poolIxMint ?? a.baseMint, isSigner: true, isWritable: true }, { pubkey: a.payer, isSigner: true, isWritable: true }] });
  const connection: any = {
    getGenesisHash: async () => DEVNET_GENESIS,
    // the mint exists on chain only after the pool tx was sent (the config tx is send #1)
    getAccountInfo: async (k: PublicKey) => (k.equals(HOOK) ? { owner: BPF, executable: true } : newMint && k.equals(newMint) && n.sent >= 2 ? mintInfo : null),
    getLatestBlockhash: async () => ({ blockhash: pk().toBase58(), lastValidBlockHeight: 1 }),
    simulateTransaction: async (vtx: any, cfg: any) => {
      n.simulated++; seen.simMessages.push(Buffer.from(vtx.message.serialize())); seen.simConfigs.push(cfg); seen.events.push('simulate');
      if (sim.tamper && poolTx) sim.tamper(poolTx);
      if (sim.rpcFail) throw new Error('fetch failed: 503');
      if (sim.err) return { context: { slot: 1 }, value: { err: sim.err, logs: ['Program log: boom'], accounts: null } };
      if (sim.noAccounts) return { context: { slot: 1 }, value: { err: null, logs: [] } };
      if (sim.nullAccount) return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [null] } };
      const i = sim.info ?? mintInfo;
      return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ owner: new PublicKey(i.owner).toBase58(), lamports: 1, executable: false, rentEpoch: 0, data: [Buffer.from(i.data).toString('base64'), 'base64'] }] } };
    },
    sendRawTransaction: async (raw: Buffer) => { n.sent++; const t = Transaction.from(raw); seen.sentMessages.push(Buffer.from(t.serializeMessage())); seen.events.push(t.instructions.some(ix => ix.programId.equals(DBC_PROGRAM_ID)) ? 'send:pool' : 'send:other'); return `FakeSig${n.sent}`; },
    confirmTransaction: async () => ({ value: { err: null } }),
    getTransaction: async () => ({ meta: { err: null, logMessages: [] } }),
  };
  const lp: any = {
    c: { name: 'devnet', label: 'devnet', connection }, hook: { programId: HOOK }, configParams: () => ({}),
    dbc: {
      partner: { createConfigWithTransferHook: async (a: any) => { n.built++; return memo([a.payer, a.config]); } },
      creator: { createPoolWithTransferHook: async (a: any) => { n.built++; newMint = a.baseMint; newConfig = a.config; poolTx = new Transaction().add(dbcIx(a)); return poolTx; } },
      state: { getPool: async () => (pool === undefined ? { baseMint: newMint, config: newConfig, migrationProgress: 0 } : pool === 'throw' ? (() => { throw new Error('503'); })() : pool(newMint!, newConfig!)) },
    },
  };
  return { lp, n, seen, mint: () => newMint! };
}
/** Counts signatures over any tx that carries the DBC create-pool ix (Transaction.sign / partialSign), during `f`. */
async function countPoolSigns<T>(f: () => Promise<T>): Promise<{ r: T | Error; poolSigns: number }> {
  const P: any = Transaction.prototype; const sign = P.sign, partial = P.partialSign; let poolSigns = 0;
  const isPool = (tx: Transaction) => tx.instructions.some(ix => ix.programId.equals(DBC_PROGRAM_ID));
  P.sign = function (this: Transaction, ...a: any[]) { if (isPool(this)) poolSigns++; return sign.apply(this, a); };
  P.partialSign = function (this: Transaction, ...a: any[]) { if (isPool(this)) poolSigns++; return partial.apply(this, a); };
  try { return { r: await f(), poolSigns }; } catch (e: any) { return { r: e, poolSigns }; } finally { P.sign = sign; P.partialSign = partial; }
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
    const bad = launchLp(V.wrongAuthority(), undefined, { info: V.pre() });   // simulation fine, chain wrong
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
      const L = launchLp(info, pool, { info: V.pre() });
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

// ---------------- launch(): pre-send simulation of the exact create-pool tx (before any signature on it)
const launchRun = (L: ReturnType<typeof launchLp>, deployer = Keypair.generate()) => countPoolSigns(() => inTmp(() => Launchpad.prototype.launch.call(L.lp, deployer, opts())));
async function refusedBeforeSigning(L: ReturnType<typeof launchLp>, re: RegExp) {
  const { r, poolSigns } = await launchRun(L);
  assert.ok(r instanceof MintHookRefusal && re.test(r.message), `expected MintHookRefusal ${re}, got ${String((r as any)?.message ?? r)}`);
  assert.equal(poolSigns, 0, 'the create-pool tx must never be signed');
  assert.equal(L.n.sent, 1, 'only the config tx may have been sent');
  assert.equal(L.n.built, 2, 'the create-pool tx is built exactly once');
}
test('pre-send: the simulation request = exact unsigned message bytes, sigVerify false, replaceRecentBlockhash, the mint from the tx (base64)', async () => {
  const L = launchLp(V.pre());
  const { r, poolSigns } = await launchRun(L);
  assert.equal((r as any).mintHookCheck, 'ok', String((r as any)?.message ?? ''));
  assert.match((r as any).mintHookSimulation, /^ok before signing: program_id=.* authority=FhVo3mqL/);
  assert.equal(poolSigns, 1); assert.equal(L.n.simulated, 1); assert.equal(L.n.built, 2); assert.equal(L.n.sent, 2);
  assert.deepEqual(L.seen.simConfigs[0], { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { addresses: [L.mint().toBase58()], encoding: 'base64' } });
  // the bytes signed and sent equal the simulated bytes apart from the blockhash (sendTx fetched a fresh one)
  const simulated = L.seen.simMessages[0], signed = L.seen.sentMessages[1];
  assert.equal(sameMessageExceptBlockhash(simulated, signed), true, 'signed bytes must equal simulated bytes apart from the blockhash');
  assert.equal(simulated.equals(signed), false, 'the fake hands out a fresh blockhash per call, so the raw bytes differ only there');
});
test('pre-send: the simulation returns a wrong-hook mint → refused, the create-pool tx is never signed, 0 pool sends', async () => {
  await refusedBeforeSigning(launchLp(V.pre(), undefined, { info: V.wrongProgram() }), /refusing before signing: simulated mint .* program_id .* != gated hook/);
});
test('pre-send: wrong authority in the simulated mint → refused before signing', async () => {
  await refusedBeforeSigning(launchLp(V.pre(), undefined, { info: V.wrongAuthority() }), /refusing before signing: .*authority .* != pinned DBC signer/);
});
test('pre-send: simulation error (err non-null) → refused before signing', async () => {
  await refusedBeforeSigning(launchLp(V.pre(), undefined, { err: { InstructionError: [1, { Custom: 6000 }] } }), /create-pool simulation failed: .*InstructionError/);
});
test('pre-send: RPC error on simulateTransaction → refused before signing', async () => {
  await refusedBeforeSigning(launchLp(V.pre(), undefined, { rpcFail: true }), /RPC error simulating the create-pool tx/);
});
test('pre-send: null or missing returned account → refused before signing', async () => {
  await refusedBeforeSigning(launchLp(V.pre(), undefined, { nullAccount: true }), /simulation returned no account for mint/);
  await refusedBeforeSigning(launchLp(V.pre(), undefined, { noAccounts: true }), /simulation returned no account for mint/);
});
test('pre-send: non-Token-2022 owner / no extension / undecodable data in the simulated mint → refused before signing', async () => {
  await refusedBeforeSigning(launchLp(V.pre(), undefined, { info: V.splTokenOwner() }), /simulated mint .* is not Token-2022/);
  await refusedBeforeSigning(launchLp(V.pre(), undefined, { info: V.noExtension() }), /simulated mint .* has no TransferHook extension/);
  await refusedBeforeSigning(launchLp(V.pre(), undefined, { info: V.truncated() }), /simulated mint .* data unparseable/);
});
test('pre-send: the decision uses the POST-simulation mint (the mint does not exist on chain before the pool tx)', async () => {
  // good simulation, nothing on chain yet: passes. A check that reads the chain before sending would find no mint.
  const L = launchLp(V.pre(), undefined, { info: V.pre() });
  const { r } = await launchRun(L); assert.equal((r as any).mintHookCheck, 'ok', String((r as any)?.message ?? ''));
});
test('pre-send: the mint comes from the built tx; a tx naming another base mint than the launch mint → refused before signing', async () => {
  await refusedBeforeSigning(launchLp(V.pre(), undefined, {}, pk()), /names base mint .* not the launch mint/);
});
test('pre-send: a tx changed after the simulation (beyond the blockhash) → refused at signing, never signed', async () => {
  const L = launchLp(V.pre(), undefined, { tamper: tx => { tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('x') })); } });
  await refusedBeforeSigning(L, /refusing to sign: the create-pool tx differs from the simulated tx/);
});
test('pre-send passes but the on-chain mint after the pool tx is wrong → refused before any buy, record FAILED', async () => {
  await inTmp(async () => {
    const L = launchLp(V.wrongAuthority(), undefined, { info: V.pre() });
    await assert.rejects(Launchpad.prototype.launch.call(L.lp, Keypair.generate(), opts()), refused(/authority .* != pinned DBC signer/));
    const rec = JSON.parse(readFileSync(join(dir, 'launches', 'devnet', `${L.mint().toBase58()}.json`), 'utf8'));
    assert.match(rec.mintHookCheck, /^FAILED: /); assert.match(rec.mintHookSimulation, /^ok before signing/);
  });
});
test('sameMessageExceptBlockhash: only the blockhash may differ (fee payer, instructions, accounts may not)', () => {
  const payer = pk(); const mk = (bh: string, p = payer, data = 'a') => { const t = new Transaction().add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(data) })); t.feePayer = p; t.recentBlockhash = bh; return t.serializeMessage(); };
  const h1 = pk().toBase58(), h2 = pk().toBase58();
  assert.equal(sameMessageExceptBlockhash(mk(h1), mk(h2)), true);
  assert.equal(sameMessageExceptBlockhash(mk(h1), mk(h2, pk())), false);
  assert.equal(sameMessageExceptBlockhash(mk(h1), mk(h2, payer, 'b')), false);
  assert.equal(sameMessageExceptBlockhash(mk(h1), Buffer.from('junk')), false);
});

// QA (#7 sim commit): the combined config+pool tx is over 1232 bytes, so the config tx is sent first (devnet). The hard rule:
// NO path sends the create-pool tx without a passing simulation of that same message.
test('no path sends the create-pool tx without a passing simulation: every refusal mode → 0 pool sends; the pass case simulates first, then sends the same message', async () => {
  const modes: [string, ReturnType<typeof launchLp>][] = [
    ['wrong program', launchLp(V.pre(), undefined, { info: V.wrongProgram() })],
    ['wrong authority', launchLp(V.pre(), undefined, { info: V.wrongAuthority() })],
    ['authority unset', launchLp(V.pre(), undefined, { info: V.authorityUnset() })],
    ['simulation err', launchLp(V.pre(), undefined, { err: 'AccountNotFound' })],
    ['simulation RPC error', launchLp(V.pre(), undefined, { rpcFail: true })],
    ['null account', launchLp(V.pre(), undefined, { nullAccount: true })],
    ['no accounts', launchLp(V.pre(), undefined, { noAccounts: true })],
    ['wrong owner', launchLp(V.pre(), undefined, { info: V.splTokenOwner() })],
    ['no extension', launchLp(V.pre(), undefined, { info: V.noExtension() })],
    ['undecodable', launchLp(V.pre(), undefined, { info: V.truncated() })],
    ['tx names another mint', launchLp(V.pre(), undefined, {}, pk())],
    ['tx changed after simulation', launchLp(V.pre(), undefined, { tamper: tx => { tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('x') })); } })],
  ];
  for (const [name, L] of modes) {
    const { r } = await launchRun(L);
    assert.ok(r instanceof MintHookRefusal, `${name}: expected MintHookRefusal, got ${String((r as any)?.message ?? r)}`);
    assert.equal(L.seen.events.filter(e => e === 'send:pool').length, 0, `${name}: the create-pool tx must not be sent`);
  }
  const ok = launchLp(V.pre()); const { r } = await launchRun(ok);
  assert.equal((r as any).mintHookCheck, 'ok', String((r as any)?.message ?? ''));
  assert.deepEqual(ok.seen.events, ['send:other', 'simulate', 'send:pool'], 'config tx, then the simulation, then the pool tx');
  assert.equal(sameMessageExceptBlockhash(ok.seen.simMessages[0], ok.seen.sentMessages[1]), true, 'the pool tx sent is the simulated message');
});
test('launch(): the pool tx is sent at exactly one place, with the byte check, after preSendMintHookCheck', () => {
  const src = readFileSync(new URL('../sdk/launch.ts', import.meta.url), 'utf8');
  const launch = src.slice(src.indexOf('async launch('), src.indexOf('async swap('));
  const sends = launch.split('\n').filter(l => /sendTx\(this\.c, poolTx/.test(l));
  assert.equal(sends.length, 1, 'one send of the pool tx');
  assert.match(sends[0], /, sameBytes\);/, 'the pool send carries the byte check');
  assert.ok(launch.indexOf('await preSendMintHookCheck(') >= 0 && launch.indexOf('await preSendMintHookCheck(') < launch.indexOf('sendTx(this.c, poolTx'), 'simulation before the pool send');
});
test('decoder: one pure byte decode for both paths (getAccountInfo data and base64 simulation data give the same result)', () => {
  for (const v of [V.pre(), V.post()]) {
    const fromBytes = decodeMintTransferHookBytes(MINT, v.data);
    const fromB64 = decodeMintTransferHookBytes(MINT, Buffer.from(Buffer.from(v.data).toString('base64'), 'base64'));
    assert.deepEqual(fromB64, fromBytes); assert.deepEqual(decodeMintTransferHook(MINT, v), fromBytes);
  }
  assert.throws(() => decodeMintTransferHookBytes(MINT, V.truncated().data), refused(/data unparseable/));
  assert.throws(() => decodeMintTransferHookBytes(MINT, V.noExtension().data), refused(/no TransferHook extension/));
});

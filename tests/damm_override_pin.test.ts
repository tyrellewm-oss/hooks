// QA mainnet blocker #3: the DAMM v2 migration config env override is a devnet-only knob. On any cluster whose genesis
// hash is not devnet's it must equal the pinned mainnet value, and a mismatch is refused before any tx is built. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Connection } from '@solana/web3.js';
import { DEVNET_GENESIS, MAINNET_GENESIS, TESTNET_GENESIS, classifyCluster, isLocalhostRpc } from '../sdk/cluster.js';
import { DBC_PROGRAM_ID, DAMM_V2_PROGRAM_ID, HOOK_PROGRAM_ID_DEVNET } from '../sdk/hook.js';
import { PublicKey } from '@solana/web3.js';
import { ClusterCheckRefusal } from '../sdk/cluster_check.js';
import { startKeeper } from '../sdk/flywheel/keeper.js';
import { KeyRuleRefusal } from '../sdk/keyrules.js';
import { Launchpad, txlogFile, resolveDammV2MigrationConfig, ConfigPinRefusal, DAMM_V2_MIGRATION_CONFIG, DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN } from '../sdk/launch.js';
import { fixtureMint } from './mint_hook_fixture.js';

const LOCAL_GENESIS = Keypair.generate().publicKey.toBase58();   // a local validator has its own random genesis
const other = () => Keypair.generate().publicKey.toBase58();
const env = (v?: string) => (v === undefined ? {} : { DAMM_V2_MIGRATION_CONFIG: v }) as NodeJS.ProcessEnv;

test('no override → pinned per-cluster value (devnet, mainnet, local)', () => {
  for (const [g, name, want, by, url] of [[DEVNET_GENESIS, 'devnet', DAMM_V2_MIGRATION_CONFIG.devnet, 'devnet', undefined], [MAINNET_GENESIS, 'devnet', DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN, 'mainnet', undefined], [LOCAL_GENESIS, 'local', DAMM_V2_MIGRATION_CONFIG.local, 'local', 'http://127.0.0.1:8899']] as const) {
    const r = resolveDammV2MigrationConfig(g, name, env(), url);
    assert.equal(r.config.toBase58(), want); assert.equal(r.override, null); assert.equal(r.clusterByGenesis, by);
  }
  assert.equal(resolveDammV2MigrationConfig(DEVNET_GENESIS, 'devnet', env('')).override, null);   // empty = unset
});

test('devnet (by genesis): any valid override is accepted and reported', () => {
  const x = other(); const r = resolveDammV2MigrationConfig(DEVNET_GENESIS, 'devnet', env(x));
  assert.equal(r.config.toBase58(), x); assert.equal(r.override, x);
  assert.throws(() => resolveDammV2MigrationConfig(DEVNET_GENESIS, 'devnet', env('not-an-address')), ConfigPinRefusal);
});

test('mainnet (by genesis): override equal to the pin is accepted', () => {
  const r = resolveDammV2MigrationConfig(MAINNET_GENESIS, 'devnet', env(DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN));
  assert.equal(r.config.toBase58(), DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN); assert.equal(r.override, DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN);
});

test('non-devnet (mainnet genesis, even if named devnet; or any other genesis): mismatching override is refused', () => {
  for (const g of [MAINNET_GENESIS, LOCAL_GENESIS]) for (const name of ['devnet', 'local'] as const)
    assert.throws(() => resolveDammV2MigrationConfig(g, name, env(other())), (e: any) => e instanceof ConfigPinRefusal && /non-devnet/.test(e.message));
  // near-misses are refused too (exact match only)
  assert.throws(() => resolveDammV2MigrationConfig(MAINNET_GENESIS, 'devnet', env(` ${DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN}`)), ConfigPinRefusal);
});

test('Launchpad.migrate on mainnet genesis with a mismatching override → refused before any tx is built or sent', async () => {
  const prev = process.env.DAMM_V2_MIGRATION_CONFIG; process.env.DAMM_V2_MIGRATION_CONFIG = other();
  try {
    let built = 0; const touched: string[] = [];
    const connection = new Proxy({}, { get: (_t, p) => { if (p === 'then') return undefined; if (p === 'getGenesisHash') return async () => MAINNET_GENESIS; touched.push(String(p)); throw new Error(`network used: ${String(p)}`); } }) as unknown as Connection;
    const fake: any = { c: { name: 'devnet', connection }, dbc: { migration: { migrateToDammV2: async () => { built++; throw new Error('should not build'); } } } };
    await assert.rejects(Launchpad.prototype.migrate.call(fake, Keypair.generate(), Keypair.generate().publicKey), ConfigPinRefusal);
    assert.equal(built, 0); assert.deepEqual(touched, []);   // only the genesis read happened
  } finally { if (prev === undefined) delete process.env.DAMM_V2_MIGRATION_CONFIG; else process.env.DAMM_V2_MIGRATION_CONFIG = prev; }
});

test('Launchpad.migrate on devnet genesis with an override → builds the migration tx with the override (stops before sending)', async () => {
  const prev = process.env.DAMM_V2_MIGRATION_CONFIG; const x = other(); process.env.DAMM_V2_MIGRATION_CONFIG = x;
  try {
    // accounts that pass the cluster check: hook executable, pool config owned by DBC, override owned by DAMM v2
    const hook = new PublicKey(HOOK_PROGRAM_ID_DEVNET), poolCfg = Keypair.generate().publicKey;
    const accts = new Map<string, any>([[hook.toBase58(), { owner: hook, executable: true }], [poolCfg.toBase58(), { owner: DBC_PROGRAM_ID, executable: false }], [x, { owner: DAMM_V2_PROGRAM_ID, executable: false }], [fixtureMint('tdt_post').pubkey.toBase58(), fixtureMint('tdt_post').info]]);
    let usedConfig = ''; const connection: any = { getGenesisHash: async () => DEVNET_GENESIS, getAccountInfo: async (k: any) => accts.get(k.toBase58()) ?? null, getLatestBlockhash: async () => { throw new Error('stop before send'); } };
    const fake: any = { c: { name: 'devnet', connection }, hook: { programId: hook }, dbc: { state: { getPool: async () => ({ config: poolCfg, baseMint: fixtureMint('tdt_post').pubkey, migrationProgress: 3 }) }, migration: { migrateToDammV2: async (a: any) => { usedConfig = a.dammConfig.toBase58(); return { transaction: {}, firstPositionNftKeypair: Keypair.generate(), secondPositionNftKeypair: Keypair.generate() }; } } } };
    await assert.rejects(Launchpad.prototype.migrate.call(fake, Keypair.generate(), Keypair.generate().publicKey), /stop before send/);
    assert.equal(usedConfig, x);
  } finally { if (prev === undefined) delete process.env.DAMM_V2_MIGRATION_CONFIG; else process.env.DAMM_V2_MIGRATION_CONFIG = prev; }
});

// The accepted devnet override must be recorded in the tx log note. Written to a TEMP log (TXLOG_DIR), never the tracked one.
test('accepted override → tx log note "overrides: DAMM_V2_MIGRATION_CONFIG=<value>" (temp tx log, tracked log untouched)', async () => {
  const { mkdtempSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Transaction, TransactionInstruction } = await import('@solana/web3.js');
  const tracked = txlogFile('devnet', {});
  const trackedBefore = existsSync(tracked) ? readFileSync(tracked) : null;
  const dir = mkdtempSync(join(tmpdir(), 'txlog-'));
  const savedDir = process.env.TXLOG_DIR, savedOv = process.env.DAMM_V2_MIGRATION_CONFIG;
  const ov = other(), hook = HOOK_PROGRAM_ID_DEVNET, poolCfg = other();
  const accts = new Map<string, any>([[hook, { owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), executable: true }], [poolCfg, { owner: DBC_PROGRAM_ID, executable: false }], [ov, { owner: DAMM_V2_PROGRAM_ID, executable: false }], [fixtureMint('tdt_post').pubkey.toBase58(), fixtureMint('tdt_post').info]]);
  const conn = {
    getGenesisHash: async () => DEVNET_GENESIS,
    getAccountInfo: async (k: any) => accts.get(k.toBase58()) ?? null,
    getLatestBlockhash: async () => ({ blockhash: other(), lastValidBlockHeight: 1 }),
    sendRawTransaction: async () => 'FakeSig1111111111111111111111111111111111111',
    confirmTransaction: async () => ({ value: { err: null } }),
    getTransaction: async () => ({ meta: { err: null, logMessages: [] } }),
  };
  const nft1 = Keypair.generate(), nft2 = Keypair.generate();
  let usedConfig = '';
  const fake = {
    c: { name: 'devnet', label: 'devnet', connection: conn },
    hook: { programId: new PublicKey(hook) },
    dbc: {
      state: { getPool: async () => ({ config: new PublicKey(poolCfg), baseMint: fixtureMint('tdt_post').pubkey, migrationProgress: 3 }) },
      migration: { migrateToDammV2: async (a: any) => {
        usedConfig = a.dammConfig.toBase58();
        const keys = [a.payer, nft1.publicKey, nft2.publicKey].map(pubkey => ({ pubkey, isSigner: true, isWritable: false }));
        return { transaction: new Transaction().add(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys, data: Buffer.from('t') })), firstPositionNftKeypair: nft1, secondPositionNftKeypair: nft2 };
      } },
    },
  };
  try {
    process.env.TXLOG_DIR = dir; process.env.DAMM_V2_MIGRATION_CONFIG = ov;
    assert.equal(txlogFile('devnet'), join(dir, 'devnet.jsonl'));
    const rec: any = await Launchpad.prototype.migrate.call(fake as any, Keypair.generate(), new PublicKey(other()));
    assert.equal(usedConfig, ov);
    assert.equal(rec.ok, true); assert.equal(rec.note, `overrides: DAMM_V2_MIGRATION_CONFIG=${ov}`);
    const lines = readFileSync(join(dir, 'devnet.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].note, `overrides: DAMM_V2_MIGRATION_CONFIG=${ov}`);
    assert.equal(lines[0].purpose, 'dbc: migration_damm_v2 (graduation)');
  } finally {
    if (savedDir === undefined) delete process.env.TXLOG_DIR; else process.env.TXLOG_DIR = savedDir;
    if (savedOv === undefined) delete process.env.DAMM_V2_MIGRATION_CONFIG; else process.env.DAMM_V2_MIGRATION_CONFIG = savedOv;
    rmSync(dir, { recursive: true, force: true });
  }
  const trackedAfter = existsSync(tracked) ? readFileSync(tracked) : null;
  assert.deepEqual(trackedAfter, trackedBefore, 'tracked tx log must not be touched');
});

// Fail closed on a genesis read error: no fallback to devnet (or any default), no pool read, no tx built.
test('getGenesisHash rejects → migrate() refuses with 0 tx builds (no fallback to devnet)', async () => {
  const prev = process.env.DAMM_V2_MIGRATION_CONFIG;
  // Every other account would pass the cluster check, so a fallback-to-devnet mutation would reach the build.
  const hook = Keypair.generate().publicKey, poolCfg = Keypair.generate().publicKey, damm = new PublicKey(DAMM_V2_MIGRATION_CONFIG.devnet);
  const accts = new Map<string, any>([[hook.toBase58(), { owner: hook, executable: true }], [poolCfg.toBase58(), { owner: DBC_PROGRAM_ID, executable: false }], [damm.toBase58(), { owner: DAMM_V2_PROGRAM_ID, executable: false }]]);
  for (const ov of [undefined, other()]) {
    if (ov === undefined) delete process.env.DAMM_V2_MIGRATION_CONFIG; else { process.env.DAMM_V2_MIGRATION_CONFIG = ov; accts.set(ov, { owner: DAMM_V2_PROGRAM_ID, executable: false }); }
    let built = 0, poolReads = 0;
    const connection: any = { getGenesisHash: async () => { throw new Error('fetch failed: 503'); }, getAccountInfo: async (k: any) => accts.get(k.toBase58()) ?? null, getLatestBlockhash: async () => { built++; throw new Error('stop before send'); } };
    const fake: any = { c: { name: 'devnet', connection }, hook: { programId: hook }, dbc: { state: { getPool: async () => { poolReads++; return { config: poolCfg }; } }, migration: { migrateToDammV2: async () => { built++; return { transaction: {}, firstPositionNftKeypair: Keypair.generate(), secondPositionNftKeypair: Keypair.generate() }; } } } };
    try {
      await assert.rejects(Launchpad.prototype.migrate.call(fake, Keypair.generate(), Keypair.generate().publicKey), (e: any) => e instanceof ConfigPinRefusal && /cannot read the genesis hash/.test(e.message));
    } finally { if (prev === undefined) delete process.env.DAMM_V2_MIGRATION_CONFIG; else process.env.DAMM_V2_MIGRATION_CONFIG = prev; }
    assert.equal(built, 0); assert.equal(poolReads, 0);
  }
});

// Local validator rule (genesis-based, three outcomes). The URL alone never decides.
const LOCAL_URLS = ['http://127.0.0.1:8899', 'http://localhost:8899', 'http://[::1]:8899'];
const REMOTE_URLS = [undefined, 'https://rpc.example.com', 'http://127.0.0.1.example.com:8899', 'http://localhost.example.com', 'not a url'];
test('classifyCluster: devnet/mainnet/testnet by genesis regardless of URL; local only for localhost + unknown genesis', () => {
  for (const u of [...LOCAL_URLS, ...REMOTE_URLS]) {
    assert.equal(classifyCluster(DEVNET_GENESIS, u), 'devnet'); assert.equal(classifyCluster(MAINNET_GENESIS, u), 'mainnet'); assert.equal(classifyCluster(TESTNET_GENESIS, u), 'testnet');
  }
  for (const u of LOCAL_URLS) { assert.ok(isLocalhostRpc(u), u); assert.equal(classifyCluster(LOCAL_GENESIS, u), 'local'); }
  for (const u of REMOTE_URLS) { assert.ok(!isLocalhostRpc(u), String(u)); assert.equal(classifyCluster(LOCAL_GENESIS, u), 'unknown'); }
});
test('DAMM pin matrix: localhost + mainnet/testnet genesis stays strict (URL never decides)', () => {
  for (const u of LOCAL_URLS) {
    assert.throws(() => resolveDammV2MigrationConfig(MAINNET_GENESIS, 'local', env(other()), u), ConfigPinRefusal);
    assert.equal(resolveDammV2MigrationConfig(MAINNET_GENESIS, 'local', env(), u).config.toBase58(), DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN);
    assert.throws(() => resolveDammV2MigrationConfig(TESTNET_GENESIS, 'local', env(other()), u), ConfigPinRefusal);   // testnet: no pin
    assert.throws(() => resolveDammV2MigrationConfig(TESTNET_GENESIS, 'local', env(), u), /no pinned DAMM_V2_MIGRATION_CONFIG/);
  }
});
test('DAMM pin matrix: localhost + unknown genesis → local (override allowed, default = cloned pin)', () => {
  for (const u of LOCAL_URLS) {
    const x = other(); const r = resolveDammV2MigrationConfig(LOCAL_GENESIS, 'local', env(x), u);
    assert.equal(r.config.toBase58(), x); assert.equal(r.override, x); assert.equal(r.clusterByGenesis, 'local');
    assert.equal(resolveDammV2MigrationConfig(LOCAL_GENESIS, 'local', env(), u).config.toBase58(), DAMM_V2_MIGRATION_CONFIG.local);
  }
});
test('DAMM pin matrix: non-localhost + unknown genesis → refused, with or without an override', () => {
  for (const u of REMOTE_URLS) {
    assert.throws(() => resolveDammV2MigrationConfig(LOCAL_GENESIS, 'local', env(other()), u), ConfigPinRefusal);
    assert.throws(() => resolveDammV2MigrationConfig(LOCAL_GENESIS, 'local', env(), u), /no pinned DAMM_V2_MIGRATION_CONFIG for cluster class 'unknown'/);
  }
});
test('migrate() via a cluster object: localhost URL + unknown genesis accepts the override; same genesis on a remote URL refuses before any build', async () => {
  const prev = process.env.DAMM_V2_MIGRATION_CONFIG; const x = other(); process.env.DAMM_V2_MIGRATION_CONFIG = x;
  const prevHook = process.env.HOOK_PROGRAM_ID; const localHook = Keypair.generate().publicKey; process.env.HOOK_PROGRAM_ID = localHook.toBase58();   // local needs it
  try {
    for (const [url, ok] of [['http://127.0.0.1:8899', true], ['https://rpc.example.com', false]] as const) {
      let usedConfig = '', built = 0;
      const connection: any = { getGenesisHash: async () => LOCAL_GENESIS, getAccountInfo: async () => { throw new Error('stop at cluster check'); } };
      const fake: any = { c: { name: 'local', url, connection }, hook: { programId: localHook }, dbc: { state: { getPool: async () => ({ config: Keypair.generate().publicKey }) }, migration: { migrateToDammV2: async (a: any) => { built++; usedConfig = a.dammConfig.toBase58(); return {}; } } } };
      // ok: resolution passed and the next gate (the cluster check) is what stops it
      if (ok) await assert.rejects(Launchpad.prototype.migrate.call(fake, Keypair.generate(), Keypair.generate().publicKey), (e: any) => e instanceof ClusterCheckRefusal && /stop at cluster check/.test(e.message));
      else await assert.rejects(Launchpad.prototype.migrate.call(fake, Keypair.generate(), Keypair.generate().publicKey), (e: any) => e instanceof ConfigPinRefusal && /class 'unknown'/.test(e.message));
      assert.equal(built, 0); void usedConfig;
    }
  } finally {
    if (prev === undefined) delete process.env.DAMM_V2_MIGRATION_CONFIG; else process.env.DAMM_V2_MIGRATION_CONFIG = prev;
    if (prevHook === undefined) delete process.env.HOOK_PROGRAM_ID; else process.env.HOOK_PROGRAM_ID = prevHook;
  }
});

test('keeper on cluster "local": needs localhost URL + unknown genesis; remote URL or a known genesis is refused', async () => {
  const { readFileSync } = await import('node:fs');
  const cfg = { ...JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')), cluster: 'local', pinned_pubkeys: undefined };
  const start = (rpcEndpoint: string, genesis: string) => startKeeper(cfg, [], { loadKey: () => Keypair.generate(), log: () => {},
    connect: async () => ({ rpcEndpoint, getGenesisHash: async () => genesis, getAccountInfo: async () => { throw new Error('reached cluster check'); } }) as any });
  await assert.rejects(start('https://rpc.example.com', LOCAL_GENESIS), (e: any) => e instanceof KeyRuleRefusal && /not a local validator/.test(e.message));
  await assert.rejects(start('http://127.0.0.1:8899', TESTNET_GENESIS), (e: any) => e instanceof KeyRuleRefusal && /not a local validator/.test(e.message));
  await assert.rejects(start('http://127.0.0.1:8899', DEVNET_GENESIS), (e: any) => e instanceof KeyRuleRefusal && /not a local validator/.test(e.message));
  await assert.rejects(start('http://127.0.0.1:8899', LOCAL_GENESIS), (e: any) => e instanceof KeyRuleRefusal && /reached cluster check/.test(e.message));
});

// Cluster check (program IDs must match the cluster): before any tx is built, (a) the hook program exists and is
// executable, (b) the DBC config exists and is owned by DBC, (c) the DAMM v2 migration config exists and is owned by
// DAMM v2. Missing accounts and RPC errors refuse. Configs are data accounts, so executable is NOT checked on them.
// Offline: every connection here is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { DEVNET_GENESIS } from '../sdk/cluster.js';
import { DBC_PROGRAM_ID, DAMM_V2_PROGRAM_ID, HOOK_PROGRAM_ID_DEVNET } from '../sdk/hook.js';
import { checkHookProgram, checkDbcConfig, checkDammV2Config, assertClusterAccounts, ClusterCheckRefusal } from '../sdk/cluster_check.js';
import { Launchpad, DAMM_V2_MIGRATION_CONFIG } from '../sdk/launch.js';
import { startKeeper } from '../sdk/flywheel/keeper.js';
import { KeyRuleRefusal } from '../sdk/keyrules.js';
import type { KeeperConfig } from '../sdk/flywheel/config.js';

const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const pk = () => Keypair.generate().publicKey;
type Info = { owner: PublicKey; executable: boolean; data?: Buffer; lamports?: number };
/** Fake RPC: accounts by address; anything else is missing. `fail` makes getAccountInfo reject (RPC error). */
function fakeConn(accts: Map<string, Info>, fail = false) {
  return {
    async getAccountInfo(k: PublicKey) { if (fail) throw new Error('fetch failed: 503 Service Unavailable'); return accts.get(k.toBase58()) ?? null; },
    async getGenesisHash() { return DEVNET_GENESIS; },
  } as any;
}
const program = (): Info => ({ owner: BPF_UPGRADEABLE, executable: true, data: Buffer.alloc(36) });
const dbcConfig = (): Info => ({ owner: DBC_PROGRAM_ID, executable: false });            // real configs are non-executable
const dammConfig = (): Info => ({ owner: DAMM_V2_PROGRAM_ID, executable: false });       // 328-byte data account on chain
const refused = (re: RegExp) => (e: any) => e instanceof ClusterCheckRefusal && re.test(e.message);

// ---------------- (a) hook program
test('(a) hook program: executable account passes; missing refuses; non-executable refuses', async () => {
  const hook = pk();
  await checkHookProgram(fakeConn(new Map([[hook.toBase58(), program()]])), hook);
  await assert.rejects(checkHookProgram(fakeConn(new Map()), hook), refused(/hook program .* does not exist/));
  await assert.rejects(checkHookProgram(fakeConn(new Map([[hook.toBase58(), { ...program(), executable: false }]])), hook), refused(/hook program .* is not executable/));
});

// ---------------- (b) DBC config
test('(b) DBC config: owned by DBC (non-executable) passes; missing refuses; wrong owner refuses', async () => {
  const cfg = pk();
  await checkDbcConfig(fakeConn(new Map([[cfg.toBase58(), dbcConfig()]])), cfg);
  await assert.rejects(checkDbcConfig(fakeConn(new Map()), cfg), refused(/DBC config .* does not exist/));
  for (const owner of [DAMM_V2_PROGRAM_ID, SYSTEM, pk()])
    await assert.rejects(checkDbcConfig(fakeConn(new Map([[cfg.toBase58(), { ...dbcConfig(), owner }]])), cfg), refused(/DBC config .* is owned by .*not the DBC program/));
});

// ---------------- (c) DAMM v2 migration config
test('(c) DAMM v2 migration config: pinned address owned by DAMM v2 (non-executable) passes; missing refuses; wrong owner refuses', async () => {
  const cfg = new PublicKey(DAMM_V2_MIGRATION_CONFIG.devnet);
  await checkDammV2Config(fakeConn(new Map([[cfg.toBase58(), dammConfig()]])), cfg);
  await assert.rejects(checkDammV2Config(fakeConn(new Map()), cfg), refused(/DAMM v2 migration config .* does not exist/));
  for (const owner of [DBC_PROGRAM_ID, SYSTEM, pk()])
    await assert.rejects(checkDammV2Config(fakeConn(new Map([[cfg.toBase58(), { ...dammConfig(), owner }]])), cfg), refused(/DAMM v2 migration config .* is owned by .*not the DAMM v2 program/));
});

// ---------------- RPC error: fail closed, never skip
test('RPC error on getAccountInfo refuses for every check (fail closed, not skipped)', async () => {
  const down = fakeConn(new Map(), true);
  await assert.rejects(checkHookProgram(down, pk()), refused(/could not read hook program .*RPC error: fetch failed/));
  await assert.rejects(checkDbcConfig(down, pk()), refused(/could not read DBC config .*RPC error/));
  await assert.rejects(checkDammV2Config(down, pk()), refused(/could not read DAMM v2 migration config .*RPC error/));
  await assert.rejects(assertClusterAccounts(down, { hookProgram: pk() }), ClusterCheckRefusal);
});

test('assertClusterAccounts runs every check it is given: all good passes, any single bad account refuses', async () => {
  const hook = pk(), dbc = pk(), damm = pk();
  const good = () => new Map<string, Info>([[hook.toBase58(), program()], [dbc.toBase58(), dbcConfig()], [damm.toBase58(), dammConfig()]]);
  const a = { hookProgram: hook, dbcConfigs: [dbc], dammV2Config: damm };
  await assertClusterAccounts(fakeConn(good()), a);
  for (const [k, bad, re] of [[hook, { ...program(), executable: false }, /not executable/], [dbc, { ...dbcConfig(), owner: DAMM_V2_PROGRAM_ID }, /not the DBC program/], [damm, { ...dammConfig(), owner: DBC_PROGRAM_ID }, /not the DAMM v2 program/]] as const) {
    const m = good(); m.set(k.toBase58(), bad as Info);
    await assert.rejects(assertClusterAccounts(fakeConn(m), a), refused(re));
  }
});

// ---------------- wiring: the checks run before any tx is built
function fakeLaunchpad(accts: Map<string, Info>, poolConfig: PublicKey, hook: PublicKey, counters: { built: number }) {
  return {
    c: { name: 'devnet', label: 'devnet', connection: fakeConn(accts) },
    hook: { programId: hook },
    configParams: () => ({}),
    dbc: {
      state: { getPool: async () => ({ config: poolConfig }) },
      migration: { migrateToDammV2: async () => { counters.built++; throw new Error('tx built'); } },
      partner: { createConfigWithTransferHook: async () => { counters.built++; throw new Error('tx built'); } },
    },
  };
}
test('migrate(): each of the three checks refuses before migrateToDammV2 builds a tx; all good reaches the build', async () => {
  const hook = new PublicKey(HOOK_PROGRAM_ID_DEVNET), poolCfg = pk(), damm = new PublicKey(DAMM_V2_MIGRATION_CONFIG.devnet);   // devnet genesis → pinned hook id
  const good = () => new Map<string, Info>([[hook.toBase58(), program()], [poolCfg.toBase58(), dbcConfig()], [damm.toBase58(), dammConfig()]]);
  const saved = process.env.DAMM_V2_MIGRATION_CONFIG; delete process.env.DAMM_V2_MIGRATION_CONFIG;
  try {
    for (const [k, re] of [[hook, /hook program .* does not exist/], [poolCfg, /DBC config .* does not exist/], [damm, /DAMM v2 migration config .* does not exist/]] as const) {
      const m = good(); m.delete(k.toBase58()); const n = { built: 0 };
      await assert.rejects(Launchpad.prototype.migrate.call(fakeLaunchpad(m, poolCfg, hook, n) as any, Keypair.generate(), pk()), refused(re));
      assert.equal(n.built, 0);
    }
    const n = { built: 0 };
    await assert.rejects(Launchpad.prototype.migrate.call(fakeLaunchpad(good(), poolCfg, hook, n) as any, Keypair.generate(), pk()), /tx built/);
    assert.equal(n.built, 1);
    // missing pool / pool read error also refuse
    const lp: any = fakeLaunchpad(good(), poolCfg, hook, n);
    lp.dbc.state.getPool = async () => null;
    await assert.rejects(Launchpad.prototype.migrate.call(lp, Keypair.generate(), pk()), refused(/DBC pool .* does not exist/));
    lp.dbc.state.getPool = async () => { throw new Error('503'); };
    await assert.rejects(Launchpad.prototype.migrate.call(lp, Keypair.generate(), pk()), refused(/could not read DBC pool/));
    assert.equal(n.built, 1);
  } finally { if (saved !== undefined) process.env.DAMM_V2_MIGRATION_CONFIG = saved; }
});

test('launch(): a non-executable hook program refuses before create_config is built', async () => {
  const hook = new PublicKey(HOOK_PROGRAM_ID_DEVNET); const n = { built: 0 };
  const authorities = { upgradeAuthority: pk().toBase58(), liftAuthority: pk().toBase58() };
  const lp = fakeLaunchpad(new Map([[hook.toBase58(), { ...program(), executable: false }]]), pk(), hook, n);
  await assert.rejects(Launchpad.prototype.launch.call(lp as any, Keypair.generate(), { name: 'x', symbol: 'X', steps: [], uncappedAfter: 1n, authorities } as any), refused(/not executable/));
  assert.equal(n.built, 0);
  const ok = fakeLaunchpad(new Map([[hook.toBase58(), program()]]), pk(), hook, n);
  await assert.rejects(Launchpad.prototype.launch.call(ok as any, Keypair.generate(), { name: 'x', symbol: 'X', steps: [], uncappedAfter: 1n, authorities } as any), /tx built/);
  assert.equal(n.built, 1);
});

test('startKeeper(): non-executable hook or a DBC source config not owned by DBC refuses; good accounts reach the authority pin check', async () => {
  const base = JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')) as KeeperConfig;
  const cfg: KeeperConfig = { ...base, pinned_pubkeys: undefined };
  const hook = new PublicKey(cfg.hook_program);
  const dbcSrc = cfg.sources.flatMap(s => (s.kind === 'dbc' ? [s.config] : []));
  assert.ok(dbcSrc.length > 0, 'fixture has a DBC source');
  const good = () => new Map<string, Info>([[hook.toBase58(), program()], ...dbcSrc.map(c => [c, dbcConfig()] as [string, Info])]);
  const deps = (m: Map<string, Info>) => ({ loadKey: () => Keypair.generate(), connect: async () => fakeConn(m) as Connection, log: () => {} });
  const m1 = good(); m1.set(hook.toBase58(), { ...program(), executable: false });
  await assert.rejects(startKeeper(cfg, [], deps(m1)), (e: any) => e instanceof KeyRuleRefusal && /hook program .* is not executable/.test(e.message));
  const m2 = good(); m2.set(dbcSrc[0], { ...dbcConfig(), owner: SYSTEM });
  await assert.rejects(startKeeper(cfg, [], deps(m2)), (e: any) => e instanceof KeyRuleRefusal && /DBC config .* not the DBC program/.test(e.message));
  await assert.rejects(startKeeper(cfg, [], { ...deps(good()), connect: async () => fakeConn(new Map(), true) as Connection }), (e: any) => e instanceof KeyRuleRefusal && /RPC error/.test(e.message));
  await assert.rejects(startKeeper(cfg, [], deps(good())), (e: any) => e instanceof KeyRuleRefusal && /hook authorit/.test(e.message));   // past the cluster check: reaches the authority read
});

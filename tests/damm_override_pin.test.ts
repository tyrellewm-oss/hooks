// QA mainnet blocker #3: the DAMM v2 migration config env override is a devnet-only knob. On any cluster whose genesis
// hash is not devnet's it must equal the pinned mainnet value, and a mismatch is refused before any tx is built. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Connection } from '@solana/web3.js';
import { DEVNET_GENESIS, MAINNET_GENESIS } from '../sdk/cluster.js';
import { DBC_PROGRAM_ID, DAMM_V2_PROGRAM_ID } from '../sdk/hook.js';
import { Launchpad, resolveDammV2MigrationConfig, ConfigPinRefusal, DAMM_V2_MIGRATION_CONFIG, DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN } from '../sdk/launch.js';

const LOCAL_GENESIS = Keypair.generate().publicKey.toBase58();   // a local validator has its own random genesis
const other = () => Keypair.generate().publicKey.toBase58();
const env = (v?: string) => (v === undefined ? {} : { DAMM_V2_MIGRATION_CONFIG: v }) as NodeJS.ProcessEnv;

test('no override → pinned per-cluster value (devnet, mainnet, local)', () => {
  for (const [g, name, want, by] of [[DEVNET_GENESIS, 'devnet', DAMM_V2_MIGRATION_CONFIG.devnet, 'devnet'], [MAINNET_GENESIS, 'devnet', DAMM_V2_MIGRATION_CONFIG_MAINNET_PIN, 'mainnet'], [LOCAL_GENESIS, 'local', DAMM_V2_MIGRATION_CONFIG.local, 'other']] as const) {
    const r = resolveDammV2MigrationConfig(g, name, env());
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
    const hook = Keypair.generate().publicKey, poolCfg = Keypair.generate().publicKey;
    const accts = new Map<string, any>([[hook.toBase58(), { owner: hook, executable: true }], [poolCfg.toBase58(), { owner: DBC_PROGRAM_ID, executable: false }], [x, { owner: DAMM_V2_PROGRAM_ID, executable: false }]]);
    let usedConfig = ''; const connection: any = { getGenesisHash: async () => DEVNET_GENESIS, getAccountInfo: async (k: any) => accts.get(k.toBase58()) ?? null, getLatestBlockhash: async () => { throw new Error('stop before send'); } };
    const fake: any = { c: { name: 'devnet', connection }, hook: { programId: hook }, dbc: { state: { getPool: async () => ({ config: poolCfg }) }, migration: { migrateToDammV2: async (a: any) => { usedConfig = a.dammConfig.toBase58(); return { transaction: {}, firstPositionNftKeypair: Keypair.generate(), secondPositionNftKeypair: Keypair.generate() }; } } } };
    await assert.rejects(Launchpad.prototype.migrate.call(fake, Keypair.generate(), Keypair.generate().publicKey), /stop before send/);
    assert.equal(usedConfig, x);
  } finally { if (prev === undefined) delete process.env.DAMM_V2_MIGRATION_CONFIG; else process.env.DAMM_V2_MIGRATION_CONFIG = prev; }
});

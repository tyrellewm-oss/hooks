// scripts/devnet_postmig.ts checks the DAMM v2 migration config before any tx (QA #3 M21). The check lives in
// postMigrationDammConfig() so it can be tested; the script must call it. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DEVNET_GENESIS, MAINNET_GENESIS } from '../sdk/cluster.js';
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID } from '../sdk/hook.js';
import { ClusterCheckRefusal } from '../sdk/cluster_check.js';
import { postMigrationDammConfig, ConfigPinRefusal, DAMM_V2_MIGRATION_CONFIG } from '../sdk/launch.js';

const PIN = DAMM_V2_MIGRATION_CONFIG.devnet;
const cl = (genesis: string, accts: Record<string, any>) => ({ name: 'devnet' as const, connection: { getGenesisHash: async () => genesis, getAccountInfo: async (k: PublicKey) => accts[k.toBase58()] ?? null } as any });
const env = (v?: string) => (v === undefined ? {} : { DAMM_V2_MIGRATION_CONFIG: v }) as NodeJS.ProcessEnv;

test('postMigrationDammConfig: pinned config owned by DAMM v2 passes; missing or wrong owner refuses (cluster check)', async () => {
  assert.equal((await postMigrationDammConfig(cl(DEVNET_GENESIS, { [PIN]: { owner: DAMM_V2_PROGRAM_ID, executable: false } }), env())).config.toBase58(), PIN);
  await assert.rejects(postMigrationDammConfig(cl(DEVNET_GENESIS, {}), env()), (e: any) => e instanceof ClusterCheckRefusal && /does not exist/.test(e.message));
  await assert.rejects(postMigrationDammConfig(cl(DEVNET_GENESIS, { [PIN]: { owner: DBC_PROGRAM_ID, executable: false } }), env()), (e: any) => e instanceof ClusterCheckRefusal && /not the DAMM v2 program/.test(e.message));
});
test('postMigrationDammConfig: a devnet override is checked too; a mainnet-genesis mismatching override refuses before any account read', async () => {
  const x = Keypair.generate().publicKey.toBase58();
  await assert.rejects(postMigrationDammConfig(cl(DEVNET_GENESIS, { [PIN]: { owner: DAMM_V2_PROGRAM_ID, executable: false } }), env(x)), (e: any) => e instanceof ClusterCheckRefusal && new RegExp(x).test(e.message));
  let reads = 0; const c = cl(MAINNET_GENESIS, {}); c.connection.getAccountInfo = async () => { reads++; return null; };
  await assert.rejects(postMigrationDammConfig(c, env(x)), ConfigPinRefusal); assert.equal(reads, 0);
});
test('scripts/devnet_postmig.ts resolves its DAMM config only through postMigrationDammConfig (no unchecked path)', () => {
  const src = readFileSync('scripts/devnet_postmig.ts', 'utf8');
  assert.match(src, /await postMigrationDammConfig\(c\)/);
  assert.doesNotMatch(src, /dammV2MigrationConfigFor|resolveDammV2MigrationConfig|DAMM_V2_MIGRATION_CONFIG\[/);
  // the check runs before the first tx in the script
  assert.ok(src.indexOf('postMigrationDammConfig(c)') < src.indexOf('sendTx(c,'));
});

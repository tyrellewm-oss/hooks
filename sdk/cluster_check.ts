// Cluster check: program IDs and config accounts must exist on the cluster the RPC points at, with the expected shape,
// before any tx that uses them is built. Fail closed: a missing account or an RPC error refuses, it never skips.
import { PublicKey } from '@solana/web3.js';
import { DBC_PROGRAM_ID, DAMM_V2_PROGRAM_ID } from './hook.js';

export class ClusterCheckRefusal extends Error {}
/** The one RPC call the checks need (a web3.js Connection satisfies it). */
export interface AccountReader { getAccountInfo(pk: PublicKey, commitment?: any): Promise<{ owner: PublicKey; executable: boolean } | null> }

async function fetchOrRefuse(conn: AccountReader, pk: PublicKey, what: string) {
  let info;
  try { info = await conn.getAccountInfo(pk, 'confirmed'); }
  catch (e: any) { throw new ClusterCheckRefusal(`refusing: cluster check could not read ${what} ${pk.toBase58()} (RPC error: ${String(e?.message ?? e).slice(0, 200)})`); }
  if (!info) throw new ClusterCheckRefusal(`refusing: ${what} ${pk.toBase58()} does not exist on this cluster`);
  return info;
}

/** (a) the hook program account exists and is executable. */
export async function checkHookProgram(conn: AccountReader, hookProgram: PublicKey): Promise<void> {
  const info = await fetchOrRefuse(conn, hookProgram, 'hook program');
  if (info.executable !== true) throw new ClusterCheckRefusal(`refusing: hook program ${hookProgram.toBase58()} is not executable on this cluster`);
}
/** (b) the DBC config account exists and is owned by the DBC program. Configs are data accounts: executable is not checked. */
export async function checkDbcConfig(conn: AccountReader, config: PublicKey): Promise<void> {
  const info = await fetchOrRefuse(conn, config, 'DBC config');
  if (!info.owner.equals(DBC_PROGRAM_ID)) throw new ClusterCheckRefusal(`refusing: DBC config ${config.toBase58()} is owned by ${info.owner.toBase58()}, not the DBC program ${DBC_PROGRAM_ID.toBase58()}`);
}
/** (c) the DAMM v2 migration config account exists and is owned by the DAMM v2 program. Executable is not checked. */
export async function checkDammV2Config(conn: AccountReader, config: PublicKey): Promise<void> {
  const info = await fetchOrRefuse(conn, config, 'DAMM v2 migration config');
  if (!info.owner.equals(DAMM_V2_PROGRAM_ID)) throw new ClusterCheckRefusal(`refusing: DAMM v2 migration config ${config.toBase58()} is owned by ${info.owner.toBase58()}, not the DAMM v2 program ${DAMM_V2_PROGRAM_ID.toBase58()}`);
}
/** Run every check that applies to a path. Throws ClusterCheckRefusal on the first failure. */
export async function assertClusterAccounts(conn: AccountReader, a: { hookProgram?: PublicKey; dbcConfigs?: PublicKey[]; dammV2Config?: PublicKey }): Promise<void> {
  if (a.hookProgram) await checkHookProgram(conn, a.hookProgram);
  for (const c of a.dbcConfigs ?? []) await checkDbcConfig(conn, c);
  if (a.dammV2Config) await checkDammV2Config(conn, a.dammV2Config);
}

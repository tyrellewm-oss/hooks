// Local simulation support: fetch the DEPLOYED devnet bytecode of the programs a launch touches (Meteora DBC and the
// Hookd hook), read-only over RPC, and cache it in .sim-programs/ (gitignored). The bytes run inside litesvm, in
// process, so a whole launch + trades can be exercised without keys, SOL or a validator. Devnet only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { DEVNET_RPC_DEFAULT, assertNotMainnet } from '../../sdk/cluster.js';

const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const SIM_DIR = '.sim-programs';
export const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const HOOK_PROGRAM = new PublicKey('FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz');

/** ELF bytes of an upgradeable program (ProgramData header is 45 bytes). Cached by program id. */
export async function programBytes(id: PublicKey, rpc = process.env.DEVNET_RPC ?? DEVNET_RPC_DEFAULT): Promise<Buffer> {
  const file = `${SIM_DIR}/${id.toBase58()}.so`;
  if (existsSync(file)) return readFileSync(file);
  assertNotMainnet(rpc);
  const conn = new Connection(rpc, 'confirmed');
  const prog = await conn.getAccountInfo(id);
  if (!prog?.executable || !prog.owner.equals(BPF_UPGRADEABLE)) throw new Error(`${id.toBase58()} is not an upgradeable program on this cluster`);
  const programData = new PublicKey(prog.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData);
  if (!pd) throw new Error(`no ProgramData for ${id.toBase58()}`);
  const elf = pd.data.subarray(45);
  mkdirSync(SIM_DIR, { recursive: true });
  writeFileSync(file, elf);
  return Buffer.from(elf);
}

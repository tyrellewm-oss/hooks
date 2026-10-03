// Throwaway keypairs, generated at runtime, stored ONLY in gitignored dirs (.devnet-keys/, .local-keys/).
import { Keypair } from '@solana/web3.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClusterName } from './cluster.js';
export const keyDir = (c: ClusterName) => (c === 'devnet' ? '.devnet-keys' : '.local-keys');
export function loadOrCreate(c: ClusterName, name: string): Keypair {
  const dir = keyDir(c); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${name}.json`);
  if (existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
  const k = Keypair.generate(); writeFileSync(p, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 }); return k;
}
/** The deployer/upgrade-authority key used by `solana program deploy` for this cluster. */
export const deployerName = (c: ClusterName) => (c === 'devnet' ? 'deployer' : 'local');

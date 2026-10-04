// Throwaway keypairs, generated at runtime, stored ONLY in gitignored dirs (.devnet-keys/, .local-keys/), or for devnet
// in DEVNET_KEY_DIR (an absolute path outside the repo, e.g. ~/.devnet-keys) when set.
import { Keypair } from '@solana/web3.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, resolve, relative } from 'node:path';
import type { ClusterName } from './cluster.js';
/** DEVNET_KEY_DIR must be an absolute path outside the repo (keys never live in the working tree's tracked area). */
export function devnetKeyDirOverride(env: NodeJS.ProcessEnv = process.env, repo: string = process.cwd()): string | null {
  const v = env.DEVNET_KEY_DIR;
  if (v === undefined || v === '') return null;
  if (!isAbsolute(v)) throw new Error('refusing: DEVNET_KEY_DIR must be an absolute path');
  const rel = relative(resolve(repo), resolve(v));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('refusing: DEVNET_KEY_DIR must be outside the repo');
  return v;
}
export const keyDir = (c: ClusterName) => (c === 'devnet' ? devnetKeyDirOverride() ?? '.devnet-keys' : '.local-keys');
export function loadOrCreate(c: ClusterName, name: string): Keypair {
  const dir = keyDir(c); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${name}.json`);
  if (existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
  // the devnet deployer is the program upgrade + Global admin key: never created here (a wrong key dir fails closed)
  if (c === 'devnet' && name === deployerName(c)) throw new Error(`refusing: the devnet ${name} key is not in ${dir}/ (it is never created by this tool)`);
  const k = Keypair.generate(); writeFileSync(p, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600, flag: 'wx' }); return k;
}
/** The deployer/upgrade-authority key used by `solana program deploy` for this cluster. */
export const deployerName = (c: ClusterName) => (c === 'devnet' ? 'deployer' : 'local');

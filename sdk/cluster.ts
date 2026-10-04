// Cluster resolution with hard guards: only LOCAL (default) or DEVNET. There is no mainnet code path.
import { Connection, type PublicKey } from '@solana/web3.js';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
/** Genesis-based cluster class. The URL never decides on its own: `local` needs a localhost RPC URL AND a genesis
 *  that is none of devnet/mainnet/testnet. A non-localhost URL with an unknown genesis is `unknown` (callers refuse). */
export type ClusterClass = 'devnet' | 'mainnet' | 'testnet' | 'local' | 'unknown';
export function isLocalhostRpc(url?: string): boolean {
  if (!url) return false;
  let host: string; try { host = new URL(url).hostname; } catch { return false; }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}
export function classifyCluster(genesis: string, url?: string): ClusterClass {
  if (genesis === DEVNET_GENESIS) return 'devnet';
  if (genesis === MAINNET_GENESIS) return 'mainnet';
  if (genesis === TESTNET_GENESIS) return 'testnet';
  return isLocalhostRpc(url) ? 'local' : 'unknown';
}
export const DEVNET_RPC_DEFAULT = 'https://solana-devnet.api.onfinality.io/public';
export const LOCAL_RPC_DEFAULT = 'http://127.0.0.1:8899';
export type ClusterName = 'local' | 'devnet';
export interface Cluster { name: ClusterName; url: string; label: 'LOCAL' | 'DEVNET'; connection: Connection; /** set by the hook gate; used for log attribution */ hookProgram?: PublicKey }

export function assertNotMainnet(url: string) {
  if (/mainnet/i.test(url)) throw new Error(`refusing mainnet-looking RPC URL: ${url}`);
}
export async function resolveCluster(name: ClusterName = 'local'): Promise<Cluster> {
  const url = name === 'devnet' ? process.env.DEVNET_RPC ?? DEVNET_RPC_DEFAULT : process.env.LOCAL_RPC ?? LOCAL_RPC_DEFAULT;
  assertNotMainnet(url);
  const connection = new Connection(url, 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_GENESIS) throw new Error('refusing: RPC is mainnet-beta');
  if (name === 'devnet' && genesis !== DEVNET_GENESIS) throw new Error(`not devnet (genesis ${genesis})`);
  if (name === 'local' && classifyCluster(genesis, url) !== 'local') throw new Error(`refusing: not a local validator (needs a localhost RPC URL and a genesis that is not devnet/mainnet/testnet; got ${classifyCluster(genesis, url)})`);
  return { name, url, label: name === 'devnet' ? 'DEVNET' : 'LOCAL', connection };
}
export function parseClusterArg(argv: string[]): ClusterName {
  const i = argv.indexOf('--cluster');
  const v = i >= 0 ? argv[i + 1] : 'local';
  if (v !== 'local' && v !== 'devnet') throw new Error(`--cluster must be local or devnet (got ${v}); there is no mainnet option`);
  return v;
}
export const explorerTx = (sig: string, c: ClusterName) =>
  c === 'devnet' ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`;
export const explorerAddr = (a: string, c: ClusterName) =>
  c === 'devnet' ? `https://explorer.solana.com/address/${a}?cluster=devnet` : `https://explorer.solana.com/address/${a}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`;
export const nowIct = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }) + ' ICT';

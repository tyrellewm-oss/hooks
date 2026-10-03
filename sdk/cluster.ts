// Cluster resolution with hard guards: only LOCAL (default) or DEVNET. There is no mainnet code path.
import { Connection } from '@solana/web3.js';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const DEVNET_RPC_DEFAULT = 'https://solana-devnet.api.onfinality.io/public';
export const LOCAL_RPC_DEFAULT = 'http://127.0.0.1:8899';
export type ClusterName = 'local' | 'devnet';
export interface Cluster { name: ClusterName; url: string; label: 'LOCAL' | 'DEVNET'; connection: Connection }

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

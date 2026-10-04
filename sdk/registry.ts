// Mint registry (ticket 8.5): the mints this deployment launched, per cluster, in keeper/registry.json.
// The keeper acts on these mints only. assertRegistryMint is the reusable check; assertRegistryPoolPair (ticket #5,
// refusal 8) applies it to a pool's two mints.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { KeyRuleRefusal } from './keyrules.js';

/** keeper/registry.json in this repo, resolved from this file (not from the working directory). */
export const REGISTRY_PATH = fileURLToPath(new URL('../keeper/registry.json', import.meta.url));
export class RegistryRefusal extends KeyRuleRefusal { constructor(msg: string) { super(msg); this.name = 'RegistryRefusal'; } }

/** The registered mints for `cluster`, read fresh on every call. A missing or unreadable file, a missing cluster list, a
 *  non-string entry or an invalid address refuses. Matching is exact (base58 string equality); an empty list matches nothing. */
export function loadRegistry(cluster: string, path = REGISTRY_PATH): ReadonlySet<string> {
  let j: any;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch (e: any) { throw new RegistryRefusal(`refusing: cannot read the mint registry ${path} (${String(e?.message ?? e).slice(0, 200)})`); }
  const list = j?.[cluster];
  if (!Array.isArray(list)) throw new RegistryRefusal(`refusing: the mint registry has no "${cluster}" list`);
  return new Set(list.map((m: unknown) => {
    if (typeof m !== 'string') throw new RegistryRefusal(`refusing: the mint registry has a non-string "${cluster}" entry: ${String(m)}`);
    try { new PublicKey(m); return m; } catch { throw new RegistryRefusal(`refusing: the mint registry has an invalid "${cluster}" entry: ${String(m)}`); }
  }));
}

/** Throws RegistryRefusal unless `mint` is in the registry. `what` names the mint in the message. */
export function assertRegistryMint(registry: ReadonlySet<string>, mint: PublicKey | string, what = 'mint'): void {
  const m = typeof mint === 'string' ? mint : mint.toBase58();
  if (!registry.has(m)) throw new RegistryRefusal(`refusing: ${what} ${m} is not in the mint registry`);
}

/** The wrapped SOL mint (the quote side of every pool the keeper trades on). */
export const WSOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
/** Ticket #5, refusal 8: a pool pair refusal. `kind` is 'pair' when the two mints are not {one mint, wSOL} and
 *  'registry' when the non-wSOL mint is not in the registry. */
export class RegistryPairRefusal extends RegistryRefusal { constructor(msg: string, public kind: 'pair' | 'registry') { super(msg); this.name = 'RegistryPairRefusal'; } }
/** Ticket #5, refusal 8: throws RegistryPairRefusal unless the pool's two mints are a registry mint and wSOL, in
 *  either order. Returns the registry mint. Exact (base58 string) matching, as assertRegistryMint. */
export function assertRegistryPoolPair(registry: ReadonlySet<string>, tokenA: PublicKey | string, tokenB: PublicKey | string): string {
  const a = typeof tokenA === 'string' ? tokenA : tokenA.toBase58();
  const b = typeof tokenB === 'string' ? tokenB : tokenB.toBase58();
  const other = a === b ? null : a === WSOL_MINT_ADDRESS ? b : b === WSOL_MINT_ADDRESS ? a : null;
  if (other === null) throw new RegistryPairRefusal(`refusing: pool mints ${a} / ${b} are not a registry mint and wSOL`, 'pair');
  try { assertRegistryMint(registry, other, 'pool mint'); }
  catch (e: any) { throw e instanceof RegistryRefusal ? new RegistryPairRefusal(e.message, 'registry') : e; }
  return other;
}

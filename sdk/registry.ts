// Mint registry (ticket 8.5): the mints this deployment launched, per cluster, in keeper/registry.json.
// The keeper acts on these mints only. assertRegistryMint is the reusable check (also meant for #5, refusal 8).
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { KeyRuleRefusal } from './keyrules.js';

export const REGISTRY_PATH = 'keeper/registry.json';
export class RegistryRefusal extends KeyRuleRefusal { constructor(msg: string) { super(msg); this.name = 'RegistryRefusal'; } }

/** The registered mints for `cluster`. A missing or unreadable file, a missing cluster list or an invalid address refuses. */
export function loadRegistry(cluster: string, path = REGISTRY_PATH): ReadonlySet<string> {
  let j: any;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch (e: any) { throw new RegistryRefusal(`refusing: cannot read the mint registry ${path} (${String(e?.message ?? e).slice(0, 200)})`); }
  const list = j?.[cluster];
  if (!Array.isArray(list)) throw new RegistryRefusal(`refusing: the mint registry has no "${cluster}" list`);
  return new Set(list.map((m: unknown) => {
    try { return new PublicKey(m as string).toBase58(); } catch { throw new RegistryRefusal(`refusing: the mint registry has an invalid "${cluster}" entry: ${String(m)}`); }
  }));
}

/** Throws RegistryRefusal unless `mint` is in the registry. `what` names the mint in the message. */
export function assertRegistryMint(registry: ReadonlySet<string>, mint: PublicKey | string, what = 'mint'): void {
  const m = typeof mint === 'string' ? mint : mint.toBase58();
  if (!registry.has(m)) throw new RegistryRefusal(`refusing: ${what} ${m} is not in the mint registry`);
}

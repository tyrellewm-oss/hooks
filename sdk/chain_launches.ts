// Launches found on chain. Every launch carries the launch key's signature (ticket 8.3: the hook program refuses any
// other launch signer), so the launch key's transaction history is the list of launches, and nothing has to be written
// anywhere when someone launches from the site. Each launch tx is parsed once (its DBC create-pool instruction names
// the config, the creator wallet and the mint; the instruction data carries the name, symbol and URI) and kept for the
// life of the process; the signature list is re-read at most every `ttlMs`. Read-only: no keys, no sends.
import { PublicKey, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { DBC_PROGRAM_ID } from './hook.js';
import { DBC_INIT_POOL_T22_HOOK_DISC } from './mint_hook.js';

export interface ChainLaunch {
  mint: string; pool: string; config: string;
  /** the wallet that paid for and created the pool */
  creator: string;
  name: string; symbol: string; uri: string;
  /** block time, ISO 8601 */
  time: string;
  /** the launch transaction */
  sig: string;
}

/** A borsh string (u32 LE length + UTF-8) at `o`; throws past the end. */
function borshString(b: Buffer, o: number): [string, number] {
  const n = b.readUInt32LE(o);
  if (o + 4 + n > b.length || n > 1024) throw new RangeError('string past the end of the instruction data');
  return [b.subarray(o + 4, o + 4 + n).toString('utf8'), o + 4 + n];
}

/** The launch a confirmed transaction made: its one DBC initialize_virtual_pool_with_token2022_transfer_hook (accounts
 *  config 0, creator 2, base_mint 3; data = name, symbol, uri). Null for a failed tx or any other transaction. Pure. */
export function launchFromTx(tx: Pick<VersionedTransactionResponse, 'transaction' | 'meta' | 'blockTime'> | null, sig: string, dbc: PublicKey = DBC_PROGRAM_ID): ChainLaunch | null {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  for (const ix of msg.compiledInstructions) {
    if (!keys.get(ix.programIdIndex)?.equals(dbc)) continue;
    const data = Buffer.from(ix.data);
    if (!data.subarray(0, 8).equals(DBC_INIT_POOL_T22_HOOK_DISC)) continue;
    const at = (i: number) => (ix.accountKeyIndexes[i] === undefined ? undefined : keys.get(ix.accountKeyIndexes[i]));
    const config = at(0), creator = at(2), mint = at(3);
    if (!config || !creator || !mint) return null;
    try {
      const [name, o1] = borshString(data, 8); const [symbol, o2] = borshString(data, o1); const [uri] = borshString(data, o2);
      return { mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, config).toBase58(), config: config.toBase58(), creator: creator.toBase58(),
        name, symbol, uri, time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : '', sig };
    } catch { return null; }
  }
  return null;
}

/** The narrow RPC surface this needs (tests pass a fake). */
export interface ChainLaunchRpc {
  getSignaturesForAddress(a: PublicKey, o?: { before?: string; limit?: number }, c?: 'confirmed' | 'finalized'): Promise<ConfirmedSignatureInfo[]>;
  getTransaction(sig: string, o: { maxSupportedTransactionVersion: 0; commitment: 'confirmed' | 'finalized' }): Promise<VersionedTransactionResponse | null>;
}

/** Newest first. `launchAuthority` resolves the on-chain launch key (null = not set: no launches). */
export class ChainLaunches {
  private parsed = new Map<string, ChainLaunch | null>();
  private list: ChainLaunch[] = [];
  private at = -Infinity;
  private pending: Promise<ChainLaunch[]> | null = null;
  constructor(private readonly rpc: ChainLaunchRpc, private readonly launchAuthority: () => Promise<PublicKey | null>,
    private readonly opts: { dbc?: PublicKey; ttlMs?: number; minRefreshMs?: number; maxSignatures?: number; batch?: number; now?: () => number } = {}) {}

  /** The launches, re-read when older than ttlMs. An RPC failure keeps the last good list (and retries next call).
   *  `want`: a mint the caller is looking for. When it is missing, the list is re-read early (at most every
   *  minRefreshMs): a token page opened right after its launch may hit a process whose list predates it. */
  async get(want?: string): Promise<ChainLaunch[]> {
    const now = (this.opts.now ?? Date.now)();
    const fresh = now - this.at < (this.opts.ttlMs ?? 15_000);
    const early = want !== undefined && !this.list.some((l) => l.mint === want) && now - this.at >= (this.opts.minRefreshMs ?? 3_000);
    if (fresh && !early) return this.list;
    this.pending ??= this.refresh().catch((e) => { console.warn(`chain launches: keeping the last list (${String(e?.message ?? e).slice(0, 160)})`); return this.list; }).finally(() => { this.pending = null; });
    return this.pending;
  }

  /** Forget the list age, so the next get() re-reads (after a launch from this site). */
  invalidate() { this.at = -Infinity; }

  private async refresh(): Promise<ChainLaunch[]> {
    const auth = await this.launchAuthority();
    if (!auth) { this.list = []; this.at = (this.opts.now ?? Date.now)(); return this.list; }
    const sigs: ConfirmedSignatureInfo[] = [];
    const max = this.opts.maxSignatures ?? 5000;
    for (let before: string | undefined; sigs.length < max;) {
      const page = await this.rpc.getSignaturesForAddress(auth, { limit: 1000, ...(before ? { before } : {}) }, 'confirmed');
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    const ok = sigs.filter((s) => !s.err);
    const todo = ok.filter((s) => !this.parsed.has(s.signature));
    const n = this.opts.batch ?? 8;
    for (let i = 0; i < todo.length; i += n) {
      await Promise.all(todo.slice(i, i + n).map(async (s) => {
        const tx = await this.rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (tx) this.parsed.set(s.signature, launchFromTx(tx, s.signature, this.opts.dbc ?? DBC_PROGRAM_ID));   // not yet served: retried next time
      }));
    }
    const seen = new Set<string>();
    this.list = ok.map((s) => this.parsed.get(s.signature)).filter((l): l is ChainLaunch => !!l && !seen.has(l.mint) && !!seen.add(l.mint));
    this.at = (this.opts.now ?? Date.now)();
    return this.list;
  }
}

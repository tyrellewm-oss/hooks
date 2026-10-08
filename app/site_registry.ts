// Ticket 8.5b: the site serves registry mints only. The listing (/api/meta), /api/token/<mint>, /api/trade and /api/wallet/build go
// through siteRoute: one loadRegistry read per request (sdk/registry.ts, no second parser, nothing cached), shared by
// every check in that request, and run before any local-record lookup, RPC call or `new PublicKey`. Matching is exact
// (base58 string equality after one URL decode). An unknown or malformed mint is a 404, and so is a registered mint
// with no local launch record (token and trade alike, with no chain call); an unreadable registry is a 503 for the
// whole response. The site never writes keeper/registry.json; /api/create marks new mints unregistered.
// Open launch adds `discovered`: launches a user's wallet made, found on chain (they carry the on-chain launch key's
// signature), listed and served next to the registry's; read only when a request needs more than the registry.
import { loadRegistry, REGISTRY_PATH } from '../sdk/registry.js';

export const NOT_REGISTERED_NOTE = 'not registered: add to keeper/registry.json';
export interface Reply { code: number; body: unknown; /** non-JSON body (an image); sent as-is with this content type */ type?: string }
export interface SiteRecord { mint: string }
export interface SiteDeps<R extends SiteRecord = SiteRecord> {
  cluster: string;
  registryPath?: string;
  /** the registry loader; tests wrap it to count reads */
  load?: (cluster: string, path?: string) => ReadonlySet<string>;
  /** local launch records (launches/<cluster>/), in record order */
  launches(): R[];
  /** launches found on chain that are listed without the registry (newest first); optional. `want` = the mint a token
   *  route looks for (the list may be re-read early when it is missing) */
  discovered?(want?: string): Promise<R[]>;
  /** the /api/meta body around the filtered listing */
  meta(listing: R[]): unknown | Promise<unknown>;
  /** the token view; reads the chain. `rec` = the record the route found. */
  token(mint: string, rec: R): Promise<unknown>;
  /** the trade; reads the chain and sends */
  trade(body: any, rec: R): Promise<Reply>;
  /** browser-wallet build (AC-21): an unsigned swap for the user's wallet; reads the chain, never signs or sends */
  build?(body: any, rec: R): Promise<Reply>;
  /** transparency page: the keeper's public logs, filtered to the registry read for this request */
  flywheel?(registered: ReadonlySet<string>): unknown | Promise<unknown>;
  /** price chart and trades feed: the indexer's file for this mint (read-only, no chain call) */
  trades?(mint: string): unknown | Promise<unknown>;
  /** token image bytes (Reply with type), or a 404 Reply */
  image?(mint: string): Reply | Promise<Reply>;
  /** studio edit of the token's details (image, description, links) */
  metadata?(mint: string, body: any): Reply | Promise<Reply>;
  /** the token's metadata JSON (GET /api/token/<mint>/metadata.json: what its on-chain URI points to) */
  tokenJson?(mint: string, rec: R): Reply | Promise<Reply>;
}

const NOT_FOUND: Reply = { code: 404, body: { error: 'unknown token' } };

/** The reply for a site route that is registry-gated, or null for any other route (unchanged). */
export async function siteRoute<R extends SiteRecord>(pathname: string, method: string, readBody: () => Promise<any>, d: SiteDeps<R>): Promise<Reply | null> {
  const isMeta = pathname === '/api/meta', isToken = pathname.startsWith('/api/token/'), isTrade = pathname === '/api/trade' && method === 'POST';
  const isBuild = pathname === '/api/wallet/build' && method === 'POST' && !!d.build;
  const isFlywheel = pathname === '/api/flywheel' && method === 'GET' && !!d.flywheel;
  if (!isMeta && !isToken && !isTrade && !isBuild && !isFlywheel) return null;
  let reg: ReadonlySet<string>;
  try { reg = (d.load ?? loadRegistry)(d.cluster, d.registryPath ?? REGISTRY_PATH); }
  catch (e: any) { return { code: 503, body: { error: `mint registry unavailable: ${String(e?.message ?? e)}` } }; }   // the whole response; never an empty listing
  if (isFlywheel) return { code: 200, body: await d.flywheel!(reg) };
  if (isMeta) {
    const listed = d.launches().filter(l => reg.has(l.mint));   // registry ∩ local records, record order
    const extra = d.discovered ? (await d.discovered()).filter(l => !listed.some(x => x.mint === l.mint)) : [];
    return { code: 200, body: await d.meta([...listed, ...extra]) };
  }
  if (isToken) {
    let mint: string;
    try { mint = decodeURIComponent(pathname.split('/')[3] ?? ''); } catch { return NOT_FOUND; }
    // registered with a local launch record (no chain call), else a launch found on chain (only when `discovered` is set)
    let rec = reg.has(mint) ? d.launches().find(l => l.mint === mint) : undefined;
    if (!rec && d.discovered && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) rec = (await d.discovered(mint)).find(l => l.mint === mint);
    if (!rec) return NOT_FOUND;
    const sub = pathname.split('/').slice(4).join('/');   // /api/token/<mint>/<sub>
    if (sub === 'trades' && method === 'GET' && d.trades) return { code: 200, body: await d.trades(mint) };
    if (sub === 'image' && method === 'GET' && d.image) return d.image(mint);
    if (sub === 'metadata' && method === 'POST' && d.metadata) return d.metadata(mint, await readBody());
    if (sub === 'metadata.json' && method === 'GET' && d.tokenJson) return d.tokenJson(mint, rec);
    if (sub) return NOT_FOUND;
    return { code: 200, body: await d.token(mint, rec) };
  }
  const b = await readBody();
  const mint = b?.mint;
  if (typeof mint !== 'string' || !reg.has(mint)) return NOT_FOUND;
  const rec = d.launches().find(l => l.mint === mint); if (!rec) return NOT_FOUND;
  return isBuild ? d.build!(b, rec) : d.trade(b, rec);
}

/** /api/create success body: the new mint is not in the registry until someone adds it by hand. */
export function createReply<T extends object>(rec: T): T & { registered: false; note: string } {
  return { ...rec, registered: false, note: NOT_REGISTERED_NOTE };
}

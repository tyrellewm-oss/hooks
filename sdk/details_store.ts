// Where token details (image, description, links; validated by sdk/metadata.ts) are kept:
//   - files (metadata/<cluster>/, the local server; read-only when hosted, where the bundled copy is a snapshot)
//   - Vercel Blob, when BLOB_READ_WRITE_TOKEN is set (the hosted site): details/<cluster>/<mint>.json plus the image
//     under a content-hashed name, both public. Images are served straight from the Blob CDN; the JSON is read through
//     its public URL and cached here briefly. Tokens with no Blob record yet fall back to the bundled files (details
//     entered before Blob existed); the first save moves them over, image included.
import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';
import { loadMetadata, loadImage, saveMetadata, publicMetadata, MetadataRefusal, type TokenMetadata, type ValidMetadata, type ImageType } from './metadata.js';
import type { ClusterName } from './cluster.js';

/** What the page gets (publicMetadata's shape): the image is a URL. */
export type PublicDetails = NonNullable<ReturnType<typeof publicMetadata>>;

export interface DetailsStore {
  /** 'files' | 'blob'; saves are refused when !writable */
  readonly kind: 'files' | 'blob';
  readonly writable: boolean;
  /** the page's view of a token's details, or null */
  view(mint: string): Promise<PublicDetails | null>;
  /** the image bytes when this store serves them itself (files); null otherwise */
  image(mint: string): Promise<{ type: ImageType; data: Buffer } | null>;
  save(mint: string, v: ValidMetadata): Promise<PublicDetails>;
}

export class FileDetailsStore implements DetailsStore {
  readonly kind = 'files' as const;
  constructor(private readonly cluster: ClusterName, readonly writable: boolean) {}
  async view(mint: string) { return publicMetadata(loadMetadata(this.cluster, mint), mint); }
  async image(mint: string) { return loadImage(this.cluster, mint); }
  async save(mint: string, v: ValidMetadata) {
    if (!this.writable) throw new MetadataRefusal("token details can't be saved on this server");
    return publicMetadata(saveMetadata(this.cluster, mint, v), mint)!;
  }
}

const EXT: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
/** A stored record: TokenMetadata with the image's public URL in place of a local file name. */
interface BlobRecord extends Omit<TokenMetadata, 'image'> { image: { type: ImageType; bytes: number; url: string } | null }
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class BlobDetailsStore implements DetailsStore {
  readonly kind = 'blob' as const;
  readonly writable = true;
  private readonly base: string;
  private cache = new Map<string, { at: number; rec: BlobRecord | null }>();
  constructor(private readonly cluster: ClusterName, private readonly token: string, private readonly opts: { ttlMs?: number; now?: () => number; fetch?: typeof fetch; fallback?: DetailsStore } = {}) {
    const storeId = token.split('_')[3] ?? '';   // vercel_blob_rw_<storeId>_<secret>, as @vercel/blob parses it
    if (!/^[A-Za-z0-9]+$/.test(storeId)) throw new Error('BLOB_READ_WRITE_TOKEN is not a Vercel Blob read-write token');
    this.base = `https://${storeId}.public.blob.vercel-storage.com`;
  }
  private path = (mint: string) => `details/${this.cluster}/${mint}.json`;
  private now = () => (this.opts.now ?? Date.now)();

  private async record(mint: string): Promise<BlobRecord | null> {
    if (!MINT.test(mint)) return null;
    const hit = this.cache.get(mint);
    if (hit && this.now() - hit.at < (this.opts.ttlMs ?? 30_000)) return hit.rec;
    const r = await (this.opts.fetch ?? fetch)(`${this.base}/${this.path(mint)}`, { cache: 'no-store' });
    let rec: BlobRecord | null = null;
    if (r.ok) rec = await r.json() as BlobRecord;
    else if (r.status !== 404) throw new Error(`token details store: HTTP ${r.status}`);
    this.cache.set(mint, { at: this.now(), rec });
    return rec;
  }
  private toView(rec: BlobRecord | null): PublicDetails | null {
    if (!rec) return null;
    const { image, ...rest } = rec;
    return { ...publicMetadata({ ...rest, image: null } as TokenMetadata, '')!, image: image?.url ?? null };
  }
  async view(mint: string) { const rec = await this.record(mint); return rec ? this.toView(rec) : (await this.opts.fallback?.view(mint)) ?? null; }
  /** Blob images are served from the CDN (the view's image URL); only a fallback record's image is served here. */
  async image(mint: string) { return (await this.record(mint)) ? null : (await this.opts.fallback?.image(mint)) ?? null; }
  async save(mint: string, v: ValidMetadata): Promise<PublicDetails> {
    if (!MINT.test(mint)) throw new MetadataRefusal('bad mint');
    this.cache.delete(mint);
    const prev = await this.record(mint);
    let image = prev?.image ?? null;
    // no Blob record yet: an image kept from the fallback files moves over with this first save
    const carried = !prev && v.image === undefined ? await this.opts.fallback?.image(mint) : null;
    if (carried) v = { ...v, image: carried };
    if (v.image === null) image = null;
    if (v.image) {
      const name = `details/${this.cluster}/${mint}-${createHash('sha256').update(v.image.data).digest('hex').slice(0, 16)}.${EXT[v.image.type]}`;
      const out = await put(name, v.image.data, { access: 'public', token: this.token, contentType: v.image.type, addRandomSuffix: false, allowOverwrite: true });
      image = { type: v.image.type, bytes: v.image.data.length, url: out.url };
    }
    const { image: _drop, ...fields } = v;
    const rec: BlobRecord = { ...fields, image, updatedAt: new Date(this.now()).toISOString() };
    await put(this.path(mint), JSON.stringify(rec), { access: 'public', token: this.token, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
    this.cache.set(mint, { at: this.now(), rec });
    return this.toView(rec)!;
  }
}

/** Blob when a token is configured; else files (writable only off the hosted site). */
export function detailsStoreFor(cluster: ClusterName, env: NodeJS.ProcessEnv, hosted: boolean): DetailsStore {
  const t = env.BLOB_READ_WRITE_TOKEN?.trim();
  return t ? new BlobDetailsStore(cluster, t, { fallback: new FileDetailsStore(cluster, false) }) : new FileDetailsStore(cluster, !hosted);
}

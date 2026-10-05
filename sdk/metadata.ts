// Token details shown on the site: image, description and links. Studio-entered (launch form or the token page's
// studio edit), validated here, stored next to the launch records (metadata/<cluster>/, gitignored like launches/).
// The on-chain metadata URI is still the devnet placeholder; pointing it here needs a public host (out of scope).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClusterName } from './cluster.js';

export const METADATA_DIR = 'metadata';
export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_DESCRIPTION = 280;
const MAX_URL = 200;

/** The site copy's forbidden words (AC-27, same list as scripts/ci.sh) also apply to a token description. */
export const FORBIDDEN = /\bsafe\b|\bsecure\b|(^|[^n])audited|anti-bundle|antibundle|sniper-proof|bot-proof|rug-proof|rugproof|honeypot-free|no admin|0 keys|\bmoon\b|100x|guaranteed|\bprofit|\breturns\b|investment opportunity|presale|\bfloor\b|pump it/i;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
const EXT: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export interface TokenMetadata { description: string; website: string | null; x: string | null; telegram: string | null; image: { type: ImageType; bytes: number; file: string } | null; updatedAt: string }
export interface MetadataInput { description?: unknown; website?: unknown; x?: unknown; telegram?: unknown; image?: unknown }
export class MetadataRefusal extends Error { constructor(m: string) { super(m); this.name = 'MetadataRefusal'; } }

/** Image type from the file's own bytes (never from a name or a client-sent type). SVG is never accepted. */
export function sniffImage(b: Uint8Array): ImageType | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  return null;
}

function url(v: unknown, field: string, hosts?: string[]): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > MAX_URL) throw new MetadataRefusal(`${field}: a link of at most ${MAX_URL} characters`);
  let u: URL;
  try { u = new URL(v.trim()); } catch { throw new MetadataRefusal(`${field}: not a valid link`); }
  if (u.protocol !== 'https:') throw new MetadataRefusal(`${field}: must start with https://`);
  if (u.username || u.password) throw new MetadataRefusal(`${field}: links with a user name or password aren't allowed`);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (hosts && !hosts.includes(host)) throw new MetadataRefusal(`${field}: must be a ${hosts.join(' or ')} link`);
  return u.toString();
}

export interface ValidMetadata { description: string; website: string | null; x: string | null; telegram: string | null; image: { type: ImageType; data: Buffer } | null | undefined }

/** Validate studio input. image: undefined = keep the current one, null = remove, { data: base64 } = replace. */
export function validateMetadata(i: MetadataInput): ValidMetadata {
  if (i.description !== undefined && typeof i.description !== 'string') throw new MetadataRefusal('description: text');
  const description = String(i.description ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (description.length > MAX_DESCRIPTION) throw new MetadataRefusal(`description: at most ${MAX_DESCRIPTION} characters`);
  const bad = description.match(FORBIDDEN);
  if (bad) throw new MetadataRefusal(`description: the word "${bad[0].replace(/^[^a-z0-9]/i, '')}" isn't allowed in site copy (AC-27)`);
  let image: ValidMetadata['image'];
  if (i.image === null) image = null;
  else if (i.image !== undefined) {
    const d = (i.image as any)?.data;
    if (typeof d !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(d)) throw new MetadataRefusal('image: send the file as base64');
    if (d.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new MetadataRefusal(`image: at most ${MAX_IMAGE_BYTES / 1024} KB`);
    const data = Buffer.from(d, 'base64');
    const type = sniffImage(data);
    if (!type) throw new MetadataRefusal('image: PNG, JPEG, WebP or GIF only');
    image = { type, data };
  }
  return { description, website: url(i.website, 'website'), x: url(i.x, 'X link', ['x.com', 'twitter.com']), telegram: url(i.telegram, 'Telegram link', ['t.me']), image };
}

const dirFor = (cluster: ClusterName, dir = METADATA_DIR) => join(dir, cluster);
export function loadMetadata(cluster: ClusterName, mint: string, dir = METADATA_DIR): TokenMetadata | null {
  const f = join(dirFor(cluster, dir), `${mint}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}
export function loadImage(cluster: ClusterName, mint: string, dir = METADATA_DIR): { type: ImageType; data: Buffer } | null {
  const m = loadMetadata(cluster, mint, dir);
  if (!m?.image) return null;
  const p = join(dirFor(cluster, dir), m.image.file);
  if (!existsSync(p)) return null;
  const data = readFileSync(p);
  return sniffImage(data) === m.image.type ? { type: m.image.type, data } : null;   // re-checked on every read
}

/** Write (atomically) the validated details for a mint. */
export function saveMetadata(cluster: ClusterName, mint: string, v: ValidMetadata, dir = METADATA_DIR): TokenMetadata {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new MetadataRefusal('bad mint');
  const d = dirFor(cluster, dir); mkdirSync(d, { recursive: true });
  const prev = loadMetadata(cluster, mint, dir);
  let image = prev?.image ?? null;
  if (v.image === null && prev?.image) { rmSync(join(d, prev.image.file), { force: true }); image = null; }
  if (v.image) {
    const file = `${mint}.${EXT[v.image.type]}`;
    if (prev?.image && prev.image.file !== file) rmSync(join(d, prev.image.file), { force: true });
    writeFileSync(join(d, file + '.tmp'), v.image.data); renameSync(join(d, file + '.tmp'), join(d, file));
    image = { type: v.image.type, bytes: v.image.data.length, file };
  }
  const meta: TokenMetadata = { description: v.description, website: v.website, x: v.x, telegram: v.telegram, image, updatedAt: new Date().toISOString() };
  const f = join(d, `${mint}.json`);
  writeFileSync(f + '.tmp', JSON.stringify(meta, null, 2)); renameSync(f + '.tmp', f);
  return meta;
}

/** What the page gets: details plus an image URL (never the bytes; the image route serves those). */
export function publicMetadata(m: TokenMetadata | null, mint: string) {
  if (!m) return null;
  return { description: m.description, website: m.website, x: m.x, telegram: m.telegram, image: m.image ? `/api/token/${mint}/image?v=${encodeURIComponent(m.updatedAt)}` : null, updatedAt: m.updatedAt };
}

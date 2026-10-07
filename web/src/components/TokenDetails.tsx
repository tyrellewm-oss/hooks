// Token image (studio upload, else the generated art) and the studio form for image, description and links.
// The server re-validates everything (sdk/metadata.ts); the checks here only give early feedback.
import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import type { MetadataInput, TokenMetadata } from '../lib/types';
import { SOCIALS, socialLinks, marketLinks, type SocialKey } from '../lib/socials';
import { TokenArt } from './TokenArt';
import { IconGlobe, IconX, IconTelegram, IconDiscord, IconTiktok, IconInstagram, IconYoutube, IconSearch, IconChart, IconCandles } from './Icons';

/** metadata: the token's details once read (null = none); until then `image` (the listing's) stands in. */
export function TokenImage({ mint, ticker, metadata, image, showTicker = true }: { mint: string; ticker?: string; metadata?: TokenMetadata | null; image?: string | null; showTicker?: boolean }) {
  const src = metadata !== undefined ? metadata?.image ?? null : image ?? null;
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) return <img src={src} alt={ticker ? `${ticker} image` : 'token image'} loading="lazy" decoding="async" onError={() => setBroken(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />;
  return <TokenArt seed={mint} ticker={ticker} showTicker={showTicker} />;
}

const MAX_KB = 512;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const httpsOk = (v: string, hosts?: string[]) => {
  if (!v) return null;
  try { const u = new URL(v); if (u.protocol !== 'https:') return 'must start with https://'; if (hosts && !hosts.includes(u.hostname.replace(/^www\./, ''))) return `must be a ${hosts.join(' or ')} link`; return null; }
  catch { return 'not a valid link'; }
};

type LinkFields = Record<SocialKey, string>;
export interface DetailsState extends LinkFields { description: string; image?: { data: string; preview: string } | null }
export const emptyDetails = (m?: TokenMetadata | null): DetailsState =>
  ({ description: m?.description ?? '', ...(Object.fromEntries(SOCIALS.map((x) => [x.key, m?.[x.key] ?? ''])) as LinkFields) });
export function toInput(d: DetailsState): MetadataInput {
  const out = { description: d.description.trim(), ...(Object.fromEntries(SOCIALS.map((x) => [x.key, d[x.key].trim()])) as LinkFields) } as MetadataInput;
  if (d.image !== undefined) out.image = d.image ? { data: d.image.data } : null;
  return out;
}
export function detailsError(d: DetailsState): string | null {
  if (d.description.length > 280) return 'Description: at most 280 characters.';
  for (const x of SOCIALS) { const e = httpsOk(d[x.key].trim(), x.hosts ?? undefined); if (e) return `${x.label}: ${e}`; }
  return null;
}

export function DetailsForm({ value, onChange, currentImage, mint, ticker }: { value: DetailsState; onChange: (v: DetailsState) => void; currentImage?: string | null; mint: string; ticker?: string }) {
  const file = useRef<HTMLInputElement>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const set = (p: Partial<DetailsState>) => onChange({ ...value, ...p });
  const pick = (f: File | undefined) => {
    setImgErr(null);
    if (!f) return;
    if (!TYPES.includes(f.type)) { setImgErr('PNG, JPEG, WebP or GIF only.'); return; }
    if (f.size > MAX_KB * 1024) { setImgErr(`At most ${MAX_KB} KB (this one is ${Math.round(f.size / 1024)} KB).`); return; }
    const r = new FileReader();
    r.onload = () => { const url = String(r.result); set({ image: { data: url.slice(url.indexOf(',') + 1), preview: url } }); };
    r.readAsDataURL(f);
  };
  const shown = value.image === null ? null : value.image?.preview ?? currentImage ?? null;
  return (
    <div>
      <div className="row" style={{ gap: 14, alignItems: 'center', marginBottom: 14 }}>
        <div style={{ width: 84, height: 84, borderRadius: 14, overflow: 'hidden', flex: 'none', background: 'var(--panel)' }}>
          {shown ? <img src={shown} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <TokenArt seed={mint} ticker={ticker} />}
        </div>
        <div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="small" onClick={() => file.current?.click()}>{shown ? 'Replace image' : 'Upload image'}</button>
            {shown && <button type="button" className="ghost small" onClick={() => set({ image: null })}>Remove</button>}
          </div>
          <div className="small faint" style={{ marginTop: 6 }}>PNG, JPEG, WebP or GIF, up to {MAX_KB} KB. Square works best.</div>
          {imgErr && <div className="small fail" role="alert">{imgErr}</div>}
          <input ref={file} type="file" accept={TYPES.join(',')} hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
      </div>
      <label className="field"><span className="spread"><span>Description</span><span className="faint num">{value.description.length}/280</span></span>
        <textarea rows={3} maxLength={280} value={value.description} onChange={(e) => set({ description: e.target.value })} placeholder="What this test token is for" />
      </label>
      <label className="field"><span>Website</span><input type="url" inputMode="url" value={value.website} onChange={(e) => set({ website: e.target.value })} placeholder={SOCIALS[0].placeholder} /></label>
      <div className="soc-grid">
        {SOCIALS.slice(1).map((x) => (
          <label key={x.key} className="field"><span>{x.label}</span><input type="url" inputMode="url" value={value[x.key]} onChange={(e) => set({ [x.key]: e.target.value })} placeholder={x.placeholder} /></label>
        ))}
      </div>
    </div>
  );
}

const SOCIAL_ICON: Record<SocialKey, ComponentType<{ size?: number }>> = { website: IconGlobe, x: IconX, telegram: IconTelegram, discord: IconDiscord, tiktok: IconTiktok, instagram: IconInstagram, youtube: IconYoutube };
const MARKET_ICON = { xsearch: IconSearch, gmgn: IconChart, dex: IconCandles } as const;
// links were validated as https on the server; never pass the page as referrer, never vouch for them
const OUT = { target: '_blank', rel: 'noopener noreferrer nofollow' } as const;

/** On a card only the first few fit: X, Telegram and the website lead; the token page shows them all. */
const CARD_ORDER: SocialKey[] = ['x', 'telegram', 'website', 'discord', 'tiktok', 'instagram', 'youtube'];

/** The token's socials as icon links (token page; on cards, `max` of them). */
export function SocialIcons({ m, size = 'md', max }: { m: TokenMetadata | null | undefined; size?: 'sm' | 'md'; max?: number }) {
  let links = socialLinks(m);
  if (max !== undefined) links = [...links].sort((a, b) => CARD_ORDER.indexOf(a.key) - CARD_ORDER.indexOf(b.key)).slice(0, max);
  if (!links.length) return null;
  return (
    <span className={`soc-icons ${size}`}>
      {links.map(({ key, label, href }) => { const Icon = SOCIAL_ICON[key]; return <a key={key} className="soc" href={href} {...OUT} aria-label={label} title={label}><Icon size={size === 'sm' ? 13 : 15} /></a>; })}
    </span>
  );
}

/** Token page: the token's socials, then where to look it up by its mint (search on X, GMGN, DEX Screener). */
export function TokenLinksBar({ mint, metadata, mainnet }: { mint: string; metadata: TokenMetadata | null | undefined; mainnet: boolean }) {
  const hasSocials = socialLinks(metadata).length > 0;
  return (
    <div className="gm-links">
      {hasSocials ? <SocialIcons m={metadata} /> : <span className="small faint">No socials added yet</span>}
      <span className="mk-links">
        {marketLinks(mint).map(({ key, label, href }) => {
          const Icon = MARKET_ICON[key];
          const note = key === 'xsearch' ? 'Posts on X that mention this token\'s mint address' : !mainnet ? `${label} lists mainnet tokens only, so this test token isn't there yet` : `This token on ${label}`;
          return <a key={key} className="mk-link" href={href} {...OUT} title={note}><Icon size={14} /><span>{label}</span></a>;
        })}
      </span>
    </div>
  );
}

// Token image (studio upload, else the generated art) and the studio form for image, description and links.
// The server re-validates everything (sdk/metadata.ts); the checks here only give early feedback.
import { useEffect, useRef, useState } from 'react';
import type { MetadataInput, TokenMetadata } from '../lib/types';
import { TokenArt } from './TokenArt';

export function TokenImage({ mint, ticker, metadata, showTicker = true }: { mint: string; ticker?: string; metadata?: TokenMetadata | null; showTicker?: boolean }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [metadata?.image]);
  if (metadata?.image && !broken) return <img src={metadata.image} alt={ticker ? `${ticker} image` : 'token image'} onError={() => setBroken(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />;
  return <TokenArt seed={mint} ticker={ticker} showTicker={showTicker} />;
}

const MAX_KB = 512;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const httpsOk = (v: string, hosts?: string[]) => {
  if (!v) return null;
  try { const u = new URL(v); if (u.protocol !== 'https:') return 'must start with https://'; if (hosts && !hosts.includes(u.hostname.replace(/^www\./, ''))) return `must be a ${hosts.join(' or ')} link`; return null; }
  catch { return 'not a valid link'; }
};

export interface DetailsState { description: string; website: string; x: string; telegram: string; image?: { data: string; preview: string } | null }
export const emptyDetails = (m?: TokenMetadata | null): DetailsState => ({ description: m?.description ?? '', website: m?.website ?? '', x: m?.x ?? '', telegram: m?.telegram ?? '' });
export function toInput(d: DetailsState): MetadataInput {
  const out: MetadataInput = { description: d.description.trim(), website: d.website.trim(), x: d.x.trim(), telegram: d.telegram.trim() };
  if (d.image !== undefined) out.image = d.image ? { data: d.image.data } : null;
  return out;
}
export function detailsError(d: DetailsState): string | null {
  if (d.description.length > 280) return 'Description: at most 280 characters.';
  return (httpsOk(d.website) && `Website: ${httpsOk(d.website)}`) || (httpsOk(d.x, ['x.com', 'twitter.com']) && `X: ${httpsOk(d.x, ['x.com', 'twitter.com'])}`) || (httpsOk(d.telegram, ['t.me']) && `Telegram: ${httpsOk(d.telegram, ['t.me'])}`) || null;
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
      <label className="field"><span>Website</span><input value={value.website} onChange={(e) => set({ website: e.target.value })} placeholder="https://example.org" /></label>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field"><span>X</span><input value={value.x} onChange={(e) => set({ x: e.target.value })} placeholder="https://x.com/handle" /></label>
        <label className="field"><span>Telegram</span><input value={value.telegram} onChange={(e) => set({ telegram: e.target.value })} placeholder="https://t.me/group" /></label>
      </div>
    </div>
  );
}

/** Links row for the token page (rel=noopener/noreferrer; links were validated as https on the server). */
export function TokenLinks({ m }: { m: TokenMetadata }) {
  const links = [['Website', m.website], ['X', m.x], ['Telegram', m.telegram]].filter(([, u]) => u) as [string, string][];
  if (!links.length) return null;
  return <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{links.map(([l, u]) => <a key={l} className="pill plain" href={u} target="_blank" rel="noopener noreferrer nofollow">{l} ↗</a>)}</div>;
}

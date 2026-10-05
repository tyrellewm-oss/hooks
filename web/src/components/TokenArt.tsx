// Generated token artwork: launches carry no image yet, so each mint gets a deterministic abstract piece
// (gradient field, rising steps that echo the cap ramp, ticker mark). Same mint -> same art.
import { useId } from 'react';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed || 1;
  return () => { a ^= a << 13; a ^= a >>> 17; a ^= a << 5; return ((a >>> 0) % 10000) / 10000; };
}

export function TokenArt({ seed, ticker, showTicker = true }: { seed: string; ticker?: string; showTicker?: boolean }) {
  const uid = useId().replace(/:/g, '');
  const r = rng(hash(seed));
  const h1 = Math.trunc(r() * 360);
  const h2 = (h1 + 40 + Math.trunc(r() * 140)) % 360;
  const h3 = (h2 + 60 + Math.trunc(r() * 120)) % 360;
  const steps = 3 + Math.trunc(r() * 3);
  const cx = 20 + r() * 60, cy = 15 + r() * 40;
  const label = (ticker ?? '').slice(0, 5);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" role="img" aria-label={label ? `${label} artwork` : 'token artwork'}>
      <defs>
        <linearGradient id={`g${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${h1} 70% 52%)`} />
          <stop offset="1" stopColor={`hsl(${h2} 72% 28%)`} />
        </linearGradient>
        <radialGradient id={`r${uid}`} cx={cx / 100} cy={cy / 100} r="0.55">
          <stop offset="0" stopColor={`hsl(${h3} 90% 72%)`} stopOpacity="0.85" />
          <stop offset="1" stopColor={`hsl(${h3} 90% 60%)`} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#g${uid})`} />
      <rect width="100" height="100" fill={`url(#r${uid})`} />
      {Array.from({ length: steps }, (_, i) => {
        const w = 100 / steps, x = i * w, top = 92 - (i + 1) * (58 / steps);
        return <rect key={i} x={x} y={top} width={w + 0.5} height={100 - top} fill="#000" opacity={0.1 + i * 0.05} />;
      })}
      <path d={Array.from({ length: steps }, (_, i) => { const w = 100 / steps, top = 92 - (i + 1) * (58 / steps); return `${i === 0 ? 'M' : 'L'}${i * w},${top} H${(i + 1) * w}`; }).join(' ')} stroke="#fff" strokeOpacity="0.55" strokeWidth="1.2" fill="none" />
      {showTicker && label && <text x="8" y="24" fill="#fff" fillOpacity="0.92" style={{ font: '600 15px var(--sans)', letterSpacing: '-0.5px' }}>{label}</text>}
    </svg>
  );
}

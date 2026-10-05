// Price chart (candles) and trades feed from the indexer (GET /api/token/:mint/trades). Prices are shown as SOL per
// 1M tokens so devnet-sized numbers stay readable. Only individual on-chain trades and prices: no volume totals (AC-28).
import { useMemo, useState } from 'react';
import type { Candle, IndexedTrade, Meta } from '../lib/types';
import { api, FIXTURE_MODE } from '../lib/api';
import { usePoll } from '../lib/hooks';
import { useWallet } from '../lib/wallet';
import { short } from './bits';

const INTERVALS = [{ s: 60, l: '1m' }, { s: 300, l: '5m' }, { s: 900, l: '15m' }, { s: 3600, l: '1h' }];
const PER = 1_000_000;   // price unit: SOL per 1M tokens
const fmtPrice = (p: number) => { const v = p * PER; return v >= 1 ? v.toFixed(3) : v >= 0.001 ? v.toFixed(5) : v.toExponential(2); };
const ago = (sec: number | null) => { if (sec === null) return '–'; const s = Math.max(0, Date.now() / 1000 - sec); return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const txUrl = (sig: string, cluster: string) => (FIXTURE_MODE ? '' : cluster === 'DEVNET' ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`);

export function useTrades(mint: string, interval: number) {
  return usePoll(() => api.trades(mint, interval), 10000, `${mint}:${interval}`);
}

export function PriceCard({ mint }: { mint: string }) {
  const [interval, setIv] = useState(300);
  const live = useTrades(mint, interval);
  const d = live.data;
  const last = d?.candles[d.candles.length - 1];
  const first = d?.candles[0];
  const change = last && first ? ((last.c - first.o) / first.o) * 100 : null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Price</h2>
        {last && <span className="num" style={{ fontSize: 15 }}>{fmtPrice(last.c)} <span className="faint small">SOL / 1M</span></span>}
        {change !== null && Number.isFinite(change) && <span className={`small num ${change >= 0 ? 'ok' : 'fail'}`}>{change >= 0 ? '+' : ''}{change.toFixed(1)}%</span>}
        <div className="tabs right" role="tablist" aria-label="Interval" style={{ padding: 3 }}>
          {INTERVALS.map((x) => <button key={x.s} role="tab" aria-selected={interval === x.s} className={interval === x.s ? 'on' : ''} style={{ padding: '3px 10px', fontSize: 12.5 }} onClick={() => setIv(x.s)}>{x.l}</button>)}
        </div>
      </div>
      {!d ? (live.error ? <div className="notice red small">{live.error.message}</div> : <div className="skeleton" style={{ height: 220 }} />)
        : !d.indexed ? <div className="notice small">No trades indexed yet. The indexer fills this in: <code>node --import tsx scripts/indexer.ts loop --cluster devnet</code></div>
        : d.candles.length === 0 ? <div className="notice small">No trades yet.</div>
        : <Candles candles={d.candles} interval={d.interval} />}
      {d?.updatedAt && <div className="small faint" style={{ marginTop: 8 }}>Indexed from the chain · updated {ago(Date.parse(d.updatedAt) / 1000)} ago · curve and post-graduation pool</div>}
    </div>
  );
}

function Candles({ candles, interval }: { candles: Candle[]; interval: number }) {
  const W = 640, H = 220, L = 8, R = 62, T = 10, B = 24;
  const cs = candles.slice(-80);
  const lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h));
  const pad = (hi - lo) * 0.08 || hi * 0.05;
  const y = (p: number) => T + (H - T - B) * (1 - (p - (lo - pad)) / (hi + pad - (lo - pad)));
  const slot = (W - L - R) / Math.max(cs.length, 12), bw = Math.max(2, Math.min(12, slot * 0.6));
  const x = (i: number) => L + slot * i + slot / 2;
  const ticks = [lo, (lo + hi) / 2, hi];
  const timeLbl = (t: number) => new Date(t * 1000).toLocaleTimeString([], interval >= 3600 ? { month: 'short', day: 'numeric', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  const lastC = cs[cs.length - 1];
  return (
    <svg className="ramp" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Price candles, ${cs.length} intervals, last ${fmtPrice(lastC.c)} SOL per 1M tokens`}>
      {ticks.map((p, i) => (
        <g key={i}><line x1={L} x2={W - R} y1={y(p)} y2={y(p)} stroke="var(--border, var(--card-border))" strokeDasharray="2 4" /><text x={W - R + 6} y={y(p) + 3.5}>{fmtPrice(p)}</text></g>
      ))}
      {cs.map((c, i) => {
        const up = c.c >= c.o, col = up ? 'var(--green)' : 'var(--red)';
        const top = y(Math.max(c.o, c.c)), h = Math.max(1, Math.abs(y(c.o) - y(c.c)));
        return (
          <g key={c.t}>
            <title>{`${timeLbl(c.t)}  O ${fmtPrice(c.o)}  H ${fmtPrice(c.h)}  L ${fmtPrice(c.l)}  C ${fmtPrice(c.c)}  (${c.n} trade${c.n > 1 ? 's' : ''})`}</title>
            <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" />
            <rect x={x(i) - bw / 2} y={top} width={bw} height={h} fill={col} rx="1" />
          </g>
        );
      })}
      <line x1={L} x2={W - R} y1={y(lastC.c)} y2={y(lastC.c)} stroke="var(--text-3)" strokeDasharray="1 3" />
      {cs.length > 1 && <><text x={x(0)} y={H - 6} textAnchor="start">{timeLbl(cs[0].t)}</text><text x={x(cs.length - 1)} y={H - 6} textAnchor="end">{timeLbl(lastC.t)}</text></>}
    </svg>
  );
}

export function TradesFeed({ mint, meta, decimals = 6 }: { mint: string; meta: Meta; decimals?: number }) {
  const live = useTrades(mint, 300);
  const { address } = useWallet();
  const [all, setAll] = useState(false);
  const rows: IndexedTrade[] = useMemo(() => (live.data?.trades ?? []).slice(0, all ? 500 : 100), [live.data, all]);
  const tok = (raw: string) => (Number(raw) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return (
    <div className="card">
      <div className="card-head"><h2>Trades</h2><span className="right small faint">newest first · on-chain</span></div>
      {!live.data ? <div className="skeleton" style={{ height: 120 }} />
        : rows.length === 0 ? <p className="small faint" style={{ margin: 0 }}>{live.data.indexed ? 'No trades yet.' : 'Not indexed yet.'}</p>
        : (
          <div className="feed-scroll">
            <table className="small">
              <thead><tr><th>Age</th><th>Type</th><th>Wallet</th><th style={{ textAlign: 'right' }}>Tokens</th><th style={{ textAlign: 'right' }}>SOL</th><th>Where</th><th>Tx</th></tr></thead>
              <tbody>{rows.map((t) => {
                const url = txUrl(t.sig, meta.cluster);
                return (
                  <tr key={t.sig + t.side}>
                    <td className="faint num">{ago(t.time)}</td>
                    <td>{t.side === 'blocked' ? <span className="pill amber" title={t.error}>Blocked by cap</span> : <span className={`pill ${t.side === 'buy' ? 'green' : 'red'}`}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>}</td>
                    <td className="mono">{t.trader === address ? <b>you</b> : short(t.trader, 4)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{t.side === 'blocked' ? '–' : tok(t.baseRaw)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{t.side === 'blocked' ? '–' : (Number(t.quoteLamports) / 1e9).toFixed(4)}</td>
                    <td className="faint">{t.venue === 'curve' ? 'curve' : 'pool'}</td>
                    <td>{url ? <a className="link mono" href={url} target="_blank" rel="noreferrer">{short(t.sig, 4)} ↗</a> : <span className="mono faint">{short(t.sig, 4)}</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
            {(live.data.trades.length > 100) && <button className="ghost small" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show ${Math.min(500, live.data.trades.length)}`}</button>}
          </div>
        )}
    </div>
  );
}

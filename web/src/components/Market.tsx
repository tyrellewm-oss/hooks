// Price chart (candles) and trades feed from the indexer (GET /api/token/:mint/trades). Prices are shown as SOL per
// 1M tokens so devnet-sized numbers stay readable. Only individual on-chain trades and prices: no volume totals (AC-28),
// which is also why the chart has no volume histogram. Rendering: TradingView's open-source lightweight-charts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle, IndexedTrade, Meta } from '../lib/types';
import { api, FIXTURE_MODE } from '../lib/api';
import { usePoll } from '../lib/hooks';
import { useWallet } from '../lib/wallet';
import { useTheme } from '../lib/ui';
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
      {!d ? (live.error ? <div className="notice red small">{live.error.message}</div> : <div className="skeleton" style={{ height: 340 }} />)
        : !d.indexed ? <div className="notice small">No trades indexed yet. The indexer fills this in: <code>node --import tsx scripts/indexer.ts loop --cluster devnet</code></div>
        : d.candles.length === 0 ? <div className="notice small">No trades yet.</div>
        : <Candles candles={d.candles} interval={d.interval} />}
      {d?.updatedAt && <div className="small faint" style={{ marginTop: 8 }}>Indexed from the chain · updated {ago(Date.parse(d.updatedAt) / 1000)} ago · curve and post-graduation pool</div>}
    </div>
  );
}

/** Quiet intervals get a flat candle at the previous close (no trades, price unchanged), up to now, so the
 *  chart reads as a continuous series instead of only the minutes that happened to trade. */
function fillGaps(candles: Candle[], interval: number): Candle[] {
  const out: Candle[] = [];
  const flat = (t: number, p: number): Candle => ({ t, o: p, h: p, l: p, c: p, n: 0 });
  for (const c of candles) {
    let prev = out[out.length - 1];
    while (prev && c.t - prev.t > interval && out.length < 5000) out.push(prev = flat(prev.t + interval, prev.c));
    out.push(c);
  }
  let prev = out[out.length - 1];
  const now = Math.trunc(Date.now() / 1000 / interval) * interval;
  while (prev && now - prev.t > interval && out.length < 2000) out.push(prev = flat(prev.t + interval, prev.c));
  return out;
}

type Ohlc = { o: number; h: number; l: number; c: number; n: number };

/** TradingView lightweight-charts candlesticks over the indexer's candles (themed from the CSS variables).
 *  Crosshair, zoom and pan come with the library; the OHLC readout sits top-left like a terminal chart. */
function Candles({ candles, interval }: { candles: Candle[]; interval: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const theme = useTheme();
  const filled = useMemo(() => fillGaps(candles, interval), [candles, interval]);
  const byTime = useMemo(() => new Map(filled.map((c) => [c.t, c])), [filled]);
  const byTimeRef = useRef(byTime);
  byTimeRef.current = byTime;
  const dataKey = useRef('');
  const [legend, setLegend] = useState<Ohlc | null>(null);
  const shown: Ohlc | null = legend ?? (filled.length ? filled[filled.length - 1] : null);

  useEffect(() => {   // create per theme (colors are read from the CSS variables once)
    const el = box.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const ch = createChart(el, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: v('--text-3'), fontFamily: v('--mono'), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: v('--card-border') }, horzLines: { color: v('--card-border') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3, barSpacing: 7, minBarSpacing: 1.5 },
      crosshair: { horzLine: { labelBackgroundColor: v('--text') }, vertLine: { labelBackgroundColor: v('--text') } },
      localization: { priceFormatter: (p: number) => fmtPrice(p / PER) },
    });
    const s = ch.addSeries(CandlestickSeries, {
      upColor: v('--green'), downColor: v('--red'), wickUpColor: v('--green'), wickDownColor: v('--red'), borderVisible: false,
      priceFormat: { type: 'custom', formatter: (p: number) => fmtPrice(p / PER), minMove: 1e-9 },
      priceLineColor: v('--text-3'),
    });
    ch.subscribeCrosshairMove((p) => {
      const d = p.time !== undefined ? byTimeRef.current.get(p.time as number) : null;
      setLegend(d ?? null);
    });
    chart.current = ch; series.current = s; dataKey.current = '';
    return () => { ch.remove(); chart.current = null; series.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {   // feed data without recreating the chart, so the user's zoom and scroll survive polling
    const s = series.current, ch = chart.current;
    if (!s || !ch || !filled.length) return;
    s.setData(filled.map((c) => ({ time: c.t as UTCTimestamp, open: c.o * PER, high: c.h * PER, low: c.l * PER, close: c.c * PER })));
    const key = `${interval}:${theme}`;
    if (dataKey.current !== key) { ch.timeScale().scrollToRealTime(); dataKey.current = key; }
  }, [filled, interval, theme]);

  return (
    <div style={{ position: 'relative' }}>
      {shown && (
        <div className="chart-legend num" aria-live="off">
          <span className="faint">O</span> {fmtPrice(shown.o)} <span className="faint">H</span> {fmtPrice(shown.h)} <span className="faint">L</span> {fmtPrice(shown.l)} <span className="faint">C</span> {fmtPrice(shown.c)}
          <span className={shown.c >= shown.o ? 'ok' : 'fail'}> {shown.o ? `${shown.c >= shown.o ? '+' : ''}${(((shown.c - shown.o) / shown.o) * 100).toFixed(2)}%` : ''}</span>
          {shown.n === 0 && <span className="faint"> · no trades</span>}
        </div>
      )}
      <div ref={box} role="img" aria-label={`Price candles, ${filled.length} intervals, SOL per 1M tokens`} style={{ height: 340, minWidth: 0 }} />
    </div>
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

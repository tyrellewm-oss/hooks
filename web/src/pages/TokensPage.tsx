import { useMemo, useState } from 'react';
import type { Meta, TokenView } from '../lib/types';
import { api } from '../lib/api';
import { navigate, useNow, usePoll } from '../lib/hooks';
import { useQuery } from '../lib/ui';
import { pctOf, BPS_DENOM, approxDuration } from '../lib/shared';
import { estimateSlot, isGraduated, liveCap, liveNextChange, phaseOf, PHASES, type Phase } from '../lib/token';
import { Addr, Skeleton } from '../components/bits';
import { TokenImage } from '../components/TokenDetails';
import { IconArrow } from '../components/Icons';

const STAGE_DOT: Record<Phase, string> = { early: 'var(--amber)', capped: 'var(--accent)', uncapped: 'var(--text-3)', graduated: 'var(--green)', unknown: 'var(--text-4)' };
type Filter = 'all' | Exclude<Phase, 'unknown'>;
type Sort = 'new' | 'curve';

interface Row { mint: string; time: string; view: TokenView | null; error: string | null }
interface Derived extends Row { phase: Phase; capPct: string | null; progress: number; reserve: number; threshold: number; nextText: string | null; launchedMs: number }

/** One poll for the whole listing (each /api/token call also scans switch history, so keep it slow). */
async function loadAll(meta: Meta): Promise<{ rows: Row[]; at: number }> {
  const res = await Promise.allSettled(meta.launches.map((l) => api.token(l.mint)));
  return { at: Date.now(), rows: meta.launches.map((l, i) => { const r = res[i]; return { mint: l.mint, time: l.time, view: r.status === 'fulfilled' ? r.value : null, error: r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason) : null }; }) };
}

/** 'Curve, early fee' -> 'Early fee' */
const stageShort = (label: string) => { const t = label.replace('Curve, ', ''); return t.charAt(0).toUpperCase() + t.slice(1); };

const ago = (ms: number) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

export function TokensPage({ meta }: { meta: Meta }) {
  const live = usePoll(() => loadAll(meta), 30000, `list:${meta.launches.map((l) => l.mint).join(',')}`);
  const now = useNow(5000);
  const q = useQuery().trim().toLowerCase();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('new');

  const rows: Derived[] = useMemo(() => (live.data?.rows ?? []).map((r) => {
    const v = r.view;
    const launchedMs = Date.parse(v?.launch?.time ?? r.time) || 0;
    if (!v) return { ...r, phase: 'unknown' as Phase, capPct: null, progress: 0, reserve: 0, threshold: 0, nextText: null, launchedMs };
    const slot = estimateSlot(v.status.slot, live.data!.at, now);
    const cap = liveCap(v, slot);
    const nc = liveNextChange(v, slot);
    const grad = isGraduated(v);
    const threshold = v.fee?.migrationQuoteThresholdSol ?? v.launch?.migrationQuoteThresholdSol ?? 0;
    const reserve = v.pool?.quoteReserveSol ?? 0;
    return {
      ...r, launchedMs, reserve, threshold,
      phase: phaseOf(v, slot),
      capPct: cap === null ? null : pctOf(Number((cap * BigInt(BPS_DENOM)) / BigInt(v.status.supply))),
      progress: grad ? 100 : threshold ? Math.min(100, (reserve / threshold) * 100) : 0,
      nextText: nc ? `${nc.bps === null ? 'no cap' : pctOf(nc.bps)} in ${approxDuration(nc.slot - slot)}` : null,
    };
  }), [live.data, now]);

  const shown = rows
    .filter((r) => filter === 'all' || r.phase === filter)
    .filter((r) => !q || [r.mint, r.view?.launch?.symbol, r.view?.launch?.name].some((s) => s?.toLowerCase().includes(q)))
    .sort((a, b) => (sort === 'new' ? b.launchedMs - a.launchedMs : b.progress - a.progress));
  const closest = rows.filter((r) => r.view && r.phase !== 'graduated').sort((a, b) => b.progress - a.progress).slice(0, 6);
  const count = (f: Filter) => (f === 'all' ? rows.length : rows.filter((r) => r.phase === f).length);

  return (
    <div>
      <section className="hero">
        <div>
          <h1>Launches with a rising cap</h1>
          <p>While a token is on its bonding curve, each token account can hold at most a set share of supply, and that share only rises. It slows snipers down; it doesn't stop them. The cap ends at graduation or when the ramp ends.</p>
        </div>
        <button className="primary" onClick={() => navigate('/hooks#hook-cap')} style={{ flex: 'none', padding: '10px 20px' }}>How the cap works</button>
        <span className="hero-line" />
      </section>

      {closest.length > 0 && (
        <>
          <div className="section-head"><h2>Closest to graduation</h2><span className="small faint">live curve progress</span></div>
          <div className="strip">
            {closest.map((r) => (
              <div key={r.mint} className="strip-item" onClick={() => navigate(`/token/${r.mint}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/token/${r.mint}`)}>
                <div className="thumb"><TokenImage mint={r.mint} ticker={r.view?.launch?.symbol} metadata={r.view?.metadata} showTicker={false} /></div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="spread"><b style={{ fontSize: 14, fontWeight: 600 }}>{r.view?.launch?.symbol ?? 'TOKEN'}</b><span className="num small">{Math.round(r.progress)}%</span></div>
                  <div className="meter" style={{ marginTop: 6 }}><span className="fill" style={{ width: `${r.progress}%` }} /></div>
                  <div className="small faint num" style={{ marginTop: 4 }}>{r.reserve} / {r.threshold} SOL</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-head"><h2>All launches</h2><span className="small faint">{meta.cluster.toLowerCase()} · registry tokens only</span></div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <div className="tabs" role="tablist" aria-label="Stage">
          {(['all', ...PHASES.map((p) => p.id)] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : stageShort(PHASES.find((p) => p.id === f)!.label)}<span className="faint num" style={{ fontSize: 11.5 }}>{count(f)}</span>
            </button>
          ))}
        </div>
        <div className="tabs" role="tablist" aria-label="Sort" style={{ marginLeft: 'auto' }}>
          <button role="tab" aria-selected={sort === 'new'} className={sort === 'new' ? 'on' : ''} onClick={() => setSort('new')}>Newest</button>
          <button role="tab" aria-selected={sort === 'curve'} className={sort === 'curve' ? 'on' : ''} onClick={() => setSort('curve')}>Curve progress</button>
        </div>
      </div>

      {!live.data ? (
        live.error ? <div className="notice red">{live.error.message}</div>
          : <div className="tgrid">{meta.launches.slice(0, 8).map((l) => <Skeleton key={l.mint} h={300} />)}{meta.launches.length === 0 && <Empty />}</div>
      ) : rows.length === 0 ? <Empty /> : shown.length === 0 ? (
        <div className="card empty"><h2>No tokens match</h2><p className="small faint" style={{ marginTop: 6 }}>Try another stage or search.</p></div>
      ) : (
        <div className="tgrid">{shown.map((r) => <TokenCard key={r.mint} r={r} />)}</div>
      )}

      <p className="small faint" style={{ marginTop: 18 }}>Only numbers read live from the chain are shown. No volume, holder or user counts.</p>
    </div>
  );
}

function TokenCard({ r }: { r: Derived }) {
  const v = r.view;
  const go = () => navigate(`/token/${r.mint}`);
  const stage = PHASES.find((p) => p.id === r.phase);
  return (
    <div className="tcard" onClick={go} role="link" tabIndex={0} aria-label={`${v?.launch?.symbol ?? r.mint} token`} onKeyDown={(e) => e.key === 'Enter' && go()}>
      <div className="art">
        <TokenImage mint={r.mint} ticker={v?.launch?.symbol} metadata={v?.metadata} />
        <span className="chip tl"><span className="d" style={{ background: STAGE_DOT[r.phase] }} />{stage ? stageShort(stage.label) : 'Unavailable'}</span>
        {r.launchedMs > 0 && <span className="chip tr">{ago(r.launchedMs)}</span>}
        {v && r.phase !== 'graduated' && <span className="chip bl">{r.capPct ? `Cap ${r.capPct}${r.nextText ? ` · ${r.nextText}` : ''}` : 'No cap'}</span>}
      </div>
      <div className="meta">
        <div className="name"><span>{v?.launch?.name ?? 'Unavailable'}</span><span className="tick">{v?.launch?.symbol}</span></div>
        {v ? (
          <>
            <div className="figs">
              <span><b>{r.phase === 'graduated' ? '–' : r.capPct ?? 'none'}</b><small>cap</small></span>
              <span><b>{Math.round(r.progress)}%</b><small>curve</small></span>
            </div>
            <div className={`meter ${r.phase === 'graduated' ? 'grad' : ''}`} style={{ marginTop: 8 }}><span className="fill" style={{ width: `${r.progress}%` }} /></div>
          </>
        ) : <div className="small fail" style={{ marginTop: 6 }}>{r.error}</div>}
        <div className="ca" onClick={(e) => e.stopPropagation()}><Addr value={r.mint} n={5} /></div>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="card empty">
      <h2>No test tokens are listed yet</h2>
      <p className="small faint" style={{ margin: '6px auto 16px', maxWidth: 440 }}>The page lists mints in keeper/registry.json that have a local launch record. A new launch appears here once it's added to the registry.</p>
      <button className="primary" onClick={() => navigate('/create')}>Open the studio launch tool <IconArrow size={16} /></button>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Meta, TokenView } from '../lib/types';
import { navigate, useNow } from '../lib/hooks';
import { useCards } from '../lib/cards';
import { useQuery } from '../lib/ui';
import { pctOf, BPS_DENOM, approxDuration } from '../lib/shared';
import { estimateSlot, isGraduated, liveCap, liveNextChange, phaseOf, PHASES, type Phase } from '../lib/token';
import { Addr, Skeleton } from '../components/bits';
import { TokenImage, SocialIcons } from '../components/TokenDetails';
import { IconArrow } from '../components/Icons';

const STAGE_DOT: Record<Phase, string> = { early: 'var(--amber)', capped: 'var(--accent)', uncapped: 'var(--text-3)', graduated: 'var(--green)', unknown: 'var(--text-4)' };
type Filter = 'all' | Exclude<Phase, 'unknown'>;
type Sort = 'new' | 'curve';
type Listing = Meta['launches'][number];

/** loaded: this token's first read has finished (view or error); until then the card shows the listing's name,
 *  ticker, image and age, with placeholders for the chain numbers */
interface Row { mint: string; listing: Listing; view: TokenView | null; error: string | null; loaded: boolean }
interface Derived extends Row { phase: Phase; capPct: string | null; progress: number; reserve: number; threshold: number; nextText: string | null; launchedMs: number }

/** Cards drawn per step; more are added as the end of the grid scrolls into view. */
const PAGE = 12;

/** 'Curve, early fee' -> 'Early fee' */
const stageShort = (label: string) => { const t = label.replace('Curve, ', ''); return t.charAt(0).toUpperCase() + t.slice(1); };

const ago = (ms: number) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

export function TokensPage({ meta }: { meta: Meta }) {
  // newest first: the order the cards are read in, so the top of the grid fills first
  const mints = useMemo(() => [...meta.launches].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0)).map((l) => l.mint), [meta.launches]);
  const cards = useCards(mints, 30_000);
  const now = useNow(5000);
  const q = useQuery().trim().toLowerCase();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('new');
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, sort, q]);

  const rows: Derived[] = useMemo(() => meta.launches.map((l) => {
    const c = cards.get(l.mint);
    const v = c?.view ?? null;
    const launchedMs = Date.parse(v?.launch?.time ?? l.time) || 0;
    const base: Row = { mint: l.mint, listing: l, view: v, error: v ? null : c?.error ?? null, loaded: !!c };
    if (!v) return { ...base, phase: 'unknown' as Phase, capPct: null, progress: 0, reserve: 0, threshold: 0, nextText: null, launchedMs };
    const slot = estimateSlot(v.status.slot, c!.at, now);
    const cap = liveCap(v, slot);
    const nc = liveNextChange(v, slot);
    const grad = isGraduated(v);
    const threshold = v.fee?.migrationQuoteThresholdSol ?? v.launch?.migrationQuoteThresholdSol ?? 0;
    const reserve = v.pool?.quoteReserveSol ?? 0;
    return {
      ...base, launchedMs, reserve, threshold,
      phase: phaseOf(v, slot),
      capPct: cap === null ? null : pctOf(Number((cap * BigInt(BPS_DENOM)) / BigInt(v.status.supply))),
      progress: grad ? 100 : threshold ? Math.min(100, (reserve / threshold) * 100) : 0,
      nextText: nc ? `${nc.bps === null ? 'no cap' : pctOf(nc.bps)} in ${approxDuration(nc.slot - slot)}` : null,
    };
  }), [meta.launches, cards, now]);

  const allLoaded = rows.every((r) => r.loaded);
  const shown = rows
    .filter((r) => filter === 'all' || r.phase === filter)
    .filter((r) => !q || [r.mint, r.view?.launch?.symbol ?? r.listing.symbol, r.view?.launch?.name ?? r.listing.name].some((s) => s?.toLowerCase().includes(q)))
    .sort((a, b) => (sort === 'new' ? b.launchedMs - a.launchedMs : b.progress - a.progress));
  // ranked by progress, so it waits for every card (no rows jumping as reads land)
  const closest = allLoaded ? rows.filter((r) => r.view && r.phase !== 'graduated').sort((a, b) => b.progress - a.progress).slice(0, 6) : [];
  const count = (f: Filter) => (f === 'all' ? rows.length : rows.filter((r) => r.phase === f).length);

  // draw more cards when the end of the grid comes near (lazy rendering for long lists)
  const more = useRef<HTMLDivElement>(null);
  const hasMore = shown.length > limit;
  useEffect(() => {
    const el = more.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setLimit((n) => n + PAGE); }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, limit]);

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

      {(!allLoaded || closest.length > 0) && rows.length > 0 && (
        <>
          <div className="section-head"><h2>Closest to graduation</h2><span className="small faint">live curve progress</span></div>
          <div className="strip">
            {!allLoaded ? Array.from({ length: Math.min(4, rows.length) }, (_, i) => <div key={i} className="strip-item strip-skel" aria-hidden="true"><Skeleton h={44} w={44} /><div style={{ flex: 1 }}><Skeleton h={12} w="60%" /><div style={{ height: 8 }} /><Skeleton h={6} /></div></div>)
              : closest.map((r) => (
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

      <div className="section-head"><h2>All launches</h2><span className="small faint">{meta.cluster.toLowerCase()} · {meta.launch?.mode === 'open' ? 'every launch' : 'registry tokens only'}</span></div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <div className="tabs" role="tablist" aria-label="Stage">
          {(['all', ...PHASES.map((p) => p.id)] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : stageShort(PHASES.find((p) => p.id === f)!.label)}{(f === 'all' || allLoaded) && <span className="faint num" style={{ fontSize: 11.5 }}>{count(f)}</span>}
            </button>
          ))}
        </div>
        <div className="tabs" role="tablist" aria-label="Sort" style={{ marginLeft: 'auto' }}>
          <button role="tab" aria-selected={sort === 'new'} className={sort === 'new' ? 'on' : ''} onClick={() => setSort('new')}>Newest</button>
          <button role="tab" aria-selected={sort === 'curve'} className={sort === 'curve' ? 'on' : ''} onClick={() => setSort('curve')}>Curve progress</button>
        </div>
      </div>

      {rows.length === 0 ? <Empty open={meta.launch?.mode === 'open'} /> : shown.length === 0 ? (
        allLoaded
          ? <div className="card empty"><h2>No tokens match</h2><p className="small faint" style={{ marginTop: 6 }}>Try another stage or search.</p></div>
          : <div className="tgrid">{Array.from({ length: Math.min(4, rows.length) }, (_, i) => <Skeleton key={i} h={300} />)}</div>
      ) : (
        <>
          <div className="tgrid">{shown.slice(0, limit).map((r) => <TokenCard key={r.mint} r={r} />)}</div>
          {hasMore && <div ref={more} className="row" style={{ justifyContent: 'center', marginTop: 16 }}><button className="small" onClick={() => setLimit((n) => n + PAGE)}>Show more</button></div>}
        </>
      )}

      <p className="small faint" style={{ marginTop: 18 }}>Only numbers read live from the chain are shown. No volume, holder or user counts.</p>
    </div>
  );
}

function TokenCard({ r }: { r: Derived }) {
  const v = r.view;
  const go = () => navigate(`/token/${r.mint}`);
  const stage = PHASES.find((p) => p.id === r.phase);
  const symbol = v?.launch?.symbol ?? r.listing.symbol ?? undefined;
  const name = v?.launch?.name ?? r.listing.name ?? (r.loaded ? 'Unavailable' : 'Token');
  return (
    <div className="tcard" onClick={go} role="link" tabIndex={0} aria-label={`${symbol ?? r.mint} token`} aria-busy={!r.loaded} onKeyDown={(e) => e.key === 'Enter' && go()}>
      <div className="art">
        <TokenImage mint={r.mint} ticker={symbol} metadata={v?.metadata} image={r.listing.image} />
        {r.loaded
          ? <span className="chip tl"><span className="d" style={{ background: STAGE_DOT[r.phase] }} />{stage ? stageShort(stage.label) : 'Unavailable'}</span>
          : <span className="chip tl"><span className="d reading" />Reading</span>}
        {r.launchedMs > 0 && <span className="chip tr">{ago(r.launchedMs)}</span>}
        {v && r.phase !== 'graduated' && <span className="chip bl">{r.capPct ? `Cap ${r.capPct}${r.nextText ? ` · ${r.nextText}` : ''}` : 'No cap'}</span>}
      </div>
      <div className="meta">
        <div className="name"><span>{name}</span><span className="tick">{symbol}</span></div>
        {v ? (
          <>
            <div className="figs">
              <span><b>{r.phase === 'graduated' ? '–' : r.capPct ?? 'none'}</b><small>cap</small></span>
              <span><b>{Math.round(r.progress)}%</b><small>curve</small></span>
            </div>
            <div className={`meter ${r.phase === 'graduated' ? 'grad' : ''}`} style={{ marginTop: 8 }}><span className="fill" style={{ width: `${r.progress}%` }} /></div>
          </>
        ) : r.loaded ? <div className="small fail" style={{ marginTop: 6 }}>{r.error}</div> : (
          <div className="figs-skel" aria-hidden="true"><div className="figs"><Skeleton h={18} w="70%" /></div><div className="meter" style={{ marginTop: 8 }} /></div>
        )}
        <div className="ca" onClick={(e) => e.stopPropagation()}><Addr value={r.mint} n={5} /><SocialIcons m={v?.metadata} size="sm" max={3} /></div>
      </div>
    </div>
  );
}

function Empty({ open }: { open: boolean }) {
  return (
    <div className="card empty">
      <h2>No test tokens are listed yet</h2>
      <p className="small faint" style={{ margin: '6px auto 16px', maxWidth: 440 }}>{open ? 'Every launch from this site shows up here a few seconds after it lands.' : "The page lists mints in keeper/registry.json that have a local launch record. A new launch appears here once it's added to the registry."}</p>
      <button className="primary" onClick={() => navigate('/create')}>{open ? 'Launch a token' : 'Open the studio launch tool'} <IconArrow size={16} /></button>
    </div>
  );
}

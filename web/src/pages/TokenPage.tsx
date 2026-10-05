import { useMemo, useState } from 'react';
import type { Meta } from '../lib/types';
import { api, ApiError } from '../lib/api';
import { usePoll, useNow } from '../lib/hooks';
import { useWallet } from '../lib/wallet';
import { pageVars, pctOf, tok, BPS_DENOM, approxDuration } from '../lib/shared';
import { curveFeePctAt, elapsedSlots, estimateSlot, isGraduated, liveCap, liveNextChange, phaseOf } from '../lib/token';
import { CapRamp } from '../components/CapRamp';
import { TradePanel } from '../components/TradePanel';
import { Dropdown, RulesAndRisks, SwitchHistory, TokenDetails } from '../components/Disclosures';
import { Addr, CurveProgress, Guard, Link, PhasePill, PhaseStepper, Skeleton, Stat } from '../components/bits';
import { TokenImage, TokenLinks, DetailsForm, emptyDetails, toInput, detailsError, type DetailsState } from '../components/TokenDetails';
import { PriceCard, TradesFeed } from '../components/Market';
import { StudioGate } from '../components/StudioGate';
import { IconBack } from '../components/Icons';

const POLL_MS = 6000;

export function TokenPage({ mint, meta }: { mint: string; meta: Meta }) {
  const { address } = useWallet();   // include the connected wallet's balances in the view
  const live = usePoll(() => api.token(mint, address), POLL_MS, `${mint}:${address ?? ''}`);
  const now = useNow(1000);
  const view = live.data;
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'trades' | 'rules'>('trades');
  const vars = useMemo(() => (view ? (pageVars(meta, view) as Record<string, string>) : null), [meta, view]);

  if (!view) {
    if (live.error) {
      const nf = live.error instanceof ApiError && live.error.status === 404;
      return (
        <div className="card" style={{ maxWidth: 560 }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>{nf ? "This token isn't listed" : "Couldn't load this token"}</h1>
          <p className="muted">{nf ? 'The page only shows tokens in the mint registry (keeper/registry.json) that have a local launch record.' : live.error.message}</p>
          <Link to="/">Back to tokens</Link>
        </div>
      );
    }
    return <div className="stack"><Skeleton h={28} w={220} /><Skeleton h={56} /><Skeleton h={300} /></div>;
  }

  const st = view.status;
  const slot = estimateSlot(st.slot, live.fetchedAt, now);
  const phase = phaseOf(view, slot);
  const graduated = isGraduated(view);
  const cap = liveCap(view, slot);
  const next = liveNextChange(view, slot);
  const elapsed = elapsedSlots(st, slot);
  const feeNow = curveFeePctAt(view.fee, elapsed);
  const capPct = cap === null ? null : pctOf(Number((cap * BigInt(BPS_DENOM)) / BigInt(st.supply)));
  const stale = now - live.fetchedAt > POLL_MS * 2.5;

  return (
    <div className="stack">
      <div className="spread" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Link to="/" className="back"><IconBack size={15} />Back to tokens</Link>
        <span className="small faint row" title={`chain slot ${st.slot}`}>
          <span className={`dot ${live.error ? 'down' : stale ? 'stale' : ''}`} />
          {live.error ? `last update failed: ${live.error.message}` : `live · slot ~${slot} · +${elapsed} since launch`}
        </span>
      </div>

      {/* GMGN-style header strip: identity on the left, the page's key numbers inline on the right */}
      <div className="card gm-head">
        <div className="row" style={{ gap: 14, minWidth: 0, flex: '1 1 300px' }}>
          <div className="thumb"><TokenImage mint={st.mint} ticker={view.launch?.symbol} metadata={view.metadata} showTicker={false} /></div>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: 20 }}>{view.launch?.symbol ?? 'TOKEN'}</h1>
              <span className="faint small">{view.launch?.name}</span>
              <PhasePill phase={phase} />
            </div>
            <div className="row small" style={{ marginTop: 4, gap: 10, flexWrap: 'wrap' }}>
              <span className="faint"><Addr value={st.mint} href={view.explorer.mint || null} n={5} /></span>
              {view.metadata && <TokenLinks m={view.metadata} />}
              <button className="ghost small" onClick={() => setEditing(true)}>{view.metadata ? 'Edit details' : 'Add details (studio)'}</button>
            </div>
            {view.metadata?.description && <p className="small muted clamp-1" style={{ margin: '4px 0 0' }}>{view.metadata.description}</p>}
          </div>
        </div>
        <div className="gm-stats">
          <div className="gm-stat">
            <div className="big-num">{graduated ? 'none' : capPct ?? 'no cap'}</div>
            <div className="small faint">cap per token account</div>
          </div>
          <div className="gm-stat">
            <div className="big-num">{graduated ? '–' : feeNow === null ? 'n/a' : `~${feeNow}%`}</div>
            <div className="small faint">curve fee now</div>
          </div>
          <div className="gm-stat" style={{ minWidth: 190 }}>
            <CurveProgress reserve={view.pool?.quoteReserveSol ?? null} threshold={view.fee?.migrationQuoteThresholdSol ?? view.launch?.migrationQuoteThresholdSol ?? null} graduated={graduated} />
            <div className="small faint" style={{ marginTop: 4 }}>curve progress</div>
          </div>
        </div>
      </div>
      {editing && <EditDetails meta={meta} mint={st.mint} ticker={view.launch?.symbol} metadata={view.metadata ?? null} onClose={() => setEditing(false)} onSaved={live.refresh} />}

      <div className="grid-token">
        {/* left: chart on top, then the tabbed bottom section with the scrollable trades feed */}
        <div className="stack">
          <Guard what="the price chart"><PriceCard mint={mint} /></Guard>
          <div>
            <div className="tabs page-tabs" role="tablist" aria-label="Token page sections" style={{ marginBottom: 12 }}>
              <button role="tab" aria-selected={tab === 'trades'} className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Trades</button>
              <button role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>Rules &amp; risks</button>
            </div>
            {tab === 'trades'
              ? <Guard what="the trades feed"><TradesFeed mint={mint} meta={meta} decimals={st.decimals ?? 6} /></Guard>
              : <Guard what="the rules and risks"><RulesAndRisks vars={vars!} /></Guard>}
          </div>
        </div>

        {/* right: phases, trade box, then the stacked info sections */}
        <div className="sticky stack" style={{ marginTop: 0 }}>
          <PhaseStepper phase={phase} />
          <Guard what="the trade panel">
            <TradePanel view={view} meta={meta} slot={slot} vars={vars!} onTraded={live.refresh} />
          </Guard>
          <Dropdown title="Cap per token account" aside={<span className="small faint hide-sm">not per wallet</span>} defaultOpen>
            <div className="stats" style={{ marginBottom: 12 }}>
              <Stat label="Cap now" value={graduated ? 'none' : capPct ?? 'no cap'} sub={cap === null ? (graduated ? 'hook removed' : 'ramp over or lifted') : `${tok(cap)} tokens`} />
              <Stat label="Next change" value={next ? (next.bps === null ? 'no cap' : pctOf(next.bps)) : '–'} sub={next ? `in ${approxDuration(next.slot - slot)}` : 'no further steps'} />
            </div>
            {st.steps && st.uncappedAfter
              ? <CapRamp steps={st.steps} uncappedAfter={st.uncappedAfter} nowElapsed={elapsed} fee={view.fee} raisedFloorBps={st.raisedFloorBps ?? 0} lifted={!!(st.mintLifted || st.globalLifted)} graduated={graduated} height={180} />
              : <p className="faint">No cap config found for this mint.</p>}
          </Dropdown>
          <SwitchHistory view={view} />
          <TokenDetails view={view} />
          {/* AC-25 anchor while the full block lives in its tab: one line, always visible on the page */}
          <div className="small faint rules-line">
            Capped per token account, not per wallet · the admin switch can only raise or remove the cap ·{' '}
            <button className="link-inline" style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }} onClick={() => setTab('rules')}>all rules &amp; risks</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Studio: edit a token's image, description and links (POST /api/token/:mint/metadata, registry-gated). */
function EditDetails({ meta, mint, ticker, metadata, onClose, onSaved }: { meta: Meta; mint: string; ticker?: string; metadata: import('../lib/types').TokenMetadata | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [d, setD] = useState<DetailsState>(() => emptyDetails(metadata));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const local = detailsError(d);
  async function save() {
    if (local) return;
    setBusy(true); setErr(null);
    try { await api.saveMetadata(mint, toInput(d)); await onSaved(); onClose(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ed-title">
        <div className="spread" style={{ marginBottom: 12 }}><h1 id="ed-title" style={{ fontSize: 18 }}>Token details</h1><button className="ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <p className="small faint">Studio tool. Shown on the token card and page. Descriptions follow the same wording rules as the site.</p>
        <StudioGate meta={meta}>
        <DetailsForm value={d} onChange={setD} currentImage={metadata?.image} mint={mint} ticker={ticker} />
        {(local || err) && <div className="notice red small" role="alert" style={{ marginBottom: 12 }}>{local ?? err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !!local} onClick={save}>{busy ? 'Saving…' : 'Save details'}</button>
        </div>
        </StudioGate>
      </div>
    </div>
  );
}

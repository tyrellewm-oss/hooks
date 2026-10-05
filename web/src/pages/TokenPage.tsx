import { useMemo } from 'react';
import type { Meta } from '../lib/types';
import { api, ApiError } from '../lib/api';
import { usePoll, useNow } from '../lib/hooks';
import { useWallet } from '../lib/wallet';
import { pageVars, pctOf, tok, BPS_DENOM, approxDuration } from '../lib/shared';
import { curveFeePctAt, elapsedSlots, estimateSlot, isGraduated, liveCap, liveNextChange, phaseOf } from '../lib/token';
import { CapRamp } from '../components/CapRamp';
import { TradePanel } from '../components/TradePanel';
import { RulesAndRisks, SwitchHistory, TokenDetails } from '../components/Disclosures';
import { Addr, CurveProgress, Guard, Link, PhasePill, PhaseStepper, Skeleton, Stat } from '../components/bits';
import { TokenArt } from '../components/TokenArt';
import { IconBack } from '../components/Icons';

const POLL_MS = 6000;

export function TokenPage({ mint, meta }: { mint: string; meta: Meta }) {
  const { address } = useWallet();   // include the connected wallet's balances in the view
  const live = usePoll(() => api.token(mint, address), POLL_MS, `${mint}:${address ?? ''}`);
  const now = useNow(1000);
  const view = live.data;
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

      <div className="top-cards">
        <div className="card">
          <div className="id-card">
            <div className="thumb"><TokenArt seed={st.mint} ticker={view.launch?.symbol} showTicker={false} /></div>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: 20 }}>{view.launch?.symbol ?? 'TOKEN'}</h1>
                <span className="faint small">{view.launch?.name}</span>
              </div>
              <div className="row small" style={{ marginTop: 4, gap: 10, flexWrap: 'wrap' }}>
                <PhasePill phase={phase} />
                <span className="faint"><Addr value={st.mint} href={view.explorer.mint || null} n={5} /></span>
              </div>
            </div>
          </div>
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <div className="big-num">{graduated ? 'none' : capPct ?? 'no cap'}</div>
            <div className="small faint">cap per token account</div>
          </div>
        </div>
        <div className="card">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="small faint" style={{ marginBottom: 8 }}>Curve progress</div>
            <CurveProgress reserve={view.pool?.quoteReserveSol ?? null} threshold={view.fee?.migrationQuoteThresholdSol ?? view.launch?.migrationQuoteThresholdSol ?? null} graduated={graduated} />
          </div>
        </div>
      </div>

      <PhaseStepper phase={phase} />

      <div className="grid-token">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Cap per token account</h2>
              <span className="right small faint">% of supply · per token account, not per wallet</span>
            </div>
            <div className="stats" style={{ marginBottom: 12 }}>
              <Stat label="Cap now" value={graduated ? 'none' : capPct ?? 'no cap'} sub={cap === null ? (graduated ? 'hook removed' : 'ramp over or lifted') : `${tok(cap)} tokens`} />
              <Stat label="Next change" value={next ? (next.bps === null ? 'no cap' : pctOf(next.bps)) : '–'} sub={next ? `in ${approxDuration(next.slot - slot)}` : 'no further steps'} />
              <Stat label="Curve fee now" value={graduated ? '–' : feeNow === null ? 'n/a' : `~${feeNow}%`} sub={graduated ? 'pool fee only' : 'approx., anti-sniper schedule'} />
            </div>
            {st.steps && st.uncappedAfter
              ? <CapRamp steps={st.steps} uncappedAfter={st.uncappedAfter} nowElapsed={elapsed} fee={view.fee} raisedFloorBps={st.raisedFloorBps ?? 0} lifted={!!(st.mintLifted || st.globalLifted)} graduated={graduated} />
              : <p className="faint">No cap config found for this mint.</p>}
          </div>

          <Guard what="the rules and risks"><RulesAndRisks vars={vars!} /></Guard>
          <SwitchHistory view={view} />
          <TokenDetails view={view} />
        </div>

        <div className="sticky">
          <Guard what="the trade panel">
            <TradePanel view={view} meta={meta} slot={slot} vars={vars!} onTraded={live.refresh} />
          </Guard>
        </div>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Meta, RulesView } from '../lib/types';
import { api, ApiError } from '../lib/api';
import { usePoll, useNow } from '../lib/hooks';
import { useWallet } from '../lib/wallet';
import { pageVars, pctOf, tok, BPS_DENOM, approxDuration } from '../lib/shared';
import { curveFeePctAt, elapsedSlots, estimateSlot, isGraduated, liveCap, liveNextChange, phaseOf } from '../lib/token';
import { CapRamp } from '../components/CapRamp';
import { hookList, optionalHookList, FLYWHEEL_SPLIT, ordinal, windowText } from '../lib/hookInfo';
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
  const [tab, setTab] = useState<'trades' | 'cap' | 'rules'>('trades');
  const vars = useMemo(() => (view ? (pageVars(meta, view) as Record<string, string>) : null), [meta, view]);

  if (!view) {
    if (live.error) {
      const nf = live.error instanceof ApiError && live.error.status === 404;
      return (
        <div className="card" style={{ maxWidth: 560 }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>{nf ? "This token isn't listed" : "Couldn't load this token"}</h1>
          <p className="muted">{nf ? 'The page only shows tokens in the mint registry (keeper/registry.json) that have a local launch record.' : live.error.message}</p>
          <Link to="/tokens">Back to tokens</Link>
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
        <Link to="/tokens" className="back"><IconBack size={15} />Back to tokens</Link>
        <span className="small faint row" title={`chain slot ${st.slot}`}>
          <span className={`dot ${live.error ? 'down' : stale ? 'stale' : ''}`} />
          {live.error ? `last update failed: ${live.error.message}` : `live · slot ~${slot} · +${elapsed} since launch`}
        </span>
      </div>

      {/* GMGN-style header strip: identity left, the page's key numbers in even columns right, description on its own line */}
      <div className="card gm-head">
        <div className="gm-id">
          <div className="thumb"><TokenImage mint={st.mint} ticker={view.launch?.symbol} metadata={view.metadata} showTicker={false} /></div>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: 19 }}>{view.launch?.symbol ?? 'TOKEN'}</h1>
              <span className="faint small">{view.launch?.name}</span>
              <PhasePill phase={phase} />
            </div>
            <div className="row small" style={{ marginTop: 5, gap: 10, flexWrap: 'wrap' }}>
              <span className="faint"><Addr value={st.mint} href={view.explorer.mint || null} n={5} /></span>
              {view.metadata && <TokenLinks m={view.metadata} />}
              <button className="ghost small" onClick={() => setEditing(true)}>{view.metadata ? 'Edit details' : 'Add details (studio)'}</button>
            </div>
          </div>
        </div>
        <div className="gm-stats">
          <div className="gm-stat">
            <div className="small faint">Cap / token account</div>
            <div className="big-num">{graduated ? 'none' : capPct ?? 'no cap'}</div>
          </div>
          <div className="gm-stat">
            <div className="small faint">Curve fee now</div>
            <div className="big-num">{graduated ? '–' : feeNow === null ? 'n/a' : `~${feeNow}%`}</div>
          </div>
          <div className="gm-stat" style={{ minWidth: 180 }}>
            <div className="small faint" style={{ marginBottom: 7 }}>Curve progress</div>
            <CurveProgress reserve={view.pool?.quoteReserveSol ?? null} threshold={view.fee?.migrationQuoteThresholdSol ?? view.launch?.migrationQuoteThresholdSol ?? null} graduated={graduated} />
          </div>
        </div>
        {view.metadata?.description && <p className="gm-desc small muted clamp-1">{view.metadata.description}</p>}
      </div>
      {editing && <EditDetails meta={meta} mint={st.mint} ticker={view.launch?.symbol} metadata={view.metadata ?? null} onClose={() => setEditing(false)} onSaved={live.refresh} />}

      <div className="grid-token">
        {/* left: chart on top, then the tabbed bottom section with the scrollable trades feed */}
        <div className="stack">
          <Guard what="the price chart"><PriceCard mint={mint} /></Guard>
          <div>
            <div className="tabs page-tabs" role="tablist" aria-label="Token page sections" style={{ marginBottom: 12 }}>
              <button role="tab" aria-selected={tab === 'trades'} className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Trades</button>
              <button role="tab" aria-selected={tab === 'cap'} className={tab === 'cap' ? 'on' : ''} onClick={() => setTab('cap')}>Cap per token account</button>
              <button role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>Rules &amp; risks</button>
            </div>
            {tab === 'trades'
              ? <Guard what="the trades feed"><TradesFeed mint={mint} meta={meta} decimals={st.decimals ?? 6} /></Guard>
              : tab === 'cap' ? (
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
              )
              : <Guard what="the rules and risks"><RulesAndRisks vars={vars!} /></Guard>}
          </div>
        </div>

        {/* right: the token's hooks live, phases under it, then the stacked info sections */}
        <div className="sticky stack" style={{ marginTop: 0 }}>
          <LiveHooks meta={meta} capText={graduated ? 'ended' : capPct ?? 'no cap'} feeText={graduated ? 'ended' : feeNow === null ? 'n/a' : `~${feeNow}%`} switchUses={view.switchHistory.length} graduated={graduated} rules={view.rules ?? null} slot={slot} />
          {view.rules && view.rules.potEvery > 0 && <PotCard rules={view.rules} graduated={graduated} />}
          <Dropdown title="Phase" aside={<PhasePill phase={phase} />} defaultOpen>
            <PhaseStepper phase={phase} />
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
  return createPortal(
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
    </div>,
    document.body
  );
}

/** The four hooks, plus any optional ones this token launched with, with this token's live state; links to the hooks
 *  page for the diagrams. */
function LiveHooks({ meta, capText, feeText, switchUses, graduated, rules, slot }: { meta: Meta; capText: string; feeText: string; switchUses: number; graduated: boolean; rules: RulesView | null; slot: bigint }) {
  // max buy and the per-slot limit apply for their window (0 = until graduation); the hook is gone after graduation
  const inWindow = !!rules && !graduated && (rules.windowSlots === '0' || slot <= BigInt(rules.launchSlot) + BigInt(rules.windowSlots));
  const ruleState = (pct: string) => (graduated ? 'ended' : inWindow ? pct : 'window over');
  const extras = rules ? optionalHookList(rules).filter((h) => (h.id === 'maxbuy' ? rules.maxBuyBps > 0 : h.id === 'slot' ? rules.maxPerSlotBps > 0 : rules.potEvery > 0)) : [];
  const value: Record<string, string> = {
    maxbuy: rules ? ruleState(pctOf(rules.maxBuyBps)) : '',
    slot: rules ? ruleState(`${pctOf(rules.maxPerSlotBps)} / slot`) : '',
    pot: rules ? `${Number(rules.wins)} winner${rules.wins === '1' ? '' : 's'}` : '',
    cap: capText,
    fee: feeText,
    switch: switchUses ? `used ${switchUses}×` : 'never used',
    burn: graduated ? `${FLYWHEEL_SPLIT.buybackPct}% of fees` : 'after graduation',
  };
  return (
    <section className="card">
      <div className="card-head" style={{ marginBottom: 6 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>Hooks on this token</h2>
        <Link to="/hooks" className="right small link">How they work</Link>
      </div>
      <div className="hk-live">
        {[...hookList(meta), ...extras].map((h) => (
          <Link key={h.id} to={`/hooks#hook-${h.id}`} className={`hk-live-row tone-${h.tone}`}>
            <span className="hook-tile">{h.icon}</span>
            <span className="nm">{h.name}</span>
            <span className="v">{value[h.id]}</span>
          </Link>
        ))}
      </div>
      {rules && (rules.maxBuyBps > 0 || rules.maxPerSlotBps > 0) && <div className="small faint" style={{ marginTop: 8 }}>Max buy and per-slot limit: {windowText(rules.windowSlots)}.</div>}
    </section>
  );
}

/** Buy pot: the count so far, the next winning buy number, and the latest winners (on chain, last 16). */
function PotCard({ rules: r, graduated }: { rules: RulesView; graduated: boolean }) {
  const count = Number(r.buyCount), every = r.potEvery;
  const next = (Math.trunc(count / every) + 1) * every;
  const into = count % every;
  return (
    <section className="card tone-amber">
      <div className="card-head" style={{ marginBottom: 8 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>Buy pot</h2>
        <Link to="/hooks#hook-pot" className="right small link">How it works</Link>
      </div>
      <div className="pot-stats">
        <div><div className="k">Counted buys</div><div className="v">{count.toLocaleString()}</div></div>
        <div><div className="k">{graduated ? 'Ended at' : 'Next winner'}</div><div className="v">{graduated ? `#${count.toLocaleString()}` : `#${next.toLocaleString()}`}</div></div>
        <div><div className="k">Winners</div><div className="v">{Number(r.wins).toLocaleString()}</div></div>
      </div>
      {!graduated && <>
        <div className="pot-bar" role="progressbar" aria-valuemin={0} aria-valuemax={every} aria-valuenow={into} aria-label="Buys towards the next winner"><span style={{ width: `${(into / every) * 100}%` }} /></div>
        <div className="small faint" style={{ marginBottom: 10 }}>{every - into} more counted buy{every - into === 1 ? '' : 's'} to the next winner · every {ordinal(every)} buy of at least {pctOf(r.potMinBps)} wins</div>
      </>}
      {r.winners.length
        ? <ol className="pot-winners" aria-label="Latest pot winners">
            {r.winners.map((w) => (
              <li key={w.buyIndex}><span className="idx">#{Number(w.buyIndex).toLocaleString()}</span><Addr value={w.owner} n={5} /><span className="faint">slot {w.slot}</span></li>
            ))}
          </ol>
        : <p className="small faint" style={{ margin: 0 }}>No winners yet.</p>}
      <p className="small faint" style={{ margin: '10px 0 0' }}>Recorded on chain by the hook. Payouts aren’t switched on yet.</p>
    </section>
  );
}

// AC-22 trade panel: buy/sell on the curve with a preview of the destination token account's room under the cap
// (same cap math as the program). AC-26: a failed trade shows the "Why did my trade fail?" text for its error.
// Signing: today the backend signs with throwaway devnet test wallets (A/B). Browser-wallet signing (AC-21) replaces
// the "Signer" block; the rest of the panel stays as is.
import { useMemo, useState } from 'react';
import type { Meta, Side, TokenView, TradeResult } from '../lib/types';
import { api, FIXTURE_MODE } from '../lib/api';
import { CONTENT, fill, tok, pctOf, explainerKey, explainerTemplate, allowRetry, explainVars, approxDuration } from '../lib/shared';
import { buyPreview, curveFeePctAt, elapsedSlots, formatTokenAmount, isGraduated, liveCap, liveNextChange, parseTokenAmount } from '../lib/token';
import { useChecklist } from '../lib/hooks';
import { Addr } from './bits';
import { ChecklistModal } from './ChecklistModal';

interface Props { view: TokenView; meta: Meta; slot: bigint; vars: Record<string, string>; onTraded: () => Promise<void> }
type Outcome = { kind: 'result'; r: TradeResult; side: Side; wallet: string; amount: string } | { kind: 'error'; message: string };

export function TradePanel({ view, meta, slot, vars, onTraded }: Props) {
  const ck = useChecklist();
  const [showCk, setShowCk] = useState(false);
  const [side, setSide] = useState<Side>('buy');
  const [wallet, setWallet] = useState(Object.keys(meta.wallets)[0] ?? 'A');
  const [amount, setAmount] = useState('1000000');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const st = view.status;
  const dec = st.decimals ?? 6;
  const sym = view.launch?.symbol ?? 'tokens';
  const balance = BigInt(view.balances[wallet] ?? '0');
  const cap = liveCap(view, slot);
  const next = liveNextChange(view, slot);
  const feeNow = curveFeePctAt(view.fee, elapsedSlots(st, slot));

  const parsed = useMemo(() => { try { const v = parseTokenAmount(amount, dec); return v > 0n ? { v } : { err: 'Enter an amount above 0' }; } catch (e) { return { err: (e as Error).message }; } }, [amount, dec]);
  const amt = 'v' in parsed ? parsed.v! : 0n;
  const pv = buyPreview(balance, amt, cap);
  const sellTooMuch = side === 'sell' && amt > balance;

  if (isGraduated(view)) {
    return (
      <div className="card">
        <div className="card-head"><h2>Trade</h2></div>
        <div className="notice green">
          <b>This token has graduated.</b> The hook was removed and it now trades as a plain Token-2022 token on its DAMM v2 pool, with no cap. This panel only trades on the bonding curve.
        </div>
        {view.explorer.pool && <p className="small" style={{ marginTop: 10 }}><a href={view.explorer.pool} target="_blank" rel="noreferrer">View the curve pool on the explorer ↗</a></p>}
      </div>
    );
  }

  async function send(s: Side = side) {
    if (!('v' in parsed) || !ck.valid) return;
    setBusy(true); setOutcome(null);
    try {
      const r = await api.trade(st.mint, wallet, s, amount.trim().replace(/,/g, ''));
      await onTraded();
      setOutcome({ kind: 'result', r, side: s, wallet, amount });
    } catch (e) { setOutcome({ kind: 'error', message: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Trade</h2>
        <span className="right pill">{meta.cluster.toLowerCase()} · curve</span>
      </div>

      <div className="seg" role="tablist" aria-label="Side" style={{ marginBottom: 14 }}>
        <button role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'on buy' : ''} onClick={() => { setSide('buy'); setOutcome(null); }}>Buy</button>
        <button role="tab" aria-selected={side === 'sell'} className={side === 'sell' ? 'on sell' : ''} onClick={() => { setSide('sell'); setOutcome(null); }}>Sell</button>
      </div>

      <label className="field">
        <span>Signer</span>
        <select value={wallet} onChange={(e) => { setWallet(e.target.value); setOutcome(null); }}>
          {Object.entries(meta.wallets).map(([k, pk]) => <option key={k} value={k}>Test wallet {k} · {pk.slice(0, 4)}…{pk.slice(-4)}</option>)}
        </select>
      </label>
      <div className="notice amber small" style={{ marginTop: -4, marginBottom: 14 }}>
        Devnet demo: trades are signed on the server by throwaway test wallets, not your own wallet. Browser-wallet signing comes before any hosted page.
      </div>

      <label className="field">
        <span className="spread"><span>Amount</span><span className="faint">balance <span className="num">{tok(balance)}</span></span></span>
        <div className="amount">
          <input aria-label={`Amount (${sym})`} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setOutcome(null); }} aria-invalid={'err' in parsed} />
          <span className="unit">{sym}</span>
        </div>
      </label>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: -6, marginBottom: 12 }}>
        {side === 'buy'
          ? pv.room !== null && <button className="chip" disabled={pv.room === 0n} onClick={() => setAmount(formatTokenAmount(pv.room!, dec))}>Max under cap</button>
          : [25n, 50n, 100n].map((p) => <button key={String(p)} className="chip" disabled={balance === 0n} onClick={() => setAmount(formatTokenAmount((balance * p) / 100n, dec))}>{p === 100n ? 'All' : `${p}%`}</button>)}
      </div>
      {'err' in parsed && <p className="small fail" role="alert">{parsed.err}</p>}

      {/* preview */}
      {side === 'buy' ? (
        cap === null ? (
          <div className="notice small">No cap applies right now (ramp over or lifted).</div>
        ) : (
          <div>
            <div className="spread small" style={{ marginBottom: 5 }}>
              <span className="muted">Token account of wallet {wallet} after this buy</span>
              <span className="num">{tok(pv.after)} / {tok(cap)}</span>
            </div>
            <CapMeter balance={pv.balance} after={pv.after} cap={cap} />
            {pv.overBy > 0n
              ? <div className="notice red small" style={{ marginTop: 10 }}><b>Over the cap by {tok(pv.overBy)} {sym}.</b> This buy will fail with WalletCapExceeded. Room left now: {tok(pv.room ?? 0n)} {sym}.</div>
              : <div className="small faint" style={{ marginTop: 5 }}>Room left after this buy: <span className="num">{tok(cap - pv.after)}</span> {sym}</div>}
          </div>
        )
      ) : (
        <div className="notice small">
          Selling back into the curve is never blocked by the rule.{sellTooMuch && <><br /><span className="fail">That's more than wallet {wallet} holds.</span></>}
        </div>
      )}

      {side === 'buy' && view.fee && feeNow !== null && feeNow > view.fee.endPct && (
        <div className="notice amber small" style={{ marginTop: 10 }}>
          <b style={{ color: 'inherit' }}>Anti-sniper fee is ~{feeNow}% right now.</b> It applies to every buyer and falls to {view.fee.endPct}% in{' '}
          {approxDuration(BigInt(view.fee.totalSlots) - elapsedSlots(st, slot))}. Waiting costs less.
        </div>
      )}

      <dl className="kv small" style={{ marginTop: 12 }}>
        <dt>Curve fee now</dt>
        <dd className="num">{feeNow === null ? 'n/a' : `~${feeNow}%`} <span className="faint">(approx.{view.fee && feeNow !== null && feeNow > view.fee.endPct ? `, falls to ${view.fee.endPct}%` : ''})</span></dd>
        <dt>Cap now</dt>
        <dd className="num">{cap === null ? 'no cap' : `${tok(cap)} ${sym}`}</dd>
        <dt>Next cap change</dt>
        <dd>{next ? <>{next.bps === null ? 'no cap' : pctOf(next.bps)} in <span className="num">{approxDuration(next.slot - slot)}</span></> : <span className="faint">none</span>}</dd>
      </dl>

      <div style={{ marginTop: 14 }}>
        {!ck.valid ? (
          <>
            <button className="primary block" onClick={() => setShowCk(true)}>Read the pre-trade checklist</button>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="block" disabled>Buy</button><button className="block" disabled>Sell</button>
            </div>
            <p className="small faint" style={{ marginTop: 6, textAlign: 'center' }}>Tick all 8 lines in the checklist to enable trading.</p>
          </>
        ) : (
          <>
            <button className="primary block" disabled={busy || !('v' in parsed) || sellTooMuch} onClick={() => send()}>
              {busy ? 'Sending…' : `${side === 'buy' ? (pv.overBy > 0n ? 'Buy anyway (will fail)' : 'Buy') : 'Sell'} ${'v' in parsed ? tok(amt) : ''} ${sym}`}
            </button>
            <p className="small faint" style={{ marginTop: 6, textAlign: 'center' }}>Checklist confirmed · valid 30 days</p>
          </>
        )}
      </div>

      {outcome && <Outcome o={outcome} view={view} vars={vars} onRetry={(s) => send(s)} />}
      {showCk && <ChecklistModal vars={vars} onClose={() => setShowCk(false)} />}
    </div>
  );
}

function CapMeter({ balance, after, cap }: { balance: bigint; after: bigint; cap: bigint }) {
  const scale = after > cap ? after : cap;
  const pct = (v: bigint) => (scale === 0n ? 0 : Number((v * 10000n) / scale) / 100);
  const within = after > cap ? cap : after;
  return (
    <div className="meter big" aria-hidden="true">
      <span className="fill" style={{ width: `${pct(balance > cap ? cap : balance)}%` }} />
      {within > balance && <span className="add" style={{ left: `${pct(balance)}%`, width: `${pct(within - balance)}%` }} />}
      {after > cap && <span className="over" style={{ left: `${pct(cap)}%`, width: `${pct(after - cap)}%` }} />}
      {after > cap && <span style={{ left: `${pct(cap)}%`, width: 2, background: 'var(--text)' }} />}
    </div>
  );
}

function Outcome({ o, view, vars, onRetry }: { o: Outcome; view: TokenView; vars: Record<string, string>; onRetry: (s: Side) => void }) {
  if (o.kind === 'error') return <div className="notice red small" style={{ marginTop: 12 }} role="alert"><b>The trade wasn't sent.</b> {o.message}</div>;
  const { r, side, wallet } = o;
  const txLink = r.link
    ? <a href={r.link} target="_blank" rel="noreferrer" className="mono">{r.sig.slice(0, 16)}… ↗</a>
    : <span className="mono faint">{FIXTURE_MODE ? 'simulated, no transaction' : r.sig ? `${r.sig.slice(0, 16)}…` : 'no signature'}</span>;
  if (r.ok) return <div className="notice green small" style={{ marginTop: 12 }} role="status"><b>{side === 'buy' ? 'Bought' : 'Sold'} {tok(parseTokenAmount(o.amount, view.status.decimals ?? 6))} {view.launch?.symbol ?? 'tokens'}.</b> {txLink}</div>;
  const t = CONTENT.trade_fail_explainer;
  const key = explainerKey(r, side);
  let text: string;
  try { text = fill(explainerTemplate(t, key), { ...vars, ...explainVars(r, view, wallet) }); }
  catch (e) { text = `${(e as Error).message}. Raw error: ${r.hookError || r.err || 'unknown'}`; }
  return (
    <div className="notice red small" style={{ marginTop: 12 }} role="alert" data-key={key}>
      <div className="spread"><b>{t.title}</b>{txLink}</div>
      <p style={{ margin: '6px 0 0' }}>{text}</p>
      {allowRetry(key) && <button className="small" style={{ marginTop: 8 }} onClick={() => onRetry(side)}>Try again</button>}
    </div>
  );
}

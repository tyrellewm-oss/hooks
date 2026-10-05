// AC-22 trade panel: buy/sell on the curve with a preview of the destination token account's room under the cap
// (same cap math as the program). AC-26: a failed trade shows the "Why did my trade fail?" text for its error.
// Signing (AC-21): with a connected browser wallet, the server builds an unsigned swap (simulated first, so a cap hit
// is explained before signing), the wallet signs, and the server relays it. The server-signed throwaway test wallets
// (A/B) stay selectable for the devnet demo.
import { useEffect, useMemo, useState } from 'react';
import type { BuiltSwap, Meta, Side, TokenView, TradeResult } from '../lib/types';
import { api, FIXTURE_MODE } from '../lib/api';
import { CONTENT, fill, tok, explainerKey, explainerTemplate, allowRetry, explainVars, approxDuration } from '../lib/shared';
import { buyPreview, curveFeePctAt, elapsedSlots, formatTokenAmount, isGraduated, liveCap, parseTokenAmount } from '../lib/token';
import { useChecklist } from '../lib/hooks';
import { bytesToB64, hexToBytes, signTransaction, useWallet } from '../lib/wallet';
import { Addr } from './bits';
import { ChecklistModal } from './ChecklistModal';

interface Props { view: TokenView; meta: Meta; slot: bigint; vars: Record<string, string>; onTraded: () => Promise<void> }
type Outcome = { kind: 'result'; r: TradeResult; side: Side; wallet: string; amount: string; presign?: boolean; quote?: BuiltSwap['quote'] } | { kind: 'error'; message: string };
/** lamports -> SOL text; small amounts keep all 9 decimals (trailing zeros dropped) so a quote and its limit stay distinct */
const sol = (lamports: string) => { const n = Number(lamports); return n >= 1e7 ? (n / 1e9).toFixed(4) : (n / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, ''); };
/** Signer value for the connected browser wallet (test wallets use their keys 'A'/'B'). */
const YOU = '__wallet__';

export function TradePanel({ view, meta, slot, vars, onTraded }: Props) {
  const ck = useChecklist();
  const [showCk, setShowCk] = useState(false);
  const [side, setSide] = useState<Side>('buy');
  const bw = useWallet();
  const [wallet, setWallet] = useState(bw.address ? YOU : Object.keys(meta.wallets)[0] ?? 'A');
  useEffect(() => {   // follow the wallet: connected -> sign with it; disconnected -> back to a test wallet
    if (bw.address) setWallet(YOU); else setWallet((w) => (w === YOU ? Object.keys(meta.wallets)[0] ?? 'A' : w));
  }, [bw.address, meta.wallets]);
  const [step, setStep] = useState('');
  const [slippageBps, setSlippageBps] = useState(100);
  const [amount, setAmount] = useState('1000000');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const st = view.status;
  const dec = st.decimals ?? 6;
  const sym = view.launch?.symbol ?? 'tokens';
  const usingWallet = wallet === YOU && !!bw.address;
  const who = usingWallet ? 'your wallet' : `test wallet ${wallet}`;
  const balance = BigInt((usingWallet ? view.wallet?.tokens : view.balances[wallet]) ?? '0');
  const cap = liveCap(view, slot);
  const feeNow = curveFeePctAt(view.fee, elapsedSlots(st, slot));

  const parsed = useMemo(() => { try { const v = parseTokenAmount(amount, dec); return v > 0n ? { v } : { err: 'Enter an amount above 0' }; } catch (e) { return { err: (e as Error).message }; } }, [amount, dec]);
  const amt = 'v' in parsed ? parsed.v! : 0n;
  const pv = buyPreview(balance, amt, cap);
  const sellTooMuch = side === 'sell' && amt > balance;
  // after graduation the token trades on its DAMM v2 pool: browser wallet only (the server test wallets are curve-only)
  const onPool = isGraduated(view);
  const poolNeedsWallet = onPool && !usingWallet;

  async function send(s: Side = side) {
    if (!('v' in parsed) || !ck.valid) return;
    setBusy(true); setOutcome(null);
    const amt = amount.trim().replace(/,/g, '');
    try {
      if (usingWallet) {
        setStep('Preparing…');
        const built = await api.walletBuild(st.mint, bw.address!, s, amt, onPool ? { venue: 'pool', slippageBps } : undefined);
        if (!built.simulation.ok) {   // stop before the wallet prompt: explain why it would fail
          const sim = built.simulation;
          setOutcome({ kind: 'result', presign: true, side: s, wallet: YOU, amount, r: { ok: false, sig: '', link: '', err: sim.err ?? undefined, hookError: sim.hookError, hookCode: sim.hookCode, capHit: sim.capHit ?? undefined } });
          return;
        }
        setStep(built.quote ? `Approve in your wallet… (${s === 'buy' ? 'at most' : 'at least'} ${sol(built.quote.limitLamports)} SOL)` : 'Approve in your wallet…');
        let signed: Uint8Array;
        try { signed = await signTransaction(hexToBytes(built.tx)); }
        catch (e) { setOutcome({ kind: 'error', message: /reject|denied|cancel/i.test((e as Error).message) ? 'You declined in the wallet. Nothing was sent.' : (e as Error).message }); return; }
        setStep('Sending…');
        const r = await api.walletSubmit(bytesToB64(signed));
        await onTraded();
        setOutcome({ kind: 'result', r, side: s, wallet: YOU, amount, quote: built.quote });
      } else {
        setStep('Sending…');
        const r = await api.trade(st.mint, wallet, s, amt);
        await onTraded();
        setOutcome({ kind: 'result', r, side: s, wallet, amount });
      }
    } catch (e) { setOutcome({ kind: 'error', message: (e as Error).message }); }
    finally { setBusy(false); setStep(''); }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Trade</h2>
        <span className={`right pill ${onPool ? 'green' : ''}`}>{meta.cluster.toLowerCase()} · {onPool ? 'pool (graduated)' : 'curve'}</span>
      </div>

      <div className="seg" role="tablist" aria-label="Side" style={{ marginBottom: 14 }}>
        <button role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'on buy' : ''} onClick={() => { setSide('buy'); setOutcome(null); }}>Buy</button>
        <button role="tab" aria-selected={side === 'sell'} className={side === 'sell' ? 'on sell' : ''} onClick={() => { setSide('sell'); setOutcome(null); }}>Sell</button>
      </div>

      <label className="field">
        <span>Signer</span>
        <select value={wallet} onChange={(e) => { setWallet(e.target.value); setOutcome(null); }}>
          {bw.address && <option value={YOU}>Your wallet · {bw.address.slice(0, 4)}…{bw.address.slice(-4)}</option>}
          {Object.entries(meta.wallets).map(([k, pk]) => <option key={k} value={k} disabled={onPool}>Test wallet {k} (server-signed{onPool ? ', curve only' : ''}) · {pk.slice(0, 4)}…{pk.slice(-4)}</option>)}
        </select>
        <span className={`signer-line ${poolNeedsWallet ? 'warn' : ''}`}>
          {usingWallet
            ? <>You sign in {bw.wallet?.name ?? 'your wallet'}; the page never sees your key. Devnet SOL only{view.wallet ? <>: you have <span className="num">{view.wallet.sol.toFixed(3)}</span></> : null}.</>
            : poolNeedsWallet
            ? <>Graduated: pool trades need your own wallet. {bw.address ? 'Pick "Your wallet" above.' : 'Connect one (top right).'}</>
            : <>Throwaway test wallet, signed on the server. {bw.address ? 'Pick "Your wallet" to sign yourself.' : 'Connect a wallet (top right) to sign yourself.'}</>}
        </span>
      </label>

      <label className="field">
        <span className="spread"><span>Amount</span><span className="faint">balance <span className="num">{tok(balance)}</span></span></span>
        <div className="amount">
          <input aria-label={`Amount (${sym})`} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setOutcome(null); }} aria-invalid={'err' in parsed} />
          <span className="unit">{sym}</span>
        </div>
      </label>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: -6, marginBottom: 12 }}>
        {side === 'buy'
          ? !onPool && pv.room !== null && <button className="chip" disabled={pv.room === 0n} onClick={() => setAmount(formatTokenAmount(pv.room!, dec))}>Max under cap</button>
          : [25n, 50n, 100n].map((p) => <button key={String(p)} className="chip" disabled={balance === 0n} onClick={() => setAmount(formatTokenAmount((balance * p) / 100n, dec))}>{p === 100n ? 'All' : `${p}%`}</button>)}
      </div>
      {'err' in parsed && <p className="small fail" role="alert">{parsed.err}</p>}

      {/* preview */}
      {onPool ? (
        <div>
          <div className="spread small" style={{ alignItems: 'center' }}>
            <span className="muted">Slippage limit</span>
            <div className="tabs" role="radiogroup" aria-label="Slippage limit" style={{ padding: 3 }}>
              {[50, 100, 200, 500].map((b) => <button key={b} role="radio" aria-checked={slippageBps === b} className={slippageBps === b ? 'on' : ''} style={{ padding: '3px 10px', fontSize: 12.5 }} onClick={() => setSlippageBps(b)}>{b / 100}%</button>)}
            </div>
          </div>
          <div className="small faint" style={{ marginTop: 8 }}>
            Graduated: no cap. Trades go to the token's DAMM v2 pool (base fee {vars.POOL_FEE}, no anti-sniper fee). The trade fails rather than {side === 'buy' ? 'pay more' : 'receive less'} than the quote {side === 'buy' ? 'plus' : 'minus'} {slippageBps / 100}%; your wallet shows the exact amounts before you sign.
            {sellTooMuch && <><br /><span className="fail">That's more than {who} holds.</span></>}
          </div>
        </div>
      ) : side === 'buy' ? (
        cap === null ? (
          <div className="notice small">No cap applies right now (ramp over or lifted).</div>
        ) : (
          <div>
            <div className="spread small" style={{ marginBottom: 5 }}>
              <span className="muted">Token account of {who} after this buy</span>
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
          Selling back into the curve is never blocked by the rule.{sellTooMuch && <><br /><span className="fail">That's more than {who} holds.</span></>}
        </div>
      )}

      {!onPool && side === 'buy' && view.fee && feeNow !== null && feeNow > view.fee.endPct && (
        <div className="notice amber small" style={{ marginTop: 10 }}>
          <b style={{ color: 'inherit' }}>Anti-sniper fee is ~{feeNow}% right now.</b> It applies to every buyer and falls to {view.fee.endPct}% in{' '}
          {approxDuration(BigInt(view.fee.totalSlots) - elapsedSlots(st, slot))}. Waiting costs less.
        </div>
      )}

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
            <button className={`primary block trade-${side}`} disabled={busy || !('v' in parsed) || sellTooMuch || poolNeedsWallet} onClick={() => send()}>
              {busy ? step || 'Sending…' : `${side === 'buy' ? (!onPool && pv.overBy > 0n ? 'Buy anyway (will fail)' : 'Buy') : 'Sell'} ${'v' in parsed ? tok(amt) : ''} ${sym}`}
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
  // the browser wallet's balance lives in view.wallet; the explainer's {WALLET_BALANCE} reads balances[wallet]
  const v = wallet === YOU ? { ...view, balances: { ...view.balances, [YOU]: view.wallet?.tokens ?? '0' } } : view;
  const txLink = o.presign
    ? <span className="mono faint">not signed, not sent</span>
    : r.link
    ? <a href={r.link} target="_blank" rel="noreferrer" className="mono">{r.sig.slice(0, 16)}… ↗</a>
    : <span className="mono faint">{FIXTURE_MODE ? 'simulated, no transaction' : r.sig ? `${r.sig.slice(0, 16)}…` : 'no signature'}</span>;
  if (r.ok) return <div className="notice green small" style={{ marginTop: 12 }} role="status"><b>{side === 'buy' ? 'Bought' : 'Sold'} {tok(parseTokenAmount(o.amount, view.status.decimals ?? 6))} {view.launch?.symbol ?? 'tokens'}.</b>{o.quote && <> Quoted {sol(o.quote.expectedLamports)} SOL, limit {sol(o.quote.limitLamports)} SOL ({o.quote.slippageBps / 100}%).</>} {txLink}</div>;
  const t = CONTENT.trade_fail_explainer;
  const key = explainerKey(r, side);
  let text: string;
  try { text = fill(explainerTemplate(t, key), { ...vars, ...explainVars(r, v, wallet) }); }
  catch (e) { text = `${(e as Error).message}. Raw error: ${r.hookError || r.err || 'unknown'}`; }
  return (
    <div className="notice red small" style={{ marginTop: 12 }} role="alert" data-key={key}>
      <div className="spread"><b>{t.title}</b>{txLink}</div>
      {o.presign && <p style={{ margin: '6px 0 0' }}><b>Stopped before your wallet asked you to sign:</b> a check of this trade shows it would fail.</p>}
      <p style={{ margin: '6px 0 0' }}>{text}</p>
      {allowRetry(key) && <button className="small" style={{ marginTop: 8 }} onClick={() => onRetry(side)}>Try again</button>}
    </div>
  );
}

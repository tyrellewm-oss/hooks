// The launch tool. Open launch (meta.launch.mode 'open', sdk/launch_open.ts): any connected wallet launches and pays; it
// approves twice (the curve config, then the launch) and the server only co-signs. Otherwise the studio flow: a studio
// wallet signs in first. Same validation as the program (validate + RELEASE_LIMITS, AC-4) before anything is sent; the
// server validates again.
import { useMemo, useState, type ReactNode } from 'react';
import type { BuyRulesInput, CreateReply, Meta, OpenLaunchReply, StepJson } from '../lib/types';
import { api } from '../lib/api';
import { navigate } from '../lib/hooks';
import { WalletButton } from '../components/WalletButton';
import { useWallet, signTransaction, hexToBytes, bytesToHex } from '../lib/wallet';
import { validate, RELEASE_LIMITS, STRICT, BALANCED, LOOSE, LOCAL_DEMO, pctOf, approxDuration, type NamedSchedule, type ScheduleError } from '../lib/shared';
import { CapRamp } from '../components/CapRamp';
import { Addr, Link } from '../components/bits';
import { StudioGate, StudioSessionControls } from '../components/StudioGate';
import { useStudioAccess } from '../lib/studio';
import { DetailsForm, emptyDetails, toInput, detailsError, type DetailsState } from '../components/TokenDetails';
import { CapDiagram } from '../components/HookArt';
import { hookList, optionalHookList, creatorLockInfo, RULES_DEFAULT, RULES_WINDOWS, CREATOR_LOCK_DEFAULT, CREATOR_LOCK_DURATIONS, windowText, ordinal, type HookId, type OptionalHookId } from '../lib/hookInfo';
import { HooksLink } from './HooksPage';
import { IconArrow, IconCheck } from '../components/Icons';

const SCHEDULE_ERRORS: Record<ScheduleError, string> = {
  BadLength: 'Use 1 to 8 steps.',
  FirstOffsetNotZero: 'The first step must start at slot 0.',
  BadOffsets: 'Steps must be in order and at least 10 slots apart.',
  Decreasing: "A cap can't be lower than the step before it.",
  OutOfRange: 'Each cap must be between 0.1% and 100% of supply.',
  BadEnd: 'No cap from: at least 10 slots after the last step, and between 150 and 6,480,000 slots.',
  ZeroSupply: 'Supply must be above 0.',
};

interface Row { offset: string; pct: string }

/** The optional hooks as the form holds them (percent strings); `on` says which are switched on. */
interface Extras { on: Record<OptionalHookId, boolean>; maxBuyPct: string; perSlotPct: string; windowSlots: string; potEvery: string; potMinPct: string; cooldownSlots: string; lockOn: boolean; lockPct: string; lockSlots: string }
const pctStr = (bps: number) => String(bps / 100);
const emptyExtras = (): Extras => ({ on: { maxbuy: false, slot: false, pot: false, cooldown: false }, maxBuyPct: pctStr(RULES_DEFAULT.maxBuyBps), perSlotPct: pctStr(RULES_DEFAULT.maxPerSlotBps), windowSlots: RULES_DEFAULT.windowSlots, potEvery: String(RULES_DEFAULT.potEvery), potMinPct: pctStr(RULES_DEFAULT.potMinBps), cooldownSlots: String(RULES_DEFAULT.cooldownSlots), lockOn: false, lockPct: String(CREATOR_LOCK_DEFAULT.pct), lockSlots: String(CREATOR_LOCK_DEFAULT.slots) });
/** Some wallets reject with a string or a plain object instead of an Error; always show the user something. */
const errText = (e: unknown): string => (e instanceof Error && e.message) || (typeof e === 'string' && e) || 'Something went wrong in the wallet. Nothing was launched — try again.';
/** percent of supply (up to 2 decimals) -> bps, or null if it isn't one */
const toBps = (v: string, min: number) => { const t = v.trim(); if (!/^\d+(\.\d{1,2})?$/.test(t)) return null; const b = Math.round(Number(t) * 100); return b >= min && b <= 10_000 ? b : null; };
/** Same limits as the server (sdk/buy_rules.ts) and the program (validate_rules). */
function checkExtras(x: Extras): { err: string | null; rules?: BuyRulesInput; lock?: { pct: number; slots: number } } {
  let lock: { pct: number; slots: number } | undefined;
  if (x.lockOn) {
    const pct = /^\d+$/.test(x.lockPct.trim()) ? Number(x.lockPct) : NaN;
    if (!(pct >= 1 && pct <= 10)) return { err: 'Creator lock: a whole percent of supply, 1 to 10.' };
    lock = { pct, slots: Number(x.lockSlots) };
  }
  if (!x.on.maxbuy && !x.on.slot && !x.on.pot && !x.on.cooldown) return { err: null, lock };
  const maxBuyBps = x.on.maxbuy ? toBps(x.maxBuyPct, 1) : 0;
  if (maxBuyBps === null) return { err: 'Max single buy: 0.01% to 100% of supply.' };
  const maxPerSlotBps = x.on.slot ? toBps(x.perSlotPct, 1) : 0;
  if (maxPerSlotBps === null) return { err: 'Per-slot limit: 0.01% to 100% of supply.' };
  if (maxBuyBps && maxPerSlotBps && maxPerSlotBps < maxBuyBps) return { err: 'The per-slot limit must be at least the max single buy.' };
  const potEvery = x.on.pot ? (/^\d+$/.test(x.potEvery.trim()) ? Number(x.potEvery) : NaN) : 0;
  if (x.on.pot && !(potEvery >= 10 && potEvery <= 100_000)) return { err: 'Buy pot: a winner every 10 to 100,000 buys.' };
  const potMinBps = x.on.pot ? toBps(x.potMinPct, 0) : 0;
  if (potMinBps === null) return { err: 'Buy pot minimum: 0% to 100% of supply, up to 2 decimals.' };
  const cooldownSlots = x.on.cooldown ? (/^\d+$/.test(x.cooldownSlots.trim()) ? Number(x.cooldownSlots) : NaN) : 0;
  if (x.on.cooldown && !(cooldownSlots >= 1 && cooldownSlots <= 150)) return { err: 'Slow mode: 1 to 150 slots between buys (~0.4 s to ~1 min).' };
  return { err: null, rules: { maxBuyBps, maxPerSlotBps, windowSlots: x.on.maxbuy || x.on.slot || x.on.cooldown ? x.windowSlots : '0', potEvery, potMinBps, cooldownSlots }, lock };
}
const rowsOf = (s: NamedSchedule): Row[] => s.steps.map((x) => ({ offset: x.slotOffset.toString(), pct: String(x.maxBps / 100) }));

export function CreatePage({ meta }: { meta: Meta }) {
  const { ok: studioAccess, required: studioRequired, session: studioSession } = useStudioAccess(meta.studio?.required ?? false);
  // open launch: no studio sign-in; the connected wallet pays and signs
  const open = meta.launch?.mode === 'open';
  const thr = meta.launch?.thresholdSol;
  const firstName = open ? '' : 'Hookd Test', firstSymbol = open ? '' : 'TTEST';
  const presets = meta.cluster === 'LOCAL' ? [LOCAL_DEMO, BALANCED, STRICT, LOOSE] : [BALANCED, STRICT, LOOSE];
  const [preset, setPreset] = useState(presets[0].id);
  const [rows, setRows] = useState<Row[]>(rowsOf(presets[0]));
  const [unc, setUnc] = useState(presets[0].uncappedAfter.toString());
  const [name, setName] = useState(firstName);
  const [symbol, setSymbol] = useState(firstSymbol);
  const [threshold, setThreshold] = useState('1');
  const bw = useWallet();
  const [step, setStep] = useState('');
  const [onMigration, setOnMigration] = useState('20');
  const [details, setDetails] = useState<DetailsState>(emptyDetails());
  const [extras, setExtras] = useState<Extras>(emptyExtras());
  const extrasCheck = useMemo(() => checkExtras(extras), [extras]);
  const extrasOn = (Object.keys(extras.on) as OptionalHookId[]).filter((k) => extras.on[k]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateReply | null>(null);
  const [launched, setLaunched] = useState<OpenLaunchReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (id: string) => {
    setPreset(id);
    const p = presets.find((x) => x.id === id);
    if (p) { setRows(rowsOf(p)); setUnc(p.uncappedAfter.toString()); }
  };
  const edit = (i: number, k: keyof Row, v: string) => { setPreset('custom'); setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x))); };

  const check = useMemo(() => {
    try {
      if (!rows.every((r) => /^\d+$/.test(r.offset.trim()) && /^\d+(\.\d+)?$/.test(r.pct.trim())) || !/^\d+$/.test(unc.trim())) return { err: 'Slots must be whole numbers and caps must be numbers.' };
      const steps = rows.map((r) => ({ slotOffset: BigInt(r.offset.trim()), maxBps: Math.round(Number(r.pct) * 100) }));
      const e = validate({ launchSlot: 0n, supply: 1n, steps, uncappedAfter: BigInt(unc.trim()) }, RELEASE_LIMITS);
      if (e) return { err: `InvalidCapSchedule (${e}): ${SCHEDULE_ERRORS[e as ScheduleError]}` };
      return { steps: steps.map((s) => ({ slotOffset: s.slotOffset.toString(), maxBps: s.maxBps })) as StepJson[] };
    } catch (e) { return { err: (e as Error).message }; }
  }, [rows, unc]);

  const nameErr = !name.trim() ? 'Enter a name.' : !/^[A-Z0-9]{2,10}$/.test(symbol) ? 'Ticker: 2 to 10 letters or digits.' : detailsError(details);
  const curveErr = !(Number(threshold) > 0) ? 'Threshold must be above 0 SOL.'
    : open && thr && !(Number(threshold) >= thr.min && Number(threshold) <= thr.max) ? `Graduation threshold: ${thr.min} to ${thr.max} SOL.`
    : !(Number.isInteger(Number(onMigration)) && +onMigration >= 1 && +onMigration <= 49) ? 'Supply to the pool at graduation: 1 to 49%.' : null;
  const formErr = nameErr ?? curveErr;
  const selected = presets.find((p) => p.id === preset);

  // ---- steps: what each one checks, and how far the user has got
  const STEPS: { id: string; label: string; err: string | null }[] = [
    { id: 'hooks', label: 'Hooks', err: null },
    { id: 'cap', label: 'Cap schedule', err: 'err' in check ? check.err! : null },
    { id: 'extras', label: 'Optional hooks', err: extrasCheck.err },
    { id: 'token', label: 'Token', err: nameErr },
    { id: 'curve', label: 'Graduation', err: curveErr },
    { id: 'review', label: 'Review', err: null },
  ];
  const [at, setAt] = useState(0);
  const [seen, setSeen] = useState(0);   // furthest step reached
  const go = (i: number) => { setAt(i); setSeen((s) => Math.max(s, i)); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const cur = STEPS[at];
  const goId = (id: string) => go(STEPS.findIndex((x) => x.id === id));
  const stateOf = (i: number) => (i === at ? 'now' : i > seen ? 'todo' : STEPS[i].err ? 'warn' : 'done');
  const reset = () => {
    pick(presets[0].id); setName(firstName); setSymbol(firstSymbol); setThreshold('1'); setOnMigration('20');
    setDetails(emptyDetails()); setExtras(emptyExtras()); setResult(null); setLaunched(null); setError(null); setAt(0); setSeen(0);
  };

  async function create() {
    if (!('steps' in check) || formErr || extrasCheck.err) return;
    setBusy(true); setError(null); setResult(null); setLaunched(null);
    const opts = { name: name.trim(), symbol, steps: check.steps!, uncappedAfter: unc.trim(), thresholdSol: Number(threshold), percentageSupplyOnMigration: Number(onMigration), ...(extrasCheck.rules ? { rules: extrasCheck.rules } : {}), ...(extrasCheck.lock ? { creatorLockPct: extrasCheck.lock.pct, creatorLockSlots: extrasCheck.lock.slots } : {}) };
    const req = { ...opts, metadata: toInput(details) };
    try {
      if (open) {
        // open launch: approve 1 = the curve config, approve 2 = the launch; the details go with the last step only
        if (!bw.address) { setError('Connect a wallet first.'); return; }
        const owner = bw.address;
        let configMade = false;
        const sign = async (hex: string): Promise<string | null> => {
          try { return bytesToHex(await signTransaction(hexToBytes(hex))); }
          catch (e) {
            const m = errText(e);
            setError(/reject|denied|cancel/i.test(m) ? `You declined in the wallet. Nothing was launched${configMade ? ' (the curve config was created: about 0.006 devnet SOL)' : ''}.` : m);
            return null;
          }
        };
        setStep('Preparing…');
        const s1 = await api.openConfig({ ...opts, owner });
        setStep('Approve 1 of 2 in your wallet: the curve config…');
        const configTx = await sign(s1.configTx); if (!configTx) return;
        setStep('Creating the curve config…');
        const s2 = await api.openBuild({ ...opts, owner, configTx, ticket: s1.ticket });
        configMade = true;
        setStep('Approve 2 of 2 in your wallet: the launch…');
        const poolTx = await sign(s2.poolTx); if (!poolTx) return;
        setStep('Launching…');
        const out = await api.openSubmit(poolTx, meta.launch?.details ? req.metadata : undefined);
        setLaunched(out);
        if (!out.detailsNote) navigate(`/token/${out.mint}`);
        return;
      }
      if (bw.address) {
        // AC-21: the launch tx is signed in the connected wallet; the server co-signs with the launch key (8.3)
        setStep('Preparing the launch…');
        const built = await api.launchBuild({ ...req, owner: bw.address });
        setStep('Approve the launch in your wallet…');
        let signed: Uint8Array;
        try { signed = await signTransaction(hexToBytes(built.tx)); }
        catch (e) { const m = errText(e); setError(/reject|denied|cancel/i.test(m) ? 'You declined in the wallet. Nothing was launched.' : m); return; }
        setStep('Sending…');
        setResult(await api.launchSubmit(bytesToHex(signed)));
      } else {
        setResult(await api.create(req));   // server-signed test path (no wallet connected)
      }
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); setStep(''); }
  }

  const blocking = STEPS.findIndex((s) => s.err);
  const capRange = 'err' in check ? null : `${pctOf(check.steps![0].maxBps)} → ${pctOf(check.steps![check.steps!.length - 1].maxBps)}`;
  return (
    <div className={`stack launch-page${open || studioAccess ? '' : ' launch-entry'}`}>
      <div className="launch-heading-row">
      <section className="wiz-head">
        <div className="small faint wiz-kicker">{open ? 'Launch' : 'Studio launch'} · {meta.cluster.toLowerCase()}</div>
        <h1>Launch a token</h1>
        <p className="muted">Six short steps. Everything is fixed at launch, except the cap, which can only be lifted later.</p>
      </section>
      {!open && studioAccess && studioRequired && studioSession && <StudioSessionControls wallet={studioSession.wallet} />}
      </div>
      <StudioGate meta={meta} variant="launch" showSession={false} bypass={open}>
      <div className="wiz-bar">
        <ol className="wiz-steps" aria-label="Launch steps">
          {STEPS.map((s, i) => {
            const st = stateOf(i);
            return (
              <li key={s.id}>
                <button className={`wiz-step ${st}`} aria-current={i === at ? 'step' : undefined} onClick={() => go(i)} disabled={i > seen + 1}>
                  <span className="wiz-line" />
                  <span className="wiz-label"><span className="num">{i + 1}</span> {s.label}</span>
                  <span className="wiz-mark" aria-label={st === 'done' ? 'done' : st === 'warn' ? 'needs attention' : undefined}>{st === 'done' ? <IconCheck size={13} /> : st === 'warn' ? <b className="wiz-bang">!</b> : null}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <button className="wiz-reset small" onClick={reset}>Reset</button>
      </div>
      <div className="wiz-mobile-now">Step {at + 1} of {STEPS.length} · {cur.label}</div>
      <div className="wiz-legend small faint"><span><IconCheck size={12} /> done</span><span><b className="wiz-bang">!</b> needs attention</span><span><i className="wiz-now-dot" /> current step</span></div>

      <div className="wiz-grid">
        <div className="wiz-main">
          {cur.id === 'hooks' && <HooksPicker meta={meta} capText={'err' in check ? null : pctOf(check.steps![0].maxBps)} extrasOn={extrasOn.length} onExtras={() => goId('extras')} />}

          {cur.id === 'extras' && <OptionalHooksStep value={extras} onChange={setExtras} err={extrasCheck.err} capStartBps={'err' in check ? null : check.steps![0].maxBps} />}

          {cur.id === 'cap' && (
            <div className="card">
              <div className="card-head"><h2>Cap schedule</h2>{selected && <span className={`right pill ${selected.id === 'balanced' ? 'green' : 'amber'}`}>{selected.label}</span>}</div>
              <p className="small muted" style={{ marginTop: -6 }}>How much of the supply one token account can hold, and how that rises over time. Start from a preset; edit the steps only if you need to.</p>
              <label className="field"><span>Preset</span>
                <select value={preset} onChange={(e) => pick(e.target.value)}>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.label})</option>)}
                  <option value="custom">Custom (not approved)</option>
                </select>
              </label>
              {'err' in check
                ? <div className="notice red small" style={{ marginBottom: 12 }}>{check.err}</div>
                : <>
                    <CapRamp steps={check.steps!} uncappedAfter={unc} height={210} />
                    <p className="small faint" style={{ marginTop: 6 }}>{check.steps!.map((s) => `${pctOf(s.maxBps)} from +${s.slotOffset}`).join(', ')}, no cap from +{unc} ({approxDuration(unc)}).</p>
                  </>}
              <details className="wiz-adv" open={preset === 'custom'}>
                <summary>Edit the steps</summary>
                <table className="small" style={{ margin: '10px 0' }}>
                  <thead><tr><th>From slot</th><th>Cap (% of supply)</th><th style={{ width: 90 }}>≈ time</th><th style={{ width: 40 }} /></tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td><input value={r.offset} disabled={i === 0} onChange={(e) => edit(i, 'offset', e.target.value)} aria-label={`Step ${i + 1} slot offset`} /></td>
                        <td><input value={r.pct} onChange={(e) => edit(i, 'pct', e.target.value)} aria-label={`Step ${i + 1} cap percent`} /></td>
                        <td className="faint num">{/^\d+$/.test(r.offset) ? (r.offset === '0' ? 'launch' : approxDuration(r.offset)) : ''}</td>
                        <td>{i > 0 && <button className="ghost" aria-label={`Remove step ${i + 1}`} onClick={() => { setPreset('custom'); setRows((x) => x.filter((_, j) => j !== i)); }}>✕</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="row" style={{ marginBottom: 12 }}>
                  <button className="small" disabled={rows.length >= 8} onClick={() => { setPreset('custom'); const last = rows[rows.length - 1]; setRows([...rows, { offset: String(Number(last.offset) + 150), pct: last.pct }]); }}>Add step</button>
                </div>
                <label className="field" style={{ marginBottom: 0 }}><span>No cap from slot (≈ {/^\d+$/.test(unc) ? approxDuration(unc) : '?'})</span>
                  <input value={unc} onChange={(e) => { setPreset('custom'); setUnc(e.target.value); }} />
                </label>
              </details>
            </div>
          )}

          {cur.id === 'token' && (
            <div className="card">
              <div className="card-head"><h2>Token</h2></div>
              <div className="wiz-two">
                <label className="field"><span>Name</span><input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} /></label>
                <label className="field"><span>Ticker</span><input value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></label>
              </div>
              <div className="wiz-sep" />
              {open && !meta.launch?.details
                ? <div className="small faint">Image, description and links can't be saved on this site yet. Your token launches with its name and ticker, and the generated art.</div>
                : <>
                    <div className="small faint" style={{ marginBottom: 10 }}>Image, description and links are optional and can be edited after launch{open ? ' by the wallet that launched it' : ''}.</div>
                    <DetailsForm value={details} onChange={setDetails} mint={symbol || 'new'} ticker={symbol} />
                  </>}
            </div>
          )}

          {cur.id === 'curve' && (
            <div className="card">
              <div className="card-head"><h2>Curve &amp; graduation</h2></div>
              <p className="small muted" style={{ marginTop: -6 }}>The token trades on its bonding curve until the curve holds this much SOL. Then it graduates: liquidity moves to a DAMM v2 pool and is locked for good.</p>
              <div className="wiz-two">
                <label className="field"><span>Graduates at (SOL in the curve)</span><input value={threshold} inputMode="decimal" onChange={(e) => setThreshold(e.target.value)} /></label>
                <label className="field"><span>Supply to the pool at graduation (%)</span><input value={onMigration} inputMode="numeric" onChange={(e) => setOnMigration(e.target.value)} /></label>
              </div>
              <div className="notice small">Fees use the current {meta.cluster.toLowerCase()} defaults: the anti-sniper fee starts at 50% and falls to 1% in about a minute.</div>
            </div>
          )}

          {cur.id === 'review' && (
            <div className="card">
              <div className="card-head"><h2>Review &amp; launch</h2><span className="right small faint">nothing is sent until you press launch</span></div>
              <div className="wiz-review">
                <ReviewRow k="Token" v={`${name.trim() || '–'} · $${symbol || '–'}`} edit={() => goId('token')} />
                <ReviewRow k="Hooks" v="Cap per token account, anti-sniper fee, lift-only switch, buyback & burn" edit={() => goId('hooks')} />
                <ReviewRow k="Optional hooks" v={extrasSummary(extras, extrasCheck)} edit={() => goId('extras')} />
                <ReviewRow k="Cap" v={capRange ? `${capRange}, no cap after ${approxDuration(unc)} · ${selected ? selected.name : 'custom'}` : 'needs attention'} edit={() => goId('cap')} />
                <ReviewRow k="Graduates at" v={`${threshold} SOL · ${onMigration}% of supply to the pool`} edit={() => goId('curve')} />
                {open
                  ? <>
                      <ReviewRow k="Paid and signed by" v={bw.address ? `your wallet (${bw.address.slice(0, 4)}…${bw.address.slice(-4)}): two approvals, the curve config, then the launch. The site's launch key co-signs.` : 'your wallet: connect it below'} />
                      <ReviewRow k="Cost" v={`about 0.02 ${meta.cluster.toLowerCase()} SOL in account rent and fees; keep at least ${meta.launch?.minSol ?? 0.05} SOL in the wallet`} />
                    </>
                  : <ReviewRow k="Signed by" v={bw.address ? `your wallet (${bw.address.slice(0, 4)}…${bw.address.slice(-4)}) + the ${meta.cluster.toLowerCase()} launch key` : `the server's throwaway ${meta.cluster.toLowerCase()} keys (connect a wallet to sign it yourself)`} />}
              </div>
              {blocking >= 0 && <div className="notice red small" style={{ marginTop: 14 }}>Step {blocking + 1} ({STEPS[blocking].label}) needs attention: {STEPS[blocking].err}</div>}
              {studioRequired && studioSession && bw.address && studioSession.wallet !== bw.address && (
                <div className="notice amber small" style={{ marginTop: 14 }}>
                  Your wallet is on a different account ({bw.address.slice(0, 4)}…{bw.address.slice(-4)}) than the one signed in to the studio ({studioSession.wallet.slice(0, 4)}…{studioSession.wallet.slice(-4)}). The launch is built for the signed-in wallet — switch back to it in your wallet, or sign in again with this one.
                </div>
              )}
              {open && !bw.address
                ? <div className="wiz-connect" style={{ marginTop: 16 }}><WalletButton primary /><span className="small faint">Connect the wallet that will launch and pay ({meta.cluster.toLowerCase()} SOL: faucet.solana.com).</span></div>
                : <button className="primary block" style={{ marginTop: 16 }} disabled={busy || !!formErr || 'err' in check || !!extrasCheck.err} onClick={create}>{busy ? step || 'Creating… (2 transactions)' : `Launch on ${meta.cluster.toLowerCase()}`}</button>}
              {error && <div className="notice red small" style={{ marginTop: 12 }}>{error}</div>}
              {launched && (
                <div className="notice green small" style={{ marginTop: 12 }}>
                  <b>Launched.</b> Mint <Addr value={launched.mint} n={6} /> · <a href={launched.link} target="_blank" rel="noreferrer">transaction</a><br />
                  {launched.detailsNote && <>{launched.detailsNote}<br /></>}
                  <Link to={`/token/${launched.mint}`}>Open the token page</Link>
                </div>
              )}
              {result && (
                <div className="notice green small" style={{ marginTop: 12 }}>
                  <b>Created.</b> Mint <Addr value={result.mint} n={6} /><br />
                  {result.registered === false && <>It won't be listed until it's added to keeper/registry.json ({result.note}).</>}
                </div>
              )}
            </div>
          )}

          <div className="wiz-nav">
            <button onClick={() => go(at - 1)} disabled={at === 0}>Back</button>
            {cur.err && <span className="small fail">{cur.err}</span>}
            {at < STEPS.length - 1 && <button className="primary" onClick={() => go(at + 1)} disabled={!!cur.err}>Continue</button>}
          </div>
        </div>

        <aside className="card wiz-side">
          <div className="small faint" style={{ marginBottom: 6 }}>Draft</div>
          <dl className="kv">
            <dt>Token</dt><dd>{symbol ? `$${symbol}` : '–'}</dd>
            <dt>Hooks</dt><dd>{4 + extrasOn.length} on{extrasOn.length ? ` · ${extrasOn.length} optional` : ''}</dd>
            <dt>Cap</dt><dd>{capRange ?? '–'}</dd>
            <dt>Graduates at</dt><dd>{threshold} SOL</dd>
            <dt>Step</dt><dd>{at + 1} / {STEPS.length}</dd>
          </dl>
        </aside>
      </div>
      </StudioGate>
      {!(open || studioAccess) && <div className="launch-entry-link"><Link to="/hooks">Explore the hooks <IconArrow size={14} /></Link></div>}
    </div>
  );
}

function ReviewRow({ k, v, edit }: { k: string; v: string; edit?: () => void }) {
  return (
    <div className="wiz-row">
      <span className="small faint">{k}</span>
      <span className="wiz-v">{v}</span>
      {edit ? <button className="ghost small" onClick={edit}>Edit</button> : <span />}
    </div>
  );
}

/** Which hooks this launch gets. The cap is tuned in the schedule card below; the other three are on for every token.
 *  Picking one shows its diagram and how it works. */
function HooksPicker({ meta, capText, extrasOn, onExtras }: { meta: Meta; capText: string | null; extrasOn: number; onExtras: () => void }) {
  const hooks = hookList(meta);
  const [sel, setSel] = useState<HookId>('cap');
  const h = hooks.find((x) => x.id === sel)!;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Hooks on this token</h2>
        <span className="small faint">{hooks.length} hooks · fixed at launch</span>
        <span className="right"><HooksLink /></span>
      </div>
      <div className="hk-grid">
        <div className="hk-list" role="listbox" aria-label="Hooks">
          {hooks.map((x) => (
            <button key={x.id} role="option" aria-selected={sel === x.id} className={`hk-item tone-${x.tone} ${sel === x.id ? 'on' : ''}`} onClick={() => setSel(x.id)}>
              <span className="hook-tile">{x.icon}</span>
              <span style={{ minWidth: 0 }}><span className="nm">{x.name}</span><span className="st">{x.when}</span></span>
              <span className={`hk-state ${x.launch}`}>{x.launch === 'tunable' ? 'You set this' : 'Always on'}</span>
            </button>
          ))}
        </div>
        <div className={`hk-preview tone-${h.tone}`}>
          <div className="row" style={{ marginBottom: 8, gap: 10 }}>
            <span className="hook-tile" style={{ width: 30, height: 30, borderRadius: 6 }}>{h.icon}</span>
            <div style={{ minWidth: 0 }}><b style={{ fontSize: 14 }}>{h.name}</b><div className="small faint">{h.short}</div></div>
          </div>
          {h.id === 'cap' && capText ? <CapDiagram capText={capText} /> : h.diagram}
          <ol className="hook-steps" style={{ marginTop: 10 }}>
            {h.steps.map((x, i) => <li key={i}><span className="hook-n">{i + 1}</span><span>{x}</span></li>)}
          </ol>
          <p className="small faint" style={{ margin: 0 }}>
            {h.launch === 'tunable' ? 'You set the cap schedule in the next step.' : `On for every launch. Runs in: ${h.runs}.`}
          </p>
        </div>
      </div>
      <button type="button" className="opt-teaser" onClick={onExtras}>
        <span className="opt-teaser-icons">{optionalHookList().map((x) => <span key={x.id} className={`hook-tile tone-${x.tone}`}>{x.icon}</span>)}</span>
        <span><b>{extrasOn ? `${extrasOn} optional hook${extrasOn > 1 ? 's' : ''} on` : 'Add optional hooks'}</b><span className="small faint"> · max single buy, per-slot buy limit, buy pot</span></span>
        <IconArrow size={15} />
      </button>
    </div>
  );
}

function extrasSummary(x: Extras, c: { err: string | null; rules?: BuyRulesInput; lock?: { pct: number; slots: number } }): string {
  if (c.err) return 'needs attention';
  const r = c.rules;
  if (!r) return c.lock ? `creator lock ${c.lock.pct}%` : 'none';
  const parts: string[] = [];
  if (r.maxBuyBps) parts.push(`max buy ${pctOf(r.maxBuyBps)}`);
  if (r.maxPerSlotBps) parts.push(`${pctOf(r.maxPerSlotBps)} per slot`);
  if (r.maxBuyBps || r.maxPerSlotBps) parts.push(windowText(x.windowSlots));
  if (r.potEvery) parts.push(`pot: every ${ordinal(r.potEvery)} buy`);
  if (r.cooldownSlots) parts.push(`slow mode ${r.cooldownSlots} slots`);
  if (c.lock) parts.push(`creator lock ${c.lock.pct}%`);
  return parts.join(' · ');
}

/** Step 3: the optional hooks. Each one is off until switched on; switching on shows its diagram (with the values
 *  typed here) and its settings. */
function OptionalHooksStep({ value: x, onChange, err, capStartBps }: { value: Extras; onChange: (x: Extras) => void; err: string | null; capStartBps: number | null }) {
  const set = (patch: Partial<Extras>) => onChange({ ...x, ...patch });
  const toggle = (id: OptionalHookId) => onChange({ ...x, on: { ...x.on, [id]: !x.on[id] } });
  // the diagrams and copy follow the typed values while they are valid, else the defaults
  const live = {
    maxBuyBps: toBps(x.maxBuyPct, 1) ?? RULES_DEFAULT.maxBuyBps, maxPerSlotBps: toBps(x.perSlotPct, 1) ?? RULES_DEFAULT.maxPerSlotBps,
    windowSlots: x.windowSlots, potEvery: /^\d+$/.test(x.potEvery) && +x.potEvery >= 10 ? +x.potEvery : RULES_DEFAULT.potEvery, potMinBps: toBps(x.potMinPct, 0) ?? RULES_DEFAULT.potMinBps,
    cooldownSlots: /^\d+$/.test(x.cooldownSlots) && +x.cooldownSlots >= 1 && +x.cooldownSlots <= 150 ? +x.cooldownSlots : RULES_DEFAULT.cooldownSlots,
  };
  const liveLock = { pct: /^\d+$/.test(x.lockPct) && +x.lockPct >= 1 && +x.lockPct <= 10 ? +x.lockPct : CREATOR_LOCK_DEFAULT.pct, slots: Number(x.lockSlots) || CREATOR_LOCK_DEFAULT.slots };
  const lockCard = creatorLockInfo(liveLock.pct, liveLock.slots);
  const hooks = optionalHookList(live);
  const maxBuyBps = toBps(x.maxBuyPct, 1);
  const windowField = (
    <label className="field"><span>Applies for</span>
      <select value={x.windowSlots} onChange={(e) => set({ windowSlots: e.target.value })}>
        {RULES_WINDOWS.map((w) => <option key={w.slots} value={w.slots}>{w.label}</option>)}
      </select>
      <span className="hint">Shared by the max single buy and the per-slot limit. After this they stop; the cap still applies.</span>
    </label>
  );
  const fields: Record<OptionalHookId, ReactNode> = {
    maxbuy: <>
      <label className="field"><span>Max per buy (% of supply)</span><input value={x.maxBuyPct} inputMode="decimal" onChange={(e) => set({ maxBuyPct: e.target.value })} />
        {capStartBps !== null && maxBuyBps !== null && maxBuyBps >= capStartBps && <span className="hint">This is at or above the launch cap ({pctOf(capStartBps)}), so the cap is the tighter rule at first.</span>}
      </label>
      {windowField}
    </>,
    slot: <>
      <label className="field"><span>Limit per slot, all buyers (% of supply)</span><input value={x.perSlotPct} inputMode="decimal" onChange={(e) => set({ perSlotPct: e.target.value })} />
        <span className="hint">A slot is about 0.4 seconds. Keep this at or above the max single buy.</span>
      </label>
      {x.on.maxbuy ? <div className="hint">Applies for: the same time as the max single buy ({windowText(x.windowSlots)}).</div> : windowField}
    </>,
    pot: <>
      <div className="wiz-two">
        <label className="field"><span>A winner every</span><input value={x.potEvery} inputMode="numeric" onChange={(e) => set({ potEvery: e.target.value })} /><span className="hint">10 to 100,000 buys</span></label>
        <label className="field"><span>Minimum buy (% of supply)</span><input value={x.potMinPct} inputMode="decimal" onChange={(e) => set({ potMinPct: e.target.value })} /><span className="hint">Smaller buys aren’t counted</span></label>
      </div>
      <div className="notice small">Winners are recorded on chain and listed on the token page. Payouts aren’t switched on yet.</div>
    </>,
    cooldown: <>
      <label className="field"><span>Gap between buys (slots)</span><input value={x.cooldownSlots} inputMode="numeric" onChange={(e) => set({ cooldownSlots: e.target.value })} />
        <span className="hint">1 to 150 slots (~0.4 s to ~1 min). One shared gap for every buyer; selling is never limited.</span>
      </label>
      {x.on.maxbuy || x.on.slot ? <div className="hint">Applies for: the same window as the other buy limits ({windowText(x.windowSlots)}).</div> : windowField}
    </>,
  };
  return (
    <div className="card">
      <div className="card-head"><h2>Optional hooks</h2><span className="right small faint">all off by default · fixed at launch</span></div>
      <p className="small muted" style={{ marginTop: -6 }}>Extra rules the transfer hook enforces during the bonding curve. Turn on any you want; leave them off for a standard launch.</p>
      <div className="opt-list">
        {hooks.map((h) => {
          const on = x.on[h.id as OptionalHookId];
          return (
            <section key={h.id} className={`opt-hook tone-${h.tone} ${on ? 'on' : ''}`}>
              <div className="opt-hook-head">
                <span className="hook-tile">{h.icon}</span>
                <span style={{ minWidth: 0 }}><span className="nm">{h.name}</span><span className="st">{h.short}</span></span>
                <button type="button" role="switch" aria-checked={on} aria-label={`${h.name}: ${on ? 'on' : 'off'}`} className="tgl" onClick={() => toggle(h.id as OptionalHookId)} />
              </div>
              {on && (
                <div className="opt-hook-body">
                  <div>{h.diagram}</div>
                  <div className="opt-hook-fields">{fields[h.id as OptionalHookId]}</div>
                </div>
              )}
            </section>
          );
        })}
        <section className={`opt-hook tone-${lockCard.tone} ${x.lockOn ? 'on' : ''}`}>
          <div className="opt-hook-head">
            <span className="hook-tile">{lockCard.icon}</span>
            <span style={{ minWidth: 0 }}><span className="nm">{lockCard.name}</span><span className="st">{x.lockOn ? lockCard.short : 'Give yourself a supply share that stays locked until after graduation'}</span></span>
            <button type="button" role="switch" aria-checked={x.lockOn} aria-label={`Creator lock: ${x.lockOn ? 'on' : 'off'}`} className="tgl" onClick={() => set({ lockOn: !x.lockOn })} />
          </div>
          {x.lockOn && (
            <div className="opt-hook-body">
              <div>{lockCard.diagram}</div>
              <div className="opt-hook-fields">
                <div className="wiz-two">
                  <label className="field"><span>Creator share (% of supply)</span><input value={x.lockPct} inputMode="numeric" onChange={(e) => set({ lockPct: e.target.value })} /><span className="hint">1 to 10, whole percents</span></label>
                  <label className="field"><span>Locked for</span>
                    <select value={x.lockSlots} onChange={(e) => set({ lockSlots: e.target.value })}>
                      {CREATOR_LOCK_DURATIONS.map((d) => <option key={d.slots} value={String(d.slots)}>{d.label} after graduation</option>)}
                    </select>
                  </label>
                </div>
                <div className="notice small">Not a transfer-hook rule: Meteora’s locked vesting holds it on chain. This share is not sold on the curve, and it can’t be changed after launch.</div>
              </div>
            </div>
          )}
        </section>
      </div>
      {err && <div className="notice red small" style={{ marginTop: 12 }}>{err}</div>}
      <p className="small faint" style={{ margin: '12px 0 0' }}>Selling is never limited by these. Each needs the upgraded hook program; if the cluster doesn’t have it yet, the launch is refused before anything is sent. <HooksLink /></p>
    </div>
  );
}

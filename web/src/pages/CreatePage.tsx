// Studio launch tool (no public self-serve). Same validation as the program (validate + RELEASE_LIMITS, AC-4) before
// anything is sent; the server validates again. A new mint stays off the listing until it's added to the registry.
import { useMemo, useState } from 'react';
import type { CreateReply, Meta, StepJson } from '../lib/types';
import { api } from '../lib/api';
import { useWallet, signTransaction, hexToBytes, bytesToHex } from '../lib/wallet';
import { validate, RELEASE_LIMITS, STRICT, BALANCED, LOOSE, LOCAL_DEMO, pctOf, approxDuration, type NamedSchedule, type ScheduleError } from '../lib/shared';
import { CapRamp } from '../components/CapRamp';
import { Addr } from '../components/bits';
import { StudioGate } from '../components/StudioGate';
import { DetailsForm, emptyDetails, toInput, detailsError, type DetailsState } from '../components/TokenDetails';
import { CapDiagram } from '../components/HookArt';
import { hookList, type HookId } from '../lib/hookInfo';
import { HooksLink } from './HooksPage';

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
const rowsOf = (s: NamedSchedule): Row[] => s.steps.map((x) => ({ offset: x.slotOffset.toString(), pct: String(x.maxBps / 100) }));

export function CreatePage({ meta }: { meta: Meta }) {
  const presets = meta.cluster === 'LOCAL' ? [LOCAL_DEMO, BALANCED, STRICT, LOOSE] : [BALANCED, STRICT, LOOSE];
  const [preset, setPreset] = useState(presets[0].id);
  const [rows, setRows] = useState<Row[]>(rowsOf(presets[0]));
  const [unc, setUnc] = useState(presets[0].uncappedAfter.toString());
  const [name, setName] = useState('Trenches Test');
  const [symbol, setSymbol] = useState('TTEST');
  const [threshold, setThreshold] = useState('1');
  const bw = useWallet();
  const [step, setStep] = useState('');
  const [onMigration, setOnMigration] = useState('20');
  const [details, setDetails] = useState<DetailsState>(emptyDetails());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateReply | null>(null);
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

  const formErr = !name.trim() ? 'Enter a name.' : !/^[A-Z0-9]{2,10}$/.test(symbol) ? 'Ticker: 2 to 10 letters or digits.'
    : !(Number(threshold) > 0) ? 'Threshold must be above 0 SOL.' : !(Number.isInteger(Number(onMigration)) && +onMigration >= 1 && +onMigration <= 49) ? 'Supply to the pool at graduation: 1 to 49%.' : null;
  const selected = presets.find((p) => p.id === preset);

  async function create() {
    if (!('steps' in check) || formErr) return;
    setBusy(true); setError(null); setResult(null);
    const req = { name: name.trim(), symbol, steps: check.steps!, uncappedAfter: unc.trim(), thresholdSol: Number(threshold), percentageSupplyOnMigration: Number(onMigration), metadata: toInput(details) };
    try {
      if (bw.address) {
        // AC-21: the launch tx is signed in the connected wallet; the server co-signs with the launch key (8.3)
        setStep('Preparing the launch…');
        const built = await api.launchBuild(req);
        setStep('Approve the launch in your wallet…');
        let signed: Uint8Array;
        try { signed = await signTransaction(hexToBytes(built.tx)); }
        catch (e) { setError(/reject|denied|cancel/i.test((e as Error).message) ? 'You declined in the wallet. Nothing was launched.' : (e as Error).message); return; }
        setStep('Sending…');
        setResult(await api.launchSubmit(bytesToHex(signed)));
      } else {
        setResult(await api.create(req));   // server-signed test path (no wallet connected)
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setStep(''); }
  }

  return (
    <div className="stack" style={{ maxWidth: 980 }}>
      <section className="hero">
        <div>
        <h1>Studio launch tool</h1>
        <p>Creates a Meteora DBC config with the transfer hook, the pool and the frozen cap config. With a wallet connected, you sign the launch in your own wallet and the server co-signs with the {meta.cluster.toLowerCase()} launch key; without one, the server's throwaway keys sign. There is no public self-serve.</p>
        </div>
        <span className="hero-line" />
      </section>
      <StudioGate meta={meta}>
      <HooksPicker meta={meta} capText={'err' in check ? null : pctOf(check.steps![0].maxBps)} />
      <div className="grid-token">
        <div className="card">
          <div className="card-head"><h2>Cap schedule</h2>{selected && <span className={`right pill ${selected.id === 'balanced' ? 'green' : 'amber'}`}>{selected.label}</span>}</div>
          <label className="field"><span>Preset</span>
            <select value={preset} onChange={(e) => pick(e.target.value)}>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.label})</option>)}
              <option value="custom">Custom (not approved)</option>
            </select>
          </label>
          <table className="small" style={{ marginBottom: 10 }}>
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
          <label className="field"><span>No cap from slot (≈ {/^\d+$/.test(unc) ? approxDuration(unc) : '?'})</span>
            <input value={unc} onChange={(e) => { setPreset('custom'); setUnc(e.target.value); }} />
          </label>
          {'err' in check
            ? <div className="notice red small">{check.err}</div>
            : <>
                <CapRamp steps={check.steps!} uncappedAfter={unc} height={200} />
                <p className="small faint" style={{ marginTop: 6 }}>{check.steps!.map((s) => `${pctOf(s.maxBps)} from +${s.slotOffset}`).join(', ')}, no cap from +{unc} ({approxDuration(unc)}). Fixed at launch; it can only be lifted later, never tightened.</p>
              </>}
        </div>

        <div className="card">
          <div className="card-head"><h2>Token</h2></div>
          <label className="field"><span>Name</span><input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Ticker</span><input value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></label>
          <label className="field"><span>Migration threshold (SOL, curve size)</span><input value={threshold} inputMode="decimal" onChange={(e) => setThreshold(e.target.value)} /></label>
          <label className="field"><span>Supply to the DAMM v2 pool at graduation (%)</span><input value={onMigration} inputMode="numeric" onChange={(e) => setOnMigration(e.target.value)} /></label>
          <p className="small faint">Fees use the current devnet defaults (sdk/launch.ts), pending a decision.</p>
          <div style={{ borderTop: '1px solid var(--card-border)', margin: '6px 0 14px' }} />
          <div className="small faint" style={{ marginBottom: 10 }}>Token details (optional, can be edited later)</div>
          <DetailsForm value={details} onChange={setDetails} mint={symbol || 'new'} ticker={symbol} />
          {(formErr || detailsError(details)) && <p className="small fail">{formErr ?? detailsError(details)}</p>}
          <button className="primary block" disabled={busy || !!formErr || !!detailsError(details) || 'err' in check} onClick={create}>{busy ? step || 'Creating… (2 transactions)' : `Create on ${meta.cluster.toLowerCase()}`}</button>
          {error && <div className="notice red small" style={{ marginTop: 12 }}>{error}</div>}
          {result && (
            <div className="notice green small" style={{ marginTop: 12 }}>
              <b>Created.</b> Mint <Addr value={result.mint} n={6} /><br />
              {result.registered === false && <>It won't be listed until it's added to keeper/registry.json ({result.note}).</>}
            </div>
          )}
        </div>
      </div>
      </StudioGate>
    </div>
  );
}

/** Which hooks this launch gets. The cap is tuned in the schedule card below; the other three are on for every token.
 *  Picking one shows its diagram and how it works. */
function HooksPicker({ meta, capText }: { meta: Meta; capText: string | null }) {
  const hooks = hookList(meta);
  const [sel, setSel] = useState<HookId>('cap');
  const h = hooks.find((x) => x.id === sel)!;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
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
              <span className={`hk-state ${x.launch}`}>{x.launch === 'tunable' ? 'Set below' : 'Always on'}</span>
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
            {h.launch === 'tunable' ? 'Set the cap steps in the Cap schedule card below.' : `On for every launch. Runs in: ${h.runs}.`}
          </p>
        </div>
      </div>
    </div>
  );
}

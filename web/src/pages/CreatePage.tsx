// Studio launch tool (no public self-serve). Same validation as the program (validate + RELEASE_LIMITS, AC-4) before
// anything is sent; the server validates again. A new mint stays off the listing until it's added to the registry.
import { useMemo, useState } from 'react';
import type { CreateReply, Meta, StepJson } from '../lib/types';
import { api } from '../lib/api';
import { validate, RELEASE_LIMITS, STRICT, BALANCED, LOOSE, LOCAL_DEMO, pctOf, approxDuration, type NamedSchedule, type ScheduleError } from '../lib/shared';
import { CapRamp } from '../components/CapRamp';
import { Addr } from '../components/bits';

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
  const [onMigration, setOnMigration] = useState('20');
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
    try { setResult(await api.create({ name: name.trim(), symbol, steps: check.steps!, uncappedAfter: unc.trim(), thresholdSol: Number(threshold), percentageSupplyOnMigration: Number(onMigration) })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ maxWidth: 980 }}>
      <section className="hero">
        <div>
        <h1>Studio launch tool</h1>
        <p>Creates a Meteora DBC config with the transfer hook, the pool and the frozen cap config, signed by the studio's throwaway {meta.cluster.toLowerCase()} launch key on the server. There is no public self-serve.</p>
        </div>
        <span className="hero-line" />
      </section>
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
          {formErr && <p className="small fail">{formErr}</p>}
          <button className="primary block" disabled={busy || !!formErr || 'err' in check} onClick={create}>{busy ? 'Creating… (2 transactions)' : `Create on ${meta.cluster.toLowerCase()}`}</button>
          {error && <div className="notice red small" style={{ marginTop: 12 }}>{error}</div>}
          {result && (
            <div className="notice green small" style={{ marginTop: 12 }}>
              <b>Created.</b> Mint <Addr value={result.mint} n={6} /><br />
              {result.registered === false && <>It won't be listed until it's added to keeper/registry.json ({result.note}).</>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

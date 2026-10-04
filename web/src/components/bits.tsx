import { Component, useState, type ReactNode } from 'react';
import { PHASES, type Phase } from '../lib/token';
import { navigate } from '../lib/hooks';
import { IconCheck, IconCopy } from './Icons';

export const short = (s: string, n = 4) => (s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);

/** Address: shortened, full value on hover, copy button, explorer link when there is one. */
export function Addr({ value, href, n = 4 }: { value: string | null | undefined; href?: string | null; n?: number }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="faint">none</span>;
  const copy = async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard blocked */ } };
  return (
    <span className="row" style={{ gap: 4, display: 'inline-flex' }}>
      {href ? <a className="mono" href={href} target="_blank" rel="noreferrer" title={value}>{short(value, n)}</a> : <span className="mono" title={value}>{short(value, n)}</span>}
      <button className="ghost small" onClick={copy} aria-label={`Copy ${value}`} title="Copy" style={{ padding: '0 3px', color: 'inherit' }}>{copied ? <IconCheck size={13} /> : <IconCopy size={13} />}</button>
    </span>
  );
}

/** In-app link (pushState). */
export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); navigate(to); }}>{children}</a>;
}

export function PhaseStepper({ phase }: { phase: Phase }) {
  const at = PHASES.findIndex((p) => p.id === phase);
  return (
    <div className="phases" role="list" aria-label="Token lifecycle">
      {PHASES.map((p, i) => (
        <div key={p.id} role="listitem" className={`phase ${i === at ? 'now' : i < at ? 'done' : ''}`} aria-current={i === at ? 'step' : undefined}>
          <div className="n">{i + 1}{i === at ? ' · now' : ''}</div>
          <div className="t">{p.label}</div>
          <div className="h">{p.hint}</div>
        </div>
      ))}
    </div>
  );
}

export function PhasePill({ phase }: { phase: Phase }) {
  const p = PHASES.find((x) => x.id === phase);
  const cls = phase === 'early' ? 'amber' : phase === 'capped' ? 'accent' : phase === 'graduated' ? 'green' : '';
  return <span className={`pill ${cls}`}>{p?.label ?? 'unknown'}</span>;
}

export function CurveProgress({ reserve, threshold, graduated }: { reserve: number | null; threshold: number | null; graduated: boolean }) {
  if (reserve === null || !threshold) return <span className="faint">n/a</span>;
  const pct = graduated ? 100 : Math.min(100, (reserve / threshold) * 100);
  return (
    <div>
      <div className={`meter big ${graduated ? 'grad' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Curve progress">
        <span className="fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="spread small" style={{ marginTop: 8 }}>
        <span className="num" style={{ fontSize: 15, fontWeight: 500 }}>{graduated ? 'complete' : <>{reserve} <span className="faint">/ {threshold} SOL</span></>}</span>
        <span className="faint">{graduated ? 'migrated to DAMM v2' : 'graduation ends the cap'}</span>
      </div>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return <div className="stat"><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

export function Skeleton({ h = 14, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

/** A copy render error (e.g. an unfilled placeholder, AC-25) must never show a half-filled page. */
export class Guard extends Component<{ children: ReactNode; what: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) return <div className="notice red"><b>Couldn't render {this.props.what}.</b> {this.state.err.message}</div>;
    return this.props.children;
  }
}

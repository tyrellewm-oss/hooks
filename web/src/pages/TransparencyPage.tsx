// Where trading fees go: the keeper's public log (claim -> 15% dev payout -> buyback -> burn), every step linked to
// its transaction. Data: GET /api/flywheel (app/flywheel_public.ts), registry mints only.
import { useState } from 'react';
import type { Meta, PublicKeeper } from '../lib/types';
import { api } from '../lib/api';
import { usePoll } from '../lib/hooks';
import { Addr, Link, Skeleton, Stat, short } from '../components/bits';
import { TokenArt } from '../components/TokenArt';

const sol = (s: string) => { const n = Number(s); return Number.isFinite(n) ? (n === 0 ? '0' : n < 0.0001 ? n.toExponential(2) : n.toFixed(4)) : s; };
const tokens = (s: string) => { const n = Number(s); return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : s; };
const when = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString() : iso || '–'; };

const STATE: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'green' },
  waiting_for_graduation: { label: 'Waiting for graduation', cls: 'amber' },
  paused: { label: 'Paused', cls: 'red' },
};
const runPill = (status: string) => (status === 'logged' ? 'green' : status === 'paused' ? 'red' : status.startsWith('failed') ? 'amber' : '');
const runLabel = (status: string) => (status === 'logged' ? 'Completed' : status.replace(/^failed_/, 'Stopped: ').replace(/_/g, ' '));

export function TransparencyPage({ meta }: { meta: Meta }) {
  const live = usePoll(() => api.flywheel(), 30000, 'flywheel');
  const d = live.data;
  return (
    <div className="stack">
      <section className="hero">
        <div>
          <h1>Where trading fees go</h1>
          <p>A keeper bot claims each token's trading fees, sends 15% to the dev wallet, uses the other 85% to buy the token back on its pool, and burns what it bought. Buybacks only start after a token graduates. Every step below links to its transaction on {meta.cluster.toLowerCase()}.</p>
        </div>
        <span className="hero-line" />
      </section>

      {!d ? (live.error ? <div className="notice red">{live.error.message}</div> : <><Skeleton h={180} /><Skeleton h={180} /></>)
        : d.keepers.length === 0 ? (
          <div className="card empty"><h2>No keeper logs yet</h2><p className="small faint" style={{ marginTop: 6 }}>Logs appear here once the keeper has run for a registered token.</p></div>
        ) : d.keepers.map((k) => <KeeperCard key={k.name} k={k} />)}

      {d && d.skipped.length > 0 && <div className="notice amber small">Couldn't read: {d.skipped.join(', ')}</div>}
      <p className="small faint">From the keeper's public log (flywheel/ in the repo). Amounts are what each transaction moved; open any link to check it on the explorer.</p>
    </div>
  );
}

function KeeperCard({ k }: { k: PublicKeeper }) {
  const [allBurns, setAllBurns] = useState(false);
  const [allRuns, setAllRuns] = useState(false);
  const st = k.paused ? { label: `Paused${k.pauseReason ? `: ${k.pauseReason}` : ''}`, cls: 'red' } : STATE[k.state] ?? { label: k.state.replace(/_/g, ' '), cls: '' };
  const claimed = Number(k.claimedSol) || 0, dev = Number(k.devSol) || 0, spent = Number(k.spentSol) || 0;
  const devPct = claimed ? (dev / claimed) * 100 : 15;
  const burns = allBurns ? k.burns : k.burns.slice(0, 6);
  const runs = allRuns ? k.runs : k.runs.slice(0, 5);
  return (
    <div className="card">
      <div className="card-head" style={{ alignItems: 'center' }}>
        <div className="id-card">
          <div className="thumb" style={{ width: 44, height: 44, borderRadius: 12 }}><TokenArt seed={k.mint} showTicker={false} /></div>
          <div>
            <h2>{k.name.replace(/^[a-z]+-/, '').toUpperCase()}</h2>
            <div className="small faint"><Addr value={k.mint} n={5} /></div>
          </div>
        </div>
        <span className={`right pill ${st.cls}`}>{st.label}</span>
      </div>

      <div className="stats">
        <Stat label="Fees claimed" value={`${sol(k.claimedSol)}`} sub="SOL" />
        <Stat label="Dev payout" value={sol(k.devSol)} sub={`SOL · ${devPct.toFixed(0)}% of claimed`} />
        <Stat label="Spent on buybacks" value={sol(k.spentSol)} sub={`SOL · pending ${sol(k.reserveSol)}`} />
        <Stat label="Burned" value={tokens(k.burnedTokens)} sub={`tokens · ${Number(k.pctOfSupply).toFixed(4)}% of supply`} />
      </div>

      {claimed > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="small faint" style={{ marginBottom: 6 }}>Split of claimed fees</div>
          <div className="meter big" aria-label={`dev ${devPct.toFixed(0)}%, buyback and pending ${(100 - devPct).toFixed(0)}%`}>
            <span className="fill" style={{ width: `${(spent / claimed) * 100}%`, left: `${devPct}%`, background: 'var(--green)', borderRadius: 0 }} />
            <span className="fill" style={{ width: `${devPct}%`, background: 'var(--amber)' }} />
          </div>
          <div className="row small faint" style={{ marginTop: 6, gap: 14, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: 'var(--amber)' }} />dev payout</span>
            <span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: 'var(--green)' }} />bought back and burned</span>
            <span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: 'var(--panel-2)' }} />waiting for the next run</span>
          </div>
        </div>
      )}

      <div className="grid-2" style={{ marginTop: 18, alignItems: 'start' }}>
        <div className="panel">
          <div className="spread" style={{ marginBottom: 8 }}><h3>Burns</h3><span className="small faint">{k.burns.length}</span></div>
          {k.burns.length === 0 ? <p className="small faint" style={{ margin: 0 }}>{k.state === 'waiting_for_graduation' ? 'None yet: buybacks start after graduation.' : 'None yet.'}</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="small">
                <thead><tr><th>When</th><th style={{ textAlign: 'right' }}>Tokens</th><th style={{ textAlign: 'right' }}>SOL</th><th>Tx</th></tr></thead>
                <tbody>{burns.map((b) => (
                  <tr key={b.sig || b.at}><td className="faint">{when(b.at)}</td><td className="num" style={{ textAlign: 'right' }}>{tokens(b.tokens)}</td><td className="num" style={{ textAlign: 'right' }}>{sol(b.sol)}</td>
                    <td>{b.link ? <a className="link mono" href={b.link} target="_blank" rel="noreferrer">{short(b.sig, 4)} ↗</a> : <span className="mono faint">{short(b.sig, 4)}</span>}</td></tr>
                ))}</tbody>
              </table>
              {k.burns.length > 6 && <button className="ghost small" onClick={() => setAllBurns((v) => !v)}>{allBurns ? 'Show fewer' : `Show all ${k.burns.length}`}</button>}
            </div>
          )}
        </div>
        <div className="panel">
          <div className="spread" style={{ marginBottom: 8 }}><h3>Keeper runs</h3><span className="small faint">latest {k.runs.length}</span></div>
          {runs.map((r) => (
            <div key={r.runId} style={{ padding: '8px 0', borderBottom: '1px solid var(--card-border)' }}>
              <div className="spread small"><span className="faint">{when(r.startedAt)}</span><span className={`pill ${runPill(r.status)}`}>{runLabel(r.status)}</span></div>
              {r.reason && <div className="small faint" style={{ marginTop: 4 }}>{r.reason}</div>}
              {r.links.length > 0 && (
                <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {r.links.map((l) => l.link
                    ? <a key={l.sig} className="pill plain" href={l.link} target="_blank" rel="noreferrer">{l.what} ↗</a>
                    : <span key={l.sig} className="pill plain">{l.what}</span>)}
                </div>
              )}
            </div>
          ))}
          {k.runs.length > 5 && <button className="ghost small" onClick={() => setAllRuns((v) => !v)}>{allRuns ? 'Show fewer' : `Show all ${k.runs.length}`}</button>}
        </div>
      </div>
      <p className="small faint" style={{ marginTop: 12, marginBottom: 0 }}>
        Token page: <Link to={`/token/${k.mint}`} className="link">open</Link>{k.pools.route && <> · buyback pool <Addr value={k.pools.route} /></>}
      </p>
    </div>
  );
}

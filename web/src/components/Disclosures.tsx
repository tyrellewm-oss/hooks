import type { ReactNode } from 'react';
import type { TokenView } from '../lib/types';
import { CONTENT, fill, tok, pctOf, supplySoldText, approxDuration } from '../lib/shared';
import { Addr } from './bits';

// The DBC and DAMM v2 pool authorities: the only exempt receivers (constants in the program; README "Admin powers").
const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
const DAMM_V2_POOL_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';

/** "Lead: rest" -> bold lead. Text is unchanged (Research owns the copy). */
function Lead({ text }: { text: string }) {
  const i = text.indexOf(': ');
  if (i < 0 || i > 40) return <>{text}</>;
  return <><b>{text.slice(0, i)}</b>{text.slice(i)}</>;
}

/** AC-25: on every token page, every placeholder filled from chain/launch config (fill() throws on a leftover). */
export function RulesAndRisks({ vars }: { vars: Record<string, string> }) {
  const rr = CONTENT.rules_and_risks;
  return (
    <div className="card">
      <div className="card-head"><h2>{fill(rr.title, vars)}</h2></div>
      <ul className="rules">{rr.items.map((t, i) => <li key={i}><Lead text={fill(t, vars)} /></li>)}</ul>
    </div>
  );
}

/** Collapsible card: a summary row that opens into the full content (cap ramp, switch history, on-chain details). */
export function Dropdown({ title, aside, defaultOpen, children }: { title: string; aside?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="card dd" open={defaultOpen}>
      <summary>
        <h2>{title}</h2>
        <span className="right row" style={{ gap: 8 }}>{aside}<span className="dd-chev" aria-hidden="true" /></span>
      </summary>
      <div className="dd-body">{children}</div>
    </details>
  );
}

/** AC-29: every RestrictionsLifted event for this token (and global ones). */
export function SwitchHistory({ view }: { view: TokenView }) {
  const h = view.switchHistory;
  return (
    <Dropdown title="Lift-only switch history" aside={<span className="pill">{h.length ? `${h.length} use${h.length > 1 ? 's' : ''}` : 'none'}</span>}>
      <p className="small muted">The admin switch can only raise or remove the cap, never lower or re-enable it. Every use emits an on-chain RestrictionsLifted event, listed here.</p>
      {h.length === 0 ? <p className="small faint" style={{ margin: 0 }}>No uses for this token.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="small">
            <thead><tr><th>Scope</th><th>Change</th><th>Slot</th><th>Signer</th><th>Tx</th></tr></thead>
            <tbody>
              {h.map((e, i) => (
                <tr key={i}>
                  <td>{e.scope}</td>
                  <td>{e.lifted ? 'cap removed' : `minimum cap raised to ${pctOf(e.newMinCapBps)}`}</td>
                  <td className="num">{e.slot}</td>
                  <td><Addr value={e.signer} /></td>
                  <td>{e.link ? <a href={e.link} target="_blank" rel="noreferrer">tx ↗</a> : <span className="faint">n/a</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dropdown>
  );
}

/** Everything the old page's state table showed, read live from the chain. */
export function TokenDetails({ view }: { view: TokenView }) {
  const st = view.status;
  const hooked = st.transferHookProgram !== null;
  const ex = (a: string | null | undefined) => a || null;
  return (
    <Dropdown title="On-chain details" aside={<span className="faint small hide-sm">live, read from the chain</span>}>
      <dl className="kv small">
        <dt>Mint</dt><dd><Addr value={st.mint} href={ex(view.explorer.mint)} n={6} /></dd>
        <dt>Curve pool</dt><dd><Addr value={view.launch?.pool} href={ex(view.explorer.pool)} n={6} /></dd>
        <dt>Supply</dt><dd className="num">{tok(st.supply)}</dd>
        <dt>Mint / freeze authority</dt><dd>{st.mintAuthority ?? 'none'} / {st.freezeAuthority ?? 'none'}</dd>
        <dt>Transfer hook</dt>
        <dd>{hooked ? <><Addr value={st.transferHookProgram} href={ex(view.explorer.program)} n={6} /> <span className="faint">authority: DBC pool authority</span></> : 'none: removed at graduation (plain Token-2022)'}</dd>
        <dt>Launch slot</dt><dd className="num">{st.launchSlot ?? 'n/a'} <span className="faint">(chain slot {st.slot})</span></dd>
        <dt>Schedule (frozen at launch)</dt>
        <dd>{(st.steps ?? []).map((s) => `${pctOf(s.maxBps)} from +${s.slotOffset}`).join(', ')}{st.uncappedAfter && `, no cap from +${st.uncappedAfter} slots (${approxDuration(st.uncappedAfter)})`}</dd>
        <dt>Build</dt><dd>{st.testSlotsBuild ? <span className="fail">test-slots build: short ramps, not a release build</span> : 'release build'}</dd>
        <dt>Exempt receivers</dt>
        <dd>DBC pool authority <Addr value={DBC_POOL_AUTHORITY} /> (owns the pool vaults)<br />DAMM v2 pool authority <Addr value={DAMM_V2_POOL_AUTHORITY} /> (migration){(st.exemptOwners ?? []).map((e) => <span key={e}><br /><Addr value={e} /></span>)}</dd>
        <dt>Lift switch state</dt>
        <dd>global lifted: {String(!!st.globalLifted)} · this token lifted: {String(!!st.mintLifted)} · raised minimum cap: {st.raisedFloorBps ? pctOf(st.raisedFloorBps) : 'none'}</dd>
        <dt>Anti-sniper fee</dt>
        <dd>{view.fee ? `${view.fee.cliffPct}% falling to ${view.fee.endPct}% over ${view.fee.totalSlots} slots (${approxDuration(view.fee.totalSlots)}, ${view.fee.mode})` : 'n/a'}</dd>
        <dt>Supply split</dt><dd>{supplySoldText((view.feeConfig as any)?.percentageSupplyOnMigration)}</dd>
        <dt>Launch key / admin</dt><dd><Addr value={st.launchAuthority} /> / <Addr value={st.liftAuthority} /></dd>
      </dl>
    </Dropdown>
  );
}

import type { Meta } from '../lib/types';
import { CONTENT, fill, pageVars } from '../lib/shared';
import { CapRamp } from './CapRamp';
import { Link } from './bits';

/** Full cap explanation, kept with its hook. Required copy stays in page_content.json. */
export function CapExplanation({ meta }: { meta: Meta }) {
  const s = meta.defaultSchedule;
  const pseudoView = { status: { steps: s.steps, uncappedAfter: s.uncappedAfter }, switchHistory: [] };
  const vars = { ...(pageVars(meta, pseudoView) as Record<string, string>), POOL_FEE: 'shown on each token page', TICKER: 'each token' };
  const ck = CONTENT.checklist, rr = CONTENT.rules_and_risks.items;
  const sections = [
    { h: 'The rule', text: ck[2] },
    { h: 'Selling is never blocked', text: ck[3] },
    { h: 'At graduation', text: rr[5] },
    { h: 'What the cap does not stop', text: rr[2] },
    { h: 'Admin power', text: ck[4] },
    { h: 'Which tokens', text: rr[7] },
  ];

  return (
    <div className="hook-cap-details">
      <details className="hook-lifecycle">
        <summary><span><b>Cap schedule</b><span className="small faint">{s.name} · {meta.cluster.toLowerCase()} default</span></span><span className="dd-chev" aria-hidden="true" /></summary>
        <div className="hook-lifecycle-body">
          <div className="card-head"><h3>Default schedule: {s.name}</h3><span className="right pill green">{s.label}</span></div>
          <div className="hook-cap-chart"><CapRamp steps={s.steps} uncappedAfter={s.uncappedAfter} /></div>
          <p className="small faint">Each token's schedule is frozen at launch and shown on its page. The anti-sniper fee and pool fee are set per launch; see each token page for its values.</p>
        </div>
      </details>
      <details className="hook-lifecycle">
        <summary><span><b>Full rule &amp; exceptions</b><span className="small faint">Selling, graduation and admin powers</span></span><span className="dd-chev" aria-hidden="true" /></summary>
        <div className="hook-lifecycle-body">
          <p className="small muted">One rule, enforced by a transfer hook while a token is on its bonding curve. Nothing else is restricted.</p>
          <div className="hook-cap-rules">{sections.map((section) => <section key={section.h}><h3>{section.h}</h3><p className="small muted">{fill(section.text, vars)}</p></section>)}</div>
          <p className="small"><Link to="/" className="link">See the test tokens</Link></p>
        </div>
      </details>
    </div>
  );
}

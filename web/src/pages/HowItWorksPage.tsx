// The rule explained with Research's own lines (page_content.json), filled with the cluster's default schedule.
// Fee values differ per launch, so this page points to each token page for them instead of showing a number.
import type { Meta } from '../lib/types';
import { CONTENT, fill, pageVars } from '../lib/shared';
import { CapRamp } from '../components/CapRamp';
import { Guard, Link } from '../components/bits';

export function HowItWorksPage({ meta }: { meta: Meta }) {
  const s = meta.defaultSchedule;
  const pseudoView = { status: { steps: s.steps, uncappedAfter: s.uncappedAfter }, switchHistory: [] };
  const vars = { ...(pageVars(meta, pseudoView) as Record<string, string>), POOL_FEE: 'shown on each token page', TICKER: 'each token' };
  const ck = CONTENT.checklist, rr = CONTENT.rules_and_risks.items;
  const sections: { h: string; text: string }[] = [
    { h: 'The rule', text: ck[2] },
    { h: 'Selling is never blocked', text: ck[3] },
    { h: 'At graduation', text: rr[5] },
    { h: 'What the cap does not stop', text: rr[2] },
    { h: 'Admin power', text: ck[4] },
    { h: 'Which tokens', text: rr[7] },
  ];
  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <section className="hero">
        <div>
          <h1>How the cap works</h1>
          <p>One rule, enforced by a transfer hook while a token is on its bonding curve. Nothing else is restricted.</p>
        </div>
        <span className="hero-line" />
      </section>
      <div className="card">
        <div className="card-head">
          <h2>Default schedule on {meta.cluster.toLowerCase()}: {s.name}</h2>
          <span className="right pill green">{s.label}</span>
        </div>
        <CapRamp steps={s.steps} uncappedAfter={s.uncappedAfter} />
        <p className="small faint" style={{ marginTop: 8 }}>Each token's schedule is frozen at launch and shown on its page. The anti-sniper fee and pool fee are set per launch; see each token page for its values.</p>
      </div>
      <Guard what="this page">
        <div className="grid-2">
          {sections.map((x) => (
            <div className="card" key={x.h} style={{ marginTop: 0 }}>
              <h2 style={{ marginBottom: 8 }}>{x.h}</h2>
              <p className="muted small" style={{ margin: 0 }}>{fill(x.text, vars)}</p>
            </div>
          ))}
        </div>
      </Guard>
      <p className="small"><Link to="/tokens" className="link">See the test tokens</Link></p>
    </div>
  );
}

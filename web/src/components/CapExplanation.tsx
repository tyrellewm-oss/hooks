import { useState } from 'react';
import type { Meta } from '../lib/types';
import { CONTENT, fill, pageVars } from '../lib/shared';
import { CapRamp } from './CapRamp';
import { Link } from './bits';
import { IconArrow, IconGrid, IconInfo, IconRamp, IconShield, IconSwitch } from './Icons';

/** Full cap explanation, kept with its hook. Required copy stays in page_content.json. */
export function CapExplanation({ meta }: { meta: Meta }) {
  const [topic, setTopic] = useState('rule');
  const s = meta.defaultSchedule;
  const pseudoView = { status: { steps: s.steps, uncappedAfter: s.uncappedAfter }, switchHistory: [] };
  const vars = { ...(pageVars(meta, pseudoView) as Record<string, string>), POOL_FEE: 'shown on each token page', TICKER: 'each token' };
  const ck = CONTENT.checklist, rr = CONTENT.rules_and_risks.items;
  const sections = [
    { id: 'rule', label: 'The rule', h: 'The rule', text: ck[2], icon: IconShield },
    { id: 'selling', label: 'Selling', h: 'Selling is never blocked', text: ck[3], icon: IconArrow },
    { id: 'graduation', label: 'Graduation', h: 'At graduation', text: rr[5], icon: IconRamp },
    { id: 'limits', label: 'Limits & exceptions', h: 'What the cap does not stop', text: rr[2], icon: IconInfo },
    { id: 'admin', label: 'Admin power', h: 'Admin power', text: ck[4], icon: IconSwitch },
    { id: 'tokens', label: 'Which tokens', h: 'Which tokens', text: rr[7], icon: IconGrid },
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
        <div className="hook-lifecycle-body cap-rule-body">
          <p className="cap-rule-intro small muted"><IconInfo size={16} /><span>One rule, enforced by a transfer hook while a token is on its bonding curve. Nothing else is restricted.</span></p>
          <div className="hook-cap-rules">
            <div className="cap-rule-topics" role="group" aria-label="Cap rule topics">
              {sections.map(({ id, label, icon: Icon }) => (
                <button key={id} type="button" className="cap-rule-choice" aria-pressed={topic === id} aria-controls={`cap-rule-${id}`} onClick={() => setTopic(id)}>
                  <Icon size={17} /><span>{label}</span><span className="cap-rule-indicator" aria-hidden="true"><IconArrow size={14} /></span>
                </button>
              ))}
            </div>
            <div className="cap-rule-panels">
              {sections.map((section, i) => (
                <section key={section.id} id={`cap-rule-${section.id}`} className="cap-rule-panel" aria-labelledby={`cap-rule-title-${section.id}`} aria-hidden={topic !== section.id}>
                  <div className="cap-rule-count mono">{String(i + 1).padStart(2, '0')} <span>/ {String(sections.length).padStart(2, '0')}</span></div>
                  <h3 id={`cap-rule-title-${section.id}`}>{section.h}</h3>
                  <p className="small muted">{fill(section.text, vars)}</p>
                </section>
              ))}
              <div className="cap-rule-footer"><Link to="/tokens">See the test tokens <IconArrow size={14} /></Link></div>
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

// Hooks: every rule a Trenches token runs, with a diagram each. Content and numbers come from lib/hookInfo.
import { useEffect, type ReactNode } from 'react';
import type { Meta } from '../lib/types';
import { approxDuration } from '../lib/shared';
import { hookList, SNIPER_DEFAULT, type HookInfo } from '../lib/hookInfo';
import { LifecycleDiagram, CapGauge } from '../components/HookArt';
import { Link } from '../components/bits';
import { IconArrow, IconHook, IconInfo } from '../components/Icons';

export function HooksPage({ meta }: { meta: Meta }) {
  const hooks = hookList(meta);
  // links like /hooks#hook-cap (token page) land on that card
  useEffect(() => { if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, []);
  const capStartPct = (meta.defaultSchedule.steps[0]?.maxBps ?? 100) / 100;
  return (
    <div className="stack" style={{ maxWidth: 1080 }}>
      <section className="hero hooks-hero">
        <div>
          <span className="eyebrow"><IconHook size={14} />Hooks</span>
          <h1>The rules every token runs</h1>
          <p>Four rules, fixed at launch. Two run inside the token itself, one is the curve's fee schedule and one is a public bot. Here is what each one does, when it is on, and what it does not do.</p>
        </div>
        <nav className="hook-jump" aria-label="Jump to a hook">
          {hooks.map((h) => (
            <a key={h.id} href={`#hook-${h.id}`} className={`hook-jump-item tone-${h.tone}`}>
              <span className="hook-ico">{h.icon}</span>{h.name}
            </a>
          ))}
        </nav>
      </section>

      <div className="card">
        <div className="card-head">
          <h2>When each hook is on</h2>
          <span className="right small faint">one token, from launch to the pool</span>
        </div>
        <div className="hd-scroll"><LifecycleDiagram feeText={`first ${approxDuration(String(SNIPER_DEFAULT.durationSlots))}`} rampText={approxDuration(meta.defaultSchedule.uncappedAfter)} /></div>
      </div>

      {hooks.map((h, i) => <HookCard key={h.id} h={h} n={i + 1} extra={h.id === 'cap' ? <CapGauge capPct={capStartPct} /> : null} />)}

      <div className="notice hooks-foot">
        <IconInfo size={18} />
        <div>
          <b>Selling back into the curve is never blocked.</b> The pool vault and the graduation path are exempt from the cap. For the full rule text see{' '}
          <Link to="/how-it-works" className="link">How the cap works</Link>; for every keeper claim, buyback and burn see{' '}
          <Link to="/transparency" className="link">Transparency</Link>.
        </div>
      </div>
    </div>
  );
}

function HookCard({ h, n, extra }: { h: HookInfo; n: number; extra: ReactNode }) {
  return (
    <section className={`card hook-card tone-${h.tone}`} id={`hook-${h.id}`} aria-labelledby={`hook-${h.id}-t`}>
      <div className="hook-card-head">
        <span className="hook-tile">{h.icon}</span>
        <div style={{ minWidth: 0 }}>
          <div className="small faint mono">0{n}</div>
          <h2 id={`hook-${h.id}-t`}>{h.name}</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>{h.short}</p>
        </div>
        <div className="hook-tags">
          <span className={`pill ${h.tone}`}>{h.when}</span>
        </div>
      </div>
      <div className="hook-body">
        <div className="hook-text">
          <h3 className="hook-sub">How it works</h3>
          <ol className="hook-steps">
            {h.steps.map((s, i) => <li key={i}><span className="hook-n">{i + 1}</span><span>{s}</span></li>)}
          </ol>
          <h3 className="hook-sub">Settings <span className="faint">(studio default)</span></h3>
          <dl className="hook-settings">
            {h.settings.map((x) => <div key={x.k}><dt>{x.k}</dt><dd>{x.v}</dd></div>)}
          </dl>
          <div className="hook-limits"><b>What it does not do.</b> {h.limits}</div>
          <div className="small faint hook-runs">Runs in: {h.runs}</div>
        </div>
        <div className="hook-art">
          <div className="hook-art-label small faint">Diagram</div>
          {h.diagram}
          {extra && <><div className="hook-art-label small faint" style={{ marginTop: 14 }}>Three buys into one token account</div>{extra}</>}
        </div>
      </div>
    </section>
  );
}

/** Link row used by the launch tool. */
export function HooksLink() {
  return <Link to="/hooks" className="link small hooks-link">How each hook works <IconArrow size={13} /></Link>;
}

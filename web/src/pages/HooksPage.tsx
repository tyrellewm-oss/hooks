// Hooks explorer: existing rules and diagrams, with one focused hook at a time.
import { useEffect, useState } from 'react';
import type { Meta } from '../lib/types';
import { approxDuration } from '../lib/shared';
import { hookList, SNIPER_DEFAULT, type HookId, type HookInfo } from '../lib/hookInfo';
import { LifecycleDiagram, CapGauge } from '../components/HookArt';
import { CapExplanation } from '../components/CapExplanation';
import { Guard, Link } from '../components/bits';
import { IconArrow, IconHook, IconInfo } from '../components/Icons';

function hookFromHash(): HookId {
  const id = location.hash.replace('#hook-', '');
  return id === 'fee' || id === 'switch' || id === 'burn' ? id : 'cap';
}

export function HooksPage({ meta }: { meta: Meta }) {
  const hooks = hookList(meta);
  const [active, setActive] = useState<HookId>(hookFromHash);
  const selected = hooks.find((hook) => hook.id === active)!;
  const capStartPct = (meta.defaultSchedule.steps[0]?.maxBps ?? 100) / 100;

  useEffect(() => {
    const onHash = () => setActive(hookFromHash());
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  function selectHook(id: HookId) {
    setActive(id);
    history.replaceState(history.state, '', `#hook-${id}`);
  }

  return (
    <div className="stack hooks-explorer">
      <section className="hero hooks-explorer-hero">
        <div>
          <span className="eyebrow"><IconHook size={14} />Hooks</span>
          <h1>The rules every token runs</h1>
          <p>Four rules, fixed at launch. Explore what each does, when it runs and where its limits are.</p>
        </div>
        <span className="hero-line" />
      </section>

      <div className="hook-selector" role="group" aria-label="Explore a hook">
        {hooks.map((hook, i) => (
          <button key={hook.id} type="button" className={`hook-choice tone-${hook.tone}`} aria-pressed={active === hook.id} aria-controls="hook-explorer-panel" onClick={() => selectHook(hook.id)}>
            <span className="hook-choice-top"><span className="hook-tile">{hook.icon}</span><span className="mono faint">0{i + 1}</span></span>
            <span className="hook-choice-name">{hook.name}</span>
            <span className="hook-choice-when">{hook.when}</span>
          </button>
        ))}
      </div>

      <div id="hook-explorer-panel">
        <HookPanel key={selected.id} hook={selected} capStartPct={capStartPct} meta={meta} />
      </div>

      <details className="card hook-lifecycle">
        <summary><span><b>When each hook is on</b><span className="small faint">Launch → bonding curve → graduation → pool</span></span><span className="dd-chev" aria-hidden="true" /></summary>
        <div className="hook-lifecycle-body">
          <p className="small muted">Two rules run inside the token, one is the curve's fee schedule and one is a public bot.</p>
          <div className="hd-scroll"><LifecycleDiagram feeText={`first ${approxDuration(String(SNIPER_DEFAULT.durationSlots))}`} rampText={approxDuration(meta.defaultSchedule.uncappedAfter)} /></div>
        </div>
      </details>

      <div className="notice hooks-foot">
        <IconInfo size={18} />
        <div><b>Selling back into the curve is never blocked.</b> The pool vault and graduation path are exempt from the cap. The <a href="#hook-cap" className="link">cap section</a> includes the full rule and exceptions. See every keeper claim, buyback and burn in <Link to="/transparency" className="link">Transparency</Link>.</div>
      </div>
    </div>
  );
}

function HookPanel({ hook: h, capStartPct, meta }: { hook: HookInfo; capStartPct: number; meta: Meta }) {
  const [diagram, setDiagram] = useState<'flow' | 'buys'>('flow');
  return (
    <section className={`card hook-focus tone-${h.tone}`} id={`hook-${h.id}`} aria-labelledby={`hook-${h.id}-t`}>
      <div className="hook-focus-head">
        <div><h2 id={`hook-${h.id}-t`}>{h.name}</h2><p className="small muted">{h.short}</p></div>
        <span className={`pill ${h.tone}`}>{h.when}</span>
      </div>
      <div className="hook-focus-body">
        <div className="hook-focus-art">
          <div className="hook-focus-art-head">
            <span className="hook-sub">In action</span>
            {h.id === 'cap' && <div className="hook-view-switch" role="group" aria-label="Cap diagram">
              <button type="button" aria-pressed={diagram === 'flow'} onClick={() => setDiagram('flow')}>Transfer check</button>
              <button type="button" aria-pressed={diagram === 'buys'} onClick={() => setDiagram('buys')}>Three buys</button>
            </div>}
          </div>
          <div className="hook-diagram-stage" aria-live="polite">
            {h.id === 'cap' && diagram === 'buys' ? <CapGauge capPct={capStartPct} /> : h.diagram}
          </div>
          <span className="hook-diagram-hint small faint">Scroll diagram to explore →</span>
          <div className="hook-runtime"><span className="hook-runtime-dot" aria-hidden="true" /><span>{h.runs}</span></div>
        </div>
        <div className="hook-focus-copy">
          <h3 className="hook-sub">How it works</h3>
          <ol className="hook-steps">{h.steps.map((step, i) => <li key={step}><span className="hook-n">{i + 1}</span><span>{step}</span></li>)}</ol>
          <details className="hook-settings-disclosure">
            <summary><span>Settings <span className="faint">· studio defaults</span></span><span className="dd-chev" aria-hidden="true" /></summary>
            <dl className="hook-settings">{h.settings.map((setting) => <div key={setting.k}><dt>{setting.k}</dt><dd>{setting.v}</dd></div>)}</dl>
          </details>
        </div>
      </div>
      <div className="hook-focus-limits"><IconInfo size={16} /><p><b>What it does not do.</b> {h.limits}</p></div>
      {h.id === 'cap' && <Guard what="the cap explanation"><CapExplanation meta={meta} /></Guard>}
    </section>
  );
}

/** Link row used by the launch tool. */
export function HooksLink() {
  return <Link to="/hooks" className="link small hooks-link">How each hook works <IconArrow size={13} /></Link>;
}

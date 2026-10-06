// Hooks explorer: existing rules and diagrams, with one focused hook at a time.
import { useEffect, useState } from 'react';
import type { Meta } from '../lib/types';
import { approxDuration } from '../lib/shared';
import { allHooks, HOOK_IDS, SNIPER_DEFAULT, type HookId, type HookInfo } from '../lib/hookInfo';
import { LifecycleDiagram, CapGauge } from '../components/HookArt';
import { CapExplanation } from '../components/CapExplanation';
import { Guard, Link } from '../components/bits';
import { IconArrow, IconEye, IconHook, IconInfo } from '../components/Icons';

function hookFromHash(): HookId {
  const id = location.hash.replace('#hook-', '') as HookId;
  return HOOK_IDS.includes(id) ? id : 'cap';
}

export function HooksPage({ meta }: { meta: Meta }) {
  const hooks = allHooks(meta);
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
          <h1>The rules every token runs</h1>
          <p>Four rules every token runs, plus {hooks.length - 4} a launch can add. All fixed at launch. Explore what each does, when it runs and where its limits are.</p>
        </div>
        <span className="hero-line" />
      </section>

      {([['always', 'On every token'], ['optional', 'Optional · chosen at launch']] as const).map(([group, title]) => (
        <div key={group} className="hook-group">
          <div className="hook-group-head small faint">{title}</div>
          <div className={`hook-selector ${group === 'optional' ? 'opt' : ''}`} role="group" aria-label={title}>
            {hooks.filter((hook) => (hook.launch === 'optional') === (group === 'optional')).map((hook) => (
              <button key={hook.id} type="button" className={`hook-choice tone-${hook.tone}`} aria-pressed={active === hook.id} aria-controls="hook-explorer-panel" onClick={() => selectHook(hook.id)}>
                <span className="hook-choice-top"><span className="hook-tile">{hook.icon}</span><span className="mono faint">0{hooks.indexOf(hook) + 1}</span></span>
                <span className="hook-choice-name">{hook.name}</span>
                <span className="hook-choice-when">{hook.when}</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      <div id="hook-explorer-panel">
        <HookPanel key={selected.id} hook={selected} capStartPct={capStartPct} />
      </div>

      <section className="card hook-reference" aria-labelledby="hook-reference-title">
        <div className="hook-reference-head"><h2 id="hook-reference-title">Details &amp; activity</h2><p className="muted">Explore the rules in depth and see them in action.</p></div>
        {active === 'cap' && <Guard what="the cap explanation"><CapExplanation meta={meta} /></Guard>}
        <details className="hook-lifecycle hook-resource">
          <summary>
            <span className="hook-resource-icon"><IconHook size={18} /></span>
            <span className="hook-resource-copy"><b>Hook lifecycle</b><span>When each hook runs, from launch to the pool</span></span>
            <span className="dd-chev" aria-hidden="true" />
          </summary>
          <div className="hook-lifecycle-body">
            <p className="small muted">Two rules run inside the token, one is the curve's fee schedule and one is a public bot.</p>
            <div className="hd-scroll"><LifecycleDiagram feeText={`first ${approxDuration(String(SNIPER_DEFAULT.durationSlots))}`} rampText={approxDuration(meta.defaultSchedule.uncappedAfter)} /></div>
          </div>
        </details>
        <Link to="/transparency" className="hook-resource-link">
          <span className="hook-resource-icon"><IconEye size={18} /></span>
          <span className="hook-resource-copy"><b>Public activity</b><span>Keeper claims, buybacks and burns</span></span>
          <span className="hook-resource-action">View logs <IconArrow size={15} /></span>
        </Link>
      </section>
    </div>
  );
}

function HookPanel({ hook: h, capStartPct }: { hook: HookInfo; capStartPct: number }) {
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
      {h.id === 'cap' ? (
        <div className="hook-cap-notes">
          <section><IconInfo size={17} /><div><h3>Scope &amp; limits</h3><p>The cap is per token account, not per wallet. One person can use several accounts or wallets. It slows snipers down; it does not stop them.</p></div></section>
          <section><IconArrow size={17} /><div><h3>Selling &amp; migration</h3><p>Selling back into the curve is never blocked by the cap. The pool vault and graduation path are exempt too.</p></div></section>
        </div>
      ) : <div className="hook-focus-limits"><IconInfo size={16} /><p><b>Keep in mind.</b> {h.limits}</p></div>}
    </section>
  );
}

/** Link row used by the launch tool. */
export function HooksLink() {
  return <Link to="/hooks" className="link small hooks-link">How each hook works <IconArrow size={13} /></Link>;
}

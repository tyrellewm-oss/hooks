// Docs: how Hookd works, end to end, in one page with a sticky contents list. UI copy lives here; the brief's
// required rules text is rendered from page_content.json (RulesAndRisks). Numbers are the studio defaults; each token
// page shows that token's own values.
import { useEffect, useState, type ReactNode } from 'react';
import type { Meta } from '../lib/types';
import { pageVars, pctOf, approxDuration } from '../lib/shared';
import { hookList, optionalHookList, SNIPER_DEFAULT, FLYWHEEL_SPLIT, POT_SHARE_PCT, RULES_DEFAULT, ordinal, windowText } from '../lib/hookInfo';
import { LifecycleDiagram, CapDiagram, SniperFeeDiagram, FlywheelDiagram, LiftDiagram, MaxBuyDiagram, SlotLimitDiagram, PotDiagram, CooldownDiagram } from '../components/HookArt';
import { RulesAndRisks } from '../components/Disclosures';
import { Addr, Link } from '../components/bits';
import { IconInfo } from '../components/Icons';

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS14EPLDNJcfGa3d5BSAShD';

const SECTIONS: { id: string; label: string; group: string }[] = [
  { id: 'overview', label: 'What Hookd is', group: 'Start here' },
  { id: 'lifecycle', label: 'A token’s life', group: 'Start here' },
  { id: 'hooks', label: 'The four hooks', group: 'Hooks' },
  { id: 'cap', label: 'Cap per token account', group: 'Hooks' },
  { id: 'fee', label: 'Anti-sniper fee', group: 'Hooks' },
  { id: 'switch', label: 'Lift-only switch', group: 'Hooks' },
  { id: 'burn', label: 'Buyback & burn', group: 'Hooks' },
  { id: 'optional', label: 'Optional hooks', group: 'Optional hooks' },
  { id: 'maxbuy', label: 'Max single buy', group: 'Optional hooks' },
  { id: 'slot', label: 'Per-slot buy limit', group: 'Optional hooks' },
  { id: 'cooldown', label: 'Slow mode', group: 'Optional hooks' },
  { id: 'pot', label: 'Buy pot', group: 'Optional hooks' },
  { id: 'graduation', label: 'Graduation', group: 'Using Hookd' },
  { id: 'trading', label: 'Trading', group: 'Using Hookd' },
  { id: 'launching', label: 'Launching', group: 'Using Hookd' },
  { id: 'addresses', label: 'Programs & addresses', group: 'Reference' },
  { id: 'risks', label: 'Rules & risks', group: 'Reference' },
  { id: 'faq', label: 'FAQ', group: 'Reference' },
];

export function DocsPage({ meta }: { meta: Meta }) {
  const s = meta.defaultSchedule;
  const capStart = pctOf(s.steps[0]?.maxBps ?? 0), capEnd = pctOf(s.steps[s.steps.length - 1]?.maxBps ?? 0);
  const ramp = approxDuration(s.uncappedAfter);
  const f = SNIPER_DEFAULT, feeTime = approxDuration(String(f.durationSlots));
  const cluster = meta.cluster.toLowerCase();
  const vars = {
    ...(pageVars(meta, { status: { steps: s.steps, uncappedAfter: s.uncappedAfter }, switchHistory: [] }) as Record<string, string>),
    TICKER: 'every token', POOL_FEE: 'shown on each token page',
    SNIPER_FEE_START: pctOf(f.startBps), SNIPER_FEE_END: pctOf(f.endBps), SNIPER_FEE_DURATION: feeTime,
    FEE_SPLIT: `the studio fee wallet; the keeper then sends ${FLYWHEEL_SPLIT.devPct}% to the dev wallet and uses ${FLYWHEEL_SPLIT.buybackPct}% to buy back and burn`,
    SWITCH_HISTORY: 'listed on each token page',
  };

  // contents: highlight the section in view; links like /docs#cap land on that section
  const [active, setActive] = useState(SECTIONS[0].id);
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    const io = new IntersectionObserver((es) => {
      const vis = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis) setActive(vis.target.id);
    }, { rootMargin: '-80px 0px -65% 0px' });
    SECTIONS.forEach((x) => { const el = document.getElementById(x.id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);
  const jump = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', `/docs#${id}`);
    setActive(id);
  };
  const groups = [...new Set(SECTIONS.map((x) => x.group))];

  return (
    <div className="docs">
      <aside className="docs-toc" aria-label="Contents">
        <div className="docs-toc-title">Documentation</div>
        {groups.map((g) => (
          <div key={g} className="docs-toc-group">
            <div className="docs-toc-g">{g}</div>
            {SECTIONS.filter((x) => x.group === g).map((x) => (
              <a key={x.id} href={`/docs#${x.id}`} onClick={jump(x.id)} className={active === x.id ? 'on' : ''} aria-current={active === x.id ? 'location' : undefined}>{x.label}</a>
            ))}
          </div>
        ))}
      </aside>

      <article className="docs-body">
        <header className="docs-hero">
          <div className="docs-kicker">Docs · {cluster}</div>
          <h1>How Hookd works</h1>
          <p>Everything about launching and holding a Hookd token, in one place. Each section is short; the numbers shown are the studio defaults, and each token page shows that token’s own.</p>
        </header>

        <Section id="overview" title="What Hookd is">
          <p>Hookd is a token launchpad on Solana where the rules are enforced on chain, not promised. Every token runs four hooks that are fixed at launch: a rising cap per token account, an anti-sniper fee, a switch that can only loosen the cap, and a bot that buys the token back and burns it after graduation. A launch can also turn on four optional hooks: a max single buy, a per-slot buy limit, a buy pot and slow mode; and set aside a creator share that stays locked until after graduation.</p>
          <div className="docs-cards">
            {[...hookList(meta), ...optionalHookList()].map((h) => (
              <a key={h.id} href={`/docs#${h.id}`} onClick={jump(h.id)} className={`docs-card tone-${h.tone}`}>
                <span className="hook-tile">{h.icon}</span>
                <span><b>{h.name}</b><span className="small faint">{h.when}</span></span>
              </a>
            ))}
          </div>
          <Callout>This is a devnet test. Tokens have no real value and the code has not had a paid audit.</Callout>
        </Section>

        <Section id="lifecycle" title="A token’s life">
          <p>Every token goes through the same stages.</p>
          <ol className="docs-steps">
            <li><b>Launch.</b> The studio creates the token, its bonding curve and its hook settings in one transaction. Supply is fixed at 1,000,000,000.</li>
            <li><b>Bonding curve.</b> The token trades on a Meteora curve. The price rises as people buy. The cap, the anti-sniper fee and the switch all apply here.</li>
            <li><b>Graduation.</b> When the curve holds its target amount of SOL, liquidity moves to a Meteora DAMM v2 pool and is locked for good.</li>
            <li><b>Pool.</b> The token trades like any other token. There is no cap any more, and trading fees fund buyback and burn.</li>
          </ol>
          <Figure caption="When each hook is on, from launch to the pool."><div className="hd-scroll"><LifecycleDiagram feeText={`first ${feeTime}`} rampText={ramp} /></div></Figure>
        </Section>

        <Section id="hooks" title="The four hooks">
          <p>A hook is a rule that runs automatically whenever the token moves or trades. Two of ours run inside the token itself (a Token-2022 transfer hook), one is part of the curve’s fee settings and one is a public bot. None of them can be tightened after launch.</p>
          <p>For a visual walk-through of each one, see <Link to="/hooks" className="link">Hooks</Link>.</p>
        </Section>

        <Section id="cap" title="Cap per token account">
          <p>While the token is on its bonding curve, each token account can hold at most a set share of the supply. With the default schedule that is <b>{capStart}</b> at launch, rising in steps to <b>{capEnd}</b>, with no cap after <b>{ramp}</b> or at graduation, whichever comes first.</p>
          <Figure caption="Every transfer into a token account is checked by the hook."><CapDiagram capText={capStart} /></Figure>
          <ul className="docs-list">
            <li>A buy that would put a token account over the cap fails, and nothing moves.</li>
            <li>The cap is per token account, not per wallet. It slows snipers down; it doesn’t stop someone using several accounts or wallets.</li>
            <li>Selling back into the curve is never blocked. The pool and the graduation path are exempt.</li>
            <li>The dev is capped exactly like everyone else.</li>
          </ul>
        </Section>

        <Section id="fee" title="Anti-sniper fee">
          <p>The curve’s trading fee starts high and steps down quickly, so buying in the first seconds is expensive. By default it starts at <b>{pctOf(f.startBps)}</b> and falls to <b>{pctOf(f.endBps)}</b> over {f.durationSlots} slots (about {feeTime}), then stays there until graduation.</p>
          <Figure caption="The default fee schedule."><SniperFeeDiagram {...f} durationText={feeTime} /></Figure>
          <Callout>This fee applies to every buyer, not only bots. If you don’t want to pay it, wait about {feeTime} after launch.</Callout>
        </Section>

        <Section id="switch" title="Lift-only switch">
          <p>The cap schedule is frozen at launch. One admin switch exists, and it only works one way: it can raise the cap for a token or remove it, but never tighten it or add a new one. It exists so a mistake can be undone in holders’ favour.</p>
          <Figure caption="What the switch can and can’t do."><LiftDiagram /></Figure>
          <p>Every use is recorded on chain and listed under <b>Lift-only switch history</b> on the token’s page.</p>
        </Section>

        <Section id="burn" title="Buyback & burn">
          <p>A keeper bot claims each token’s trading fees on a timer (about every 5 minutes). It sends {FLYWHEEL_SPLIT.devPct}% to the dev wallet and uses {FLYWHEEL_SPLIT.buybackPct}% to buy the token on its pool, then burns everything it bought. Fees build up while the token is on the curve; buybacks start after graduation. A token with a buy pot puts {POT_SHARE_PCT}% of its curve fees in the pot instead, so those fees split {FLYWHEEL_SPLIT.devPct}% dev, {POT_SHARE_PCT}% pot, {FLYWHEEL_SPLIT.buybackPct - POT_SHARE_PCT}% buyback.</p>
          <Figure caption="Where trading fees go."><FlywheelDiagram {...FLYWHEEL_SPLIT} /></Figure>
          <p>Every claim, buy and burn is public and linked to its transaction on <Link to="/transparency" className="link">Transparency</Link>. Burning supply doesn’t set or support any price.</p>
        </Section>

        <Section id="optional" title="Optional hooks">
          <p>Four more rules a launch can switch on. They are off by default, chosen in the launch’s <b>Optional hooks</b> step and, like everything else, fixed at launch. All four run in the same transfer hook as the cap, only on buys from the bonding curve: selling and wallet-to-wallet transfers are never touched, and they end at graduation when the hook is removed.</p>
          <p>Each token page lists the optional hooks that token launched with, live.</p>
        </Section>

        <Section id="maxbuy" title="Max single buy">
          <p>No single buy can be bigger than a set share of the supply (by default <b>{pctOf(RULES_DEFAULT.maxBuyBps)}</b>), for a set time after launch (by default the {windowText(RULES_DEFAULT.windowSlots)}). Unlike the cap, it looks only at the size of that one buy, not at what the buyer already holds.</p>
          <Figure caption="Each buy is judged on its own size."><MaxBuyDiagram maxText={pctOf(RULES_DEFAULT.maxBuyBps)} /></Figure>
          <ul className="docs-list">
            <li>A buy over the max fails, and nothing moves.</li>
            <li>Someone can still split a big buy into smaller ones or use several wallets; with the cap and the per-slot limit that gets slower and more expensive.</li>
          </ul>
        </Section>

        <Section id="slot" title="Per-slot buy limit">
          <p>All buys in the same slot (about 0.4 seconds) are added up, across every wallet. A buy that would take the slot over the limit (by default <b>{pctOf(RULES_DEFAULT.maxPerSlotBps)}</b> of supply) fails; the next slot starts from zero. It applies for the same time as the max single buy.</p>
          <Figure caption="One shared limit per slot."><SlotLimitDiagram limitText={pctOf(RULES_DEFAULT.maxPerSlotBps)} /></Figure>
        </Section>
        <Section id="cooldown" title="Slow mode">
          <p>After any curve buy lands, the next buy, from anyone, must wait a fixed gap (by default <b>{RULES_DEFAULT.cooldownSlots} slots</b>, about {Math.round(RULES_DEFAULT.cooldownSlots * 0.4)} seconds; at most 150). One shared timer for the whole token: a crew splitting a big position across wallets waits out the gap for every single buy. Selling is never limited, and in a busy opening an honest buy can fail for being second; trying again after the gap works.</p>
          <Figure caption="One shared gap between buys."><CooldownDiagram gapText={`${RULES_DEFAULT.cooldownSlots}-slot`} /></Figure>
          <Callout>This limit is shared by everyone. In a busy opening an ordinary buy can fail too; trying again a moment later works.</Callout>
        </Section>

        <Section id="pot" title="Buy pot">
          <p>The hook counts buys on the curve in order, and every Nth one (by default every <b>{ordinal(RULES_DEFAULT.potEvery)}</b>) is recorded on chain as a winner, with its wallet, buy number and slot. Only the first buy in each slot counts, and only if it’s at least the minimum size (by default {pctOf(RULES_DEFAULT.potMinBps)} of supply), so splitting a buy into dust doesn’t help.</p>
          <Figure caption="Every Nth counted buy wins."><PotDiagram every={RULES_DEFAULT.potEvery} minText={pctOf(RULES_DEFAULT.potMinBps)} /></Figure>
          <ul className="docs-list">
            <li>Winners are picked by order, not at random. Anyone watching the count can try to time the winning buy.</li>
            <li>The hook only records winners: a transfer hook can approve or refuse a transfer, but it can’t hold or send SOL.</li>
            <li>{POT_SHARE_PCT}% of the token’s curve trading fees fill the pot. The keeper pays new winners in SOL about every 5 minutes; winners since its last payout split the pot equally, and with no new winner it carries over to the next one.</li>
            <li>The chain keeps the last 16 winners. A winner pushed out before the keeper pays them is skipped, and their share stays in the pot.</li>
            <li>After graduation there are no new winners: pot money with nobody left to pay goes to the buyback. The token page shows each winner and their payout.</li>
          </ul>
        </Section>

        <Section id="graduation" title="Graduation">
          <p>When the bonding curve holds its target amount of SOL (set at launch), the token graduates:</p>
          <ul className="docs-list">
            <li>Liquidity moves to a Meteora DAMM v2 pool and is permanently locked.</li>
            <li>The transfer hook is removed, so the token becomes a plain Token-2022 token with no cap.</li>
            <li>Only the pool’s trading fee applies from then on; there is no anti-sniper fee.</li>
          </ul>
          <p>Each token page shows how close the curve is to graduating.</p>
        </Section>

        <Section id="trading" title="Trading">
          <p>Hookd doesn’t have a buy or sell button. Use any Solana wallet or app that supports Token-2022 tokens with transfer hooks. The rules travel with the token: the cap is checked on chain on every transfer, whatever app you use.</p>
          <Callout>If a buy fails during the curve, the most likely reason is that it would put your token account over the cap. Try a smaller amount, or wait for the cap to rise.</Callout>
        </Section>

        <Section id="launching" title="Launching">
          <p>Launching is studio-only for now; there is no public self-serve. A studio wallet signs in by signing a short message (no transaction, no fee), then follows six steps:</p>
          <ol className="docs-steps">
            <li><b>Hooks</b>: see what the token will run.</li>
            <li><b>Cap schedule</b>: pick a preset or set your own steps.</li>
            <li><b>Optional hooks</b>: switch on a max single buy, a per-slot buy limit, a buy pot or slow mode, and a creator lock, if you want them.</li>
            <li><b>Token</b>: name, ticker and optional image, description and links.</li>
            <li><b>Graduation</b>: the SOL target and how much supply goes to the pool.</li>
            <li><b>Review</b>: check everything, then sign.</li>
          </ol>
          <p>With a wallet connected, you sign the launch in your own wallet and the server co-signs with the {cluster} launch key. The server only sends launches it built itself, once, within 90 seconds.</p>
          <p><Link to="/create" className="link">Open Studio launch</Link></p>
        </Section>

        <Section id="addresses" title="Programs & addresses">
          <dl className="docs-addr">
            <dt>Hookd hook program</dt><dd><Addr value={meta.programId} n={8} /></dd>
            <dt>Meteora bonding curve (DBC)</dt><dd><Addr value={DBC_PROGRAM} n={8} /></dd>
            <dt>Meteora DAMM v2 (pools)</dt><dd><Addr value={DAMM_V2_PROGRAM} n={8} /></dd>
            <dt>Token-2022</dt><dd><Addr value={TOKEN_2022_PROGRAM} n={8} /></dd>
            <dt>Network</dt><dd>{meta.cluster}</dd>
          </dl>
          <p className="small faint">Each token page lists its own mint, pool and cap config under On-chain details.</p>
        </Section>

        <Section id="risks" title="Rules & risks">
          <p>The full rules, exactly as they apply to every token:</p>
          <RulesAndRisks vars={vars} />
        </Section>

        <Section id="faq" title="FAQ">
          <Faq q="Does the cap stop snipers?">No. It slows them down: one token account can only hold so much while the token is on the curve. Someone can still use several accounts or wallets.</Faq>
          <Faq q="Can the rules be changed after launch?">Only in one direction. The switch can raise or remove the cap; nothing can tighten it or add a new one.</Faq>
          <Faq q="Can I always sell?">Yes. Selling back into the curve is never blocked by the cap.</Faq>
          <Faq q="What happens at graduation?">Liquidity moves to a locked DAMM v2 pool, the cap ends, and buyback and burn starts.</Faq>
          <Faq q="Where do the fees go?">{FLYWHEEL_SPLIT.devPct}% to the dev wallet, {FLYWHEEL_SPLIT.buybackPct}% to buying the token back and burning it (a token with a buy pot puts {POT_SHARE_PCT}% of its curve fees in the pot instead). Every step is on the Transparency page.</Faq>
          <Faq q="What are the optional hooks?">A max single buy, a per-slot buy limit, a buy pot and slow mode. A launch can switch any of them on; they’re off by default. A launch can also lock a creator share until after graduation. The token page shows which ones a token has.</Faq>
          <Faq q="Can anyone launch a token?">Not yet. Launching is limited to studio wallets during this test.</Faq>
        </Section>
      </article>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="docs-sec" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}><a href={`/docs#${id}`} className="docs-anchor" aria-hidden="true" tabIndex={-1}>#</a>{title}</h2>
      {children}
    </section>
  );
}
const Figure = ({ caption, children }: { caption: string; children: ReactNode }) => (
  <figure className="docs-fig">{children}<figcaption>{caption}</figcaption></figure>
);
const Callout = ({ children }: { children: ReactNode }) => (
  <div className="docs-callout"><IconInfo size={16} /><div>{children}</div></div>
);
function Faq({ q, children }: { q: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`docs-faq ${open ? 'open' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{q}<span className="dd-chev" aria-hidden="true" /></button>
      <div className="dd-wrap"><div className="dd-body"><p>{children}</p></div></div>
    </div>
  );
}

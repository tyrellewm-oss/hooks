// Home: one headline, two actions, then a grid of live preview cards (one per section of the site) and two short
// lists. Only chain-read numbers (cap, curve progress, burns); no volume, holder or user counts (AC-28).
import { useMemo, type ReactNode } from 'react';
import type { Meta, PublicKeeper, TokenView } from '../lib/types';
import { api } from '../lib/api';
import { navigate, useNow, usePoll } from '../lib/hooks';
import { pctOf, BPS_DENOM, approxDuration } from '../lib/shared';
import { estimateSlot, isGraduated, liveCap } from '../lib/token';
import { hookList, FLYWHEEL_SPLIT } from '../lib/hookInfo';
import { Link } from '../components/bits';
import { TokenImage } from '../components/TokenDetails';
import { IconArrow, IconCheck, IconFlame } from '../components/Icons';

interface Tok { mint: string; view: TokenView; capPct: string | null; progress: number; graduated: boolean }

async function loadTokens(meta: Meta): Promise<{ at: number; views: { mint: string; view: TokenView }[] }> {
  const res = await Promise.allSettled(meta.launches.map((l) => api.token(l.mint)));
  return { at: Date.now(), views: meta.launches.flatMap((l, i) => (res[i].status === 'fulfilled' ? [{ mint: l.mint, view: (res[i] as PromiseFulfilledResult<TokenView>).value }] : [])) };
}

export function HomePage({ meta }: { meta: Meta }) {
  const list = usePoll(() => loadTokens(meta), 30000, `home:${meta.launches.map((l) => l.mint).join(',')}`);
  const fw = usePoll(() => api.flywheel(), 60000, 'home:flywheel');
  const now = useNow(10000);

  const toks: Tok[] = useMemo(() => (list.data?.views ?? []).map(({ mint, view }) => {
    const slot = estimateSlot(view.status.slot, list.data!.at, now);
    const cap = liveCap(view, slot);
    const graduated = isGraduated(view);
    const threshold = view.fee?.migrationQuoteThresholdSol ?? view.launch?.migrationQuoteThresholdSol ?? 0;
    const reserve = view.pool?.quoteReserveSol ?? 0;
    return {
      mint, view, graduated,
      capPct: cap === null ? null : pctOf(Number((cap * BigInt(BPS_DENOM)) / BigInt(view.status.supply))),
      progress: graduated ? 100 : threshold ? Math.min(100, (reserve / threshold) * 100) : 0,
    };
  }), [list.data, now]);

  const closest = toks.filter((t) => !t.graduated).sort((a, b) => b.progress - a.progress).slice(0, 5);
  const burns = (fw.data?.keepers ?? []).flatMap((k) => k.burns.map((b) => ({ ...b, k }))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 5);
  const s = meta.defaultSchedule;
  const capStart = pctOf(s.steps[0]?.maxBps ?? 0), capEnd = pctOf(s.steps[s.steps.length - 1]?.maxBps ?? 0);

  return (
    <div className="home">
      <section className="home-hero">
        <h1>Fairer launches.<br /><span>Rules you can check on chain.</span></h1>
        <p>Every Trenches token runs four hooks, fixed at launch. Snipers get slowed down, the rules can only loosen, and fees buy the token back and burn it.</p>
        <div className="row home-cta">
          <button className="primary" onClick={() => navigate('/tokens')}>Explore tokens</button>
          <button onClick={() => navigate('/create')}>Launch</button>
        </div>
      </section>

      <div className="bento">
        <Tile to="/tokens" label="Tokens" className="span-2"><TokenMarquee toks={toks} /></Tile>
        <Tile to="/hooks" label="Hooks" className="span-2"><HookRows meta={meta} /></Tile>
        <Tile to="/how-it-works" label="How the cap works">
          <div className="tile-pad">
            <div className="small faint">Cap per token account</div>
            <div className="tile-big num">{capStart} <span className="faint">→</span> {capEnd}</div>
            <div className="small faint">of supply, rising over {approxDuration(s.uncappedAfter)}</div>
          </div>
          <MiniRamp steps={s.steps.map((x) => x.maxBps)} />
        </Tile>
        <Tile to="/create" label="Studio launch">
          <div className="tile-pad">
            <div className="tile-kicker">Token setup</div>
            <div className="mock-field"><span className="mock-dot" />Ticker <b className="num">$YOURS</b></div>
            <div className="mock-row">
              {hookList(meta).map((h) => <span key={h.id} className={`mock-hook tone-${h.tone}`} title={h.name}>{h.icon}</span>)}
              <span className="small faint">4 hooks</span>
            </div>
            <div className="mock-ready"><IconCheck size={14} />Ready to launch</div>
            <span className="mock-btn">Launch on {meta.cluster.toLowerCase()}</span>
          </div>
        </Tile>
        <Tile to="/transparency" label="Transparency">
          <div className="tile-pad">
            <div className="tile-kicker">Where fees go</div>
            <div className="fee-split">
              <div style={{ flex: FLYWHEEL_SPLIT.buybackPct }} className="fs-a"><span>{FLYWHEEL_SPLIT.buybackPct}%</span></div>
              <div style={{ flex: FLYWHEEL_SPLIT.devPct }} className="fs-b"><span>{FLYWHEEL_SPLIT.devPct}%</span></div>
            </div>
            <div className="row small" style={{ justifyContent: 'space-between', marginTop: 6 }}><span className="faint">buy back + burn</span><span className="faint">dev</span></div>
            <div className="tile-log mono">
              <div><span className="ok">●</span> claim fees</div>
              <div><span className="ok">●</span> buy on the pool</div>
              <div><span className="ok">●</span> burn, supply ↓</div>
            </div>
          </div>
        </Tile>
      </div>

      <div className="home-lists">
        <section>
          <div className="section-head"><h2>Closest to graduation</h2><Link to="/tokens" className="small link">All tokens</Link></div>
          <div className="list-card">
            {!list.data ? <ListEmpty text="Reading tokens…" /> : closest.length === 0 ? <ListEmpty text="No tokens on a curve right now." /> : closest.map((t) => (
              <Link key={t.mint} to={`/token/${t.mint}`} className="list-row">
                <span className="lr-thumb"><TokenImage mint={t.mint} ticker={t.view.launch?.symbol} metadata={t.view.metadata} showTicker={false} /></span>
                <span className="lr-main">
                  <b>{t.view.launch?.symbol ?? 'TOKEN'}</b>
                  <span className="small faint">{t.view.launch?.name}</span>
                </span>
                <span className="lr-meter"><span className="meter"><span className="fill" style={{ width: `${t.progress}%` }} /></span><span className="small num faint">{Math.round(t.progress)}%</span></span>
                <span className="lr-side small num">{t.capPct ? `cap ${t.capPct}` : 'no cap'}</span>
              </Link>
            ))}
          </div>
        </section>
        <section>
          <div className="section-head"><h2>Latest burns</h2><Link to="/transparency" className="small link">All keeper logs</Link></div>
          <div className="list-card">
            {!fw.data ? <ListEmpty text={fw.error ? "Couldn't read the keeper logs." : 'Reading keeper logs…'} /> : burns.length === 0 ? <ListEmpty text="No burns yet: buybacks start after a token graduates." /> : burns.map((b) => (
              <a key={b.sig} href={b.link || undefined} target="_blank" rel="noreferrer" className="list-row">
                <span className="lr-ico"><IconFlame size={16} /></span>
                <span className="lr-main">
                  <b className="num">{fmtTokens(b.tokens)}</b>
                  <span className="small faint">{tickerOf(b.k)} burned</span>
                </span>
                <span className="lr-side small faint">{ago(b.at)}</span>
              </a>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Tile({ to, label, className = '', children }: { to: string; label: string; className?: string; children: ReactNode }) {
  return (
    <Link to={to} className={`tile ${className}`}>
      <div className="tile-body">{children}</div>
      <div className="tile-foot"><span>{label}</span><span className="tile-open">Open <IconArrow size={13} /></span></div>
    </Link>
  );
}

/** Four columns of token cards drifting up and down (repeated so the loop is seamless). */
function TokenMarquee({ toks }: { toks: Tok[] }) {
  if (toks.length === 0) return <div className="tile-pad faint small">Reading tokens…</div>;
  const base = toks.length >= 4 ? toks : Array.from({ length: 4 }, (_, i) => toks[i % toks.length]);
  const cols = [0, 1, 2, 3].map((c) => base.filter((_, i) => i % 4 === c));
  return (
    <div className="marquee" aria-hidden="true">
      {cols.map((col, c) => (
        <div key={c} className={`mq-col ${c % 2 ? 'down' : 'up'}`} style={{ animationDuration: `${26 + c * 4}s` }}>
          {[...col, ...col, ...col, ...col].map((t, i) => (
            <div key={i} className="mq-card">
              <div className="mq-art"><TokenImage mint={t.mint} ticker={t.view.launch?.symbol} metadata={t.view.metadata} showTicker={false} /></div>
              <div className="mq-meta">
                <b>{t.view.launch?.symbol ?? 'TOKEN'}</b>
                <span className="num">{t.graduated ? 'graduated' : t.capPct ? `cap ${t.capPct}` : 'no cap'}</span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function HookRows({ meta }: { meta: Meta }) {
  return (
    <div className="tile-pad hook-rows">
      {hookList(meta).map((h, i) => (
        <div key={h.id} className={`hr-row tone-${h.tone}`} style={{ animationDelay: `${i * 2}s` }}>
          <span className="hook-tile">{h.icon}</span>
          <span className="hr-main"><b>{h.name}</b><span className="small faint">{h.when}</span></span>
          <span className="hr-state"><IconCheck size={13} />on</span>
        </div>
      ))}
    </div>
  );
}

/** The default cap schedule as a small stepped area (same shape as the cap chart, no axes). */
function MiniRamp({ steps }: { steps: number[] }) {
  const W = 300, H = 90, top = Math.max(...steps, 1);
  const n = steps.length;
  let d = `M0 ${H}`;
  steps.forEach((b, i) => { const x = (W * i) / n, y = H - (H - 12) * (b / top); d += ` L${x} ${y} L${(W * (i + 1)) / n} ${y}`; });
  const area = `${d} L${W} ${H} Z`;
  return (
    <svg className="mini-ramp" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="mr-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
      <path d={area} fill="url(#mr-g)" />
      <path d={d.replace(/^M0 \d+ L/, 'M')} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const ListEmpty = ({ text }: { text: string }) => <div className="small faint" style={{ padding: '18px 16px' }}>{text}</div>;
const fmtTokens = (s: string) => { const n = Number(s); return Number.isFinite(n) ? (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : Math.trunc(n).toString()) : s; };
const tickerOf = (k: PublicKeeper) => k.name.replace(/^[a-z]+-/, '').toUpperCase();
const ago = (iso: string) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return ''; const s = Math.max(0, (Date.now() - t) / 1000); return s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

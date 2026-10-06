// Diagrams for the hooks page and the launch tool. Plain inline SVG themed through CSS classes (.hd-*) so both themes
// work. Every number drawn here comes from the caller (studio defaults or a token's own config), never invented.
// Layout rules: nodes in a row share one height and centre line, connectors are straight or right-angled.
import { useId, type ReactNode } from 'react';

const Arrow = ({ d, cls = '' }: { d: string; cls?: string }) => <path d={d} className={`hd-arrow ${cls}`} markerEnd="url(#hd-head)" />;
const Frame = ({ w, h, label, children }: { w: number; h: number; label: string; children: ReactNode }) => (
  <svg className="hd" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id="hd-head" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse" markerUnits="strokeWidth">
        <path d="M1.5 1.5L8.5 5 1.5 8.5" className="hd-head" />
      </marker>
    </defs>
    {children}
  </svg>
);

type Tone = '' | 'ok' | 'bad' | 'hook';
/** A node: optional 18px glyph on top, title, optional sub line - the whole stack centred in the box. */
function Node({ x, y, w, h, title, sub, tone = '', icon }: { x: number; y: number; w: number; h: number; title: string; sub?: string; tone?: Tone; icon?: ReactNode }) {
  const cx = x + w / 2;
  const stack = (icon ? 26 : 0) + 14 + (sub ? 15 : 0);   // glyph + gap, title, sub
  const top = y + (h - stack) / 2;
  const titleY = top + (icon ? 26 : 0) + 11;
  return (
    <g className={`hd-node ${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx="7" />
      {icon && <g transform={`translate(${cx - 9} ${top})`} className="hd-ico">{icon}</g>}
      <text x={cx} y={titleY} textAnchor="middle" className="hd-t">{title}</text>
      {sub && <text x={cx} y={titleY + 15} textAnchor="middle" className="hd-s">{sub}</text>}
    </g>
  );
}

// ---- 18px glyphs used inside diagrams (stroked with currentColor via .hd-ico)
const G = ({ children }: { children: ReactNode }) => <g strokeWidth="1.6">{children}</g>;
const gShield = <G><path d="M9 1.5l6.5 2.5v5c0 4-2.8 6.6-6.5 7.8C5.3 15.6 2.5 13 2.5 9V4L9 1.5z" /><path d="M6 9l2.2 2.2L12.2 7" /></G>;
const gPct = <G><circle cx="9" cy="9" r="7.2" /><path d="M6.4 11.6l5.2-5.2" /><circle cx="6.6" cy="6.6" r=".9" /><circle cx="11.4" cy="11.4" r=".9" /></G>;
const gFlame = <G><path d="M9 1.5c.6 3-2.6 4.6-2.6 7.6a2.6 2.6 0 0 0 5.2 0c0-1.3-.6-2-1.1-2.7 2.2 1 3.9 3 3.9 5.4A5.4 5.4 0 0 1 3 11.8c0-4.5 4.6-6.3 6-10.3z" /></G>;
const gLoop = <G><path d="M15 8a6 6 0 0 0-11-3M3 10a6 6 0 0 0 11 3" /><path d="M4 1.5V5h3.5M14 16.5V13h-3.5" /></G>;
const gSwitch = <G><rect x="1.5" y="5" width="15" height="8" rx="4" /><circle cx="12.5" cy="9" r="2.2" /></G>;
const gWallet = <G><rect x="2" y="4" width="14" height="11" rx="2.5" /><path d="M2 7.5h14M12 11.2h1.5" /></G>;
const gCoins = <G><ellipse cx="9" cy="5" rx="6" ry="2.5" /><path d="M3 5v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M3 9v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V9" /></G>;
const gSwap = <G><path d="M3 6h11l-3-3M15 12H4l3 3" /></G>;

/** 1 · Cap per token account: buy -> hook checks the destination token account -> lands or fails. */
export function CapDiagram({ capText = 'the cap' }: { capText?: string }) {
  const cy = 105, h = 70;
  return (
    <Frame w={420} h={210} label="A buy passes through the transfer hook, which lets it land if the token account stays under the cap and fails it otherwise">
      <Node x={6} y={cy - h / 2} w={88} h={h} title="Buy" sub="SOL in" icon={gWallet} />
      <Arrow d={`M96 ${cy} H130`} cls="flow" />
      <Node x={134} y={cy - h / 2} w={124} h={h} title="Transfer hook" sub={`balance ≤ ${capText}?`} tone="hook" icon={gShield} />
      <Arrow d={`M260 ${cy - 12} H284 V46 H310`} cls="ok flow" />
      <Arrow d={`M260 ${cy + 12} H284 V164 H310`} cls="bad" />
      <text x={291} y={cy - 26} className="hd-s strong ok">yes</text>
      <text x={291} y={cy + 34} className="hd-s strong bad">no</text>
      <Node x={314} y={24} w={100} h={44} title="Tokens land" sub="under the cap" tone="ok" />
      <Node x={314} y={142} w={100} h={44} title="Buy fails" sub="nothing moves" tone="bad" />
    </Frame>
  );
}

/** One token account across three buys: each column is the balance after that buy. The third would cross the cap,
 *  so it fails and the balance stays where it was. */
export function CapGauge({ capPct = 1 }: { capPct?: number }) {
  const uid = useId().replace(/:/g, '');
  const top = 30, base = 146, capY = 66;                       // capY = the cap (100% of it)
  const lv = (f: number) => base - (base - capY) * f;          // fraction of the cap -> y
  const cols = [
    { old: 0, add: 0.5, ok: true, label: 'buy 1' },
    { old: 0.5, add: 0.38, ok: true, label: 'buy 2' },
    { old: 0.88, add: 0.42, ok: false, label: 'buy 3' },
  ];
  return (
    <Frame w={420} h={196} label={`One token account across three buys: the first two land, the third would go over the ${capPct}% cap so it fails and the balance does not change`}>
      <g transform="translate(40 6)">
        <rect width="10" height="10" rx="2" className="hd-fill old" /><text x="15" y="9" className="hd-s">held before</text>
        <rect x="96" width="10" height="10" rx="2" className="hd-fill" /><text x="111" y="9" className="hd-s">this buy</text>
        <rect x="176" width="10" height="10" rx="2" className="hd-ghost" /><text x="191" y="9" className="hd-s">refused (over the cap)</text>
      </g>
      {cols.map((c, i) => {
        const x = 52 + i * 112, w = 64;
        const oldY = lv(c.old), newY = lv(c.old + c.add);
        return (
          <g key={i}>
            <clipPath id={`${uid}-c${i}`}><rect x={x} y={top} width={w} height={base - top} rx="7" /></clipPath>
            <rect x={x} y={top} width={w} height={base - top} rx="7" className="hd-well" />
            <g clipPath={`url(#${uid}-c${i})`}>
              {c.ok && <rect x={x} y={newY} width={w} height={oldY - newY} className="hd-fill" />}
              {c.old > 0 && <rect x={x} y={oldY} width={w} height={base - oldY} className="hd-fill old" />}
              {c.ok && c.old > 0 && <line x1={x} x2={x + w} y1={oldY} y2={oldY} className="hd-seam" />}
            </g>
            {!c.ok && <rect x={x + 3} y={newY} width={w - 6} height={oldY - newY - 3} rx="5" className="hd-ghost" />}
            <text x={x + w / 2} y={base + 18} textAnchor="middle" className="hd-s">{c.label}</text>
            <text x={x + w / 2} y={base + 33} textAnchor="middle" className={`hd-s strong ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? '✓ lands' : '✕ fails'}</text>
          </g>
        );
      })}
      <line x1={40} x2={386} y1={capY} y2={capY} className="hd-capline" />
      <text x={392} y={capY - 2} className="hd-t small">cap</text>
      <text x={392} y={capY + 12} className="hd-s">{capPct}%</text>
    </Frame>
  );
}

/** 2 · Anti-sniper fee: a falling step schedule from startBps to endBps over durationSlots in `periods` steps, then
 *  flat at endBps until graduation. */
export function SniperFeeDiagram({ startBps, endBps, periods, durationSlots, durationText }: { startBps: number; endBps: number; periods: number; durationSlots: number; durationText: string }) {
  const L = 48, R = 318, END = 408, T = 20, B = 156;
  const y = (bps: number) => B - ((B - T) * bps) / startBps;
  const x = (i: number) => L + ((R - L) * i) / periods;
  const step = (startBps - endBps) / periods;
  let d = `M${L} ${y(startBps)}`;
  for (let i = 1; i <= periods; i++) d += ` H${x(i)} V${y(startBps - step * i)}`;
  const pct = (b: number) => `${+(b / 100).toFixed(1)}%`;
  return (
    <Frame w={420} h={196} label={`Curve fee starts at ${pct(startBps)} and falls in ${periods} steps to ${pct(endBps)} over ${durationText}, then stays at ${pct(endBps)}`}>
      <rect x={R} y={T - 6} width={END - R} height={B - T + 6} className="hd-band" />
      {[1, 0.5].map((f) => <line key={f} x1={L} x2={END} y1={y(startBps * f)} y2={y(startBps * f)} className="hd-grid" />)}
      <path d={`${d} V${B} H${L} Z`} className="hd-area amber" />
      <path d={`M${R} ${y(endBps)} H${END}`} className="hd-line amber dashed" />
      <path d={d} className="hd-line amber" />
      <circle cx={L} cy={y(startBps)} r="4" className="hd-dot amber" />
      <circle cx={R} cy={y(endBps)} r="4" className="hd-dot amber" />
      <text x={L - 8} y={y(startBps) + 4} textAnchor="end" className="hd-s">{pct(startBps)}</text>
      <text x={L - 8} y={y(startBps / 2) + 4} textAnchor="end" className="hd-s">{pct(startBps / 2)}</text>
      <text x={L - 8} y={B + 4} textAnchor="end" className="hd-s">0%</text>
      <text x={(R + END) / 2} y={y(endBps) - 12} textAnchor="middle" className="hd-t small">stays {pct(endBps)}</text>
      <text x={(R + END) / 2} y={T + 12} textAnchor="middle" className="hd-s">until</text>
      <text x={(R + END) / 2} y={T + 26} textAnchor="middle" className="hd-s">graduation</text>
      <line x1={L} x2={END} y1={B} y2={B} className="hd-axis" />
      <text x={L} y={B + 18} textAnchor="middle" className="hd-s">launch</text>
      <text x={R} y={B + 18} textAnchor="middle" className="hd-s">{durationText}</text>
      <text x={(L + R) / 2} y={B + 34} textAnchor="middle" className="hd-s faint">{periods} steps down over {durationSlots} slots</text>
    </Frame>
  );
}

/** 3 · Buyback & burn: fees -> keeper -> 85% buys the token -> burn, with the dev share branching off the keeper. */
export function FlywheelDiagram({ devPct, buybackPct }: { devPct: number; buybackPct: number }) {
  const cy = 138, h = 70, top = cy - h / 2;
  return (
    <Frame w={430} h={190} label={`Trading fees are claimed by the keeper, ${devPct}% goes to the dev wallet and ${buybackPct}% buys the token back on the pool and burns it`}>
      <Node x={4} y={top} w={88} h={h} title="Trading fees" sub="in SOL" icon={gCoins} />
      <Arrow d={`M94 ${cy} H112`} cls="flow" />
      <Node x={116} y={top} w={88} h={h} title="Keeper" sub="claims fees" tone="hook" icon={gLoop} />
      <Arrow d={`M206 ${cy} H224`} cls="ok flow" />
      <Node x={228} y={top} w={88} h={h} title={`${buybackPct}% buys`} sub="the token" tone="ok" icon={gSwap} />
      <Arrow d={`M318 ${cy} H336`} cls="ok flow" />
      <Node x={340} y={top} w={86} h={h} title="Burn" sub="supply goes ↓" tone="bad" icon={gFlame} />
      {/* the dev share branches up off the keeper */}
      <Arrow d={`M160 ${top - 2} V36 H224`} />
      <Node x={228} y={14} w={88} h={44} title={`${devPct}%`} sub="dev wallet" />
    </Frame>
  );
}

/** 4 · Lift-only switch: a scale from "tighter" to "no cap"; the switch can only move the cap up. */
export function LiftDiagram() {
  const tx = 30, tw = 24, T = 26, B = 176, knob = 104;
  const row = (y: number, ok: boolean, title: string) => (
    <g key={title} className={`hd-opt ${ok ? 'ok' : 'bad'}`}>
      <rect x={124} y={y - 16} width={290} height={32} rx="7" />
      <circle cx={143} cy={y} r="9" />
      {ok ? <path d={`M138.6 ${y}l3 3 6-6`} className="hd-mark" /> : <path d={`M139.5 ${y - 3.5}l7 7M146.5 ${y - 3.5}l-7 7`} className="hd-mark" />}
      <text x={160} y={y + 4} className="hd-t small">{title}</text>
      <text x={404} y={y + 4} textAnchor="end" className={`hd-s strong ${ok ? 'ok' : 'bad'}`}>{ok ? 'allowed' : 'never'}</text>
    </g>
  );
  return (
    <Frame w={420} h={200} label="The admin switch can raise or remove the cap but can never tighten it or add a new one">
      <text x={tx + tw / 2} y={T - 9} textAnchor="middle" className="hd-s">no cap</text>
      <text x={tx + tw / 2} y={B + 17} textAnchor="middle" className="hd-s">tighter</text>
      <rect x={tx} y={T} width={tw} height={knob - T} rx="6" className="hd-zone ok" />
      <rect x={tx} y={knob} width={tw} height={B - knob} rx="6" className="hd-zone bad" />
      <rect x={tx - 7} y={knob - 6} width={tw + 14} height={12} rx="6" className="hd-knob" />
      <Arrow d={`M${tx + tw + 22} ${knob - 12} V${T + 4}`} cls="ok" />
      <Arrow d={`M${tx + tw + 22} ${knob + 12} V${B - 4}`} cls="bad dashed" />
      <text x={tx + tw + 30} y={knob + 4} className="hd-s strong">now</text>
      {row(42, true, 'Raise the cap')}
      {row(82, true, 'Remove the cap')}
      {row(126, false, 'Tighten the cap')}
      {row(166, false, 'Add a new cap')}
    </Frame>
  );
}

/** Lifecycle overview: when each hook is on, across launch -> curve -> graduation -> pool. */
export function LifecycleDiagram({ feeText, rampText }: { feeText: string; rampText: string }) {
  const L = 160, M = 520, R = 694, rows = [66, 106, 146, 186], bh = 20;
  const lane = (y: number, name: string, ico: ReactNode, i: number) => (
    <g key={name}>
      {i % 2 === 0 && <rect x={4} y={y - 19} width={R} height={38} rx="6" className="hd-row" />}
      <g transform={`translate(14 ${y - 9})`} className="hd-ico">{ico}</g>
      <text x={42} y={y + 4} className="hd-t left">{name}</text>
    </g>
  );
  const bar = (y: number, x1: number, x2: number, cls: string, label: string, inside = true) => (
    <g>
      <rect x={x1} y={y - bh / 2} width={x2 - x1} height={bh} rx={bh / 2} className={`hd-bar ${cls}`} />
      <text x={inside ? x1 + 12 : x2 + 10} y={y + 4} className={`hd-s ${inside ? 'on' : ''}`}>{label}</text>
    </g>
  );
  return (
    <Frame w={700} h={226} label="Timeline: the anti-sniper fee runs at the very start, the cap and the switch run during the bonding curve, and buyback and burn runs after graduation">
      <rect x={L} y={8} width={M - L - 3} height={28} rx="7" className="hd-phase" />
      <rect x={M + 3} y={8} width={R - M - 3} height={28} rx="7" className="hd-phase pool" />
      <text x={(L + M) / 2} y={26} textAnchor="middle" className="hd-t small">Bonding curve</text>
      <text x={(M + R) / 2 + 1} y={26} textAnchor="middle" className="hd-t small">Pool, after graduation</text>
      {lane(rows[0], 'Anti-sniper fee', gPct, 0)}
      {lane(rows[1], 'Cap per account', gShield, 1)}
      {lane(rows[2], 'Lift-only switch', gSwitch, 2)}
      {lane(rows[3], 'Buyback & burn', gFlame, 3)}
      <line x1={M} x2={M} y1={42} y2={208} className="hd-grad" />
      <line x1={L} x2={L} y1={42} y2={208} className="hd-start" />
      {bar(rows[0], L, L + 44, 'amber', feeText, false)}
      {bar(rows[1], L, M - 6, 'accent', `ends at graduation or after ${rampText}`)}
      {bar(rows[2], L, M - 6, 'sim', 'can only lift the cap')}
      {bar(rows[3], L, M - 6, 'dotted', 'fees build up')}
      {bar(rows[3], M + 6, R, 'green', 'buy back + burn')}
      <text x={L} y={221} textAnchor="middle" className="hd-s">launch</text>
      <text x={M} y={221} textAnchor="middle" className="hd-s">graduation</text>
    </Frame>
  );
}

// ---- optional hooks (chosen at launch; program v2 rules)

/** 5 · Max single buy: three buys against one limit. Each buy is judged on its own size, not on what the buyer holds. */
export function MaxBuyDiagram({ maxText }: { maxText: string }) {
  const L = 70, M = 250, top = 40, rowH = 42, bh = 22;
  const rows = [
    { label: 'Buy A', f: 0.42, ok: true },
    { label: 'Buy B', f: 0.86, ok: true },
    { label: 'Buy C', f: 1.45, ok: false },
  ];
  const x = (f: number) => L + (M - L) * f;
  return (
    <Frame w={420} h={196} label={`Three buys against a ${maxText} max single buy: the two under it land, the one over it fails and nothing moves`}>
      <text x={M} y={20} textAnchor="middle" className="hd-t small">max {maxText}</text>
      <text x={M} y={33} textAnchor="middle" className="hd-s">per buy</text>
      {rows.map((r, i) => {
        const y = top + 8 + i * rowH;
        return (
          <g key={r.label}>
            <text x={L - 10} y={y + bh / 2 + 4} textAnchor="end" className="hd-s">{r.label}</text>
            <rect x={L} y={y} width={x(1.6) - L} height={bh} rx="6" className="hd-well" />
            {r.ok
              ? <rect x={L} y={y} width={x(r.f) - L} height={bh} rx="6" className="hd-fill" />
              : <rect x={L + 2} y={y + 2} width={x(r.f) - L - 4} height={bh - 4} rx="5" className="hd-ghost" />}
            <text x={414} y={y + bh / 2 + 4} textAnchor="end" className={`hd-s strong ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? '✓ lands' : '✕ fails'}</text>
          </g>
        );
      })}
      <line x1={M} x2={M} y1={top} y2={top + 3 * rowH + 6} className="hd-capline" />
      <text x={L} y={186} className="hd-s faint">Only the size of this one buy counts, not what the buyer already holds.</text>
    </Frame>
  );
}

/** 6 · Max bought per slot: every buy in one slot (~0.4 s) adds up against one shared limit. The buy that would go
 *  over fails; the next slot starts again from zero. */
export function SlotLimitDiagram({ limitText }: { limitText: string }) {
  const uid = useId().replace(/:/g, '');
  const top = 34, base = 150, capY = 64;
  const lv = (f: number) => base - (base - capY) * f;
  const cols = [
    { x: 74, label: 'slot n', parts: [{ k: 'A', f: 0.42 }, { k: 'B', f: 0.4 }], fail: { k: 'C', f: 0.38 } },
    { x: 266, label: 'slot n + 1', parts: [{ k: 'C', f: 0.38 }], fail: null as null | { k: string; f: number } },
  ];
  const w = 80;
  return (
    <Frame w={420} h={196} label={`All buys in one slot share a ${limitText} limit: A and B land, C would go over and fails, then lands in the next slot`}>
      {cols.map((c, i) => {
        let acc = 0;
        return (
          <g key={c.label}>
            <clipPath id={`${uid}-s${i}`}><rect x={c.x} y={top} width={w} height={base - top} rx="7" /></clipPath>
            <rect x={c.x} y={top} width={w} height={base - top} rx="7" className="hd-well" />
            <g clipPath={`url(#${uid}-s${i})`}>
              {c.parts.map((p, j) => {
                const y0 = lv(acc), y1 = lv(acc + p.f); acc += p.f;
                return (
                  <g key={p.k}>
                    <rect x={c.x} y={y1} width={w} height={y0 - y1} className={`hd-fill${j % 2 ? ' old' : ''}`} />
                    {j > 0 && <line x1={c.x} x2={c.x + w} y1={y0} y2={y0} className="hd-seam" />}
                  </g>
                );
              })}
            </g>
            {c.parts.map((p, j) => {
              const before = c.parts.slice(0, j).reduce((s, q) => s + q.f, 0);
              return <text key={p.k} x={c.x - 8} y={(lv(before) + lv(before + p.f)) / 2 + 4} textAnchor="end" className="hd-s strong">{p.k}</text>;
            })}
            {c.fail && (() => { const y0 = lv(acc), y1 = lv(acc + c.fail.f); return (
              <g>
                <rect x={c.x + 3} y={y1} width={w - 6} height={y0 - y1 - 3} rx="5" className="hd-ghost" />
                <text x={c.x - 8} y={(y0 + y1) / 2 + 3} textAnchor="end" className="hd-s strong bad">{c.fail.k}</text>
              </g>
            ); })()}
            <text x={c.x + w / 2} y={base + 17} textAnchor="middle" className="hd-s">{c.label}</text>
            <text x={c.x + w / 2} y={base + 32} textAnchor="middle" className={`hd-s strong ${c.fail ? 'bad' : 'ok'}`}>{c.fail ? `✕ ${c.fail.k} fails` : `✓ ${c.parts[0].k} lands`}</text>
          </g>
        );
      })}
      <path d={`M${74 + w + 14} ${lv(0.6)} H${266 - 14}`} className="hd-arrow dashed" markerEnd="url(#hd-head)" />
      <text x={(74 + w + 266) / 2} y={lv(0.6) - 8} textAnchor="middle" className="hd-s">try again</text>
      <line x1={74} x2={364} y1={capY} y2={capY} className="hd-capline" />
      <text x={370} y={capY - 2} className="hd-t small">limit</text>
      <text x={370} y={capY + 12} className="hd-s">{limitText}</text>
      <text x={370} y={capY + 25} className="hd-s">per slot</text>
    </Frame>
  );
}

/** 7 · Nth-buy pot: buys are counted in order and every Nth one is recorded on chain as a winner. */
export function PotDiagram({ every, minText }: { every: number; minText: string }) {
  const cy = 74, r = 17, gap = 45, x0 = 30;
  const cells: { t: string; win?: boolean; dots?: boolean }[] = [
    { t: '1' }, { t: '2' }, { t: '…', dots: true }, { t: String(every - 1) }, { t: String(every), win: true },
    { t: String(every + 1) }, { t: '…', dots: true }, { t: String(2 * every - 1) }, { t: String(2 * every), win: true },
  ];
  return (
    <Frame w={420} h={176} label={`Buys are counted in order; every ${every}th counted buy is recorded on chain as a pot winner`}>
      <text x={x0 - r} y={24} className="hd-t small">counted buys</text>
      <line x1={x0} x2={x0 + gap * (cells.length - 1)} y1={cy} y2={cy} className="hd-axis" />
      {cells.map((c, i) => {
        const x = x0 + gap * i;
        if (c.dots) return <text key={i} x={x} y={cy + 4} textAnchor="middle" className="hd-t">…</text>;
        return (
          <g key={i} className={`hd-pot ${c.win ? 'win' : ''}`}>
            <circle cx={x} cy={cy} r={c.win ? r + 2 : r} />
            <text x={x} y={cy + 4} textAnchor="middle" className="hd-t small">#{c.t}</text>
            {c.win && <text x={x} y={cy + r + 20} textAnchor="middle" className="hd-s strong hd-win">wins</text>}
          </g>
        );
      })}
      <text x={x0 - r} y={146} className="hd-s">One buy per slot counts (the first). Buys under {minText} don’t count.</text>
      <text x={x0 - r} y={162} className="hd-s faint">Winners are picked by order, never at random, and recorded on chain.</text>
    </Frame>
  );
}

/** Slow mode: a shared gap between curve buys. Buy A lands, B comes too soon and fails, C waits out the gap and lands. */
export function CooldownDiagram({ gapText }: { gapText: string }) {
  const y = 96, L = 36, R = 404;
  const marks = [
    { x: 92, label: 'Buy A', ok: true, note: 'lands' },
    { x: 196, label: 'Buy B', ok: false, note: 'too soon' },
    { x: 328, label: 'Buy C', ok: true, note: 'lands' },
  ];
  return (
    <Frame w={420} h={196} label={`Curve buys share one ${gapText} gap: A lands, B inside the gap fails, C after the gap lands`}>
      <line x1={L} x2={R} y1={y} y2={y} className="hd-axis" />
      <rect x={marks[0].x + 8} y={y - 11} width={marks[2].x - marks[0].x - 16} height={22} rx="7" className="hd-well" />
      <text x={(marks[0].x + marks[2].x) / 2} y={y + 4.5} textAnchor="middle" className="hd-s">{gapText} gap</text>
      {marks.map((m) => (
        <g key={m.label}>
          <circle cx={m.x} cy={y} r="7" className={m.ok ? 'hd-fill' : 'hd-ghost'} />
          <text x={m.x} y={y - 24} textAnchor="middle" className="hd-t small">{m.label}</text>
          <text x={m.x} y={y + 34} textAnchor="middle" className={`hd-s strong ${m.ok ? 'ok' : 'bad'}`}>{m.ok ? '\u2713 ' + m.note : '\u2715 ' + m.note}</text>
        </g>
      ))}
      <text x={(L + R) / 2} y={160} textAnchor="middle" className="hd-s">one shared gap, every buyer together \u00b7 selling is never limited</text>
    </Frame>
  );
}

/** Creator lock: the creator's slice stays locked through the curve and graduation, unlocking in one piece later. */
export function LockDiagram({ pctText, durText }: { pctText: string; durText: string }) {
  const y = 84, L = 36, R = 404, unlockX = 318;
  const stations = [
    { x: 70, label: 'launch' },
    { x: 190, label: 'graduation' },
    { x: unlockX, label: `+${durText}` },
  ];
  return (
    <Frame w={420} h={196} label={`The creator's ${pctText} is locked from launch, through graduation, and unlocks all at once about ${durText} later`}>
      <line x1={L} x2={R} y1={y} y2={y} className="hd-axis" />
      <rect x={stations[0].x} y={y - 12} width={unlockX - stations[0].x} height={24} rx="7" className="hd-well" />
      <text x={(stations[0].x + unlockX) / 2} y={y + 4.5} textAnchor="middle" className="hd-s">{pctText} locked</text>
      {stations.map((st) => (
        <g key={st.label}>
          <line x1={st.x} x2={st.x} y1={y - 16} y2={y + 16} className="hd-axis" />
          <text x={st.x} y={y + 34} textAnchor="middle" className="hd-s">{st.label}</text>
        </g>
      ))}
      <circle cx={unlockX} cy={y} r="7" className="hd-fill" />
      <text x={unlockX} y={y - 24} textAnchor="middle" className="hd-t small">unlocks</text>
      <text x={(L + R) / 2} y={160} textAnchor="middle" className="hd-s">one piece, on chain \u00b7 the creator cannot sell it earlier</text>
    </Frame>
  );
}

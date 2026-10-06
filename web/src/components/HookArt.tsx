// Diagrams for the hooks page and the launch tool. Plain inline SVG themed through CSS classes (.hd-*) so both themes
// work. Every number drawn here comes from the caller (studio defaults or a token's own config), never invented.
// Layout rules: nodes in a row share one height and centre line, connectors are straight or right-angled.
// Brand style: solid cut-corner blocks with depth (light top, coloured front, dark side). The rule diagrams loop a
// 6 s story (buys arrive, the refused one hits the rule, shakes and is pulled back); keyframes live in brand.css and
// stop under prefers-reduced-motion, leaving every element in its resting place.
import { createContext, useContext, useId, type CSSProperties, type ReactNode } from 'react';

const Hazard = createContext('');
const Arrow = ({ d, cls = '' }: { d: string; cls?: string }) => <path d={d} className={`hd-arrow ${cls}`} markerEnd="url(#hd-head)" />;
function Frame({ w, h, label, children }: { w: number; h: number; label: string; children: ReactNode }) {
  const hz = `hd-hz-${useId().replace(/:/g, '')}`;
  return (
    <svg className="hd" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="hd-head" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse" markerUnits="strokeWidth">
          <path d="M1.5 1.5L8.5 5 1.5 8.5" className="hd-head" />
        </marker>
        <pattern id={hz} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="7" height="7" className="hd-hz-bg" /><rect width="3.5" height="7" className="hd-hz-fg" />
        </pattern>
      </defs>
      <Hazard.Provider value={hz}>{children}</Hazard.Provider>
    </svg>
  );
}

/** One cut-corner block with depth. kind picks the colour (brand.css .hd-blk.*); `bad` is hazard-striped. Depth equals
 *  the cut, so the cut corners line up with the depth direction and the outline stays clean. */
type Kind = 'buy' | 'held' | 'ok' | 'bad' | 'cyan' | 'amber' | 'node' | 'hook' | 'okn' | 'badn' | 'embern';
function Block({ x, y, w, h, kind, d = 6, tl = true, br = true, anim, origin, style, children }: {
  x: number; y: number; w: number; h: number; kind: Kind; d?: number; tl?: boolean; br?: boolean;
  anim?: string; origin?: 'up' | 'rt'; style?: CSSProperties; children?: ReactNode;
}) {
  const hz = useContext(Hazard);
  const a = tl ? d : 0, b = br ? d : 0;
  const front = `${x + a},${y} ${x + w},${y} ${x + w},${y + h - b} ${x + w - b},${y + h} ${x},${y + h} ${x},${y + a}`;
  const top = `${x + a},${y} ${x + w},${y} ${x + w + d},${y - d} ${x + a + d},${y - d}`;
  const side = `${x + w},${y} ${x + w + d},${y - d} ${x + w + d},${y + h - b - d} ${x + w},${y + h - b}`;
  const cls = `hd-blk ${kind}${anim ? ' hd-anim' : ''}${origin ? ` hd-${origin}` : ''}`;
  return (
    <g className={cls} style={anim ? { animationName: anim, ...style } : style}>
      <polygon className="t" points={top} />
      <polygon className="r" points={side} />
      <polygon className="f" points={front} style={kind === 'bad' ? { fill: `url(#${hz})` } : undefined} />
      {children}
    </g>
  );
}
/** A text label that fades in on the shared 6 s loop (static when motion is reduced). */
const Lbl = ({ x, y, anim, cls, anchor = 'middle', children }: { x: number; y: number; anim?: string; cls: string; anchor?: 'start' | 'middle' | 'end'; children: ReactNode }) => (
  <text x={x} y={y} textAnchor={anchor} className={`${cls}${anim ? ' hd-anim' : ''}`} style={anim ? { animationName: anim } : undefined}>{children}</text>
);
/** A thin rule shelf (the cap line, the limit wall): a block 3px thick, with a red copy that flashes when a buy hits it. */
function Shelf({ x, y, w, h, flash }: { x: number; y: number; w: number; h: number; flash?: string }) {
  return (
    <g>
      <Block x={x} y={y} w={w} h={h} kind="node" d={6} tl={false} br={false} />
      {flash && <g className="hd-anim hd-flash" style={{ animationName: flash }}><Block x={x} y={y} w={w} h={h} kind="bad" d={6} tl={false} br={false} /></g>}
    </g>
  );
}

type Tone = '' | 'ok' | 'bad' | 'hook' | 'ember';
const nodeKind: Record<Tone, Kind> = { '': 'node', ok: 'okn', bad: 'badn', hook: 'hook', ember: 'embern' };
/** A node: a cut block with depth; optional 18px glyph on top, title, optional sub line - the stack centred. */
function Node({ x, y, w, h, title, sub, tone = '', icon }: { x: number; y: number; w: number; h: number; title: string; sub?: string; tone?: Tone; icon?: ReactNode }) {
  const cx = x + w / 2;
  const stack = (icon ? 26 : 0) + 14 + (sub ? 15 : 0);   // glyph + gap, title, sub
  const top = y + (h - stack) / 2;
  const titleY = top + (icon ? 26 : 0) + 11;
  return (
    <g className={`hd-node ${tone}`}>
      <Block x={x} y={y} w={w} h={h} kind={nodeKind[tone]} d={6} />
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
    <Frame w={426} h={210} label="A buy passes through the transfer hook, which lets it land if the token account stays under the cap and fails it otherwise">
      <Arrow d={`M96 ${cy} H130`} cls="flow" />
      <Arrow d={`M260 ${cy - 12} H284 V46 H310`} cls="ok flow" />
      <Arrow d={`M260 ${cy + 12} H284 V164 H310`} cls="bad" />
      <Node x={6} y={cy - h / 2} w={88} h={h} title="Buy" sub="SOL in" icon={gWallet} />
      <Node x={134} y={cy - h / 2} w={124} h={h} title="Transfer hook" sub={`balance ≤ ${capText}?`} tone="hook" icon={gShield} />
      <text x={291} y={cy - 26} className="hd-s strong ok">yes</text>
      <text x={291} y={cy + 34} className="hd-s strong bad">no</text>
      <Node x={314} y={24} w={100} h={44} title="Tokens land" sub="under the cap" tone="ok" />
      <Node x={314} y={142} w={100} h={44} title="Buy fails" sub="nothing moves" tone="bad" />
    </Frame>
  );
}

/** One token account across three buys: each column is the balance after that buy. The third would cross the cap,
 *  so it rises into the cap, shakes and is pulled back: the balance stays where it was. */
export function CapGauge({ capPct = 1 }: { capPct?: number }) {
  const base = 170, capY = 66, w = 56;
  const lv = (f: number) => base - (base - capY) * f;          // fraction of the cap -> y
  const xs = [70, 182, 294];
  return (
    <Frame w={420} h={210} label={`One token account across three buys: the first two land, the third would go over the ${capPct}% cap so it fails and the balance does not change`}>
      <g transform="translate(40 4)">
        <rect width="10" height="10" className="hd-key buy" /><text x="15" y="9" className="hd-s">this buy</text>
        <rect x="86" width="10" height="10" className="hd-key held" /><text x="101" y="9" className="hd-s">held before</text>
        <rect x="190" width="10" height="10" className="hd-key bad" /><text x="205" y="9" className="hd-s">refused (over the cap)</text>
      </g>
      <g className="hd-cyc">
        <Block x={xs[0]} y={lv(0.5)} w={w} h={base - lv(0.5)} kind="buy" d={8} anim="hdC1" origin="up" />
        <Block x={xs[1]} y={lv(0.5)} w={w} h={base - lv(0.5)} kind="held" d={8} tl={false} anim="hdC2h" />
        <Block x={xs[1]} y={lv(0.88)} w={w} h={lv(0.5) - lv(0.88) - 3} kind="buy" d={8} br={false} anim="hdC2" origin="up" />
        <Block x={xs[2]} y={lv(0.88)} w={w} h={base - lv(0.88)} kind="held" d={8} tl={false} anim="hdC3h" />
        <Block x={xs[2]} y={lv(1.3)} w={w} h={lv(0.88) - lv(1.3) - 3} kind="bad" d={8} br={false} anim="hdCx" origin="up" />
        <Shelf x={50} y={capY - 1.5} w={322} h={3} flash="hdFlashC" />
        <text x={386} y={capY - 2} className="hd-t small">cap</text>
        <text x={386} y={capY + 12} className="hd-s">{capPct}%</text>
        {xs.map((x, i) => <text key={i} x={x + w / 2} y={base + 18} textAnchor="middle" className="hd-s">buy {i + 1}</text>)}
        <Lbl x={xs[0] + w / 2} y={base + 33} cls="hd-s strong ok" anim="hdL1">✓ lands</Lbl>
        <Lbl x={xs[1] + w / 2} y={base + 33} cls="hd-s strong ok" anim="hdL2">✓ lands</Lbl>
        <Lbl x={xs[2] + w / 2} y={base + 33} cls="hd-s strong bad" anim="hdLx">✕ fails</Lbl>
      </g>
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
      <rect x={L - 4} y={y(startBps) - 4} width="8" height="8" className="hd-dot amber" />
      <rect x={R - 4} y={y(endBps) - 4} width="8" height="8" className="hd-dot amber" />
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
    <Frame w={436} h={190} label={`Trading fees are claimed by the keeper, ${devPct}% goes to the dev wallet and ${buybackPct}% buys the token back on the pool and burns it`}>
      <Arrow d={`M94 ${cy} H112`} cls="flow" />
      <Arrow d={`M206 ${cy} H224`} cls="ok flow" />
      <Arrow d={`M318 ${cy} H336`} cls="ok flow" />
      {/* the dev share branches up off the keeper */}
      <Arrow d={`M160 ${top - 8} V36 H224`} />
      <Node x={4} y={top} w={88} h={h} title="Trading fees" sub="in SOL" icon={gCoins} />
      <Node x={116} y={top} w={88} h={h} title="Keeper" sub="claims fees" tone="hook" icon={gLoop} />
      <Node x={228} y={top} w={88} h={h} title={`${buybackPct}% buys`} sub="the token" tone="ok" icon={gSwap} />
      <Node x={340} y={top} w={86} h={h} title="Burn" sub="supply goes ↓" tone="ember" icon={gFlame} />
      <Node x={228} y={14} w={88} h={44} title={`${devPct}%`} sub="dev wallet" />
    </Frame>
  );
}

/** 4 · Lift-only switch: a scale from "tighter" to "no cap"; the switch can only move the cap up. */
export function LiftDiagram() {
  const tx = 30, tw = 24, T = 26, B = 176, knob = 104;
  const row = (y: number, ok: boolean, title: string) => (
    <g key={title} className={`hd-opt ${ok ? 'ok' : 'bad'}`}>
      <Block x={124} y={y - 16} w={284} h={32} kind="node" d={6} />
      <rect x={135} y={y - 8} width="16" height="16" className="hd-optmark" />
      {ok ? <path d={`M138.6 ${y}l3 3 6-6`} className="hd-mark" /> : <path d={`M139.5 ${y - 3.5}l7 7M146.5 ${y - 3.5}l-7 7`} className="hd-mark" />}
      <text x={160} y={y + 4} className="hd-t small">{title}</text>
      <text x={398} y={y + 4} textAnchor="end" className={`hd-s strong ${ok ? 'ok' : 'bad'}`}>{ok ? 'allowed' : 'never'}</text>
    </g>
  );
  return (
    <Frame w={420} h={200} label="The admin switch can raise or remove the cap but can never tighten it or add a new one">
      <text x={tx + tw / 2} y={T - 9} textAnchor="middle" className="hd-s">no cap</text>
      <text x={tx + tw / 2} y={B + 17} textAnchor="middle" className="hd-s">tighter</text>
      <rect x={tx} y={T} width={tw} height={knob - T} className="hd-zone ok" />
      <rect x={tx} y={knob} width={tw} height={B - knob} className="hd-zone bad" />
      <rect x={tx - 7} y={knob - 6} width={tw + 14} height={12} className="hd-knob" />
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
      {i % 2 === 0 && <rect x={4} y={y - 19} width={R} height={38} className="hd-row" />}
      <g transform={`translate(14 ${y - 9})`} className="hd-ico">{ico}</g>
      <text x={42} y={y + 4} className="hd-t left">{name}</text>
    </g>
  );
  const bar = (y: number, x1: number, x2: number, cls: string, label: string, inside = true) => (
    <g>
      <rect x={x1} y={y - bh / 2} width={x2 - x1} height={bh} className={`hd-bar ${cls}`} />
      <text x={inside ? x1 + 12 : x2 + 10} y={y + 4} className={`hd-s ${inside ? 'on' : ''}`}>{label}</text>
    </g>
  );
  return (
    <Frame w={700} h={226} label="Timeline: the anti-sniper fee runs at the very start, the cap and the switch run during the bonding curve, and buyback and burn runs after graduation">
      <rect x={L} y={8} width={M - L - 3} height={28} className="hd-phase" />
      <rect x={M + 3} y={8} width={R - M - 3} height={28} className="hd-phase pool" />
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
      {bar(rows[3], M + 6, R, 'ember', 'buy back + burn')}
      <text x={L} y={221} textAnchor="middle" className="hd-s">launch</text>
      <text x={M} y={221} textAnchor="middle" className="hd-s">graduation</text>
    </Frame>
  );
}

// ---- optional hooks (chosen at launch; program v2 rules)

/** 5 · Max single buy: three buys against one limit. Each buy is judged on its own size, not on what the buyer holds.
 *  C runs into the limit wall, pokes through in stripes, shakes and is refused whole. */
export function MaxBuyDiagram({ maxText }: { maxText: string }) {
  const L = 70, M = 250, bh = 28;
  const ys = [44, 92, 140];
  const x = (f: number) => L + (M - L) * f;
  return (
    <Frame w={420} h={204} label={`Three buys against a ${maxText} max single buy: the two under it land, the one over it fails and nothing moves`}>
      <text x={M} y={12} textAnchor="middle" className="hd-t small">max {maxText}</text>
      <text x={M} y={24} textAnchor="middle" className="hd-s">per buy</text>
      <g className="hd-cyc">
        {['Buy A', 'Buy B', 'Buy C'].map((t, i) => <text key={t} x={L - 10} y={ys[i] + bh / 2 + 4} textAnchor="end" className="hd-s">{t}</text>)}
        <Block x={L} y={ys[0]} w={x(0.42) - L} h={bh} kind="buy" anim="hdBa" origin="rt" />
        <Block x={L} y={ys[1]} w={x(0.86) - L} h={bh} kind="buy" anim="hdBb" origin="rt" />
        <Block x={L} y={ys[2]} w={M - L} h={bh} kind="buy" br={false} anim="hdBc" origin="rt" />
        <Block x={M + 1} y={ys[2]} w={x(1.45) - M - 1} h={bh} kind="bad" tl={false} anim="hdBo" origin="rt" />
        <Shelf x={M - 1.5} y={34} w={3} h={150} flash="hdFlashB" />
        <Lbl x={414} y={ys[0] + bh / 2 + 4} anchor="end" cls="hd-s strong ok" anim="hdLa">✓ lands</Lbl>
        <Lbl x={414} y={ys[1] + bh / 2 + 4} anchor="end" cls="hd-s strong ok" anim="hdLb">✓ lands</Lbl>
        <Lbl x={414} y={ys[2] + bh / 2 + 4} anchor="end" cls="hd-s strong bad" anim="hdLc">✕ fails</Lbl>
      </g>
      <text x={L} y={200} className="hd-s faint">Only the size of this one buy counts, not what the buyer already holds.</text>
    </Frame>
  );
}

/** 6 · Max bought per slot: every buy in one slot (~0.4 s) adds up against one shared limit. The buy that would go
 *  over fails; the next slot starts again from zero, where it lands. */
export function SlotLimitDiagram({ limitText }: { limitText: string }) {
  const base = 150, capY = 64, w = 80, n = 74, n1 = 266;
  const lv = (f: number) => base - (base - capY) * f;
  const aT = lv(0.42), bT = lv(0.82) - 2, cT = lv(1.2) - 4;
  return (
    <Frame w={420} h={196} label={`All buys in one slot share a ${limitText} limit: A and B land, C would go over and fails, then lands in the next slot`}>
      <g className="hd-cyc">
        <Block x={n} y={aT} w={w} h={base - aT} kind="buy" tl={false} anim="hdSa" origin="up" />
        <Block x={n} y={bT} w={w} h={aT - 2 - bT} kind="held" tl={false} br={false} anim="hdSb" origin="up" />
        <Block x={n} y={cT} w={w} h={bT - 2 - cT} kind="bad" br={false} anim="hdSx" origin="up" />
        <Block x={n1} y={lv(0.38)} w={w} h={base - lv(0.38)} kind="buy" anim="hdSc" />
        <Shelf x={n} y={capY - 1.5} w={n1 + w - n + 10} h={3} flash="hdFlashS" />
        <text x={n - 8} y={(aT + base) / 2 + 4} textAnchor="end" className="hd-s strong">A</text>
        <text x={n - 8} y={(bT + aT) / 2 + 4} textAnchor="end" className="hd-s strong">B</text>
        <text x={n - 8} y={(cT + bT) / 2 + 4} textAnchor="end" className="hd-s strong bad">C</text>
        <text x={n1 - 8} y={(lv(0.38) + base) / 2 + 4} textAnchor="end" className="hd-s strong">C</text>
        <path d={`M${n + w + 18} ${lv(0.6)} H${n1 - 14}`} className="hd-arrow dashed" markerEnd="url(#hd-head)" />
        <text x={(n + w + n1) / 2 + 2} y={lv(0.6) - 8} textAnchor="middle" className="hd-s">try again</text>
        <text x={n + w / 2} y={base + 17} textAnchor="middle" className="hd-s">slot n</text>
        <text x={n1 + w / 2} y={base + 17} textAnchor="middle" className="hd-s">slot n + 1</text>
        <Lbl x={n + w / 2} y={base + 32} cls="hd-s strong bad" anim="hdLs1">✕ C fails</Lbl>
        <Lbl x={n1 + w / 2} y={base + 32} cls="hd-s strong ok" anim="hdLs2">✓ C lands</Lbl>
      </g>
      <text x={372} y={capY - 2} className="hd-t small">limit</text>
      <text x={372} y={capY + 12} className="hd-s">{limitText}</text>
      <text x={372} y={capY + 25} className="hd-s">per slot</text>
    </Frame>
  );
}

/** 7 · Nth-buy pot: buys are counted in order and every Nth one is recorded on chain as a winner. */
export function PotDiagram({ every, minText }: { every: number; minText: string }) {
  const cy = 74, s = 30, gap = 45, x0 = 30;
  const cells: { t: string; win?: boolean; dots?: boolean }[] = [
    { t: '1' }, { t: '2' }, { t: '…', dots: true }, { t: String(every - 1) }, { t: String(every), win: true },
    { t: String(every + 1) }, { t: '…', dots: true }, { t: String(2 * every - 1) }, { t: String(2 * every), win: true },
  ];
  return (
    <Frame w={420} h={176} label={`Buys are counted in order; every ${every}th counted buy is recorded on chain as a pot winner`}>
      <text x={x0 - s / 2} y={24} className="hd-t small">counted buys</text>
      <line x1={x0} x2={x0 + gap * (cells.length - 1)} y1={cy} y2={cy} className="hd-axis" />
      {cells.map((c, i) => {
        const x = x0 + gap * i;
        if (c.dots) return <text key={i} x={x} y={cy + 4} textAnchor="middle" className="hd-t">…</text>;
        const k = c.win ? s + 4 : s;
        return (
          <g key={i} className={`hd-pot ${c.win ? 'win' : ''}`}>
            <Block x={x - k / 2} y={cy - k / 2} w={k} h={k} kind={c.win ? 'amber' : 'node'} d={5} />
            <text x={x} y={cy + 4} textAnchor="middle" className="hd-t small">#{c.t}</text>
            {c.win && <text x={x} y={cy + k / 2 + 18} textAnchor="middle" className="hd-s strong hd-win">wins</text>}
          </g>
        );
      })}
      <text x={x0 - s / 2} y={146} className="hd-s">One buy per slot counts (the first). Buys under {minText} don’t count.</text>
      <text x={x0 - s / 2} y={162} className="hd-s faint">Winners are picked by order, never at random, and recorded on chain.</text>
    </Frame>
  );
}

/** Slow mode: a shared gap between curve buys. A lands, B drops in before the gap has run and bounces off, C lands
 *  the moment the gap (drawn as a filling timer) is over. */
export function CooldownDiagram({ gapText }: { gapText: string }) {
  const ty = 104, L = 30, R = 398, c = 24;
  const xa = 80, xb = 186, xc = 320;
  return (
    <Frame w={420} h={196} label={`Curve buys share one ${gapText} gap: A lands, B inside the gap fails, C after the gap lands`}>
      <g className="hd-cyc">
        <Block x={L} y={ty} w={R - L} h={10} kind="node" d={6} tl={false} br={false} />
        <rect x={xa + c} y={ty + 1} width={xc - xa - c} height={8} className="hd-timer hd-anim hd-rt" style={{ animationName: 'hdTm', animationTimingFunction: 'linear' }} />
        <Block x={xa} y={ty - c} w={c} h={c} kind="cyan" anim="hdDa" />
        <Block x={xb} y={ty - c} w={c} h={c} kind="bad" anim="hdDb" />
        <Block x={xc} y={ty - c} w={c} h={c} kind="cyan" anim="hdDc" />
        {([['Buy A', xa], ['Buy B', xb], ['Buy C', xc]] as const).map(([t, x]) => <text key={t} x={x + c / 2} y={ty - c - 22} textAnchor="middle" className="hd-t small">{t}</text>)}
        <Lbl x={xa + c / 2} y={ty + 34} cls="hd-s strong ok" anim="hdLd1">✓ lands</Lbl>
        <Lbl x={xb + c / 2} y={ty + 34} cls="hd-s strong bad" anim="hdLd2">✕ too soon</Lbl>
        <Lbl x={xc + c / 2} y={ty + 34} cls="hd-s strong ok" anim="hdLd3">✓ lands</Lbl>
        <text x={(xa + c + xc) / 2} y={ty + 56} textAnchor="middle" className="hd-s">← {gapText} gap →</text>
      </g>
      <text x={(L + R) / 2} y={184} textAnchor="middle" className="hd-s">one shared gap, every buyer together · selling is never limited</text>
    </Frame>
  );
}

/** Creator lock: the creator's slice stays locked through the curve and graduation, unlocking in one piece later. */
export function LockDiagram({ pctText, durText }: { pctText: string; durText: string }) {
  const y = 84, L = 36, R = 404, unlockX = 318;
  const stations = [
    { x: 70, label: 'launch' },
    { x: 190, label: 'graduation' },
    { x: unlockX, label: `${durText} later` },
  ];
  return (
    <Frame w={420} h={196} label={`The creator's ${pctText} is locked from launch, through graduation, and unlocks all at once about ${durText} later`}>
      <line x1={L} x2={R} y1={y} y2={y} className="hd-axis" />
      <Block x={stations[0].x} y={y - 12} w={unlockX - stations[0].x} h={24} kind="held" d={6} />
      <text x={(stations[0].x + stations[1].x) / 2} y={y + 4.5} textAnchor="middle" className="hd-s on">{pctText} locked</text>
      {stations.map((st) => (
        <g key={st.label}>
          <line x1={st.x} x2={st.x} y1={y - 22} y2={y + 18} className="hd-axis" />
          <text x={st.x} y={y + 34} textAnchor="middle" className="hd-s">{st.label}</text>
        </g>
      ))}
      <Block x={unlockX - 9} y={y - 9} w={18} h={18} kind="buy" d={5} />
      <text x={unlockX} y={y - 28} textAnchor="middle" className="hd-t small">unlocks</text>
      <text x={(L + R) / 2} y={160} textAnchor="middle" className="hd-s">one piece, on chain {'·'} the creator cannot sell it earlier</text>
    </Frame>
  );
}

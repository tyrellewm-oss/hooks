// Diagrams for the hooks page and the launch tool. Plain inline SVG themed through CSS classes (.hd-*) so both themes
// work. Every number drawn here comes from the caller (studio defaults or a token's own config), never invented.
import type { ReactNode } from 'react';

const Arrow = ({ d, cls = '' }: { d: string; cls?: string }) => <path d={d} className={`hd-arrow ${cls}`} markerEnd="url(#hd-head)" />;
const Defs = () => (
  <defs>
    <marker id="hd-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M1 1.5L8.5 5 1 8.5" className="hd-head" />
    </marker>
  </defs>
);
const Frame = ({ w, h, label, children }: { w: number; h: number; label: string; children: ReactNode }) => (
  <svg className="hd" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
    <Defs />{children}
  </svg>
);
/** a rounded node: title + optional sub line, optional tone */
function Node({ x, y, w, h, title, sub, tone = '', icon }: { x: number; y: number; w: number; h: number; title: string; sub?: string; tone?: '' | 'ok' | 'bad' | 'hook' | 'amber'; icon?: ReactNode }) {
  const cx = x + w / 2;
  const ty = sub ? y + h / 2 - 3 : y + h / 2 + 4;
  return (
    <g className={`hd-node ${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx="6" />
      {icon && <g transform={`translate(${cx - 9} ${y + 9})`} className="hd-ico">{icon}</g>}
      <text x={cx} y={icon ? y + h - (sub ? 22 : 12) : ty} textAnchor="middle" className="hd-t">{title}</text>
      {sub && <text x={cx} y={icon ? y + h - 9 : ty + 15} textAnchor="middle" className="hd-s">{sub}</text>}
    </g>
  );
}

// ---- small 18px glyphs used inside diagrams (stroke = currentColor via .hd-ico)
const gShield = <path d="M9 1.5l6.5 2.5v5c0 4-2.8 6.6-6.5 7.8C5.3 15.6 2.5 13 2.5 9V4L9 1.5z M6 9l2.2 2.2L12.2 7" />;
const gCoin = <><circle cx="9" cy="9" r="7" /><path d="M9 5v8M6.5 7h3.8a1.6 1.6 0 0 1 0 3.2H7.7a1.6 1.6 0 0 0 0 3.2h3.8" transform="translate(0 -1.2) scale(1 0.9)" /></>;
const gFlame = <path d="M9 1.5c.6 3-2.6 4.6-2.6 7.6a2.6 2.6 0 0 0 5.2 0c0-1.3-.6-2-1.1-2.7 2.2 1 3.9 3 3.9 5.4A5.4 5.4 0 0 1 3 11.8c0-4.5 4.6-6.3 6-10.3z" />;
const gLoop = <><path d="M15 8a6 6 0 0 0-11-3M3 10a6 6 0 0 0 11 3" /><path d="M4 1.5V5h3.5M14 16.5V13h-3.5" /></>;
const gSwitch = <><rect x="1.5" y="5" width="15" height="8" rx="4" /><circle cx="12.5" cy="9" r="2.2" /></>;

/** 1 · Cap per token account: buy -> hook checks the destination token account -> lands or fails. */
export function CapDiagram({ capText = 'the cap' }: { capText?: string }) {
  return (
    <Frame w={420} h={210} label="A buy passes through the transfer hook, which lets it land if the token account stays under the cap and fails it otherwise">
      <Node x={10} y={82} w={92} h={46} title="Buy" sub="SOL in" />
      <Arrow d="M104 105 H140" cls="flow" />
      <Node x={144} y={58} w={128} h={94} title="Transfer hook" sub={`balance ≤ ${capText}?`} tone="hook" icon={<g strokeWidth="1.6">{gShield}</g>} />
      <Arrow d="M274 88 C 296 88, 296 46, 314 46" cls="ok flow" />
      <Arrow d="M274 122 C 296 122, 296 164, 314 164" cls="bad" />
      <Node x={318} y={24} w={94} h={44} title="Tokens land" sub="under the cap" tone="ok" />
      <Node x={318} y={142} w={94} h={44} title="Buy fails" sub="nothing moves" tone="bad" />
      <text x={296} y={108} className="hd-s" textAnchor="middle">yes / no</text>
    </Frame>
  );
}

/** Mini gauge used in the cap card: one token account's balance against the cap line. */
export function CapGauge({ capPct = 1 }: { capPct?: number }) {
  const h = 120, top = 18, cap = top + h * 0.38;
  return (
    <Frame w={420} h={170} label={`One token account filling up to the cap of ${capPct}% of supply`}>
      {[0, 1, 2].map((i) => {
        const x = 40 + i * 120, fill = [0.55, 0.92, 1.18][i];
        const y = top + h - (h - (cap - top)) * Math.min(fill, 1);
        const over = fill > 1;
        return (
          <g key={i}>
            <rect x={x} y={top} width={64} height={h} rx="6" className="hd-well" />
            <rect x={x} y={over ? cap : y} width={64} height={top + h - (over ? cap : y)} rx="6" className={over ? 'hd-fill bad' : 'hd-fill'} />
            {over && <rect x={x} y={cap - 22} width={64} height={22} rx="4" className="hd-ghost bad" />}
            <text x={x + 32} y={top + h + 18} textAnchor="middle" className="hd-s">{['buy 1', 'buy 2', 'buy 3'][i]}</text>
            <text x={x + 32} y={top + h + 32} textAnchor="middle" className={`hd-s ${over ? 'bad' : 'ok'}`}>{over ? '✕ fails' : '✓ lands'}</text>
          </g>
        );
      })}
      <line x1={24} x2={396} y1={cap} y2={cap} className="hd-capline" />
      <text x={396} y={cap - 6} textAnchor="end" className="hd-t small">cap {capPct}%</text>
    </Frame>
  );
}

/** 2 · Anti-sniper fee: a falling step schedule from startBps to endBps over durationSlots in `periods` steps. */
export function SniperFeeDiagram({ startBps, endBps, periods, durationSlots, durationText }: { startBps: number; endBps: number; periods: number; durationSlots: number; durationText: string }) {
  const W = 420, H = 200, L = 46, R = 366, T = 18, B = 160;
  const y = (bps: number) => B - ((B - T) * bps) / startBps;
  const x = (i: number) => L + ((R - L) * i) / periods;
  const step = (startBps - endBps) / periods;
  let d = `M${L} ${y(startBps)}`;
  for (let i = 1; i <= periods; i++) d += ` H${x(i)} V${y(i === periods ? endBps : startBps - step * i)}`;
  const area = `${d} H${R} V${B} H${L} Z`;
  const pct = (b: number) => `${+(b / 100).toFixed(1)}%`;
  return (
    <Frame w={W} h={H} label={`Curve fee starts at ${pct(startBps)} and falls in ${periods} steps to ${pct(endBps)} over ${durationText}`}>
      {[0, 0.5, 1].map((f) => <line key={f} x1={L} x2={R} y1={y(startBps * f)} y2={y(startBps * f)} className="hd-grid" />)}
      <path d={area} className="hd-area amber" />
      <path d={d} className="hd-line amber" />
      <circle cx={L} cy={y(startBps)} r="4" className="hd-dot amber" />
      <circle cx={R} cy={y(endBps)} r="4" className="hd-dot amber" />
      <text x={L - 8} y={y(startBps) + 4} textAnchor="end" className="hd-s">{pct(startBps)}</text>
      <text x={L - 8} y={y(startBps / 2) + 4} textAnchor="end" className="hd-s">{pct(startBps / 2)}</text>
      <text x={L - 8} y={B + 4} textAnchor="end" className="hd-s">0%</text>
      <text x={R + 10} y={y(endBps) + 4} className="hd-t small">{pct(endBps)}</text>
      <line x1={L} x2={R} y1={B} y2={B} className="hd-axis" />
      <text x={L} y={B + 18} className="hd-s">launch</text>
      <text x={R} y={B + 18} textAnchor="middle" className="hd-s">+{durationSlots} slots · {durationText}</text>
      <text x={(L + R) / 2} y={B + 34} textAnchor="middle" className="hd-s faint">{periods} steps down</text>
    </Frame>
  );
}

/** 3 · Buyback & burn: fees -> keeper claims -> split -> buy back on the pool -> burn. */
export function FlywheelDiagram({ devPct, buybackPct }: { devPct: number; buybackPct: number }) {
  return (
    <Frame w={420} h={210} label={`Trading fees are claimed by the keeper, ${devPct}% goes to the dev wallet and ${buybackPct}% buys the token back on the pool and burns it`}>
      <Node x={8} y={84} w={84} h={46} title="Trading fees" sub="in SOL" />
      <Arrow d="M94 107 H118" cls="flow" />
      <Node x={122} y={70} w={86} h={74} title="Keeper" sub="claims fees" tone="hook" icon={<g strokeWidth="1.6">{gLoop}</g>} />
      <Arrow d="M210 92 C 230 92, 230 40, 250 40" />
      <Arrow d="M210 122 C 230 122, 230 158, 250 158" cls="ok flow" />
      <Node x={254} y={18} w={78} h={44} title={`${devPct}%`} sub="dev wallet" />
      <Node x={254} y={134} w={78} h={48} title={`${buybackPct}%`} sub="buys token" tone="ok" />
      <Arrow d="M334 158 H352" cls="ok flow" />
      <Node x={356} y={122} w={58} h={72} title="Burn" sub="supply ↓" tone="bad" icon={<g strokeWidth="1.6">{gFlame}</g>} />
    </Frame>
  );
}

/** 4 · Lift-only switch: the cap can be raised or removed, never added back or tightened. */
export function LiftDiagram() {
  const x = 150, w = 120, top = 26, h = 140, cap = top + 82;
  return (
    <Frame w={420} h={200} label="The admin switch can raise or remove the cap but can never tighten it or add it back">
      <rect x={x} y={top} width={w} height={h} rx="8" className="hd-well" />
      <rect x={x} y={cap} width={w} height={top + h - cap} rx="8" className="hd-fill soft" />
      <line x1={x - 8} x2={x + w + 8} y1={cap} y2={cap} className="hd-capline" />
      <text x={x + w / 2} y={cap + 22} textAnchor="middle" className="hd-t small">cap now</text>
      {/* allowed: up */}
      <Arrow d={`M${x + w + 30} ${cap - 6} V${top + 10}`} cls="ok" />
      <text x={x + w + 44} y={top + 26} className="hd-t ok">Raise</text>
      <text x={x + w + 44} y={top + 42} className="hd-s">allowed</text>
      <text x={x + w + 44} y={top + 66} className="hd-t ok">Remove</text>
      <text x={x + w + 44} y={top + 82} className="hd-s">allowed</text>
      {/* never: down */}
      <Arrow d={`M${x - 30} ${cap + 6} V${top + h - 10}`} cls="bad dashed" />
      <g className="hd-x" transform={`translate(${x - 38} ${cap + 40})`}><path d="M0 0l16 16M16 0L0 16" /></g>
      <text x={x - 48} y={cap + 34} textAnchor="end" className="hd-t bad">Tighten</text>
      <text x={x - 48} y={cap + 50} textAnchor="end" className="hd-s">impossible</text>
      <text x={x - 48} y={cap + 74} textAnchor="end" className="hd-t bad">Add back</text>
      <text x={x - 48} y={cap + 90} textAnchor="end" className="hd-s">impossible</text>
    </Frame>
  );
}

/** Lifecycle overview: when each hook is on, across launch -> curve -> graduation -> pool. */
export function LifecycleDiagram({ feeText, rampText }: { feeText: string; rampText: string }) {
  const L = 150, M = 520, R = 690, rows = [62, 102, 142, 182];
  const lane = (y: number, name: string, ico: ReactNode) => (
    <g key={name}>
      <g transform={`translate(10 ${y - 9})`} className="hd-ico">{ico}</g>
      <text x={36} y={y + 4} className="hd-t left">{name}</text>
      <line x1={L} x2={R} y1={y} y2={y} className="hd-track" />
    </g>
  );
  return (
    <Frame w={700} h={214} label="Timeline: the anti-sniper fee runs at the very start, the cap and the switch run during the bonding curve, and buyback and burn runs after graduation">
      {/* phase header */}
      <rect x={L} y={8} width={M - L} height={26} rx="6" className="hd-phase" />
      <rect x={M + 4} y={8} width={R - M - 4} height={26} rx="6" className="hd-phase pool" />
      <text x={(L + M) / 2} y={25} textAnchor="middle" className="hd-t small">Bonding curve</text>
      <text x={(M + R) / 2 + 2} y={25} textAnchor="middle" className="hd-t small">Pool (after graduation)</text>
      <line x1={M + 2} x2={M + 2} y1={40} y2={200} className="hd-grad" />
      <text x={M + 2} y={210} textAnchor="middle" className="hd-s">graduation</text>
      <text x={L} y={210} textAnchor="middle" className="hd-s">launch</text>
      {lane(rows[0], 'Anti-sniper fee', <g strokeWidth="1.6">{gCoin}</g>)}
      {lane(rows[1], 'Cap per account', <g strokeWidth="1.6">{gShield}</g>)}
      {lane(rows[2], 'Lift-only switch', <g strokeWidth="1.6">{gSwitch}</g>)}
      {lane(rows[3], 'Buyback & burn', <g strokeWidth="1.6">{gFlame}</g>)}
      {/* bars */}
      <rect x={L} y={rows[0] - 7} width={46} height={14} rx="7" className="hd-bar amber" />
      <text x={L + 54} y={rows[0] + 4} className="hd-s">{feeText}</text>
      <rect x={L} y={rows[1] - 7} width={M - L - 4} height={14} rx="7" className="hd-bar accent" />
      <text x={L + 10} y={rows[1] + 4} className="hd-s on">ends at graduation or after {rampText}</text>
      <rect x={L} y={rows[2] - 7} width={M - L - 4} height={14} rx="7" className="hd-bar sim" />
      <text x={L + 10} y={rows[2] + 4} className="hd-s on">can only lift the cap</text>
      <rect x={L} y={rows[3] - 7} width={M - L - 4} height={14} rx="7" className="hd-bar dotted" />
      <text x={L + 10} y={rows[3] + 4} className="hd-s">fees build up</text>
      <rect x={M + 4} y={rows[3] - 7} width={R - M - 4} height={14} rx="7" className="hd-bar green" />
      <text x={M + 14} y={rows[3] + 4} className="hd-s on">buy back + burn</text>
    </Frame>
  );
}

// The cap schedule as a step chart: cap per token account (% of supply) over time since launch, the anti-sniper fee
// window, the raised minimum cap (lift switch), and a "now" marker. The x axis is square-root scaled so a 1-minute
// first step and a 30-minute ramp both stay readable; tick labels are approximate times at ~0.4 s/slot.
import type { FeeInfo, StepJson } from '../lib/types';
import { approxDuration, pctOf } from '../lib/shared';

interface Props {
  steps: StepJson[];
  uncappedAfter: string;
  /** slots since launch now; null = no marker (schedule preview) */
  nowElapsed?: bigint | null;
  fee?: FeeInfo | null;
  raisedFloorBps?: number;
  lifted?: boolean;
  graduated?: boolean;
  height?: number;
}

const W = 640, L = 44, R = 18, T = 22, B = 36;

export function CapRamp({ steps, uncappedAfter, nowElapsed = null, fee = null, raisedFloorBps = 0, lifted = false, graduated = false, height = 230 }: Props) {
  const H = height - T - B, CW = W - L - R;
  const end = Number(uncappedAfter);
  const xMax = end * 1.2;
  const x = (slots: number) => L + Math.sqrt(Math.max(0, Math.min(slots, xMax)) / xMax) * CW;
  const topBps = Math.max(...steps.map((s) => s.maxBps), raisedFloorBps);
  const yMax = topBps * 1.32;
  const y = (bps: number) => T + H - (bps / yMax) * H;
  const off = steps.map((s) => Number(s.slotOffset));

  // step line + area
  let line = '', area = `M${x(0)},${T + H}`;
  steps.forEach((s, i) => {
    const x0 = x(off[i]), x1 = x(i + 1 < steps.length ? off[i + 1] : end), yy = y(s.maxBps);
    line += `${i === 0 ? 'M' : 'L'}${x0},${yy} L${x1},${yy} `;
    area += ` L${x0},${yy} L${x1},${yy}`;
  });
  area += ` L${x(end)},${T + H} Z`;

  // anti-sniper fee: its own vertical scale (0..start fee) inside the fee window
  let feePath = '';
  if (fee && fee.totalSlots > 0 && fee.periods > 0) {
    const fy = (pct: number) => T + H - (pct / Math.max(fee.cliffPct, 0.01)) * H * 0.92;
    const red = (fee.cliffPct - fee.endPct) / fee.periods;
    for (let k = 0; k < fee.periods; k++) {
      const pct = fee.mode.startsWith('exponential') ? fee.cliffPct * Math.pow(fee.endPct / fee.cliffPct, k / fee.periods) : fee.cliffPct - k * red;
      feePath += `${k === 0 ? 'M' : 'L'}${x(k * fee.periodSlots)},${fy(pct)} L${x((k + 1) * fee.periodSlots)},${fy(pct)} `;
    }
  }

  const ticks = [...new Set([...off, end])];
  const yTicks = [...new Set(steps.map((s) => s.maxBps))];
  const now = nowElapsed === null ? null : Number(nowElapsed);
  const nowX = now === null ? null : x(now);
  const past = now !== null && now > xMax;
  const ended = graduated || lifted;
  const label = `Cap schedule: ${steps.map((s) => `${pctOf(s.maxBps)} from ${approxDuration(s.slotOffset)}`).join(', ')}, no cap after ${approxDuration(end)}.`;

  return (
    <svg className="ramp" viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={label}>
      <title>{label}</title>
      {/* grid */}
      {yTicks.map((b) => (
        <g key={b}>
          <line x1={L} x2={W - R} y1={y(b)} y2={y(b)} stroke="var(--border)" strokeDasharray="2 4" />
          <text x={L - 8} y={y(b) + 3.5} textAnchor="end" className="lbl">{pctOf(b)}</text>
        </g>
      ))}
      <line x1={L} x2={W - R} y1={T + H} y2={T + H} stroke="var(--border-strong)" />

      {/* fee window */}
      {fee && fee.totalSlots > 0 && (
        <g>
          <rect x={x(0)} y={T} width={x(fee.totalSlots) - x(0)} height={H} fill="var(--amber-soft)" />
          <path d={feePath} fill="none" stroke="var(--amber)" strokeWidth="1.25" strokeDasharray="3 2" />
          <text x={x(0) + 6} y={T + 12} className="fee-lbl">fee {fee.cliffPct}%→{fee.endPct}%</text>
        </g>
      )}

      {/* cap */}
      <path d={area} fill="var(--accent-soft)" opacity={ended ? 0.4 : 1} />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.25" opacity={ended ? 0.45 : 1} />
      <line x1={x(end)} x2={x(end)} y1={y(steps[steps.length - 1].maxBps)} y2={T - 6} stroke="var(--text-3)" strokeDasharray="2 3" />
      <line x1={x(end)} x2={W - R} y1={T - 6} y2={T - 6} stroke="var(--text-3)" strokeDasharray="2 3" />
      <text x={W - R} y={T - 10} textAnchor="end">no cap</text>

      {raisedFloorBps > 0 && (
        <g>
          <line x1={L} x2={x(end)} y1={y(raisedFloorBps)} y2={y(raisedFloorBps)} stroke="var(--green)" strokeDasharray="5 3" />
          <text x={x(end) - 4} y={y(raisedFloorBps) - 5} textAnchor="end" fill="var(--green)" style={{ fill: 'var(--green)' }}>raised minimum cap {pctOf(raisedFloorBps)}</text>
        </g>
      )}

      {/* x ticks */}
      {ticks.map((s, i) => (
        <g key={s}>
          <line x1={x(s)} x2={x(s)} y1={T + H} y2={T + H + 4} stroke="var(--border-strong)" />
          <text x={x(s)} y={T + H + 16} textAnchor={i === 0 ? 'start' : 'middle'}>{s === 0 ? 'launch' : approxDuration(s)}</text>
        </g>
      ))}
      <text x={L} y={height - 4}>time since launch (approx., ~0.4 s/slot, not to scale)</text>

      {/* now */}
      {nowX !== null && (
        <g>
          <line x1={nowX} x2={nowX} y1={T - 2} y2={T + H} stroke="var(--text)" strokeWidth="1.25" />
          <circle cx={nowX} cy={T + H} r="3.5" fill="var(--text)" />
          <text x={nowX + (past ? -6 : 6)} y={T + H - 8} textAnchor={past ? 'end' : 'start'} className="now-lbl">
            {graduated ? 'graduated' : lifted ? 'now (cap lifted)' : past ? 'now →' : 'now'}
          </text>
        </g>
      )}
    </svg>
  );
}

// Cap schedules used by scripts and the page. Options: research/cap_schedule_options.md.
// King approved Balanced (Oct 4, 2026, 04:16 ICT); it is the DEVNET default, labelled
// "approved by King (Oct 4, 2026)". Strict/Loose stay selectable, labelled not approved. The LOCAL demo
// schedule stays separate (fast, release limits), and the LOCAL-only test-slots schedule lives in
// tests/test_slots.test.ts (needs the test-slots build).
import type { Step } from './capMath.js';

export interface NamedSchedule { id: string; name: string; label: string; steps: Step[]; uncappedAfter: bigint }
const st = (pairs: [number, number][]): Step[] => pairs.map(([o, b]) => ({ slotOffset: BigInt(o), maxBps: b }));

export const STRICT: NamedSchedule = { id: 'strict', name: 'Strict', label: 'not approved (King chose Balanced)', steps: st([[0, 50], [150, 100], [750, 200], [2250, 400]]), uncappedAfter: 9000n };
export const BALANCED: NamedSchedule = { id: 'balanced', name: 'Balanced', label: 'approved by King (Oct 4, 2026)', steps: st([[0, 100], [150, 200], [1500, 400]]), uncappedAfter: 4500n };
export const LOOSE: NamedSchedule = { id: 'loose', name: 'Loose', label: 'not approved (King chose Balanced)', steps: st([[0, 200], [150, 500]]), uncappedAfter: 1500n };
export const LOCAL_DEMO: NamedSchedule = { id: 'demo', name: 'Current test (demo)', label: 'LOCAL demo schedule (~2 min ramp), not production', steps: st([[0, 100], [150, 200]]), uncappedAfter: 300n };

export const SCHEDULE_BY_ID: Record<string, NamedSchedule> = { strict: STRICT, balanced: BALANCED, loose: LOOSE, demo: LOCAL_DEMO };
/** Default per cluster: DEVNET -> Balanced ("approved by King (Oct 4, 2026)"); LOCAL -> fast demo schedule. */
export const defaultSchedule = (cluster: 'local' | 'devnet'): NamedSchedule => (cluster === 'devnet' ? BALANCED : LOCAL_DEMO);
export const scheduleJson = (s: NamedSchedule) => ({ id: s.id, name: s.name, label: s.label, steps: s.steps.map(x => ({ slotOffset: x.slotOffset.toString(), maxBps: x.maxBps })), uncappedAfter: s.uncappedAfter.toString() });

export const SCHEDULE_IDS = Object.keys(SCHEDULE_BY_ID) as readonly string[]; // strict|balanced|loose|demo
export class UnknownScheduleError extends Error {
  constructor(public readonly given: string) { super(`unknown schedule "${given}"; valid names: ${SCHEDULE_IDS.join('|')}`); this.name = 'UnknownScheduleError'; }
}
/** Resolve a schedule name (QA L-16). undefined/omitted -> the cluster default; a known id -> that schedule
 *  (case-insensitive); anything else (typo, empty value) -> throws UnknownScheduleError. Never falls back silently. */
export function resolveSchedule(name: string | undefined | null, cluster: 'local' | 'devnet'): NamedSchedule {
  if (name === undefined || name === null) return defaultSchedule(cluster);
  const id = String(name).trim().toLowerCase();
  if (Object.hasOwn(SCHEDULE_BY_ID, id)) return SCHEDULE_BY_ID[id];
  throw new UnknownScheduleError(String(name));
}
/** CLI helper: value of `--schedule` (undefined if the flag is absent; '' if the flag has no value). */
export function scheduleFlag(argv: string[]): string | undefined {
  const i = argv.indexOf('--schedule'); if (i < 0) return undefined;
  const v = argv[i + 1]; return v === undefined || v.startsWith('--') ? '' : v;
}

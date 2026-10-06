// Keeper monitoring (go-live G7, detection half): pure health rules over the keeper's public log shape
// (app/flywheel_public.ts). Who receives alerts and who may pause is King's decision; this module only says
// whether a keeper looks healthy and why not. Used by scripts/keeper_watch.ts. No chain or network access.

export interface HealthInput {
  name: string;
  mint: string;
  state: string;
  paused: boolean;
  pauseReason: string;
  /** newest first, like PublicKeeper.runs */
  runs: { runId: string; startedAt: string; status: string; reason: string }[];
}

export interface HealthOpts {
  /** a keeper whose newest run is older than this is stale */
  maxAgeMin: number;
  /** this many failed runs in a row (newest backwards) is an alert */
  maxConsecutiveFailures: number;
  /** an unbroken streak of warm-up holds (hold_*) older than this is an alert; holds are not failures before that */
  maxHoldMin: number;
}
export const DEFAULT_HEALTH: HealthOpts = { maxAgeMin: 20, maxConsecutiveFailures: 3, maxHoldMin: 60 };

export interface KeeperHealth {
  name: string;
  mint: string;
  healthy: boolean;
  /** empty when healthy; each entry is one human-readable problem */
  problems: string[];
  lastRunAt: string | null;
  minutesSinceLastRun: number | null;
  consecutiveFailures: number;
  paused: boolean;
}

/** A run counts as failed when its status says so ('failed_price', 'failed_swap', ...). 'logged' is a success;
 *  an unknown status is treated as failed, so a new failure mode can never read as healthy. */
export const runFailed = (status: string) => !RUN_OK.has(status) && !runHolding(status);
/** Run statuses that mean the keeper is working as designed (sdk/flywheel/keeper.ts): it did its work (`logged`),
 *  had nothing to do (`noop`, `noop_window_done`), is waiting for the main token to graduate
 *  (`waiting_for_graduation`), or stopped itself mid-run (`paused_midrun`, reported through the paused flag). */
export const RUN_OK: ReadonlySet<string> = new Set(['logged', 'noop', 'noop_window_done', 'waiting_for_graduation', 'paused_midrun']);
/** A warm-up hold (ticket #5, `hold_*`): the price window is refilling. Not a failure, but a long streak is a problem. */
export const runHolding = (status: string) => status.startsWith('hold_');

export function keeperHealth(k: HealthInput, nowMs: number, opts: HealthOpts = DEFAULT_HEALTH): KeeperHealth {
  if (!(opts.maxAgeMin > 0) || !(opts.maxConsecutiveFailures > 0) || !(opts.maxHoldMin > 0)) throw new Error('health thresholds must be > 0');
  const problems: string[] = [];

  if (k.paused) problems.push(`paused${k.pauseReason ? `: ${k.pauseReason}` : ''}`);

  const newest = k.runs[0];
  let lastRunAt: string | null = null;
  let ageMin: number | null = null;
  if (!newest) {
    problems.push('no runs recorded');
  } else {
    lastRunAt = newest.startedAt || null;
    const t = Date.parse(newest.startedAt);
    if (!Number.isFinite(t)) {
      problems.push(`newest run has no readable start time (run ${newest.runId || '?'})`);
    } else {
      ageMin = Math.trunc((nowMs - t) / 60_000);
      if (ageMin > opts.maxAgeMin) problems.push(`stale: newest run started ${ageMin} min ago (limit ${opts.maxAgeMin} min)`);
    }
  }

  // a warm-up hold streak (newest backwards) is fine until it has lasted longer than maxHoldMin
  let holds = 0;
  for (const r of k.runs) { if (runHolding(r.status)) holds++; else break; }
  if (holds > 0) {
    const oldest = k.runs[holds - 1];
    const t0 = Date.parse(oldest.startedAt);
    const heldMin = Number.isFinite(t0) ? Math.trunc((nowMs - t0) / 60_000) : null;
    if (heldMin !== null && heldMin > opts.maxHoldMin) problems.push(`holding: ${holds} warm-up hold run${holds > 1 ? 's' : ''} in a row for ${heldMin} min (limit ${opts.maxHoldMin} min; newest: ${k.runs[0].status}${k.runs[0].reason ? ` - ${k.runs[0].reason}` : ''})`);
  }

  let fails = 0;
  for (const r of k.runs) { if (runFailed(r.status)) fails++; else break; }
  if (fails >= opts.maxConsecutiveFailures) {
    const newestReason = k.runs[0]?.reason ? ` (newest: ${k.runs[0].status}${k.runs[0].reason ? ` - ${k.runs[0].reason}` : ''})` : ` (newest: ${k.runs[0]?.status})`;
    problems.push(`${fails} failed runs in a row${newestReason}`);
  }

  return { name: k.name, mint: k.mint, healthy: problems.length === 0, problems, lastRunAt, minutesSinceLastRun: ageMin, consecutiveFailures: fails, paused: k.paused };
}

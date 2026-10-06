// Keeper watcher (go-live G7, detection half): reads the keeper's PUBLIC logs (flywheel/<cluster>-*.json, registry
// mints only, same loader as the transparency page) and reports each keeper's health (sdk/keeper_health.ts).
// Read-only: no chain access, no keys, nothing sent anywhere unless KEEPER_ALERT_WEBHOOK is set.
//
//   node --import tsx scripts/keeper_watch.ts --cluster devnet              one check; exit 1 if anything is unhealthy
//   node --import tsx scripts/keeper_watch.ts --cluster devnet --loop 60    repeat every 60 s (exit stays 0; alerts print)
//   --max-age-min 20   newest run older than this = stale      --max-fails 3   failed runs in a row = alert
//
// Alerts: every problem prints to stdout (any supervisor, cron or systemd can act on the exit code). If the env var
// KEEPER_ALERT_WEBHOOK holds an https URL, each unhealthy check POSTs {cluster, at, alerts} there as JSON. Who gets
// the alerts and who may pause the keeper stays King's decision (G7); this script only detects and reports.
import { loadPublicKeepers } from '../app/flywheel_public.js';
import { keeperHealth, DEFAULT_HEALTH, type KeeperHealth } from '../sdk/keeper_health.js';
import { loadRegistry } from '../sdk/registry.js';
import type { ClusterName } from '../sdk/cluster.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const cluster = (arg('cluster') ?? 'devnet') as ClusterName;
if (cluster !== 'devnet' && cluster !== 'local') { console.error('cluster must be devnet or local'); process.exit(2); }
const opts = { maxAgeMin: Number(arg('max-age-min') ?? DEFAULT_HEALTH.maxAgeMin), maxConsecutiveFailures: Number(arg('max-fails') ?? DEFAULT_HEALTH.maxConsecutiveFailures) };
const loopArg = process.argv.indexOf('--loop');
const everySec = loopArg >= 0 ? Number(process.argv[loopArg + 1] ?? 60) || 60 : null;

function check(): { healths: KeeperHealth[]; alerts: string[] } {
  const registered = loadRegistry(cluster);
  const { keepers, skipped } = loadPublicKeepers(cluster, registered);
  const alerts: string[] = [];
  const healths = keepers.map((k) => keeperHealth(k, Date.now(), opts));
  for (const f of skipped) alerts.push(`log file ${f} does not parse`);
  if (keepers.length === 0) alerts.push(`no keeper logs for registry mints on ${cluster} (flywheel/${cluster}-*.json)`);
  for (const h of healths) for (const p of h.problems) alerts.push(`${h.name} (${h.mint.slice(0, 6)}…): ${p}`);
  return { healths, alerts };
}

async function post(alerts: string[]) {
  const url = process.env.KEEPER_ALERT_WEBHOOK;
  if (!url || !url.startsWith('https://')) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cluster, at: new Date().toISOString(), alerts }) });
  } catch (e: any) { console.error(`webhook failed: ${e.message}`); }
}

async function once(): Promise<boolean> {
  const { healths, alerts } = check();
  const at = new Date().toISOString();
  for (const h of healths) {
    const age = h.minutesSinceLastRun === null ? 'no readable run time' : `last run ${h.minutesSinceLastRun} min ago`;
    console.log(`${h.healthy ? 'OK   ' : 'ALERT'} ${h.name} ${age}${h.consecutiveFailures ? ` · ${h.consecutiveFailures} failed in a row` : ''}${h.paused ? ' · paused' : ''}`);
  }
  for (const a of alerts) console.log(`ALERT ${at} ${a}`);
  if (alerts.length) await post(alerts);
  return alerts.length === 0;
}

if (everySec === null) {
  once().then((ok) => process.exit(ok ? 0 : 1));
} else {
  console.log(`watching ${cluster} keeper logs every ${everySec}s (stale > ${opts.maxAgeMin} min, ${opts.maxConsecutiveFailures}+ fails in a row)`);
  const tick = () => { once().catch((e) => console.error(`check failed: ${e.message}`)); };
  tick();
  setInterval(tick, everySec * 1000);
}

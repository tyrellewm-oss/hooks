// §12a key separation (spec v1.2; four roles since 8.3): fee claimer, hook upgrade authority, hook lift (admin) authority
// and hook launch authority must be four different keys, and no key the keeper holds may be any of the three hook keys.
// Off devnet/local these are hard refusals; on devnet/local they are visible warnings (accepted throwaway exception, FW-25).
// Pure functions: no network calls, so the refusals run before any connection or tx exists (FW-22..FW-24).
export type AnyClusterName = 'local' | 'devnet' | 'mainnet' | (string & {});
export class KeyRuleRefusal extends Error { constructor(msg: string) { super(msg); this.name = 'KeyRuleRefusal'; } }
// Warn-only on devnet/local. Launchpad passes the genesis class from classifyCluster (via the hook gate), so a Cluster's
// name never decides; the keeper's name is checked against its genesis class at start. Anything else refuses.
const isTestCluster = (c: AnyClusterName) => c === 'devnet' || c === 'local';
const short = (k: string) => `${k.slice(0, 4)}…`;

/** `launchAuthority` (8.3): the launch key in Global bytes 42..74; null or missing = unknown (not migrated), which
 *  refuses off devnet/local like an unknown upgrade or lift key. */
export interface Authorities { upgradeAuthority: string | null; liftAuthority: string | null; launchAuthority?: string | null }
/** §12a: the hook upgrade, lift and launch authorities must be different keys (devnet: one throwaway holds upgrade + lift). */
function sameAuthorityProblem(auth: Authorities): string[] {
  const p: string[] = [];
  if (auth.upgradeAuthority && auth.liftAuthority && auth.upgradeAuthority === auth.liftAuthority) p.push(`hook upgrade authority and lift authority are the same key ${short(auth.upgradeAuthority)}`);
  if (auth.launchAuthority && auth.launchAuthority === auth.upgradeAuthority) p.push(`hook launch authority and upgrade authority are the same key ${short(auth.launchAuthority)}`);
  if (auth.launchAuthority && auth.launchAuthority === auth.liftAuthority) p.push(`hook launch authority and lift authority are the same key ${short(auth.launchAuthority)}`);
  return p;
}
/** Off devnet/local an unknown launch key is a problem (so it refuses); listed with the others so every break is named. */
const unknownLaunchProblem = (cluster: AnyClusterName, auth: Authorities) => (!isTestCluster(cluster) && !auth.launchAuthority ? [`hook launch authority unknown on ${cluster} (Global not migrated?)`] : []);

/** FW-22 / FW-23: keeper start. Throws KeyRuleRefusal off devnet/local; returns warnings on devnet/local. */
export function keeperStartChecks(cluster: AnyClusterName, keeperKeys: Record<string, string>, auth: Authorities, opts: { forceFailSwap?: boolean } = {}): string[] {
  const problems: string[] = [];
  if (opts.forceFailSwap && !isTestCluster(cluster)) throw new KeyRuleRefusal(`refusing to start: force_fail_swap is devnet-only (cluster=${cluster})`);
  if (!isTestCluster(cluster) && (!auth.upgradeAuthority || !auth.liftAuthority)) throw new KeyRuleRefusal(`refusing to start: upgrade/lift authority unknown on ${cluster}`);
  problems.push(...unknownLaunchProblem(cluster, auth), ...sameAuthorityProblem(auth));
  for (const [role, k] of Object.entries(keeperKeys)) {
    if (auth.upgradeAuthority && k === auth.upgradeAuthority) problems.push(`keeper key '${role}' ${short(k)} is the hook upgrade authority`);
    if (auth.liftAuthority && k === auth.liftAuthority) problems.push(`keeper key '${role}' ${short(k)} is the hook lift authority`);
    if (auth.launchAuthority && k === auth.launchAuthority) problems.push(`keeper key '${role}' ${short(k)} is the hook launch authority`);
  }
  if (problems.length && !isTestCluster(cluster)) throw new KeyRuleRefusal(`refusing to start (three-key rule §12a): ${problems.join('; ')}`);
  return problems.map(p => `WARNING three-key rule (accepted throwaway exception on ${cluster}): ${p}`);
}

/** FW-24: launch-config build. Throws KeyRuleRefusal off devnet/local before any tx is built; warnings on devnet/local. */
export function launchConfigChecks(cluster: AnyClusterName, feeClaimer: string, auth: Authorities): string[] {
  const problems: string[] = [];
  if (!isTestCluster(cluster) && (!auth.upgradeAuthority || !auth.liftAuthority)) throw new KeyRuleRefusal(`refusing to build config: upgrade/lift authority unknown on ${cluster}`);
  problems.push(...unknownLaunchProblem(cluster, auth), ...sameAuthorityProblem(auth));
  if (auth.upgradeAuthority && feeClaimer === auth.upgradeAuthority) problems.push(`feeClaimer ${short(feeClaimer)} is the hook upgrade authority`);
  if (auth.liftAuthority && feeClaimer === auth.liftAuthority) problems.push(`feeClaimer ${short(feeClaimer)} is the hook lift authority`);
  if (auth.launchAuthority && feeClaimer === auth.launchAuthority) problems.push(`feeClaimer ${short(feeClaimer)} is the hook launch authority`);
  if (problems.length && !isTestCluster(cluster)) throw new KeyRuleRefusal(`refusing to build config (three-key rule §12a): ${problems.join('; ')}`);
  return problems.map(p => `WARNING three-key rule (accepted throwaway exception on ${cluster}): ${p}`);
}

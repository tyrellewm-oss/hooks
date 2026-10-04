// §12a three-key separation (spec v1.2): fee claimer, hook upgrade authority and hook lift authority must be three
// different keys, and no key the keeper holds may be the upgrade or lift authority.
// Off devnet/local these are hard refusals; on devnet/local they are visible warnings (accepted throwaway exception, FW-25).
// Pure functions: no network calls, so the refusals run before any connection or tx exists (FW-22..FW-24).
export type AnyClusterName = 'local' | 'devnet' | 'mainnet' | (string & {});
export class KeyRuleRefusal extends Error { constructor(msg: string) { super(msg); this.name = 'KeyRuleRefusal'; } }
const isTestCluster = (c: AnyClusterName) => c === 'devnet' || c === 'local';
const short = (k: string) => `${k.slice(0, 4)}…`;

export interface Authorities { upgradeAuthority: string | null; liftAuthority: string | null }
/** §12a: the hook upgrade authority and the lift authority must be different keys (devnet: one throwaway holds both). */
function sameAuthorityProblem(auth: Authorities): string[] {
  return auth.upgradeAuthority && auth.liftAuthority && auth.upgradeAuthority === auth.liftAuthority
    ? [`hook upgrade authority and lift authority are the same key ${short(auth.upgradeAuthority)}`] : [];
}

/** FW-22 / FW-23: keeper start. Throws KeyRuleRefusal off devnet/local; returns warnings on devnet/local. */
export function keeperStartChecks(cluster: AnyClusterName, keeperKeys: Record<string, string>, auth: Authorities, opts: { forceFailSwap?: boolean } = {}): string[] {
  const problems: string[] = [];
  if (opts.forceFailSwap && !isTestCluster(cluster)) throw new KeyRuleRefusal(`refusing to start: force_fail_swap is devnet-only (cluster=${cluster})`);
  if (!isTestCluster(cluster) && (!auth.upgradeAuthority || !auth.liftAuthority)) throw new KeyRuleRefusal(`refusing to start: upgrade/lift authority unknown on ${cluster}`);
  problems.push(...sameAuthorityProblem(auth));
  for (const [role, k] of Object.entries(keeperKeys)) {
    if (auth.upgradeAuthority && k === auth.upgradeAuthority) problems.push(`keeper key '${role}' ${short(k)} is the hook upgrade authority`);
    if (auth.liftAuthority && k === auth.liftAuthority) problems.push(`keeper key '${role}' ${short(k)} is the hook lift authority`);
  }
  if (problems.length && !isTestCluster(cluster)) throw new KeyRuleRefusal(`refusing to start (three-key rule §12a): ${problems.join('; ')}`);
  return problems.map(p => `WARNING three-key rule (accepted throwaway exception on ${cluster}): ${p}`);
}

/** FW-24: launch-config build. Throws KeyRuleRefusal off devnet/local before any tx is built; warnings on devnet/local. */
export function launchConfigChecks(cluster: AnyClusterName, feeClaimer: string, auth: Authorities): string[] {
  const problems: string[] = [];
  if (!isTestCluster(cluster) && (!auth.upgradeAuthority || !auth.liftAuthority)) throw new KeyRuleRefusal(`refusing to build config: upgrade/lift authority unknown on ${cluster}`);
  problems.push(...sameAuthorityProblem(auth));
  if (auth.upgradeAuthority && feeClaimer === auth.upgradeAuthority) problems.push(`feeClaimer ${short(feeClaimer)} is the hook upgrade authority`);
  if (auth.liftAuthority && feeClaimer === auth.liftAuthority) problems.push(`feeClaimer ${short(feeClaimer)} is the hook lift authority`);
  if (problems.length && !isTestCluster(cluster)) throw new KeyRuleRefusal(`refusing to build config (three-key rule §12a): ${problems.join('; ')}`);
  return problems.map(p => `WARNING three-key rule (accepted throwaway exception on ${cluster}): ${p}`);
}

// Pure placeholder fills for the page (no DOM): app.js renders with these; tests/copy_v0d.test.ts renders the
// full Research copy with them. Every value comes from META (server) or the token view (chain + launch config).
import { capRampText, approxDuration, feeVars } from './format.js';

export const tok = (base) => (Number(BigInt(base)) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
export const pctOf = (bps) => `${bps / 100}%`;
/** Fill {PLACEHOLDERS}; throw if any is left (AC-25). */
export function fill(tpl, vars) {
  const out = tpl.replace(/\{([A-Z_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const left = out.match(/\{[A-Z_]+\}/);
  if (left) throw new Error(`unfilled placeholder ${left[0]}`);
  return out;
}
/** Placeholders shared by banner/checklist/rules/footer. meta = /api/meta; view = /api/token/:mint (or null). */
export function pageVars(meta, view) {
  const st = view?.status ?? {};
  const steps = st.steps ?? [];
  const hist = view?.switchHistory ?? [];
  return {
    MULTISIG: `a throwaway ${meta.cluster === 'DEVNET' ? 'devnet' : 'local'} test key (${meta.liftAuthority})`,
    ANNOUNCE_CHANNEL: 'the switch history on this page (public channel pending King decision N3)',
    RESTRICTED_LIST: 'restricted regions (list pending)',
    REPO_COMMIT: `local repo trenches-launchpad@${meta.commit} (not yet public)`,
    PROGRAM_ID: meta.programId,
    TICKER: view?.launch ? (view.launch.symbol ?? 'TOKEN ' + view.launch.mint.slice(0, 6)) : 'TOKEN',
    CAP_START: steps.length ? pctOf(steps[0].maxBps) : 'n/a',
    CAP_END: steps.length ? pctOf(steps[steps.length - 1].maxBps) : 'n/a',
    CAP_RAMP: capRampText(st.uncappedAfter),
    SWITCH_HISTORY: hist.length ? `${hist.length} use(s), listed below` : 'none',
    ...feeVars(view?.feeConfig ?? null),
    COMPAT_LINK: 'compatibility list pending',
    REPORT_CONTACT: 'the studio bug contact (pending, via NEO)',
  };
}
/** Extra fills for the "Why did my trade fail" explainer. r = trade result, w = test wallet key. */
export function explainVars(r, view, w) {
  const st = view?.status ?? {}; const n = st.nextChange;
  return {
    WALLET_BALANCE: r.capHit ? `${tok(r.capHit.balance)} tokens (after the buy)` : `${tok(view?.balances?.[w] ?? 0)} tokens`,
    WALLET_CAP: r.capHit ? `${tok(r.capHit.cap)} tokens` : 'n/a',
    NEXT_CAP: n ? (n.bps === null ? 'no cap' : pctOf(n.bps)) : 'no cap',
    NEXT_CAP_TIME: n ? `slot ${n.slot} (${approxDuration(BigInt(n.slot) - BigInt(st.slot))} from now, approx.)` : 'now',
    RAW_ERROR: r.hookError || r.err || 'unknown', TX_LINK: r.link || 'n/a',
  };
}

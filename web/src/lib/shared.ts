// One source of truth: the new UI uses the SAME pure modules as the old page and the tests.
// - cap math: sdk/capMath.ts (parity-tested against the Rust crate, AC-2)
// - copy: research/page_content.json (Research owns it; AC-25/26/27)
// - placeholder fills, fee/format helpers, the "why did my trade fail" mapping: app/public/*.js (unit-tested)
// Nothing in here is re-implemented in web/.
export {
  validate, effectiveCap, capBpsAt, nextChange, roomUnderCap, bpsToAmount, RELEASE_LIMITS, BPS_DENOM, MAX_STEPS, FLOOR_BPS,
  type CapConfig, type Step as CapStep, type ScheduleError,
} from '../../../sdk/capMath';
export { STRICT, BALANCED, LOOSE, LOCAL_DEMO, type NamedSchedule } from '../../../sdk/schedules';
export { fill, tok, pctOf, pageVars, explainVars } from '../../../app/public/pagevars.js';
export { explainerKey, explainerTemplate, allowRetry } from '../../../app/public/explainer.js';
export { approxDuration, capRampText, supplySoldText, feeVars, bpsPct } from '../../../app/public/format.js';
import pageContent from '../../../research/page_content.json';

export interface PageContent {
  version: string;
  devnet_label: string;
  banner: string;
  checklist_title: string;
  checklist: string[];
  checklist_button: string;
  rules_and_risks: { title: string; items: string[] };
  trade_fail_explainer: Record<string, string> & { title: string };
  footer: string;
}
export const CONTENT = pageContent as unknown as PageContent;

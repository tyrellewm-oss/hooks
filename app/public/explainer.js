// "Why did my trade fail" mapping (AC-26). Pure module: no DOM, so tests/explainer.test.ts imports it in node.
// Text comes only from research/page_content.json (trade_fail_explainer); this file only picks the key.

/** trenches-hook program errors: Anchor name -> code. Codes = 6000 + enum index in
 *  programs/trenches-hook/src/errors.rs (the IDL source; `anchor idl build` is unavailable here,
 *  tests/explainer.test.ts parses errors.rs to keep this table in sync). */
export const PROGRAM_ERRORS = Object.freeze({
  WalletCapExceeded: 6000,
  ConfigFrozen: 6001,
  Unauthorized: 6002,
  InvalidCapSchedule: 6003,
  NotTransferring: 6004,
  InvalidMint: 6005,
});
const BY_CODE = Object.fromEntries(Object.entries(PROGRAM_ERRORS).map(([n, c]) => [c, n]));

/** Program error -> trade_fail_explainer key. */
export const PROGRAM_ERROR_KEY = Object.freeze({
  WalletCapExceeded: 'WalletCapExceeded',
  NotTransferring: 'HookNotSupported',
  InvalidMint: 'HookNotSupported',
  Unauthorized: 'LauncherError',     // resolved to the page_content "Unauthorized" text (same "Launcher error" text as InvalidCapSchedule)
  InvalidCapSchedule: 'LauncherError',
  ConfigFrozen: 'ConfigFrozen',
});

/** Resolve an Anchor error name or a numeric code (6001, "6001", "0x1771") to the program error name, else null. */
export function resolveProgramError(nameOrCode) {
  if (nameOrCode === null || nameOrCode === undefined || nameOrCode === '') return null;
  if (typeof nameOrCode === 'string' && Object.hasOwn(PROGRAM_ERRORS, nameOrCode)) return nameOrCode;
  const s = String(nameOrCode).trim();
  const n = /^0x[0-9a-f]+$/i.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? Number(s) : NaN;
  return Number.isFinite(n) && Object.hasOwn(BY_CODE, n) ? BY_CODE[n] : null;
}

/** Pick the explainer key for a failed trade result { hookError?, hookCode?, err? }. */
export function explainerKey(r, side) {
  const pe = resolveProgramError(r.hookError) ?? resolveProgramError(r.hookCode);
  // A cap error (or anything unrecognised) on a sell is the "sell must never be blocked" case.
  if (pe && !(side === 'sell' && pe === 'WalletCapExceeded')) return PROGRAM_ERROR_KEY[pe];
  if (side === 'sell') return 'SellFailed';
  if (/insufficient|slippage|0x1771|ExceededSlippage/i.test(r.err || '') && !pe) return 'SlippageOrBalance';
  return 'Unknown';
}

/** Text template for a key. LauncherError uses the page_content Unauthorized/InvalidCapSchedule text. */
export function explainerTemplate(t, key) {
  if (key === 'LauncherError') return t.Unauthorized ?? t.InvalidCapSchedule;
  return t[key] ?? t.Unknown;
}

/** Only these keys may show a "Try again" button. ConfigFrozen never does (the rule is fixed; retrying can't help). */
const RETRY_KEYS = new Set(['SlippageOrBalance']);
export const allowRetry = (key) => key !== 'ConfigFrozen' && RETRY_KEYS.has(key);

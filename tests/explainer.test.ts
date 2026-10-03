// AC-26: "Why did my trade fail" mapping for all six trenches-hook errors (by name and by numeric code),
// with text taken from research/page_content.json. ConfigFrozen must never render as a retry message.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROGRAM_ERRORS, resolveProgramError, explainerKey, explainerTemplate, allowRetry } from '../app/public/explainer.js';
import { ERRORS, hookCodeFromLogs, hookErrorFromLogs, DEFAULT_PROGRAM_ID } from '../sdk/hook.js';

const content = JSON.parse(readFileSync('research/page_content.json', 'utf8'));
const t = content.trade_fail_explainer;
const RETRY_RE = /try again|retry|again later/i;

test('error table matches the program enum (errors.rs = IDL source) and the SDK list', () => {
  const src = readFileSync('programs/trenches-hook/src/errors.rs', 'utf8');
  const body = src.slice(src.indexOf('pub enum HookError'));
  const names = [...body.matchAll(/^\s*([A-Z][A-Za-z]+),\s*$/gm)].map(m => m[1]);
  assert.deepEqual(names, ERRORS.slice());
  names.forEach((n, i) => assert.equal((PROGRAM_ERRORS as any)[n], 6000 + i, n));
});

const EXPECT: Record<string, { key: string; text: string }> = {
  WalletCapExceeded: { key: 'WalletCapExceeded', text: t.WalletCapExceeded },
  NotTransferring: { key: 'HookNotSupported', text: t.HookNotSupported },
  InvalidMint: { key: 'HookNotSupported', text: t.HookNotSupported },
  Unauthorized: { key: 'LauncherError', text: t.Unauthorized },
  InvalidCapSchedule: { key: 'LauncherError', text: t.InvalidCapSchedule },
  ConfigFrozen: { key: 'ConfigFrozen', text: "This token's rule is fixed and can't be tightened." },
};

for (const [name, exp] of Object.entries(EXPECT)) {
  test(`${name}: resolves by name, decimal code and hex code to the ${exp.key} text`, () => {
    const code = (PROGRAM_ERRORS as any)[name] as number;
    for (const r of [{ hookError: name }, { hookCode: code }, { hookCode: String(code) }, { hookCode: '0x' + code.toString(16) }]) {
      const key = explainerKey(r, 'buy');
      assert.equal(key, exp.key, JSON.stringify(r));
      assert.equal(explainerTemplate(t, key), exp.text, JSON.stringify(r));
    }
    assert.equal(resolveProgramError(name), name);
    assert.equal(resolveProgramError(code), name);
  });
}

test('Launcher-error text is the "Launcher error" copy; HookNotSupported copy is shared', () => {
  assert.match(explainerTemplate(t, 'LauncherError'), /^Launcher error/);
  assert.equal(t.Unauthorized, t.InvalidCapSchedule);
  assert.equal(t.NotTransferring, t.HookNotSupported); assert.equal(t.InvalidMint, t.HookNotSupported);
});

test('ConfigFrozen never renders as a retry / try-again message and gets no retry button', () => {
  for (const side of ['buy', 'sell']) for (const r of [{ hookError: 'ConfigFrozen' }, { hookCode: 6001 }, { hookCode: '0x1771' }, { hookError: 'ConfigFrozen', err: 'slippage insufficient' }]) {
    const key = explainerKey(r, side);
    assert.equal(key, 'ConfigFrozen', `${side} ${JSON.stringify(r)}`);
    assert.equal(allowRetry(key), false);
    assert.doesNotMatch(explainerTemplate(t, key), RETRY_RE);
  }
});

test('unchanged keys: SellFailed, SlippageOrBalance, Unknown; only SlippageOrBalance offers retry', () => {
  assert.equal(explainerKey({ hookError: 'WalletCapExceeded' }, 'sell'), 'SellFailed');
  assert.equal(explainerKey({ err: 'boom' }, 'sell'), 'SellFailed');
  assert.equal(explainerKey({ err: '{"InstructionError":[2,{"Custom":6000}]} slippage' }, 'buy'), 'SlippageOrBalance');
  assert.equal(explainerKey({ err: '{"InstructionError":[2,{"Custom":6000}]}' }, 'buy'), 'Unknown'); // bare Custom 6000 may be DBC's: not guessed
  assert.equal(explainerKey({ hookCode: 7000 }, 'buy'), 'Unknown');
  assert.equal(allowRetry('SlippageOrBalance'), true);
  for (const k of ['WalletCapExceeded', 'HookNotSupported', 'LauncherError', 'SellFailed', 'Unknown', 'HighEarlyFee']) assert.equal(allowRetry(k), false, k);
  for (const k of ['HighEarlyFee', 'SlippageOrBalance', 'SellFailed', 'Unknown']) assert.equal(explainerTemplate(t, k), t[k]);
});

test('hookCodeFromLogs only reads codes raised by our program', () => {
  const id = DEFAULT_PROGRAM_ID.toBase58();
  assert.equal(hookCodeFromLogs([`Program ${id} failed: custom program error: 0x1771`]), 6001);
  assert.equal(hookCodeFromLogs(['Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: 0x1770']), null);
});

test('every explainer template fills with the page placeholders (no leftovers)', () => {
  const vars: Record<string, string> = {};
  for (const p of Object.keys(content.placeholders)) vars[p.replace(/[{}]/g, '')] = 'x';
  for (const k of ['WalletCapExceeded', 'HookNotSupported', 'LauncherError', 'ConfigFrozen', 'HighEarlyFee', 'SlippageOrBalance', 'SellFailed', 'Unknown']) {
    const out = explainerTemplate(t, k).replace(/\{([A-Z_]+)\}/g, (m: string, n: string) => (n in vars ? vars[n] : m));
    assert.doesNotMatch(out, /\{[A-Z_]+\}/, k);
  }
  assert.match(t.WalletCapExceeded, /\{WALLET_BALANCE\}/); assert.match(t.WalletCapExceeded, /\{WALLET_CAP\}/);
});

// QA M-12: names AND codes are attributed only to our program, using the invoke stack.
describe('log attribution (QA M-12)', () => {
  const HOOK = DEFAULT_PROGRAM_ID.toBase58();
  const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
  const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const rec = (logs: string[], err = '{"InstructionError":[3,{"Custom":6053}]}') => ({ hookError: hookErrorFromLogs(logs), hookCode: hookCodeFromLogs(logs), err });
  const dbcUnauthorized = [`Program ${DBC} invoke [1]`, 'Program log: Instruction: ClaimTradingFee',
    'Program log: AnchorError thrown in programs/dynamic-bonding-curve/src/x.rs:10. Error Code: Unauthorized. Error Number: 6053. Error Message: Unauthorized.',
    `Program ${DBC} consumed 9000 of 200000 compute units`, `Program ${DBC} failed: custom program error: 0x17a5`];
  const nestedCapHit = [`Program ${DBC} invoke [1]`, 'Program log: Instruction: Swap2', `Program ${T22} invoke [2]`, 'Program log: Instruction: TransferChecked',
    `Program ${HOOK} invoke [3]`, 'Program log: Instruction: Execute',
    'Program log: WalletCapExceeded: token_account=T owner=W balance=11 cap=10 slot=5 next_change=None',
    'Program log: AnchorError thrown in programs/trenches-hook/src/lib.rs:185. Error Code: WalletCapExceeded. Error Number: 6000. Error Message: m.',
    `Program ${HOOK} consumed 8000 of 180000 compute units`, `Program ${HOOK} failed: custom program error: 0x1770`,
    `Program ${T22} failed: custom program error: 0x1770`, `Program ${DBC} failed: custom program error: 0x1770`];

  test('DBC Unauthorized (6053) is not our Launcher error', () => {
    const r = rec(dbcUnauthorized);
    assert.equal(r.hookError, null); assert.equal(r.hookCode, null);
    assert.equal(explainerKey(r, 'buy'), 'Unknown'); assert.equal(explainerKey(r, 'sell'), 'SellFailed');
  });
  test('DBC custom code 6000 (and a DBC-logged "WalletCapExceeded" name) is not our WalletCapExceeded', () => {
    const logs = [`Program ${DBC} invoke [1]`, 'Program log: AnchorError occurred. Error Code: WalletCapExceeded. Error Number: 6000. Error Message: x.',
      `Program ${DBC} failed: custom program error: 0x1770`];
    const r = rec(logs, '{"InstructionError":[3,{"Custom":6000}]}');
    assert.equal(r.hookError, null); assert.equal(r.hookCode, null);
    assert.notEqual(explainerKey(r, 'buy'), 'WalletCapExceeded');
  });
  test('our hook nested in DBC swap -> Token-2022 -> hook, failing WalletCapExceeded, maps to ours', () => {
    const r = rec(nestedCapHit, '{"InstructionError":[3,{"Custom":6000}]}');
    assert.equal(r.hookError, 'WalletCapExceeded'); assert.equal(r.hookCode, 6000);
    assert.equal(explainerKey(r, 'buy'), 'WalletCapExceeded');
  });
  test('our program succeeding, then DBC failing with Unauthorized: not ours', () => {
    const logs = [`Program ${DBC} invoke [1]`, `Program ${T22} invoke [2]`, `Program ${HOOK} invoke [3]`, `Program ${HOOK} success`, `Program ${T22} success`,
      'Program log: AnchorError occurred. Error Code: Unauthorized. Error Number: 6053. Error Message: x.', `Program ${DBC} failed: custom program error: 0x17a5`];
    const r = rec(logs);
    assert.equal(r.hookError, null); assert.equal(r.hookCode, null);
  });
  test('mixed log: a DBC Unauthorized tx followed by a tx where our hook fails -> only ours counts', () => {
    const r = rec([...dbcUnauthorized, ...nestedCapHit]);
    assert.equal(r.hookError, 'WalletCapExceeded'); assert.equal(r.hookCode, 6000);
    assert.equal(explainerKey(r, 'buy'), 'WalletCapExceeded');
  });
  test('our program top-level: name via "AnchorError occurred", code via failed line', () => {
    const logs = [`Program ${HOOK} invoke [1]`, 'Program log: AnchorError occurred. Error Code: NotTransferring. Error Number: 6004. Error Message: m.', `Program ${HOOK} failed: custom program error: 0x1774`];
    const r = rec(logs);
    assert.equal(r.hookError, 'NotTransferring'); assert.equal(r.hookCode, 6004);
    assert.equal(explainerKey(r, 'buy'), 'HookNotSupported');
  });
});

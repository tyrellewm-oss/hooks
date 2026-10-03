// WalletCapExceeded log parsing: current program logs token_account= + owner=; older builds logged wallet=<owner>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capHitDetails } from '../sdk/hook.js';

test('parses the current log format (token_account + owner)', () => {
  const d = capHitDetails(['Program log: WalletCapExceeded: token_account=TokAcct1 owner=Owner1 balance=11 cap=10 slot=5 next_change=None'])!;
  assert.deepEqual(d, { tokenAccount: 'TokAcct1', owner: 'Owner1', balance: 11n, cap: 10n, slot: 5n });
});
test('still parses logs from builds before the rename (wallet=<owner>)', () => {
  const d = capHitDetails(['Program log: WalletCapExceeded: wallet=Owner1 balance=11 cap=10 slot=5 next_change=None'])!;
  assert.deepEqual(d, { tokenAccount: null, owner: 'Owner1', balance: 11n, cap: 10n, slot: 5n });
});
test('program source: per-token-account wording, log label and error text', () => {
  const lib = readFileSync('programs/trenches-hook/src/lib.rs', 'utf8'); const errs = readFileSync('programs/trenches-hook/src/errors.rs', 'utf8');
  assert.match(lib, /WalletCapExceeded: token_account=\{\} owner=\{\} balance=/);
  assert.doesNotMatch(lib, /wallet=\{\}/);
  assert.match(errs, /#\[msg\("Destination token account would be over the current cap"\)\]\s*\n\s*WalletCapExceeded,/);
  // wording across the tree (cap is per token account) is checked by QA's public-main gate
});

// {CAP_RAMP} placeholder: human-readable, labelled approx (~0.4 s/slot). Research copy v0c will use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approxDuration, capRampText } from '../app/public/format.js';
import { BALANCED, STRICT, LOOSE, LOCAL_DEMO } from '../sdk/schedules.js';

const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{([A-Z_]+)\}/g, (m, k) => (k in v ? v[k] : m));

test('approxDuration uses ~0.4 s/slot and a "~" prefix', () => {
  assert.equal(approxDuration(150), '~60 s');
  assert.equal(approxDuration(300), '~2 min');
  assert.equal(approxDuration(1500), '~10 min');
  assert.equal(approxDuration(4500), '~30 min');
  assert.equal(approxDuration(9000), '~1 h');
  assert.equal(approxDuration(6_480_000), '~720 h');
});
test('capRampText per schedule is labelled approx and shows slots', () => {
  assert.equal(capRampText(BALANCED.uncappedAfter), '~30 min (approx., 4,500 slots at ~0.4 s/slot)');
  assert.equal(capRampText(STRICT.uncappedAfter.toString()), '~1 h (approx., 9,000 slots at ~0.4 s/slot)');
  assert.equal(capRampText(LOOSE.uncappedAfter), '~10 min (approx., 1,500 slots at ~0.4 s/slot)');
  assert.equal(capRampText(LOCAL_DEMO.uncappedAfter), '~2 min (approx., 300 slots at ~0.4 s/slot)');
  assert.equal(capRampText(undefined), 'n/a');
});
test('fills the v0c sentence "cap ends at graduation or at {CAP_RAMP}, whichever first" with no leftovers', () => {
  const out = fill('cap ends at graduation or at {CAP_RAMP}, whichever first', { CAP_RAMP: capRampText('4500') });
  assert.equal(out, 'cap ends at graduation or at ~30 min (approx., 4,500 slots at ~0.4 s/slot), whichever first');
  assert.doesNotMatch(out, /\{[A-Z_]+\}/);
});
test('page fills {CAP_RAMP} via capRampText (pagevars.js, used by app.js)', async () => {
  const fs = await import('node:fs');
  assert.match(fs.readFileSync('app/public/pagevars.js', 'utf8'), /CAP_RAMP: capRampText\(st\.uncappedAfter\)/);
  assert.match(fs.readFileSync('app/public/app.js', 'utf8'), /pageVars\(META, view\)/);
});

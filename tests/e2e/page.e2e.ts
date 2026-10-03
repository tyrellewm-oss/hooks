// UI check (AC-23/24/25/26/29): needs the page server running (`pnpm page`), uses system Chrome headless with a temp profile.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.PAGE_URL ?? 'http://127.0.0.1:5175';
// Screenshots go to a gitignored folder (local output, never committed).
const SHOTS = 'artifacts/screens'; mkdirSync(SHOTS, { recursive: true });
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'pw-')), { executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, viewport: { width: 1280, height: 1800 } });
const page = await ctx.newPage();
const log = (...a: any[]) => console.log('[e2e]', ...a);
await page.goto(BASE);
await page.waitForSelector('#c-go');
assert.match(await page.textContent('#top-banner') ?? '', /UNAUDITED EXPERIMENT — DEVNET/);
assert.match(await page.textContent('#badge') ?? '', /DEVNET TEST - no real value/);
await page.screenshot({ path: `${SHOTS}/home.png` });
let mint = process.env.MINT;
if (!mint) {
  await page.fill('#c-name', 'Trenches UI Test'); await page.fill('#c-sym', 'TUI');
  await page.click('#c-go');
  await page.waitForURL(/\/token\//, { timeout: 120_000 });
  mint = page.url().split('/token/')[1];
  log('created', mint);
} else await page.goto(`${BASE}/token/${mint}`);
await page.waitForSelector('#ck-btn');
const body = await page.textContent('body') ?? '';
assert.ok(!/\{[A-Z_]+\}/.test(body), 'unfilled placeholder visible');
assert.match(body, /UNAUDITED EXPERIMENT — DEVNET/); assert.match(body, /Rules and risks/);
// AC-24: 7 ticked -> disabled, 8 -> enabled
const boxes = await page.$$('.checklist input[type=checkbox]');
assert.equal(boxes.length, 8);
for (const b of boxes.slice(0, 7)) await b.check();
assert.equal(await page.isDisabled('#ck-btn'), true); assert.equal(await page.isDisabled('#t-buy'), true);
await boxes[7].check(); assert.equal(await page.isDisabled('#ck-btn'), false);
await page.click('#ck-btn');
await page.waitForFunction(() => !(document.querySelector('#t-buy') as HTMLButtonElement).disabled);
log('checklist gate OK (7 -> disabled, 8 -> enabled)');
// buy under cap (0.5% of 1e9 = 5,000,000 tokens)
await page.selectOption('#t-w', 'A'); await page.fill('#t-amt', '5000000'); await page.click('#t-buy');
await page.waitForSelector('#t-out .ok, #t-out .fail', { timeout: 60_000 });
log('buy under cap ->', await page.textContent('#t-out'));
// buy over cap (+6,000,000 -> 1.1%)
await page.fill('#t-amt', '6000000'); await page.click('#t-buy');
await page.waitForFunction(() => /Why did my trade fail/.test(document.querySelector('#t-out')?.textContent ?? ''), null, { timeout: 60_000 });
const out = await page.textContent('#t-out') ?? '';
assert.match(out, /Wallet cap/); log('cap-hit explainer ->', out.slice(0, 300));
await page.screenshot({ path: `${SHOTS}/token_cap_hit.png`, fullPage: true });
await page.fill('#t-amt', '1000000'); await page.click('#t-sell');
await page.waitForFunction(() => /OK:|Failed/.test(document.querySelector('#t-out')?.textContent ?? ''), null, { timeout: 60_000 });
log('sell ->', await page.textContent('#t-out'));
await page.screenshot({ path: `${SHOTS}/token_after_sell.png`, fullPage: true });
console.log(JSON.stringify({ mint }));
await ctx.close();

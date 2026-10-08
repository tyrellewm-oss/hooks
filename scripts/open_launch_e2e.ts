// Open-launch end to end against a running site (devnet): a throwaway test wallet plays the user. It asks the site for
// the config tx, signs it here, asks for the launch tx, signs it here, submits, then checks the token is listed and its
// page and metadata JSON load. Only signed transactions leave this machine; the wallet key stays in the key dir.
//   node --import tsx scripts/open_launch_e2e.ts --site http://127.0.0.1:5176 [--wallet buyerB] [--symbol OPENT]
import { Transaction } from '@solana/web3.js';
import { loadOrCreate } from '../sdk/keys.js';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const site = arg('--site', 'http://127.0.0.1:5176').replace(/\/+$/, '');
const wallet = loadOrCreate('devnet', arg('--wallet', 'buyerB'));
const symbol = arg('--symbol', 'OPENT');
const owner = wallet.publicKey.toBase58();

async function call(path: string, body?: unknown) {
  const r = await fetch(site + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${j.error ?? ''}`);
  return j;
}
const sign = (hex: string) => { const t = Transaction.from(Buffer.from(hex, 'hex')); t.partialSign(wallet); return t.serialize().toString('hex'); };
const t0 = Date.now(); const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const meta = await call('/api/meta');
console.log(`site ${site}: ${meta.cluster}, commit ${meta.commit}, launch mode ${meta.launch?.mode}, details ${meta.launch?.details}, listed ${meta.launches.length}`);
if (meta.launch?.mode !== 'open') throw new Error('open launch is not on at this site');

// the same body the page sends: balanced preset, one optional hook, a description
const req = {
  owner, name: `Open launch ${symbol}`, symbol,
  steps: meta.defaultSchedule.steps, uncappedAfter: meta.defaultSchedule.uncappedAfter,
  thresholdSol: 1, percentageSupplyOnMigration: 20,
  rules: { maxBuyBps: 100, maxPerSlotBps: 0, windowSlots: '150', potEvery: 0, potMinBps: 0, cooldownSlots: 0 },
};
const s1 = await call('/api/launch/config', req);
console.log(`${at()} 1/3 config tx built for ${owner.slice(0, 6)}…: config ${s1.config}, ${s1.configTx.length / 2} bytes, ticket ok`);
const s2 = await call('/api/launch/build', { ...req, configTx: sign(s1.configTx), ticket: s1.ticket });
console.log(`${at()} 2/3 config ${s2.createConfig ? 'created ' + s2.createConfig.slice(0, 10) + '…' : 'already existed'}; launch tx built: mint ${s2.mint}, ${s2.poolTx.length / 2} bytes`);
const s3 = await call('/api/launch/submit', { poolTx: sign(s2.poolTx), metadata: { description: `Open launch end-to-end test (${new Date().toISOString().slice(0, 16)}).`, website: 'https://example.com' } });
console.log(`${at()} 3/3 launched: ${s3.link} (sentHere ${s3.sentHere})${s3.detailsNote ? ' — ' + s3.detailsNote : ''}`);

const after = await call('/api/meta');
const listed = after.launches.find((l: any) => l.mint === s3.mint);
console.log(`${at()} listed: ${listed ? `yes (${listed.symbol}, ${listed.time})` : 'NO'}; total ${after.launches.length}`);
const view = await call(`/api/token/${s3.mint}`);
console.log(`${at()} token page: ${view.launch?.symbol} "${view.launch?.name}", creator ${view.pool?.creator?.slice(0, 6)}…, cap ${view.status.currentCap}, threshold ${view.fee?.migrationQuoteThresholdSol} SOL, rules maxBuy ${view.rules?.maxBuyBps} bps, details ${view.metadata ? 'yes' : 'none'}`);
const j = await call(`/api/token/${s3.mint}/metadata.json`);
console.log(`${at()} metadata.json: ${JSON.stringify(j).slice(0, 200)}`);
if (!listed || view.launch?.symbol !== symbol || view.pool?.creator !== owner) process.exit(1);
console.log('OPEN LAUNCH E2E OK');

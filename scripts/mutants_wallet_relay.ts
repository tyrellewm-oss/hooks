// Mutation check for AC-21 browser-wallet signing (sdk/wallet_tx.ts: curve and post-graduation pool paths, the relay,
// the registry gate and the server route). LOCAL, offline.
// Each mutant replaces one exact snippet in one source file, runs the wallet/registry tests and must make at least one
// test fail ("killed"). The file is restored after every mutant (also on error or Ctrl-C); a dirty tree at the end fails.
// Usage: node --import tsx scripts/mutants_wallet_relay.ts [name-filter]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TESTS = ['tests/wallet_tx.test.ts', 'tests/site_registry.test.ts'];
const W = 'sdk/wallet_tx.ts', REG = 'app/site_registry.ts', SRV = 'app/server.ts';
type Mutant = { name: string; file: string; from: string; to: string };
const M: Mutant[] = [
  // relay: only what this server issued, once, signed by the issued owner, before it expires
  { name: 'relay: a message this server never built is accepted', file: W, from: 'if (!e) throw new WalletTxRefusal(', to: 'if (false) throw new WalletTxRefusal(' },
  { name: 'relay: fee payer not checked', file: W, from: 'if (!tx.feePayer || tx.feePayer.toBase58() !== e.owner) throw', to: 'if (false) throw' },
  { name: 'relay: missing owner signature accepted', file: W, from: 'if (!sig || sig.every((b) => b === 0)) throw', to: 'if (false) throw' },
  { name: 'relay: signatures not verified', file: W, from: 'if (!tx.verifySignatures(true)) throw', to: 'if (false) throw' },
  { name: 'relay: a build can be used twice (not consumed)', file: W, from: '    this.issued.delete(h);\n    return e;', to: '    return e;' },
  { name: 'relay: builds never expire', file: W, from: 'if (v.expires <= t) this.issued.delete(k);', to: 'if (false) this.issued.delete(k);' },
  { name: 'relay: expiry one tick late (< instead of <=)', file: W, from: 'if (v.expires <= t) this.issued.delete(k);', to: 'if (v.expires < t) this.issued.delete(k);' },
  { name: 'relay: window 10x longer', file: W, from: 'export const BUILD_TTL_MS = 90_000;', to: 'export const BUILD_TTL_MS = 900_000;' },
  { name: 'relay: lookup not by the message actually signed', file: W, from: 'const h = messageHash(tx.serializeMessage());\n    const e = this.issued.get(h);', to: 'const h = [...this.issued.keys()][0] ?? \'\';\n    const e = this.issued.get(h);' },
  // pre-sign simulation: never reads as passing when it failed
  { name: 'simulate: a failed simulation reads as ok', file: W, from: 'return { ok: !r.value.err, err,', to: 'return { ok: true, err,' },
  { name: 'simulate: an RPC error reads as ok', file: W, from: "return { ok: false, err: String(e?.message ?? e).slice(0, 300)", to: "return { ok: true, err: String(e?.message ?? e).slice(0, 300)" },
  { name: 'simulate: cap hit not parsed', file: W, from: 'hookError: hookErrorFromLogs(logs, c.hookProgram), hookCode: hookCodeFromLogs(logs, c.hookProgram), capHit: capHitDetails(logs), unitsConsumed', to: 'hookError: null, hookCode: null, capHit: null, unitsConsumed' },
  { name: 'simulate: empty wallet not mapped to the balance explainer', file: W, from: "if (err === '\"AccountNotFound\"') err =", to: 'if (false) err =' },
  // build reply survives send()'s redaction
  { name: 'reply: base64 instead of hex (redaction mangles it)', file: W, from: ".toString('hex'), encoding: 'hex'", to: ".toString('base64'), encoding: 'hex'" },
  // registry gate (ticket 8.5b) on the build route
  { name: 'gate: build for a mint outside the registry', file: REG, from: "if (typeof mint !== 'string' || !reg.has(mint)) return NOT_FOUND;", to: "if (typeof mint !== 'string') return NOT_FOUND;" },
  { name: 'gate: build without a local launch record', file: REG, from: 'const rec = d.launches().find(l => l.mint === mint); if (!rec) return NOT_FOUND;', to: 'const rec = (d.launches().find(l => l.mint === mint) ?? { mint }) as R;' },
  { name: 'gate: build routed to the server-signed trade', file: REG, from: 'return isBuild ? d.build!(b, rec) : d.trade(b, rec);', to: 'return d.trade(b, rec);' },
  { name: 'gate: build accepted on GET', file: REG, from: "const isBuild = pathname === '/api/wallet/build' && method === 'POST' && !!d.build;", to: "const isBuild = pathname === '/api/wallet/build' && !!d.build;" },
  // server: the swap is built for the requesting wallet, never a server key
  { name: 'server: build for a server test wallet instead of the user', file: SRV, from: 'buildUserSwap(lp, relay, owner, ', to: 'buildUserSwap(lp, relay, wallets.A.publicKey, ' },
  { name: 'server: build also sends a server-signed swap', file: SRV, from: "  try {\n    if (venue === 'pool') {", to: "  await lp.swap(wallets.A, new PublicKey(rec.pool), b.side, tokens);\n  try {\n    if (venue === 'pool') {" },
  // after graduation: the DAMM v2 pool path
  { name: 'pool: any pair accepted (token/wSOL check removed)', file: W, from: 'if (!((a === mint && b === wsol) || (a === wsol && b === mint))) throw', to: 'if (false) throw' },
  { name: 'pool: buy and sell directions swapped', file: W, from: "const [input, output] = side === 'buy' ? [wsol, mint] : [mint, wsol];", to: "const [input, output] = side === 'sell' ? [wsol, mint] : [mint, wsol];" },
  { name: 'pool: token programs swapped', file: W, from: '(m === wsol ? TOKEN_PROGRAM_ID : TOKEN_2022)', to: '(m === wsol ? TOKEN_2022 : TOKEN_PROGRAM_ID)' },
  { name: 'pool: slippage up to 100% accepted', file: W, from: 'export const POOL_SLIPPAGE_DEFAULT_BPS = 100, POOL_SLIPPAGE_MIN_BPS = 10, POOL_SLIPPAGE_MAX_BPS = 1000;', to: 'export const POOL_SLIPPAGE_DEFAULT_BPS = 100, POOL_SLIPPAGE_MIN_BPS = 10, POOL_SLIPPAGE_MAX_BPS = 10000;' },
  { name: 'pool: zero slippage accepted', file: W, from: 'export const POOL_SLIPPAGE_DEFAULT_BPS = 100, POOL_SLIPPAGE_MIN_BPS = 10, POOL_SLIPPAGE_MAX_BPS = 1000;', to: 'export const POOL_SLIPPAGE_DEFAULT_BPS = 100, POOL_SLIPPAGE_MIN_BPS = 0, POOL_SLIPPAGE_MAX_BPS = 1000;' },
  { name: 'pool: default slippage 10%', file: W, from: 'export const POOL_SLIPPAGE_DEFAULT_BPS = 100, POOL_SLIPPAGE_MIN_BPS = 10, POOL_SLIPPAGE_MAX_BPS = 1000;', to: 'export const POOL_SLIPPAGE_DEFAULT_BPS = 1000, POOL_SLIPPAGE_MIN_BPS = 10, POOL_SLIPPAGE_MAX_BPS = 1000;' },
  { name: 'pool: fractional bps accepted', file: W, from: 'if (!Number.isInteger(n) || n < POOL_SLIPPAGE_MIN_BPS', to: 'if (!Number.isFinite(n) || n < POOL_SLIPPAGE_MIN_BPS' },
  { name: 'pool: graduation gate removed', file: W, from: "  await assertPoolMintHook(lp as any, dbcPool, 'post', { wallet: owner.toBase58() });", to: '' },
  { name: 'pool: sell with no minimum out', file: W, from: 'minimumAmountOut: q.minimumAmountOut };', to: 'minimumAmountOut: new BN(0) };' },
  { name: 'pool: buy with no maximum in', file: W, from: 'maximumAmountIn: q.maximumAmountIn };', to: 'maximumAmountIn: new BN(2_000_000_000) };' },
  { name: 'pool: quote ignores the requested slippage', file: W, from: 'slippage: slippageBps,', to: 'slippage: 1000,' },
  { name: 'server: pool taken from the request body', file: SRV, from: 'await dammPoolOf(rec.mint), rec.mint, ', to: 'new PublicKey(b.pool), rec.mint, ' },
  { name: 'server: unknown venue treated as the curve', file: SRV, from: "if (!venue) return { code: 400, body: { error: 'venue must be curve or pool' } };", to: '' },
];

const filter = process.argv[2];
const files = new Map<string, string>();
const restoreAll = () => { for (const [f, src] of files) writeFileSync(f, src); };
process.on('SIGINT', () => { restoreAll(); process.exit(130); });
const run = () => spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=60000', ...TESTS], { encoding: 'utf8', maxBuffer: 64 << 20 });

const base = run();
if (base.status !== 0) { console.error('baseline FAILED: fix the tests first'); process.exit(1); }
let killed = 0, survived = 0, broken = 0;
for (const m of M.filter(x => !filter || x.name.includes(filter))) {
  const src = files.get(m.file) ?? readFileSync(m.file, 'utf8'); files.set(m.file, src);
  const n = src.split(m.from).length - 1;
  if (n !== 1) { console.log(`BROKEN    ${m.name} (snippet found ${n}x in ${m.file})`); broken++; continue; }
  try {
    writeFileSync(m.file, src.replace(m.from, m.to));
    const r = run();
    const fails = /^# fail (\d+)/m.exec(r.stdout)?.[1] ?? '?';
    if (r.status !== 0) { killed++; console.log(`KILLED    ${m.name} (${fails} failing)`); }
    else { survived++; console.log(`SURVIVED  ${m.name}`); }
  } finally { writeFileSync(m.file, src); }
}
restoreAll();
const changed = [...files].filter(([f, src]) => readFileSync(f, 'utf8') !== src).map(([f]) => f);
console.log(`\nmutants: ${killed} killed, ${survived} survived, ${broken} broken (of ${killed + survived + broken})`);
if (changed.length) { console.log(`NOT RESTORED: ${changed.join(', ')}`); process.exit(2); }
process.exit(survived || broken ? 1 : 0);

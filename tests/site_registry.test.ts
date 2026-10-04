// Ticket 8.5b: the site serves registry mints only (app/site_registry.ts). Each test names the acceptance criterion
// (C1..C13) it covers. The route stubs below stand in for everything that touches the chain (token view, trade, the
// /api/meta body), so a count of 0 means no RPC call, no `new PublicKey` and no swap was reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair, PublicKey } from '@solana/web3.js';
import { siteRoute, createReply, NOT_REGISTERED_NOTE } from '../app/site_registry.js';
import { loadRegistry, REGISTRY_PATH } from '../sdk/registry.js';
import { redactDeep } from '../sdk/redact.js';

const pk = () => Keypair.generate().publicKey.toBase58();
const A = pk(), B = pk(), C = pk(), D = pk();
const dir = mkdtempSync(join(tmpdir(), 'site-reg-'));
let n = 0;
const regFile = (j: unknown, raw?: string) => { const p = join(dir, `r${n++}.json`); writeFileSync(p, raw ?? JSON.stringify(j)); return p; };

/** A gated site with counting stubs. records = local launch records (launches/<cluster>/), in order. */
function site(registryPath: string, records: string[] = [A], cluster = 'devnet') {
  const t = { reads: 0, local: 0, chain: 0, listing: null as string[] | null, tokenMint: '', tradeRec: '' };
  const deps = {
    cluster, registryPath,
    load: (c: string, p?: string) => { t.reads++; return loadRegistry(c, p); },
    launches: () => { t.local++; return records.map(mint => ({ mint, pool: 'pool-' + mint.slice(0, 4) })); },
    meta: (l: { mint: string }[]) => { t.chain++; t.listing = l.map(x => x.mint); return { launches: l }; },
    token: async (mint: string) => { t.chain++; t.tokenMint = mint; new PublicKey(mint); return { mint }; },
    trade: async (_b: any, rec: { mint: string }) => { t.chain++; t.tradeRec = rec.mint; return { code: 200, body: { ok: true } }; },
  };
  const get = (path: string) => siteRoute(path, 'GET', async () => ({}), deps);
  const post = (path: string, b: unknown) => siteRoute(path, 'POST', async () => b, deps);
  const token = (m: string) => get('/api/token/' + m);
  const trade = (m: unknown) => post('/api/trade', { mint: m, wallet: 'A', side: 'buy', amount: 1 });
  return { t, deps, get, post, token, trade };
}

test('C1: one registry read per request, shared by every check in it (meta, token, trade); loadRegistry from sdk/registry.ts, no second parser', async () => {
  const s = site(regFile({ devnet: [A] }));
  for (const call of [() => s.get('/api/meta'), () => s.token(A), () => s.trade(A), () => s.token(B), () => s.trade(B)]) {
    const before = s.t.reads; await call(); assert.equal(s.t.reads - before, 1, 'exactly one read per request');
  }
  const src = readFileSync('app/site_registry.ts', 'utf8');
  assert.match(src, /import \{ loadRegistry, REGISTRY_PATH \} from '\.\.\/sdk\/registry\.js';/);
  for (const f of readdirSync('app').filter(f => f.endsWith('.ts'))) {
    const s2 = readFileSync(join('app', f), 'utf8');
    assert.doesNotMatch(s2, /JSON\.parse\([^)]*registry|readFileSync\([^)]*registry/i, `no second registry parser in app/${f}`);
  }
  assert.doesNotMatch(src, /^(let|const|var) \w+\s*(:[^=]+)?=\s*(null|undefined|new Set|loadRegistry)/m, 'no module-level registry cache');
});

test('C2: an unknown (valid but unregistered) mint is a 404 on /api/token and /api/trade, with 0 chain calls and 0 local-record lookups', async () => {
  const s = site(regFile({ devnet: [A] }), [A, B]);
  assert.deepEqual(await s.token(B), { code: 404, body: { error: 'unknown token' } });
  assert.deepEqual(await s.trade(B), { code: 404, body: { error: 'unknown token' } });
  assert.equal(s.t.chain, 0, 'no RPC call / new PublicKey / swap'); assert.equal(s.t.local, 0, 'no local-record lookup');
  assert.equal((await s.token(A))!.code, 200); assert.equal(s.t.tokenMint, A); assert.equal((await s.trade(A))!.code, 200); assert.equal(s.t.tradeRec, A);
});

test('C3: a malformed mint is a 404, not a 500: it never reaches new PublicKey (0 chain calls)', async () => {
  assert.throws(() => new PublicKey('junk'), 'new PublicKey would throw on junk (the old 500 path)');
  const s = site(regFile({ devnet: [A] }));
  for (const m of ['junk', '', '%E0%A4%A', '%', '0', 'null', 'junk/extra', '..%2F..%2Fx']) assert.equal((await s.token(m))!.code, 404, m);
  for (const m of ['junk', '', 42, null, undefined, [A], { toString: () => A }]) assert.equal((await s.trade(m))!.code, 404, String(m));
  assert.deepEqual(await s.post('/api/trade', null), { code: 404, body: { error: 'unknown token' } });
  assert.equal(s.t.chain, 0); assert.equal(s.t.local, 0);
});

test('C4: exact match: case variants, whitespace, prefixes and extensions are 404; URL input is decoded once', async () => {
  const s = site(regFile({ devnet: [A] }));
  const variants = [A.toLowerCase(), A.toUpperCase(), ' ' + A, A + ' ', '\t' + A, A + '\n', A.slice(0, -1), A.slice(1), A + 'x', A + A];
  for (const v of variants) {
    if (v === A) continue;
    assert.equal((await s.token(encodeURIComponent(v)))!.code, 404, `token ${JSON.stringify(v)}`);
    assert.equal((await s.trade(v))!.code, 404, `trade ${JSON.stringify(v)}`);
  }
  assert.equal((await s.token('%20' + A))!.code, 404, 'encoded leading space');
  assert.equal((await s.token(encodeURIComponent(encodeURIComponent(' ') + A)))!.code, 404, 'double-encoded: decoded once only');
  assert.equal((await s.token('%' + A.charCodeAt(0).toString(16) + A.slice(1)))!.code, 200, 'a percent-encoded character decodes once to the exact mint');
  assert.equal((await s.token('%25' + A.charCodeAt(0).toString(16) + A.slice(1)))!.code, 404, 'an encoded percent sign is decoded once only (never a second decode into the mint)');
  assert.equal(s.t.chain, 1, 'only the exact mint reached the chain');
  // a local record whose mint differs from the registered one (case, whitespace, prefix, extension) is still not served
  const lookalikes = site(regFile({ devnet: [A] }), [A, ...variants]);
  for (const v of variants) {
    assert.equal((await lookalikes.token(encodeURIComponent(v)))!.code, 404, `token with a local record ${JSON.stringify(v)}`);
    assert.equal((await lookalikes.trade(v))!.code, 404, `trade with a local record ${JSON.stringify(v)}`);
  }
  assert.equal(lookalikes.t.chain, 0, 'no lookalike reached the chain');
  // registry entries are not normalised either: a padded or truncated entry is refused by the loader (503), never trimmed into a match
  for (const e of [' ' + A, A + ' ', A.slice(0, -2)]) assert.equal((await site(regFile({ devnet: [e] })).token(A))!.code, 503, JSON.stringify(e));
});

test('C5: listing = registry ∩ local launch records, in record order', async () => {
  const s = site(regFile({ devnet: [D, A, pk()] }), [B, A, C, D]);   // B, C: local only; the third registry mint has no record
  const r = await s.get('/api/meta');
  assert.equal(r!.code, 200); assert.deepEqual(s.t.listing, [A, D], 'record order, registry ∩ records');
  const none = site(regFile({ devnet: [] }), [A, B]); await none.get('/api/meta'); assert.deepEqual(none.t.listing, []);
  const noRec = site(regFile({ devnet: [A, B] }), []); await noRec.get('/api/meta'); assert.deepEqual(noRec.t.listing, []);
});

test('C6: an unreadable registry is a 503 on the listing, /api/token and /api/trade (whole response, never launches: []); the body is redacted like every send() body', async () => {
  const home = '/' + 'home' + '/' + 'Jane Name' + '/launchpad/keeper/registry.json';   // a path under a home directory (missing)
  const d = join(dir, 'a-dir'); mkdirSync(d);
  const bad = [home, regFile(null, '{not json'), d, regFile({ local: [] }), regFile({ devnet: [A, 7] }), regFile({ devnet: ['junk'] })];
  for (const p of bad) {
    const s = site(p);
    for (const r of [await s.get('/api/meta'), await s.token(A), await s.trade(A)]) {
      assert.equal(r!.code, 503, p); assert.match((r!.body as any).error, /^mint registry unavailable: refusing:/);
      assert.equal((r!.body as any).launches, undefined, 'no empty listing');
    }
    assert.equal(s.t.chain, 0); assert.equal(s.t.local, 0); assert.equal(s.t.listing, null);
  }
  const r = await site(home).get('/api/meta');
  const out = JSON.stringify(redactDeep(r!.body));   // what send() writes (send deep-redacts every JSON body; checked in redact.test.ts)
  assert.doesNotMatch(out, /Jane|Name/, out); assert.match(out, /<path>/);
  assert.match(readFileSync('app/server.ts', 'utf8'), /\n    if \(routed\) return send\(res, routed\.code, routed\.body\);\n/, 'the routed reply (incl. the 503) goes through send()');
});

test('C7: delisting takes effect on the next request without a restart (listing, token and trade)', async () => {
  const p = regFile({ devnet: [A] }); const s = site(p, [A]);
  await s.get('/api/meta'); assert.deepEqual(s.t.listing, [A]); assert.equal((await s.token(A))!.code, 200); assert.equal((await s.trade(A))!.code, 200);
  writeFileSync(p, JSON.stringify({ devnet: [] }));
  await s.get('/api/meta'); assert.deepEqual(s.t.listing, []); assert.equal((await s.token(A))!.code, 404); assert.equal((await s.trade(A))!.code, 404);
  writeFileSync(p, JSON.stringify({ devnet: [A] }));
  await s.get('/api/meta'); assert.deepEqual(s.t.listing, [A]); assert.equal((await s.token(A))!.code, 200);
});

test('C8: other routes are unchanged: not gated and no registry read, even when the registry is unreadable', async () => {
  const s = site(join(dir, 'missing.json'));
  for (const [path, method] of [['/api/wallets', 'GET'], ['/', 'GET'], ['/capMath.js', 'GET'], ['/token/' + A, 'GET'], ['/app.js', 'GET'], ['/api/create', 'POST'], ['/api/trade', 'GET']] as const)
    assert.equal(await siteRoute(path, method, async () => ({}), s.deps), null, `${method} ${path}`);
  assert.equal(s.t.reads, 0); assert.equal(s.t.chain, 0);
});

test('C9: an empty cluster list fails closed: on LOCAL (committed registry, local: []) the listing is empty and token pages are 404', async () => {
  assert.deepEqual([...loadRegistry('local')], [], 'the committed local list is empty');
  const s = site(REGISTRY_PATH, [A, B], 'local');
  await s.get('/api/meta'); assert.deepEqual(s.t.listing, []);
  assert.equal((await s.token(A))!.code, 404); assert.equal((await s.trade(A))!.code, 404); assert.equal(s.t.chain, 1, 'only the (empty) listing body');
});

test('C10: /api/create keeps working and returns registered: false with the note; the new mint stays off the page until added by hand', async () => {
  const rec = { mint: C, pool: 'p', txs: { a: 'sig' } };
  assert.deepEqual(createReply(rec), { mint: C, pool: 'p', txs: { a: 'sig' }, registered: false, note: 'not registered: add to keeper/registry.json' });
  assert.equal(NOT_REGISTERED_NOTE, 'not registered: add to keeper/registry.json');
  const srv = readFileSync('app/server.ts', 'utf8');
  assert.match(srv, /return send\(res, 200, createReply\(rec\)\);/, 'the create success body goes through createReply');
  assert.match(readFileSync('app/public/app.js', 'utf8'), /if \(r\.registered === false\) \{[^\n]*esc\(r\.note\)/, 'the page shows the note instead of opening a 404 token page');
  const s = site(regFile({ devnet: [A] }), [A, C]);
  assert.equal((await s.token(C))!.code, 404); assert.equal((await s.trade(C))!.code, 404); await s.get('/api/meta'); assert.deepEqual(s.t.listing, [A]);
});

test('C11: the site never writes keeper/registry.json: no file-write API in app/, and the registry bytes are unchanged after every route', async () => {
  const files = [...readdirSync('app').filter(f => f.endsWith('.ts')).map(f => join('app', f)), ...readdirSync('app/public').filter(f => f.endsWith('.js')).map(f => join('app/public', f))];
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /writeFile|appendFile|createWriteStream|openSync|renameSync|copyFile|rmSync|unlinkSync|truncate/, `${f} writes files`);
  const p = regFile({ devnet: [A] }); const before = readFileSync(p, 'utf8'); const s = site(p, [A, C]);
  await s.get('/api/meta'); await s.token(A); await s.trade(A); await s.token(C); createReply({ mint: C });
  assert.equal(readFileSync(p, 'utf8'), before);
  const committed = readFileSync(REGISTRY_PATH, 'utf8'); createReply({ mint: C }); assert.equal(readFileSync(REGISTRY_PATH, 'utf8'), committed);
});

test('C12: a registered mint with no local launch record is a 404 on /api/token, like /api/trade, and the token view is never called', async () => {
  const s = site(regFile({ devnet: [A, B] }), [A]);   // B is registered but has no record under launches/<cluster>/
  let tokenCalls = 0; const token = s.deps.token; s.deps.token = async (m: string) => { tokenCalls++; return token(m); };
  assert.deepEqual(await s.token(B), { code: 404, body: { error: 'unknown token' } });
  assert.deepEqual(await s.trade(B), { code: 404, body: { error: 'unknown token' } });
  assert.equal(tokenCalls, 0, 'the token stub is never called'); assert.equal(s.t.chain, 0, 'no chain call');
  assert.equal((await s.token(A))!.code, 200); assert.equal(tokenCalls, 1, 'the recorded mint still reaches the token view');
});

test('C13: server.ts writes to res only through send(): outside it, `res` is only the handler parameter and the first argument of send() (no writeHead/write/end/setHeader, .pipe(res), passing or aliasing) (strict source check; the server needs a cluster and keys to start)', () => {
  const src = readFileSync('app/server.ts', 'utf8').replace(/(^|\s)\/\/[^\n]*/g, '$1');   // drop line comments
  const start = src.indexOf('const send = (res: http.ServerResponse');
  assert.ok(start > 0, 'send() is defined');
  const end = src.indexOf('; };\n', start); assert.ok(end > start, 'end of send()');
  const body = src.slice(start, end + 4);
  assert.match(body, /obj = redactDeep\(obj\);[\s\S]*res\.writeHead\(code,[\s\S]*res\.end\(/, 'send() redacts, then writes');
  const outside = src.slice(0, start) + src.slice(end + 4);
  const rest = outside.replace(/\bsend\(res, /g, 'send(').replace('http.createServer(async (req, res) => {', 'http.createServer(async (req) => {');
  const left = [...rest.matchAll(/\bres\b/g)].map(m => rest.slice(Math.max(0, m.index! - 30), m.index! + 30));
  assert.deepEqual(left, [], 'outside send(), res may only be the handler parameter and the first argument of send()');
  assert.doesNotMatch(outside, /\bres\s*\.|\bres\s*\[|\.socket\b|ServerResponse\.prototype|=\s*res\b/, 'no res.write/end/writeHead/setHeader/statusCode/... and no aliasing outside send()');
  assert.equal((outside.match(/\(req, res\) =>/g) ?? []).length, 1, 'the one request handler');
  // no second response path: exactly one send definition (any form), one createServer, and no 'request' listener
  const sendDefs = [...src.matchAll(/\bfunction\s*\*?\s*send\s*\(|\b(?:const|let|var)\s+send\b|(?<![\w$.])send\s*=(?![=>])|[{,]\s*send\s*(?=[,}=:])[^(]/g)].map(m => m[0]);
  assert.equal(sendDefs.length, 1, `exactly one send definition in server.ts: ${JSON.stringify(sendDefs)}`);
  assert.equal((src.match(/\bcreateServer\s*\(/g) ?? []).length, 1, 'exactly one createServer(');
  assert.doesNotMatch(src, /\bnew\s+(?:https?\.)?Server\s*\(/, 'no other server constructor');
  assert.doesNotMatch(src, /\.(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*['"`]request['"`]/, "no 'request' listener");
});

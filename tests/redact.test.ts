// FW-17 path redaction (sdk/redact.ts): single-component paths, spaces, quoted paths, file: URLs, Windows/UNC and ~/ paths,
// and the things that must stay readable (signatures, pubkeys, https/loopback/.invalid URLs, ratios, plain words).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { utils as anchorUtils } from '@coral-xyz/anchor';
import { redactPaths, redactingReplacer, redactedJson, redactDeep } from '../sdk/redact.js';

const same = (s: string) => assert.equal(redactPaths(s), s, `must not be redacted: ${s}`);
const to = (s: string, want: string) => assert.equal(redactPaths(s), want, `redaction of: ${s}`);

test('FW-17 gap 1: single-component absolute paths, alone or followed by a separator or punctuation', () => {
  for (const p of ['/root', '/tmp', '/home', '/opt', '/.cache', '/_x']) { to(p, '<path>'); to(`at ${p}.`, 'at <path>.'); to(`(${p})`, '(<path>)'); to(`${p}, next`, '<path>, next'); to(`${p}: denied`, '<path>: denied'); }
  to('/root/', '<path>'); to('/tmp/, then', '<path>, then'); to('mkdir /tmp/x.json; ok', 'mkdir <path>; ok');
  to('FW_PUBLIC_LOG=/tmp/fw.json', 'FW_PUBLIC_LOG=<path>'); to('EACCES /var', 'EACCES <path>');
  to('/tmp is full, retry', '<path> is full, retry');
  to('/2026/10/x.json', '<path>');
  to('EACCES:/tmp/x', 'EACCES:<path>'); to('open(/srv/a b/c):fail', 'open(<path>):fail');                                   // multi-component paths keep the old any-segment rule
});

test('FW-17 gap 2: paths with spaces, unquoted and quoted', () => {
  to('open /srv/my user/x.json failed', 'open <path> failed');
  to('/Users/my user/Library/a b c/x', '<path>');
  to('/srv/my%20user/x', '<path>');
  to("mkdir '/srv/my dir/file name.txt' failed", "mkdir '<path>' failed");
  to('at "/a b/c d" now', 'at "<path>" now');
  to('see `~/my notes/x y.txt`', 'see `<path>`');
  to("'/root'", "'<path>'");
});

test('FW-17 gap 3: file: URLs, including file:/// and percent-encoded spaces', () => {
  to('file:///srv/my%20user/x.json', '<path>'); to('url file:///tmp/a.', 'url <path>.');
  to('FILE:///C:/Users/x', '<path>'); to('file:/x', '<path>'); to('(file://host/share/a b)', '(<path> b)');
  to('"file:///srv/my user/x"', '"<path>"');
  to('see file:///tmp/a, then', 'see <path>, then');
});

test('FW-17: Windows drive and UNC paths, and ~/ home paths', () => {
  to('C:\\Users\\me\\x.json', '<path>'); to('C:\\', '<path>'); to('C:\\\\Users\\\\me', '<path>'); to('C:\\\\data\\\\me', '<path>'); to('at C:/Program Files/x/y.txt.', 'at <path>.');
  to('d:\\data', '<path>'); to('\\\\srv\\share\\a b\\c', '<path>');
  to('~/', '<path>'); to('~/.config/solana/id.json', '<path>'); to('~bob/x', '<path>'); to('cp ~/My Docs/x .', 'cp <path>');
});

test('FW-17 gap 4: signatures, pubkeys, https/loopback/.invalid URLs, ratios and plain words are NOT redacted', () => {
  const sig = anchorUtils.bytes.bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 255));
  const pk = Keypair.generate().publicKey.toBase58();
  same(sig); same(pk); same(`sig ${sig} mint ${pk}`);
  same(`https://explorer.solana.com/tx/${sig}?cluster=devnet`); same(`https://explorer.solana.com/address/${pk}?cluster=devnet`);
  same('https://api.devnet.solana.com'); same('http://127.0.0.1:8899/rpc'); same('http://localhost:8899/'); same('http://[::1]:8899/x');
  same('https://rpc.invalid/x/y'); same('http://fw.invalid:1/a/b');
  same('1/2 and 15/85 split'); same('and/or N/A'); same('a / b'); same('~5 SOL'); same('/2'); same("it's fine"); same('lamports/sig');
  same('<path>'); same('relative/dir/x.json');
  to(`EACCES /srv/fw.json see https://explorer.solana.com/tx/${sig}?cluster=devnet`, `EACCES <path> see https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  to('/tmp then b/c', '<path> then b/c');                            // a first POSIX segment never absorbs prose
  to('/tmp/a then b/c', '<path>');                                   // a later one can (up to 3 spaces, then a separator): fails safe
});

test('FW-17: evidence replacer redacts string values before JSON escaping, other values untouched', () => {
  const line = JSON.stringify({ reason: 'mkdir "/srv/my dir/x" failed', win: 'C:\\Users\\me', n: 5, ok: true, sigs: ['abc', '/tmp'], nested: { at: '~/x' } }, redactingReplacer);
  assert.deepEqual(JSON.parse(line), { reason: 'mkdir "<path>" failed', win: '<path>', n: 5, ok: true, sigs: ['abc', '<path>'], nested: { at: '<path>' } });
});

// Home roots: no part of the user name may leak. Placeholder user name; built by concatenation so no host path is a literal.
const UN = 'Jane Name';
const HOME = '/' + 'home' + '/';
const HOME_CASES = [`/Users/${UN}/x`, `${HOME}${UN}/x`, `/Users/${UN}`, `/Users/${UN} and then prose`, `/mnt/c/Users/${UN}/x`, `C:\\Users\\${UN}\\x`, `C:\\\\Users\\\\${UN}\\\\x`,
  `C:/Users/${UN}/x`, `d:\\users\\${UN}`, `/USERS/${UN}/x`, `file:///Users/${UN.replace(' ', '%20')}/x`, `file:///C:/Users/${UN.replace(' ', '%20')}/x`, `file://localhost${HOME}${UN}/x`,
  `EACCES:/Users/${UN}/x.json, retry`, `'/Users/${UN}/x'`, `"C:\\Users\\${UN}"`, `/mnt/c/Users/${UN}`, `/mnt/d/Users/${UN} and prose`, `C:\\\\Users\\\\${UN}`];
const noUser = (out: string, from: string) => { assert.doesNotMatch(out, /Jane|Name/, `user name leaked: ${JSON.stringify(from)} -> ${JSON.stringify(out)}`); };

test('FW-17 home roots: the whole user-name segment is redacted (spaces, %20, end of string, prose after it)', () => {
  for (const c of HOME_CASES) { noUser(redactPaths(c), c); noUser(redactPaths(`see ${c}`), c); assert.match(redactPaths(c), /<path>/, c); }
  to(`/Users/${UN} and then prose`, '<path>');                       // an unterminated user name swallows the rest of the line (fails safe)
  to(`a /Users/${UN}\nnext line`, 'a <path>\nnext line');           // ... but not the next line
  to(`'/Users/${UN}/x' ok`, "'<path>' ok");
  same('https://github.com/Users/x'); same('see Users/admins'); same('x/Users/y');   // not a root: relative, or inside a URL path
});

test('FW-17 home roots: inside JSON through the replacer, and in an Error message and stack', () => {
  for (const c of HOME_CASES) { const line = JSON.stringify({ reason: c, nested: [{ at: `mkdir ${c}` }] }, redactingReplacer); noUser(line, c); }
  const e = new Error(`ENOENT: open '${HOME}${UN}/fw.json' and C:\\Users\\${UN}\\x`);
  e.stack = `Error: ${e.message}\n    at f (/Users/${UN}/src/a.ts:1:2)\n    at g (file:///C:/Users/${UN.replace(' ', '%20')}/b.js:3:4)\n    at node:internal/x:5:6`;
  noUser(redactPaths(e.message), e.message); noUser(redactPaths(e.stack), e.stack);
  noUser(JSON.stringify({ error: String(e.message).slice(0, 300), stack: e.stack, cut: e.message.slice(0, 22) }, redactingReplacer), 'error/stack');
  assert.match(redactPaths(e.stack), /at node:internal\/x:5:6/);   // node: frames keep their location
});

test('FW-17 home prefixes: everything after the prefix goes, to the end of the line or a closing quote (UNC, ~, last segment, JSON-escaped slash)', () => {
  const J = '\\/';   // a JSON-escaped slash
  const cases = [`\\\\srv\\${UN}`, `\\\\srv\\share\\${UN}\\x`, `~/${UN}`, `~jane/${UN}/x`, `~/x/${UN}`, `C:\\Users\\Jane\\Name Here`, `/Users/Jane/Name Here`, `C:/Users/Jane/Name Here`,
    `${HOME}Jane/Name Here`, `/mnt/c/Users/Jane/Name Here`, `file:///Users/Jane/Name%20Here`, `file:///C:/Users/Jane/Name Here`, `${J}home${J}Jane${J}Name Here`, `${J}Users${J}${UN}`, `${J}mnt${J}c${J}Users${J}Jane${J}Name Here`];
  for (const c of cases) for (const w of [c, `x ${c} y`, `'${c}' ok`]) {
    const o = redactPaths(w); assert.doesNotMatch(o, /Jane|Name|Here/i, `leaked: ${JSON.stringify(w)} -> ${JSON.stringify(o)}`); assert.match(o, /<path>/, w);
  }
  to(`say "/Users/Jane/Name Here" ok`, 'say "<path>" ok'); to(`at C:\\Users\\Jane\\Name Here\\" ok`, 'at <path>\\" ok');   // a quote or backslash-quote ends it
  to(`/Users/Jane/x failed, retry`, '<path>');                       // prose on the same line goes too (fails safe)
  same('a\\/b'); same('x\\/home'); same('1\\/2');                     // an escaped slash alone is not a root
});

test('FW-17: redactPaths takes any value; redactDeep and redactedJson redact keys and handle Error, Map, Set, Buffer and bigint', () => {
  assert.equal(redactPaths(undefined), ''); assert.equal(redactPaths(null), ''); assert.equal(redactPaths(5), '5'); assert.equal(redactPaths(`/Users/${UN}` as unknown), '<path>');
  const e = new Error(`open ${HOME}${UN}/x`); e.stack = `Error: ${e.message}\n    at f (C:\\Users\\${UN}\\a.ts:1:2)`;
  const pk = Keypair.generate().publicKey; const buf = Buffer.from('abc');
  const d: any = redactDeep({ [`/Users/${UN}/k`]: 1, err: e, m: new Map([[`C:\\Users\\${UN}`, `~/${UN}`]]), set: new Set([`/Users/${UN}`]), buf, n: 5n, pk });
  assert.deepEqual(Object.keys(d), ['<path>', 'err', 'm', 'set', 'buf', 'n', 'pk']);
  assert.deepEqual(d.err, { name: 'Error', message: 'open <path>', stack: 'Error: open <path>\n    at f (<path>' });
  assert.deepEqual(d.m, { '<path>': '<path>' }); assert.deepEqual(d.set, ['<path>']);
  assert.equal(d.buf, buf); assert.equal(d.n, 5n); assert.equal(d.pk, pk);
  const line = redactedJson({ [`~/${UN}`]: { [`\\\\srv\\${UN}`]: e }, pk, list: [new Map([['k', `/Users/${UN}`]])] });
  noUser(line, 'keys'); assert.equal(JSON.parse(line).pk, pk.toBase58());
});

test('FW-17: evidence lines with home paths inside still parse, leak no name fragment and keep the other fields', () => {
  const vals = [...HOME_CASES, `mkdir "/Users/${UN}/x" failed`, `mkdir "C:\\Users\\${UN}\\" failed`, `C:\\Users\\${UN}\\`, `say "${HOME}${UN}" then "/Users/${UN}\\"`, `/Users/${UN}","n":9,"x":"`];
  for (const v of vals) {
    const o = { at: '2026-10-04T00:00:00.000Z', kind: 'error', error: v, n: 5, ok: true, sig: 'abc', list: [v, 'keep me'], nested: { msg: `x ${v} y`, k: 1 } };
    const line = redactedJson(o);
    let back: any; assert.doesNotThrow(() => { back = JSON.parse(line); }, `line must parse: ${line}`);
    noUser(line, v);
    assert.deepEqual({ ...back, error: undefined, list: [back.list[1]], nested: { k: back.nested.k } }, { ...o, error: undefined, list: ['keep me'], nested: { k: 1 } }, `other fields intact: ${line}`);
    assert.equal(back.error, redactPaths(v)); assert.equal(back.nested.msg, redactPaths(`x ${v} y`));
  }
});

test('FW-17: everything the previous generic pattern caught is still redacted (corpus)', () => {
  const OLD = /(?<![:\w/])\/(?:[\w.\-]+\/)+[\w.\-]+/g;
  const corpus = ['log write failed: EACCES /some/dir/fw.json', 'mkdir /srv/a/b failed', 'x ./rel/x y', '/a-b/c_d/e.f', '/2026/10/x.json', '(/opt/x/y)', "'/opt/x/y'", '"/var/lib/x"',
    'FW_PUBLIC_LOG=/var/x/fw.json', '/a/b.', '/a/.../b', '/-a/b', '/.cache/x', 'at /srv/x/y:12:3', `${HOME}u/x`, '/Users/u/x', 'C:/x/y/z', 'e.g. /usr/local/bin/node --x',
    'two /a/b and /c/d', 'tail/x/y is relative', 'https://h/a/b', '/a//b/c', '/a/b/c/'];
  let n = 0;
  for (const s of corpus) for (const m of s.match(OLD) ?? []) { n++; assert.ok(!redactPaths(s).includes(m), `old match ${JSON.stringify(m)} survives in ${JSON.stringify(redactPaths(s))}`); }
  assert.ok(n >= 20, `corpus exercises the old pattern (${n} matches)`);
});

test('FW-17: redaction stays linear on long adversarial input', () => {
  for (const s of ['/' + 'a'.repeat(20000) + '!', '/a' + ' a'.repeat(5000), '/' + 'a/'.repeat(5000) + ' ', 'C:' + '\\'.repeat(20000) + '!', '~/' + 'a.'.repeat(10000), "'/" + 'a'.repeat(20000), '/Users/' + 'a '.repeat(10000), 'C:\\Users\\' + 'x\\'.repeat(5000) + '!', 'file:///Users/' + '%20'.repeat(5000)]) {
    const t0 = Date.now(); redactPaths(s); assert.ok(Date.now() - t0 < 500, `slow on input of length ${s.length}`);
  }
});

test('FW-17 home prefixes: /root, ~user with spaces, UNC and drive roots inside JSON-escaped text', () => {
  const R = '/' + 'root' + '/';
  const vars = [`${R}${UN}`, `${R}Jane@Name/x`, `${R}Jane  Name/x`, `${R}Jane\tName/x`, `${R}Jäne Nämé/x`, ...'@+#=,~()'.split('').map(ch => `${R}Jane${ch}Name/x`),
    `~jane lee/x`, `~jane lee/${UN}/x`, `~${UN}/x`, `C:\\\\\\\\Users\\\\\\\\${UN}\\\\\\\\x`, `C:\\\\\\\\Users\\\\\\\\Jane\\\\\\\\Name Here`, `C:\\\\\\Users\\\\\\Jane\\\\\\Name Here`];
  for (const c of vars) {
    to(c, '<path>');
    for (const w of [`x ${c}`, `'${c}' ok`, `${c}\nnext`]) { const o = redactPaths(w); assert.doesNotMatch(o, /J.ne|N.m|lee/, `leaked: ${JSON.stringify(w)} -> ${JSON.stringify(o)}`); }
  }
  to(`${R}${UN}\nnext line`, '<path>\nnext line');
  // a UNC path inside a JSON-escaped string (as in the keeper's "reconciliation failed: {...}" reason): escaped double backslashes
  to('reconciliation failed: {"err":"\\\\\\\\srv\\\\Jane Name\\\\x"}', 'reconciliation failed: {"err":"<path>"}');
  to('{"a":"\\\\\\\\srv\\\\Jane Name","b":1}', '{"a":"<path>","b":1}');
  same('~5 sec / try'); same('approx ~ 3'); same('a ~ b/c'); same('backup~/x'); same('v2~jane/x');   // a tilde inside a word is not a home prefix
});

test('FW-17: every pass is global and case-insensitive where it should be (two paths in one string; FILE:)', () => {
  to('FILE:///srv/my%20user/x', '<path>'); to('see File:/srv/x.', 'see <path>.'); to(`'FILE:///x y/z' ok`, `'<path>' ok`);
  to('C:\\data\\a and D:\\b\\c', '<path> and <path>');                       // Windows rule
  to('file:///srv/a and file:///srv/b', '<path> and <path>');                // FILE_URL rule
  to(`"/srv/a b" and "/srv/c d"`, '"<path>" and "<path>"');                 // quoted pass
  to(`'D:\\a b\\c' or 'E:\\d e\\f'`, `'<path>' or '<path>'`);
  to('/opt/a and /opt/b', '<path> and <path>');                              // POSIX rule
  to(`/Users/a\n${HOME}b\n~/c\n\\\\srv\\d`, '<path>\n<path>\n<path>\n<path>');   // home prefixes, one per line
});

test('FW-17: redactDeep converts class instances, null-prototype objects and Error extras; keeps toJSON objects and byte arrays', () => {
  class Box { a = `/Users/${UN}`; [`/Users/${UN}/k`] = 1; }
  const np = Object.create(null); np.p = `~/${UN}`; np[`C:\\Users\\${UN}`] = 2;
  const cause = new Error(`inner ${HOME}${UN}/x`);
  const e: any = new Error(`outer /Users/${UN}`, { cause }); e.code = 'EACCES'; e.path = `${HOME}${UN}/x`;
  const date = new Date(0); const u8 = Uint8Array.from([1, 2]); const pk = Keypair.generate().publicKey;
  const cyc: any = { name: `/Users/${UN}` }; cyc.self = cyc;
  const d: any = redactDeep({ box: new Box(), np, e, date, u8, pk, cyc });
  assert.deepEqual(d.box, { a: '<path>', '<path>': 1 }); assert.equal(Object.getPrototypeOf(d.box), Object.prototype);
  assert.deepEqual(d.np, { p: '<path>', '<path>': 2 });
  assert.equal(d.e.message, 'outer <path>'); assert.equal(d.e.code, 'EACCES'); assert.equal(d.e.path, '<path>'); assert.equal(d.e.cause.message, 'inner <path>');
  assert.equal(d.date, date); assert.equal(d.u8, u8); assert.equal(d.pk, pk); assert.equal(d.cyc.self, '[Circular]');
  noUser(JSON.stringify(d), 'redactDeep'); noUser(redactedJson({ box: new Box(), np, e }), 'redactedJson');
  const shared = { k: `/Users/${UN}` }; assert.deepEqual(redactDeep([shared, shared]), [{ k: '<path>' }, { k: '<path>' }]);   // a repeated (not circular) reference is copied
});

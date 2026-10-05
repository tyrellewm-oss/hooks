// Studio sign-in (sdk/studio_auth.ts) with real ed25519 signatures, and the server's use of it on the studio routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { StudioAuth, StudioAuthError, parseAllowlist, verifyWalletSignature, challengeText, CHALLENGE_TTL_MS, SESSION_TTL_MS } from '../sdk/studio_auth.ts';

/** What a wallet's signMessage does: ed25519 over the exact message bytes. */
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
function walletSign(kp: Keypair, text: string): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(new TextEncoder().encode(text)), key).toString('hex');
}
const studioKp = Keypair.generate(), outsider = Keypair.generate();
const S = studioKp.publicKey.toBase58();
const mk = (now = () => Date.now(), open = false) => new StudioAuth(new Set([S]), 'DEVNET', open, now);
const code = (f: () => unknown) => { try { f(); return 0; } catch (e) { assert.ok(e instanceof StudioAuthError, String(e)); return (e as StudioAuthError).code; } };

test('allowlist: canonical wallet addresses only; a bad entry stops the server at start', () => {
  assert.deepEqual([...parseAllowlist(` ${S} ,`)], [S]);
  assert.equal(parseAllowlist(undefined).size, 0); assert.equal(parseAllowlist('').size, 0);
  assert.throws(() => parseAllowlist('not-a-wallet'), /not a wallet address/);
  assert.throws(() => parseAllowlist(`${S},abc`), /abc/);
});

test('fails closed: devnet without an allowlist refuses everything; local without one is open', () => {
  const closed = new StudioAuth(new Set(), 'DEVNET', false);
  assert.deepEqual(closed.status(), { required: true, configured: false });
  assert.equal(code(() => closed.require(undefined)), 403);
  assert.equal(code(() => closed.challenge(S)), 403);
  const local = new StudioAuth(new Set(), 'LOCAL', true);
  assert.equal(local.require(undefined), 'local-open');
  assert.equal(new StudioAuth(new Set([S]), 'LOCAL', true).open, false, 'a configured list always applies, even locally');
});

test('sign-in: challenge -> wallet signs -> session; the session unlocks studio routes', () => {
  const a = mk();
  assert.equal(code(() => a.require(undefined)), 401);
  const ch = a.challenge(S);
  assert.match(ch.message, new RegExp(`Wallet: ${S}`)); assert.match(ch.message, /not a transaction/);
  const s = a.signIn(S, ch.nonce, walletSign(studioKp, ch.message));
  assert.equal(a.require(s.token), S);
  assert.equal(a.require([s.token]), S, 'header arrays are handled');
  a.signOut(s.token); assert.equal(code(() => a.require(s.token)), 401, 'signed out');
});

test('sign-in refusals: outsider, wrong signer, wrong message, reused or expired challenge, bad hex', () => {
  const a = mk();
  assert.equal(code(() => a.challenge(outsider.publicKey.toBase58())), 403, 'not on the list');
  let ch = a.challenge(S);
  assert.equal(code(() => a.signIn(S, ch.nonce, walletSign(outsider, ch.message))), 401, 'signed by another key');
  ch = a.challenge(S);
  assert.equal(code(() => a.signIn(S, ch.nonce, walletSign(studioKp, ch.message + ' '))), 401, 'signed a different message');
  ch = a.challenge(S);
  assert.equal(code(() => a.signIn(outsider.publicKey.toBase58(), ch.nonce, walletSign(outsider, ch.message))), 401, 'claims another wallet');
  ch = a.challenge(S);
  const sig = walletSign(studioKp, ch.message);
  a.signIn(S, ch.nonce, sig);
  assert.equal(code(() => a.signIn(S, ch.nonce, sig)), 401, 'a challenge works once');
  ch = a.challenge(S);
  assert.equal(code(() => a.signIn(S, ch.nonce, 'zz')), 400);
  assert.equal(code(() => a.signIn(S, 'nope', sig)), 401);
});

test('expiry: challenge after 5 min, session after 8 h (boundaries)', () => {
  let now = 1_000_000; const a = mk(() => now);
  let ch = a.challenge(S); const sig = walletSign(studioKp, ch.message);
  now += CHALLENGE_TTL_MS; assert.equal(code(() => a.signIn(S, ch.nonce, sig)), 401, 'challenge expired at exactly 5 min');
  now = 2_000_000; ch = a.challenge(S); now += CHALLENGE_TTL_MS - 1;
  const s = a.signIn(S, ch.nonce, walletSign(studioKp, ch.message));
  now += SESSION_TTL_MS - 1; assert.equal(a.require(s.token), S, 'still valid 1 ms before');
  now += 1; assert.equal(code(() => a.require(s.token)), 401, 'expired at exactly 8 h');
});

test('signature check is real ed25519 over the exact bytes', () => {
  const t = challengeText(S, 'n', 'DEVNET', 0, 1);
  const sig = Buffer.from(walletSign(studioKp, t), 'hex');
  assert.equal(verifyWalletSignature(S, new TextEncoder().encode(t), sig), true);
  const flipped = Buffer.from(sig); flipped[10] ^= 1;
  assert.equal(verifyWalletSignature(S, new TextEncoder().encode(t), flipped), false);
  assert.equal(verifyWalletSignature(S, new TextEncoder().encode(t), sig.subarray(0, 63)), false);
  assert.equal(verifyWalletSignature('bad', new TextEncoder().encode(t), sig), false);
});

test('server: create and token-details edits check the studio session first', () => {
  const src = readFileSync('app/server.ts', 'utf8');
  const create = src.slice(src.indexOf("if (url.pathname === '/api/create' && req.method === 'POST') {"));
  assert.match(create, /^[^\n]*\{\n\s*const who = studioCheck\(req\); if \('code' in who\) return send\(res, who\.code, who\.body\);/, 'first line of /api/create');
  assert.ok(create.indexOf('studioCheck(req)') < create.indexOf('await body(req)'), 'before the body is read');
  assert.match(src, /metadata: \(mint, b\) => \{ const who = studioCheck\(req\); if \('code' in who\) return who;/, 'token-details edit');
  assert.match(src, /new StudioAuth\(parseAllowlist\(process\.env\.STUDIO_WALLETS\), c\.label, c\.name === 'local'\)/, 'open only on a local cluster');
  assert.match(src, /studio\.require\(req\.headers\['x-studio-session'\]\)/, 'session from the header, not a cookie');
});

test('a wrong or missing token is refused while a real session exists', () => {
  const a = mk();
  const ch = a.challenge(S); const s = a.signIn(S, ch.nonce, walletSign(studioKp, ch.message));
  assert.equal(a.require(s.token), S);
  assert.equal(code(() => a.require('f'.repeat(64))), 401, 'a well-formed but unknown token');
  assert.equal(code(() => a.require(undefined)), 401, 'no header');
  assert.equal(code(() => a.require(s.token.slice(0, 63) + (s.token[63] === '0' ? '1' : '0'))), 401, 'one character off');
  assert.equal(code(() => a.require(s.token.toUpperCase() === s.token ? 'x' : s.token.toUpperCase())), 401, 'case changed');
});

test('the studio wallet signing while the request claims another wallet is refused', () => {
  const a = mk();
  const ch = a.challenge(S);
  assert.equal(code(() => a.signIn(outsider.publicKey.toBase58(), ch.nonce, walletSign(studioKp, ch.message))), 401);
});

test('windows are pinned: 5 min to finish sign-in, 8 h sessions', () => {
  assert.equal(CHALLENGE_TTL_MS, 5 * 60_000);
  assert.equal(SESSION_TTL_MS, 8 * 3600_000);
});

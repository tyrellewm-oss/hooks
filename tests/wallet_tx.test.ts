// AC-21 browser-wallet signing: the relay only forwards transactions this server built (sdk/wallet_tx.ts), and the
// build route is registry-gated like /api/trade (app/site_registry.ts). No chain access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { WalletRelay, WalletTxRefusal, messageHash, BUILD_TTL_MS, simulateSwap } from '../sdk/wallet_tx.ts';
import { DEFAULT_PROGRAM_ID } from '../sdk/hook.ts';
import { siteRoute } from '../app/site_registry.ts';

const BH = '11111111111111111111111111111111';
function unsignedFor(owner: Keypair, lamports = 1000, to = Keypair.generate().publicKey) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports }));
  tx.recentBlockhash = BH; tx.feePayer = owner.publicKey;
  return tx;
}
const entry = (owner: Keypair) => ({ owner: owner.publicKey.toBase58(), mint: 'M', side: 'buy' as const, amount: '1', blockhash: BH, lastValidBlockHeight: 100 });
/** What the wallet does: sign the bytes it was given; what the server receives: the wire bytes. */
const viaWallet = (tx: Transaction, signer: Keypair) => { const t = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })); t.partialSign(signer); return Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false })); };

test('relay: a transaction built here and signed by its owner is accepted once', () => {
  const owner = Keypair.generate(); const relay = new WalletRelay();
  const tx = unsignedFor(owner); relay.issue(tx.serializeMessage(), entry(owner));
  const got = relay.take(viaWallet(tx, owner));
  assert.equal(got.owner, owner.publicKey.toBase58());
  assert.throws(() => relay.take(viaWallet(tx, owner)), WalletTxRefusal, 'one use only');
  assert.equal(relay.size, 0);
});

test('relay: anything the server did not build, or changed after building, is refused', () => {
  const owner = Keypair.generate(); const relay = new WalletRelay();
  const built = unsignedFor(owner); relay.issue(built.serializeMessage(), entry(owner));
  assert.throws(() => relay.take(viaWallet(unsignedFor(owner, 999_999), owner)), /not built by this page|changed/, 'different transfer amount');
  const extra = unsignedFor(owner); extra.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 5 }));
  assert.throws(() => relay.take(viaWallet(extra, owner)), WalletTxRefusal, 'an added instruction changes the message');
  assert.equal(relay.size, 1, 'the real build is still waiting');
});

test('relay: unsigned, wrongly signed or forged signatures are refused', () => {
  const owner = Keypair.generate(); const other = Keypair.generate(); const relay = new WalletRelay();
  const tx = unsignedFor(owner); relay.issue(tx.serializeMessage(), entry(owner));
  assert.throws(() => relay.take(Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))), /not signed/);
  const forged = viaWallet(tx, owner); forged.signatures[0].signature![0] ^= 0xff;
  assert.throws(() => relay.take(forged), /does not verify/);
  assert.throws(() => { const t = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })); t.partialSign(other); }, 'web3 itself refuses a non-required signer');
  assert.equal(relay.size, 1);
});

test('relay: a build expires after BUILD_TTL_MS', () => {
  let now = 1_000; const owner = Keypair.generate(); const relay = new WalletRelay(() => now);
  const tx = unsignedFor(owner); relay.issue(tx.serializeMessage(), entry(owner));
  now += BUILD_TTL_MS - 1; assert.equal(relay.size, 1);
  now += 1; assert.equal(relay.size, 0);
  assert.throws(() => relay.take(viaWallet(tx, owner)), /expired/);
});

test('relay: the fee payer must be the wallet the build was issued for', () => {
  const owner = Keypair.generate(); const relay = new WalletRelay();
  const tx = unsignedFor(owner);
  const other = Keypair.generate();
  relay.issue(tx.serializeMessage(), entry(other));   // issued for someone else
  assert.throws(() => relay.take(viaWallet(tx, owner)), /fee payer/);
  assert.equal(messageHash(new Uint8Array([1, 2])), messageHash(new Uint8Array([1, 2])));
});

test('build route is registry-gated like /api/trade: unknown or unrecorded mints are 404 and never reach build()', async () => {
  const A = 'So11111111111111111111111111111111111111112', B = 'Aaaa1111111111111111111111111111111111111111', C = 'Bbbb1111111111111111111111111111111111111111';
  let builds = 0;
  const deps = {
    cluster: 'devnet', load: () => new Set([A, B]),
    launches: () => [{ mint: A }],
    meta: () => ({}), token: async () => ({}), trade: async () => ({ code: 200, body: 'trade' }),
    build: async (_b: any, rec: any) => { builds++; return { code: 200, body: { built: rec.mint } }; },
  };
  const post = (mint: string) => siteRoute('/api/wallet/build', 'POST', async () => ({ mint, owner: A, side: 'buy', amount: '1' }), deps as any);
  assert.deepEqual(await post(A), { code: 200, body: { built: A } });
  assert.equal((await post(B))!.code, 404, 'registered but no launch record');
  assert.equal((await post(C))!.code, 404, 'not in the registry');
  assert.equal(builds, 1);
  assert.equal(await siteRoute('/api/wallet/build', 'GET', async () => ({}), deps as any), null, 'POST only');
  const { build: _omit, ...noBuild } = deps;
  assert.equal(await siteRoute('/api/wallet/build', 'POST', async () => ({ mint: A }), noBuild as any), null, 'no build dep -> route not handled');
  const unreadable = { ...deps, load: () => { throw new Error('boom'); } };
  assert.equal((await siteRoute('/api/wallet/build', 'POST', async () => ({ mint: A }), unreadable as any))!.code, 503);
});

test('server: the browser-wallet path never signs with a server key and replies only through send()', () => {
  const src = readFileSync('app/server.ts', 'utf8');
  const build = src.slice(src.indexOf('async function build('), src.indexOf('async function body('));
  assert.ok(build.length > 0);
  assert.doesNotMatch(build, /\bwallets\b|deployer|launchKey|\.sign\(|partialSign|sendTx\(|\.swap\(|sendRaw/, 'build() touches no server key and sends nothing');
  assert.match(build, /buildUserSwap\(lp, relay, owner, /, 'the swap is built for the requesting wallet');
  assert.match(src, /if \(url\.pathname === '\/api\/wallet\/submit' && req\.method === 'POST'\) \{[\s\S]*?return send\(res, 200, await submitSigned\(c, relay, /, 'submit replies through send()');
  const wt = readFileSync('sdk/wallet_tx.ts', 'utf8');
  assert.doesNotMatch(wt, /Keypair|\.sign\(|partialSign|loadOrCreate/, 'sdk/wallet_tx.ts never holds or uses a keypair');
});

test('build replies survive the server redaction unchanged (FW-17 send() redacts every JSON string)', async () => {
  const { redactDeep } = await import('../sdk/redact.ts');
  const { randomBytes } = await import('node:crypto');
  for (let i = 0; i < 500; i++) {
    const hex = randomBytes(1232).toString('hex');   // max legacy tx size
    const body = { tx: hex, encoding: 'hex', owner: Keypair.generate().publicKey.toBase58(), side: 'buy', amount: '1', lastValidBlockHeight: 1, expiresInMs: 1, simulation: { ok: true, err: null, hookError: null, hookCode: null, capHit: null, unitsConsumed: 1 } };
    assert.deepEqual(redactDeep(body), body, 'redaction left the build reply intact');
  }
  // the reason for hex: base64 does get mangled
  let mangled = 0; for (let i = 0; i < 200; i++) { const b = randomBytes(900).toString('base64'); if (redactDeep({ tx: b }).tx !== b) mangled++; }
  assert.ok(mangled > 0, 'base64 is not redaction-proof (keep the hex encoding)');
  const src = readFileSync('sdk/wallet_tx.ts', 'utf8');
  assert.match(src, /\.toString\('hex'\), encoding: 'hex'/, 'the build reply is hex');
});

test('the build window is 90 s: a blockhash lives about that long, so a longer window would relay dead transactions', () => {
  assert.equal(BUILD_TTL_MS, 90_000);
});

test('pre-sign simulation: a cap hit is reported with its name and details; an empty wallet reads as a balance problem', async () => {
  const ours = DEFAULT_PROGRAM_ID.toBase58();
  const owner = Keypair.generate(); const tx = unsignedFor(owner);
  const stub = (value: any) => ({ hookProgram: DEFAULT_PROGRAM_ID, connection: { simulateTransaction: async () => ({ value }) } as any });
  const ok = await simulateSwap(stub({ err: null, logs: [], unitsConsumed: 1234 }), tx);
  assert.deepEqual([ok.ok, ok.err, ok.hookError, ok.unitsConsumed], [true, null, null, 1234]);
  const capLogs = [`Program ${ours} invoke [2]`, 'Program log: WalletCapExceeded: token_account=A owner=B balance=11 cap=10 slot=5 next_change=None',
    'Program log: AnchorError thrown in programs/trenches-hook/src/lib.rs:190. Error Code: WalletCapExceeded. Error Number: 6000. Error Message: x.', `Program ${ours} failed: custom program error: 0x1770`];
  const cap = await simulateSwap(stub({ err: { InstructionError: [2, { Custom: 6000 }] }, logs: capLogs }), tx);
  assert.equal(cap.ok, false); assert.equal(cap.hookError, 'WalletCapExceeded'); assert.equal(String(cap.capHit?.cap), '10');
  const empty = await simulateSwap(stub({ err: 'AccountNotFound', logs: [] }), tx);
  assert.equal(empty.ok, false); assert.match(empty.err!, /insufficient funds/, 'the explainer keys SlippageOrBalance on "insufficient"');
  const boom = await simulateSwap({ hookProgram: DEFAULT_PROGRAM_ID, connection: { simulateTransaction: async () => { throw new Error('rpc down'); } } as any }, tx);
  assert.equal(boom.ok, false, 'an RPC failure never reads as a passing simulation');
});

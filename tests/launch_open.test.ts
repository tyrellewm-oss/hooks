// Open launch (sdk/launch_open.ts), found-on-chain launches (sdk/chain_launches.ts), stateless studio sessions and the
// Blob details store: offline, with real keypairs and real signatures. The devnet run is scripts/open_launch_e2e.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, type VersionedTransactionResponse } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { checkOpenConfigTx, checkOpenPoolTx, checkTicket, issueTicket, optsDigest, sendAndConfirm, derivedKey, OpenLaunchRefusal, DBC_CREATE_CONFIG_HOOK_DISC } from '../sdk/launch_open.ts';
import { launchFromTx, ChainLaunches } from '../sdk/chain_launches.ts';
import { DBC_INIT_POOL_T22_HOOK_DISC } from '../sdk/mint_hook.ts';
import { DBC_PROGRAM_ID } from '../sdk/hook.ts';
import { StudioAuth, challengeText } from '../sdk/studio_auth.ts';
import { BlobDetailsStore } from '../sdk/details_store.ts';
import type { LaunchOpts } from '../sdk/launch.ts';

const BH = '11111111111111111111111111111111';
const HOOK = Keypair.generate().publicKey;
const kp = () => Keypair.generate();
const wire = (t: Transaction) => Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
const opts = (o: Partial<LaunchOpts> = {}): LaunchOpts => ({ name: 'Open T', symbol: 'OPENT', steps: [{ slotOffset: 0n, maxBps: 100 }, { slotOffset: 150n, maxBps: 300 }], uncappedAfter: 900n, migrationQuoteThresholdSol: 1, percentageSupplyOnMigration: 20, ...o });

/** A config tx shaped like DBC create_config_with_transfer_hook: config 0, fee claimer 1, leftover 2, quote 3, hook 4, payer 5. */
function configTx(owner: PublicKey, config: Keypair, partner: PublicKey, o: { quote?: PublicKey; hook?: PublicKey; leftover?: PublicKey; extra?: TransactionInstruction } = {}) {
  const ix = new TransactionInstruction({ programId: DBC_PROGRAM_ID, data: Buffer.concat([DBC_CREATE_CONFIG_HOOK_DISC, Buffer.alloc(40)]), keys: [
    { pubkey: config.publicKey, isSigner: true, isWritable: true }, { pubkey: partner, isSigner: false, isWritable: false }, { pubkey: o.leftover ?? partner, isSigner: false, isWritable: false },
    { pubkey: o.quote ?? NATIVE_MINT, isSigner: false, isWritable: false }, { pubkey: o.hook ?? HOOK, isSigner: false, isWritable: false }, { pubkey: owner, isSigner: true, isWritable: true },
  ] });
  const t = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix);
  if (o.extra) t.add(o.extra);
  t.feePayer = owner; t.recentBlockhash = BH;
  return t;
}
/** A launch tx shaped like DBC create pool (config 0, pool authority 1, creator 2, base mint 3) + the hook config ix. */
function poolTx(owner: PublicKey, mint: Keypair, launch: PublicKey, config: PublicKey, o: { creator?: PublicKey; extra?: TransactionInstruction } = {}) {
  const dbc = new TransactionInstruction({ programId: DBC_PROGRAM_ID, data: Buffer.concat([DBC_INIT_POOL_T22_HOOK_DISC, Buffer.alloc(20)]), keys: [
    { pubkey: config, isSigner: false, isWritable: false }, { pubkey: kp().publicKey, isSigner: false, isWritable: false },
    { pubkey: o.creator ?? owner, isSigner: false, isWritable: false }, { pubkey: mint.publicKey, isSigner: true, isWritable: true },
  ] });
  const hook = new TransactionInstruction({ programId: HOOK, data: Buffer.alloc(8), keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: launch, isSigner: true, isWritable: false }] });
  const t = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), dbc, hook);
  if (o.extra) t.add(o.extra);
  t.feePayer = owner; t.recentBlockhash = BH;
  return t;
}

test('ticket: binds wallet, config, options and expiry; only the key that issued it verifies it', () => {
  const key = derivedKey(kp(), 'open-launch-ticket-v1'), other = derivedKey(kp(), 'open-launch-ticket-v1');
  const now = 1_800_000_000_000, d = optsDigest(opts());
  const t = issueTicket(key, 'W', 'C', d, now + 75_000);
  assert.doesNotThrow(() => checkTicket(key, t, 'W', 'C', d, now));
  for (const [what, f] of [
    ['another server', () => checkTicket(other, t, 'W', 'C', d, now)],
    ['another wallet', () => checkTicket(key, t, 'X', 'C', d, now)],
    ['another config', () => checkTicket(key, t, 'W', 'X', d, now)],
    ['changed options', () => checkTicket(key, t, 'W', 'C', optsDigest(opts({ migrationQuoteThresholdSol: 2 })), now)],
    ['expired', () => checkTicket(key, t, 'W', 'C', d, now + 75_000)],
    ['malformed', () => checkTicket(key, 'x.' + t, 'W', 'C', d, now)],
    ['missing', () => checkTicket(key, undefined, 'W', 'C', d, now)],
    ['a later expiry with the old MAC', () => checkTicket(key, t.replace(/^\d+/, String(now + 999_999)), 'W', 'C', d, now)],
  ] as const) assert.throws(f as () => void, OpenLaunchRefusal, what);
  assert.notDeepEqual(derivedKey(kp(), 'studio-session-v1'), key, 'one key per purpose');
});

test('optsDigest: every option that reaches the chain changes it; the URI (named after the mint, made in step 2) does not', () => {
  const base = optsDigest(opts());
  for (const o of [{ name: 'Open U' }, { symbol: 'OPENU' }, { steps: [{ slotOffset: 0n, maxBps: 100 }] }, { uncappedAfter: 901n }, { migrationQuoteThresholdSol: 1.5 }, { percentageSupplyOnMigration: 21 }, { creatorLockPct: 5, creatorLockSlots: 1000 },
    { rules: { maxBuyTokens: 1n, maxPerSlotTokens: 0n, windowSlots: 150n, potEvery: 0, potMinTokens: 0n, cooldownSlots: 0n } }] as Partial<LaunchOpts>[])
    assert.notEqual(optsDigest(opts(o)), base, JSON.stringify(Object.keys(o)));
  assert.equal(optsDigest(opts({ uri: 'https://x.example/api/m/abc' })), base);
});

test('config step check: one DBC create_config_with_transfer_hook for this partner, SOL quote, our hook, paid and signed by the wallet and its config key', () => {
  const owner = kp(), config = kp(), partner = kp().publicKey;
  const k = { owner: owner.publicKey, partner, dbc: DBC_PROGRAM_ID, hook: HOOK };
  const signed = (t: Transaction) => { t.partialSign(config); const w = wire(t); w.partialSign(owner); return w; };
  assert.equal(checkOpenConfigTx(signed(configTx(owner.publicKey, config, partner)), k).toBase58(), config.publicKey.toBase58());
  const bad: [string, Transaction, RegExp][] = [
    ['wallet signature missing', (() => { const t = configTx(owner.publicKey, config, partner); t.partialSign(config); return wire(t); })(), /missing a signature/],
    ['another fee claimer', signed(configTx(owner.publicKey, config, kp().publicKey)), /fee claimer/],
    ['another leftover receiver', signed(configTx(owner.publicKey, config, partner, { leftover: kp().publicKey })), /fee claimer/],
    ['not SOL-quoted', signed(configTx(owner.publicKey, config, partner, { quote: kp().publicKey })), /SOL-quoted/],
    ['another hook', signed(configTx(owner.publicKey, config, partner, { hook: kp().publicKey })), /SOL-quoted config for this transfer hook/],
    ['an extra program', signed(configTx(owner.publicKey, config, partner, { extra: SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: partner, lamports: 1 }) })), /program this site doesn't use/],
  ];
  for (const [what, t, re] of bad) assert.throws(() => checkOpenConfigTx(t, k), (e: any) => e instanceof OpenLaunchRefusal && re.test(e.message), what);
  const tampered = signed(configTx(owner.publicKey, config, partner));
  tampered.signatures[1].signature = Buffer.from(tampered.signatures[1].signature!.map((b, i) => (i === 5 ? b ^ 1 : b)));
  assert.throws(() => checkOpenConfigTx(tampered, k), /does not verify/);
  assert.throws(() => checkOpenConfigTx(signed(configTx(owner.publicKey, config, partner)), { ...k, owner: kp().publicKey }), /not paid by the launching wallet/);
});

test('launch step check: the launch key co-signed these exact bytes; every signature valid; the creator is the fee payer', () => {
  const owner = kp(), mint = kp(), launch = kp(), config = kp().publicKey;
  const k = { launchAuthority: launch.publicKey, dbc: DBC_PROGRAM_ID, hook: HOOK };
  const signed = (t: Transaction, ...cos: Keypair[]) => { t.partialSign(...cos); const w = wire(t); w.partialSign(owner); return w; };
  const ok = checkOpenPoolTx(signed(poolTx(owner.publicKey, mint, launch.publicKey, config), mint, launch), k);
  assert.equal(ok.mint.toBase58(), mint.publicKey.toBase58());
  assert.equal(ok.config.toBase58(), config.toBase58());
  assert.equal(ok.pool.toBase58(), deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config).toBase58());
  const impostor = kp();   // signed by some other "launch key": the hook ix names it, so the tx verifies, but it isn't ours
  assert.throws(() => checkOpenPoolTx(signed(poolTx(owner.publicKey, mint, impostor.publicKey, config), mint, impostor), k), /co-signed by this site's launch key/);
  assert.throws(() => checkOpenPoolTx(wire(((t) => { t.partialSign(mint, launch); return t; })(poolTx(owner.publicKey, mint, launch.publicKey, config))), k), /missing a signature/);
  assert.throws(() => checkOpenPoolTx(signed(poolTx(owner.publicKey, mint, launch.publicKey, config, { creator: kp().publicKey }), mint, launch), k), /creator is not the wallet/);
  assert.throws(() => checkOpenPoolTx(signed(poolTx(owner.publicKey, mint, launch.publicKey, config, { extra: SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: launch.publicKey, lamports: 1 }) }), mint, launch), k), /program this site doesn't use/);
  // the wallet re-signing a changed message breaks the launch key's signature
  const t = poolTx(owner.publicKey, mint, launch.publicKey, config); t.partialSign(mint, launch);
  const changed = wire(t); changed.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }); changed.partialSign(owner);
  assert.throws(() => checkOpenPoolTx(changed, k), /does not verify|missing a signature/);
});

/** A fake RPC for sendAndConfirm. */
function rpc(o: { sendErr?: string; statuses?: (any | null)[]; valid?: boolean[] }) {
  let si = 0, vi = 0; const sends: boolean[] = [];
  return { sends, conn: {
    async sendRawTransaction(_raw: any, opt: any) { sends.push(!!opt?.skipPreflight); if (o.sendErr && !opt?.skipPreflight) throw new Error(o.sendErr); return 'sig'; },
    async getSignatureStatuses() { return { value: [o.statuses?.[Math.min(si++, (o.statuses?.length ?? 1) - 1)] ?? null] }; },
    async isBlockhashValid() { return { value: o.valid?.[Math.min(vi++, (o.valid?.length ?? 1) - 1)] ?? true }; },
  } as any };
}
const signedTx = () => { const p = kp(); const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: p.publicKey, toPubkey: kp().publicKey, lamports: 1 })); t.feePayer = p.publicKey; t.recentBlockhash = BH; t.sign(p); return t; };

test('send and confirm: polls to confirmed; a retried send of a landed tx confirms with sentHere false; refusals say why', async () => {
  const t = signedTx();
  const a = rpc({ statuses: [null, { confirmationStatus: 'confirmed', err: null }] });
  const r = await sendAndConfirm(a.conn, t, 'launch', Date.now() + 10_000);
  assert.equal(r.sentHere, true); assert.equal(a.sends[0], false, 'first send runs preflight');
  const again = await sendAndConfirm(rpc({ sendErr: 'Transaction simulation failed: This transaction has already been processed', statuses: [{ confirmationStatus: 'finalized', err: null }] }).conn, t, 'launch', Date.now() + 10_000);
  assert.equal(again.sentHere, false);
  await assert.rejects(sendAndConfirm(rpc({ sendErr: 'Attempt to debit an account but found no record of a prior credit.' }).conn, t, 'launch', Date.now() + 10_000), /not enough devnet SOL/);
  await assert.rejects(sendAndConfirm(rpc({ sendErr: 'Blockhash not found' }).conn, t, 'launch', Date.now() + 10_000), /expired before it was sent/);
  await assert.rejects(sendAndConfirm(rpc({ statuses: [{ confirmationStatus: 'confirmed', err: { InstructionError: [1, { Custom: 6000 }] } }] }).conn, t, 'launch', Date.now() + 10_000), /failed on chain/);
  await assert.rejects(sendAndConfirm(rpc({ statuses: [null], valid: [false] }).conn, t, 'launch', Date.now() + 10_000), /expired before it confirmed/);
});

/** A confirmed-tx response with a DBC create pool (name/symbol/uri borsh strings), as getTransaction returns it. */
function launchResponse(o: { mint: PublicKey; config: PublicKey; creator: PublicKey; name: string; symbol: string; uri: string; err?: unknown; blockTime?: number; disc?: Buffer }): VersionedTransactionResponse {
  const s = (v: string) => { const b = Buffer.from(v, 'utf8'); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const ix = new TransactionInstruction({ programId: DBC_PROGRAM_ID, data: Buffer.concat([o.disc ?? DBC_INIT_POOL_T22_HOOK_DISC, s(o.name), s(o.symbol), s(o.uri)]), keys: [
    { pubkey: o.config, isSigner: false, isWritable: false }, { pubkey: kp().publicKey, isSigner: false, isWritable: false },
    { pubkey: o.creator, isSigner: true, isWritable: true }, { pubkey: o.mint, isSigner: true, isWritable: true },
  ] });
  const t = new Transaction().add(ix); t.feePayer = o.creator; t.recentBlockhash = BH;
  return { slot: 1, blockTime: o.blockTime ?? 1_791_400_000, meta: { err: o.err ?? null, loadedAddresses: { writable: [], readonly: [] } } as any, transaction: new VersionedTransaction(t.compileMessage()) as any } as any;
}

test('chain launches: a launch tx parses to its mint, pool, config, creator, name, symbol and URI; failed or other txs are skipped', () => {
  const mint = kp().publicKey, config = kp().publicKey, creator = kp().publicKey;
  const l = launchFromTx(launchResponse({ mint, config, creator, name: 'Ünïcode name', symbol: 'OPENT', uri: 'https://hookd.example/api/m/x' }), 'SIG')!;
  assert.deepEqual({ ...l }, { mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, config).toBase58(), config: config.toBase58(), creator: creator.toBase58(), name: 'Ünïcode name', symbol: 'OPENT', uri: 'https://hookd.example/api/m/x', time: new Date(1_791_400_000_000).toISOString(), sig: 'SIG' });
  assert.equal(launchFromTx(launchResponse({ mint, config, creator, name: 'x', symbol: 'X', uri: '', err: { InstructionError: [0, 'Custom'] } }), 'S'), null, 'a failed tx');
  assert.equal(launchFromTx(launchResponse({ mint, config, creator, name: 'x', symbol: 'X', uri: '', disc: Buffer.alloc(8) }), 'S'), null, 'not a create pool');
  assert.equal(launchFromTx(null, 'S'), null);
});

test('chain launches: newest first, one parse per tx, re-read after the TTL or early for a missing wanted mint, last good list kept on RPC errors', async () => {
  let now = 0, sigCalls = 0, txCalls = 0, fail = false;
  const auth = kp().publicKey, a = kp().publicKey, b = kp().publicKey, c = kp().publicKey;
  const txs: Record<string, VersionedTransactionResponse> = {
    A: launchResponse({ mint: a, config: kp().publicKey, creator: kp().publicKey, name: 'A', symbol: 'AA', uri: '' }),
    B: launchResponse({ mint: b, config: kp().publicKey, creator: kp().publicKey, name: 'B', symbol: 'BB', uri: '' }),
    C: launchResponse({ mint: c, config: kp().publicKey, creator: kp().publicKey, name: 'C', symbol: 'CC', uri: '' }),
  };
  let sigs = [{ signature: 'B', err: null }, { signature: 'X', err: { InstructionError: [0, 'x'] } }, { signature: 'A', err: null }];
  const cl = new ChainLaunches({
    async getSignaturesForAddress(k: PublicKey) { assert.ok(k.equals(auth)); sigCalls++; if (fail) throw new Error('429'); return sigs as any; },
    async getTransaction(sig: string) { txCalls++; return txs[sig] ?? null; },
  }, async () => auth, { ttlMs: 15_000, minRefreshMs: 3_000, now: () => now });
  assert.deepEqual((await cl.get()).map((l) => l.symbol), ['BB', 'AA'], 'newest first; failed txs skipped');
  assert.equal(txCalls, 2, 'failed signatures are never fetched');
  await cl.get(); assert.equal(sigCalls, 1, 'cached within the TTL');
  sigs = [{ signature: 'C', err: null }, ...sigs];
  now = 1_000; await cl.get(c.toBase58()); assert.equal(sigCalls, 1, 'a missing wanted mint waits for minRefreshMs');
  now = 3_000; assert.deepEqual((await cl.get(c.toBase58())).map((l) => l.symbol), ['CC', 'BB', 'AA'], 'then re-reads early');
  assert.equal(txCalls, 3, 'only the new tx is fetched');
  fail = true; now = 100_000;
  assert.deepEqual((await cl.get()).map((l) => l.symbol), ['CC', 'BB', 'AA'], 'an RPC error keeps the last list');
  const none = new ChainLaunches({ async getSignaturesForAddress() { throw new Error('unused'); }, async getTransaction() { return null; } } as any, async () => null);
  assert.deepEqual(await none.get(), [], 'no launch authority on chain: no launches');
});

test('studio sessions, stateless (hosted): any wallet signs in with anyWallet; tokens verify on any instance with the same secret and expire; allowlist marks studio wallets', () => {
  const secret = derivedKey(kp(), 'studio-session-v1');
  let now = 1_800_000_000_000;
  const user = kp(), admin = kp();
  const mk = () => new StudioAuth(new Set([admin.publicKey.toBase58()]), 'DEVNET', false, () => now, { anyWallet: true, secret });
  const a = mk(), b = mk();   // two "instances"
  const w = user.publicKey.toBase58();
  const ch = a.challenge(w);
  assert.equal(ch.message, challengeText(w, ch.nonce, 'DEVNET', now, now + 5 * 60_000));
  const sig = (m: string, k: Keypair) => walletSign(k, m);
  const s = b.signIn(w, ch.nonce, sig(ch.message, user));   // signed in on the other instance
  assert.equal(a.require(s.token), w, 'the session verifies on another instance');
  assert.equal(a.isStudioWallet(w), false); assert.equal(a.isStudioWallet(admin.publicKey.toBase58()), true);
  assert.deepEqual(a.status(), { required: true, configured: true });
  assert.throws(() => a.require(s.token.replace(/.$/, (x) => (x === '0' ? '1' : '0'))), /sign-in required/, 'a changed MAC');
  assert.throws(() => a.require(s.token.replace(w, admin.publicKey.toBase58())), /sign-in required/, 'another wallet under the same MAC');
  assert.throws(() => new StudioAuth(new Set(), 'DEVNET', false, () => now, { anyWallet: true, secret: derivedKey(kp(), 'studio-session-v1') }).require(s.token), /sign-in required/, 'another secret');
  assert.throws(() => a.signIn(w, ch.nonce, sig(ch.message, kp())), /does not match/, 'signed by someone else');
  assert.throws(() => a.signIn(w, ch.nonce.replace(/^\d+/, String(now + 1)), sig(ch.message, user)), /expired or already used/, 'a forged nonce');
  now += 8 * 3600_000; assert.throws(() => a.require(s.token), /sign-in required/, 'sessions expire after 8 h');
  const closed = new StudioAuth(new Set(), 'DEVNET', false, () => now, { secret });
  assert.throws(() => closed.challenge(w), /studio is closed/, 'without anyWallet an empty allowlist stays closed');
});
/** What a wallet's signMessage does: ed25519 over the exact message bytes (as tests/studio_auth.test.ts). */
function walletSign(k: Keypair, text: string): string {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(k.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  return edSign(null, Buffer.from(new TextEncoder().encode(text)), key).toString('hex');
}

test('Blob details store: reads each token through its public URL (cached), 404 = none; the image URL is the Blob CDN one; a bad token refuses', async () => {
  const mint = kp().publicKey.toBase58();
  let calls = 0; let now = 0;
  const rec = { description: 'd', website: null, x: 'https://x.com/a', telegram: null, image: { type: 'image/png', bytes: 3, url: 'https://abc123.public.blob.vercel-storage.com/details/devnet/m.png' }, updatedAt: '2026-10-08T00:00:00.000Z' };
  const store = new BlobDetailsStore('devnet', 'vercel_blob_rw_abc123_secretpart', { ttlMs: 30_000, now: () => now, fetch: (async (u: string) => {
    calls++; assert.equal(u, `https://abc123.public.blob.vercel-storage.com/details/devnet/${mint}.json`);
    return { ok: true, status: 200, json: async () => rec } as any;
  }) as any });
  const v = await store.view(mint);
  assert.equal(v!.image, rec.image.url); assert.equal(v!.x, 'https://x.com/a'); assert.equal(v!.discord, null);
  await store.view(mint); assert.equal(calls, 1, 'cached');
  now = 30_000; await store.view(mint); assert.equal(calls, 2, 're-read after the TTL');
  assert.equal(await store.view('not a mint'), null);
  const none = new BlobDetailsStore('devnet', 'vercel_blob_rw_abc123_s', { fetch: (async () => ({ ok: false, status: 404 })) as any });
  assert.equal(await none.view(mint), null);
  assert.equal(await none.image(mint), null, 'images are served by the CDN, not this server');
  assert.throws(() => new BlobDetailsStore('devnet', 'not-a-token'), /not a Vercel Blob read-write token/);
  // details entered before Blob existed (the bundled files) still show until the first save moves them over
  const old = { description: 'older', image: '/api/token/x/image?v=1' } as any;
  const fallback = { kind: 'files' as const, writable: false, view: async () => old, image: async () => ({ type: 'image/png' as const, data: Buffer.from([1]) }), save: async () => { throw new Error('read-only'); } };
  const layered = new BlobDetailsStore('devnet', 'vercel_blob_rw_abc123_s', { fallback, fetch: (async () => ({ ok: false, status: 404 })) as any });
  assert.equal(await layered.view(mint), old, 'no Blob record: the fallback view');
  assert.deepEqual(await layered.image(mint), { type: 'image/png', data: Buffer.from([1]) }, "and the fallback's image bytes");
  assert.equal(await store.image(mint), null, 'a Blob record: its image is on the CDN');
});

test('server wiring: hosted POSTs are exactly the open-launch steps, sign-in and details saves; the launch key is never serialized; a bad HOOKD_LAUNCH_KEY never echoes', () => {
  const src = readFileSync('app/server.ts', 'utf8');
  const re = new RegExp(/const HOSTED_POST = \/(.+)\/;/.exec(src)![1]);
  const M = 'HrybSGMJrrRv6H1SBq1aRrupgUPjEVtjQFB2fiJgw7sY';
  for (const p of ['/api/launch/config', '/api/launch/build', '/api/launch/submit', '/api/studio/session', '/api/studio/signout', `/api/token/${M}/metadata`]) assert.ok(re.test(p), p);
  for (const p of ['/api/create', '/api/trade', '/api/wallet/build', '/api/wallet/submit', '/api/studio/launch/build', '/api/studio/launch/submit', '/api/launch/config/x', `/api/token/${M}/metadata/x`, '/api/launch/other']) assert.ok(!re.test(p), p);
  assert.match(src, /if \(HOSTED && req\.method !== 'GET' && !\(OPEN_LAUNCH && HOSTED_POST\.test\(url\.pathname\)\)\) return send\(res, 403,/);
  const route = src.slice(src.indexOf('async function openLaunchRoute('));
  assert.match(route.slice(0, 200), /if \(!OPEN_LAUNCH\) return \{ code: 403/, 'the open routes refuse first when open launch is off');
  assert.doesNotMatch(src, /secretKey/, 'server.ts never reads a secret key (sdk/launch_open.ts derives the MAC keys)');
  const kfs = src.slice(src.indexOf('function keyFromSecret('), src.indexOf('function keyFromSecret(') + 900);
  assert.doesNotMatch(kfs.replace(/const s = v\?\.trim\(\)/, ''), /\$\{s\}|\$\{v\}|\+ s\b|\+ v\b/, 'refusals never include the value');
  const lo = readFileSync('sdk/launch_open.ts', 'utf8');
  const build = lo.slice(lo.indexOf('export async function buildOpenPool'), lo.indexOf('export interface OpenPoolTx'));
  assert.ok(build.indexOf('checkTicket(') < build.indexOf('sendAndConfirm('), 'the ticket is checked before the config is sent');
  assert.ok(build.indexOf('preSendMintHookCheck(') < build.indexOf('poolTx.partialSign('), 'blocker #7: simulated before any co-signature');
  const submit = lo.slice(lo.indexOf('export async function submitOpenPool'));
  assert.ok(submit.indexOf('checkOpenPoolTx(') < submit.indexOf('sendAndConfirm('), 'nothing is relayed before the launch-key check');
});

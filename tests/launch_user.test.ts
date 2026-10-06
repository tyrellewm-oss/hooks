// AC-21 studio launch: the relay only forwards launch transactions this server built, with EVERY signature verified
// (sdk/launch_user.ts). Runtime tests use real keypairs offline; the build/submit chain parts are source-checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { StudioLaunchRelay, LaunchUserRefusal, LAUNCH_BUILD_TTL_MS } from '../sdk/launch_user.ts';

const BH = '11111111111111111111111111111111';
/** a launch-shaped tx: the wallet pays, two co-signers (stand-ins for the mint and launch keys) */
function launchTx(owner: Keypair, mint: Keypair, launch: Keypair) {
  const tx = new Transaction()
    .add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: mint.publicKey, lamports: 1 }))
    .add(SystemProgram.transfer({ fromPubkey: mint.publicKey, toPubkey: launch.publicKey, lamports: 1 }))
    .add(SystemProgram.transfer({ fromPubkey: launch.publicKey, toPubkey: owner.publicKey, lamports: 1 }));
  tx.recentBlockhash = BH; tx.feePayer = owner.publicKey;
  return tx;
}
const pendingFor = (owner: Keypair) => ({ owner: owner.publicKey.toBase58(), opts: { name: 'T', symbol: 'T', steps: [], uncappedAfter: 0n } as any, config: 'C', mint: 'M', pool: 'P', createConfigSig: 's1', simulationNote: 'ok', exp: {} as any, lastValidBlockHeight: 1 });
const wire = (tx: Transaction) => Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));

test('relay: a fully signed launch this server built is accepted exactly once', () => {
  const owner = Keypair.generate(), mint = Keypair.generate(), launch = Keypair.generate();
  const relay = new StudioLaunchRelay();
  const tx = launchTx(owner, mint, launch);
  tx.partialSign(mint, launch);   // the server's co-signatures, like buildUserLaunch
  relay.issue(tx.serializeMessage(), pendingFor(owner));
  const signed = wire(tx); signed.partialSign(owner);   // the wallet's signature
  const p = relay.take(signed);
  assert.equal(p.mint, 'M');
  assert.throws(() => relay.take(signed), LaunchUserRefusal, 'one use only');
});

test('relay: a tx the server did not build, a missing signature, a tampered signature and a swapped fee payer are all refused', () => {
  const owner = Keypair.generate(), mint = Keypair.generate(), launch = Keypair.generate();
  const relay = new StudioLaunchRelay();
  const notIssued = launchTx(owner, mint, launch); notIssued.partialSign(mint, launch, owner);
  assert.throws(() => relay.take(notIssued), /not a launch this server built/);

  const issue = () => { const tx = launchTx(owner, mint, launch); tx.partialSign(mint, launch); relay.issue(tx.serializeMessage(), pendingFor(owner)); return tx; };
  const missing = wire(issue());   // wallet never signed
  assert.throws(() => relay.take(missing), /missing a signature/);

  const tampered = wire(issue()); tampered.partialSign(owner);
  tampered.signatures[1].signature = Buffer.from(tampered.signatures[1].signature!.map((b, i) => (i === 3 ? b ^ 0xff : b)));
  assert.throws(() => relay.take(tampered), /does not verify/);

  const other = Keypair.generate();
  const tx = launchTx(owner, mint, launch); tx.partialSign(mint, launch);
  relay.issue(tx.serializeMessage(), { ...pendingFor(owner), owner: other.publicKey.toBase58() });   // built for someone else
  const signed = wire(tx); signed.partialSign(owner);
  assert.throws(() => relay.take(signed), /not the wallet this launch was built for/);
});

test('relay: entries expire after the TTL', () => {
  let now = 1000;
  const relay = new StudioLaunchRelay(() => now);
  const owner = Keypair.generate(), mint = Keypair.generate(), launch = Keypair.generate();
  const tx = launchTx(owner, mint, launch); tx.partialSign(mint, launch);
  relay.issue(tx.serializeMessage(), pendingFor(owner));
  now += LAUNCH_BUILD_TTL_MS + 1;
  const signed = wire(tx); signed.partialSign(owner);
  assert.throws(() => relay.take(signed), /unknown or expired/);
});

test('build/submit wiring: 8.3 checks before any build, simulation before co-signing, secrets never in the reply, routes studio-gated', () => {
  const src = readFileSync('sdk/launch_user.ts', 'utf8');
  const build = src.slice(src.indexOf('export async function buildUserLaunch'), src.indexOf('export interface LaunchedReply'));
  assert.ok(build.indexOf('assertLaunchSigner(') < build.indexOf('buildCreatePoolTx('), '8.3: the launch signer is checked before anything is built');
  assert.ok(build.indexOf('preSendMintHookCheck(') < build.indexOf('poolTx.partialSign('), 'blocker #7: simulated before any signature');
  assert.ok(build.indexOf('poolTx.partialSign(') < build.indexOf('relay.issue('), 'the issued message carries the co-signatures');
  assert.match(build, /launchKeypairsFor\(gate\.clusterClass\)/, 'keypair generation stays devnet/local only');
  assert.doesNotMatch(build, /secretKey/, 'no secret key is read or serialized');
  const submit = src.slice(src.indexOf('export async function submitUserLaunch'));
  assert.ok(submit.indexOf('relay.take(tx)') < submit.indexOf('sendRawTransaction'), 'nothing is sent that the relay did not issue');
  assert.match(submit, /assertMintHook\(conn, new PublicKey\(p\.mint\), 'pre', p\.exp\)/, 'post-send mint hook check, like Launchpad.launch()');
  const srv = readFileSync('app/server.ts', 'utf8');
  for (const route of ['/api/studio/launch/build', '/api/studio/launch/submit']) {
    const r = srv.slice(srv.indexOf(`url.pathname === '${route}'`));
    assert.match(r.slice(0, 300), /studioCheck\(req\)/, `${route} is studio-gated`);
  }
  assert.match(srv, /const owner = walletKey\(who\.wallet\)/, 'the launch is built for the signed-in studio wallet, not a body field');
});

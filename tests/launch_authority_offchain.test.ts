// Ticket 8.3, off-chain: the third hook key in the §12a rules and the keeper pin (AC-13), and the migrate/rotate tool
// (AC-16 nothing touches mainnet, AC-17 dry run by default). Offline: the RPC is a stub; no key is loaded from disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { keeperStartChecks, launchConfigChecks, KeyRuleRefusal } from '../sdk/keyrules.js';
import { HookClient, DEFAULT_PROGRAM_ID } from '../sdk/hook.js';
import { DEVNET_GENESIS, MAINNET_GENESIS, TESTNET_GENESIS } from '../sdk/cluster.js';
import { runGlobalChange, buildGlobalChangeTx, checkGlobalChange, readGlobal, LaunchAuthorityRefusal, type LaConn } from '../sdk/launch_authority.js';
import { parseArgs } from '../scripts/launch_authority.js';
import { buildCreatePoolTx, assertLaunchSigner } from '../sdk/launch.js';
import { Transaction } from '@solana/web3.js';

const pk = () => Keypair.generate().publicKey.toBase58();
const FX = JSON.parse(readFileSync('tests/fixtures/devnet_hook_authorities.json', 'utf8'));
const V1 = Buffer.from(FX.global.data_base64, 'base64');
const ADMIN = new PublicKey(V1.subarray(8, 40));

// ---------------------------------------------------------------- AC-13: the third key in the §12a rules
test('AC-13 key rules: launch == upgrade, launch == lift, feeClaimer == launch, keeper key == launch and an unknown launch key refuse off devnet and warn on devnet', () => {
  const u = pk(), l = pk(), la = pk(), claimer = pk(), gas = pk();
  const clean = { upgradeAuthority: u, liftAuthority: l, launchAuthority: la };
  assert.deepEqual(launchConfigChecks('mainnet', claimer, clean), []); assert.deepEqual(keeperStartChecks('mainnet', { gas }, clean), []);   // control
  const cases: [string, () => string[], RegExp][] = [
    ['launch == upgrade (launch)', () => launchConfigChecks(C, claimer, { ...clean, launchAuthority: u }), /launch authority and upgrade authority are the same key/],
    ['launch == upgrade (keeper)', () => keeperStartChecks(C, { gas }, { ...clean, launchAuthority: u }), /launch authority and upgrade authority are the same key/],
    ['launch == lift (launch)', () => launchConfigChecks(C, claimer, { ...clean, launchAuthority: l }), /launch authority and lift authority are the same key/],
    ['launch == lift (keeper)', () => keeperStartChecks(C, { gas }, { ...clean, launchAuthority: l }), /launch authority and lift authority are the same key/],
    ['feeClaimer == launch', () => launchConfigChecks(C, la, clean), /feeClaimer .* is the hook launch authority/],
    ['keeper key == launch', () => keeperStartChecks(C, { gas: la }, clean), /keeper key 'gas' .* is the hook launch authority/],
    ['launch unknown (launch)', () => launchConfigChecks(C, claimer, { ...clean, launchAuthority: null }), /launch authority unknown/],
    ['launch unknown (keeper)', () => keeperStartChecks(C, { gas }, { upgradeAuthority: u, liftAuthority: l }), /launch authority unknown/],
  ];
  let C = 'mainnet';
  for (const [name, f, re] of cases) assert.throws(f, (e: any) => e instanceof KeyRuleRefusal && re.test(e.message), name);
  for (C of ['devnet', 'local']) for (const [name, f, re] of cases) {
    if (/unknown/.test(name)) { assert.deepEqual(f(), [], `${name} on ${C}: an unmigrated devnet Global is allowed`); continue; }
    const w = f(); assert.equal(w.length, 1, `${name} on ${C}`); assert.match(w[0], /^WARNING three-key rule/); assert.match(w[0], re);
  }
});

// ---------------------------------------------------------------- AC-16 / AC-17: the migrate / rotate tool
/** A stub RPC holding the recorded devnet Global; counts simulations and sends. */
function rpc(genesis: string, data: Buffer = V1) {
  const c = { reads: 0, sims: 0, sends: 0, blockhash: 0 };
  const conn: LaConn = {
    getGenesisHash: async () => genesis,
    getAccountInfo: async () => { c.reads++; return { data, lamports: 863_600, owner: DEFAULT_PROGRAM_ID }; },
    getLatestBlockhash: async () => { c.blockhash++; return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }; },
    simulateTransaction: async () => { c.sims++; return { value: { err: null, logs: ['Program log: simulated'] } }; },
    sendRawTransaction: async () => { c.sends++; return 'sig'; },
  };
  return { conn, c };
}
const hook = new HookClient(DEFAULT_PROGRAM_ID);
const ch = (o: Partial<Parameters<typeof checkGlobalChange>[0]> = {}) => ({ op: 'migrate' as const, admin: ADMIN, payer: Keypair.generate().publicKey, launch: Keypair.generate().publicKey, ...o });

test('AC-16 nothing touches mainnet: a mainnet, testnet or unknown genesis refuses before any read, build, simulation or send (also with send: true)', async () => {
  for (const g of [MAINNET_GENESIS, TESTNET_GENESIS, pk()]) for (const url of ['https://rpc.example', 'http://127.0.0.2:8899']) for (const send of [false, true]) {
    const { conn, c } = rpc(g);
    await assert.rejects(runGlobalChange(conn, url, hook, ch(), { send, signers: [Keypair.generate()] }), (e: any) => e instanceof LaunchAuthorityRefusal && /devnet\/local only/.test(e.message));
    await assert.rejects(buildGlobalChangeTx(conn, url, hook, ch()), LaunchAuthorityRefusal);
    assert.deepEqual(c, { reads: 0, sims: 0, sends: 0, blockhash: 0 }, `${g} ${url}`);
  }
  // a local validator (localhost + unknown genesis) and devnet are allowed
  for (const [g, url] of [[DEVNET_GENESIS, 'https://api.devnet.example'], [pk(), 'http://127.0.0.1:8899']]) {
    const { conn, c } = rpc(g); const r = await runGlobalChange(conn, url, hook, ch()); assert.equal(r.sent, false); assert.equal(c.sims, 1);
  }
});

test('AC-17 dry run by default: without send the tool simulates once and calls sendRawTransaction 0 times; the CLI parses to send = false unless --send is given', async () => {
  const { conn, c } = rpc(DEVNET_GENESIS);
  const r = await runGlobalChange(conn, 'https://api.devnet.example', hook, ch());
  assert.equal(r.sent, false); assert.equal(r.sig, null); assert.equal(c.sims, 1); assert.equal(c.sends, 0);
  assert.equal(r.before.length, 42); assert.equal(r.before.base64, FX.global.data_base64); assert.equal(r.before.address, FX.global.pubkey);   // bytes printed before
  const base = ['migrate', '--launch', pk(), '--admin', ADMIN.toBase58()];
  assert.equal(parseArgs(base).send, false); assert.equal(parseArgs([...base, '--cluster', 'devnet']).send, false); assert.equal(parseArgs([...base, '--send']).send, true);
  // a send needs the signers: none given → refused before anything is sent
  const s = rpc(DEVNET_GENESIS); await assert.rejects(runGlobalChange(s.conn, 'https://api.devnet.example', hook, ch(), { send: true }), /no signer/); assert.equal(s.c.sends, 0);
});

test('migrate/rotate preflight mirrors the program: wrong admin, zero key, launch == admin, migrate on 74 bytes, rotate on 42 bytes and rotate to the current key refuse before signing', async () => {
  const L = Keypair.generate().publicKey;
  const g1 = await readGlobal(rpc(DEVNET_GENESIS).conn, hook);
  const g2 = await readGlobal(rpc(DEVNET_GENESIS, Buffer.concat([V1, L.toBuffer()])).conn, hook);
  assert.equal(g2.launchAuthority, L.toBase58());
  const bad: [string, any, any][] = [
    ['wrong admin', ch({ admin: Keypair.generate().publicKey }), g1], ['zero key', ch({ launch: PublicKey.default }), g1], ['launch == admin', ch({ launch: ADMIN }), g1],
    ['migrate twice', ch(), g2], ['rotate before migrate', ch({ op: 'rotate' }), g1], ['rotate to current', ch({ op: 'rotate', launch: L }), g2],
  ];
  for (const [name, c, g] of bad) assert.throws(() => checkGlobalChange(c, g), LaunchAuthorityRefusal, name);
  checkGlobalChange(ch(), g1); checkGlobalChange(ch({ op: 'rotate' }), g2);   // controls
});

test('the tool and its module never create or generate keys (a send loads existing key files only)', () => {
  for (const f of ['sdk/launch_authority.ts', 'scripts/launch_authority.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/Keypair\.generate|loadOrCreate|writeFileSync/.test(src), `${f} must not create keys`);
  }
});

// ---------------------------------------------------------------- AC-13: buildCreatePoolTx uses the launch key, checked against the chain
test('AC-13 buildCreatePoolTx: the hook signer is the on-chain launch key, not the payer; a key that differs from the chain, equals the lift key, or an unset chain launch key refuses before anything is built', async () => {
  const payer = Keypair.generate().publicKey, launch = Keypair.generate().publicKey, lift = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
  let built = 0;
  const lp = { hook: new HookClient(DEFAULT_PROGRAM_ID), dbc: { creator: { createPoolWithTransferHook: async () => { built++; return new Transaction(); } } } };
  const o: any = { name: 'x', symbol: 'X', steps: [{ slotOffset: 0n, maxBps: 100 }], uncappedAfter: 300n };
  const keys = (la: PublicKey) => ({ payer, config: Keypair.generate().publicKey, mint: Keypair.generate().publicKey, launchAuthority: la });
  const auth = { upgradeAuthority: pk(), liftAuthority: lift.toBase58(), launchAuthority: launch.toBase58() };
  const tx = await buildCreatePoolTx(lp, o, keys(launch), auth);
  const hookIx = tx.instructions.find(i => i.programId.equals(DEFAULT_PROGRAM_ID))!;
  assert.ok(hookIx.keys[1].pubkey.equals(launch) && hookIx.keys[1].isSigner, 'the hook authority account is the launch key');
  assert.ok(!hookIx.keys[1].pubkey.equals(payer), 'never the payer');
  built = 0;
  await assert.rejects(buildCreatePoolTx(lp, o, keys(other), auth), (e: any) => e instanceof KeyRuleRefusal && /not the on-chain launch authority/.test(e.message));
  await assert.rejects(buildCreatePoolTx(lp, o, keys(payer), auth), /not the on-chain launch authority/);   // the payer is refused unless it is the launch key
  await assert.rejects(buildCreatePoolTx(lp, o, keys(lift), { ...auth, launchAuthority: lift.toBase58() }), /is the hook lift \(admin\) authority/);
  await assert.rejects(buildCreatePoolTx(lp, o, keys(launch), { ...auth, launchAuthority: null }), /not set on chain/);
  assert.equal(built, 0, 'nothing built on a refusal');
  // the payer may sign the hook config only when it IS the launch key
  const self = await buildCreatePoolTx(lp, o, keys(payer), { ...auth, launchAuthority: payer.toBase58() });
  assert.ok(self.instructions.find(i => i.programId.equals(DEFAULT_PROGRAM_ID))!.keys[1].pubkey.equals(payer));
  assert.throws(() => assertLaunchSigner(launch, { ...auth, launchAuthority: undefined }), /not set on chain/);
});

test('AC-13 keeper pin: startKeeper refuses when the pinned hook_launch_authority differs from the chain (the devnet configs pin null: Global not migrated)', async () => {
  const { startKeeper } = await import('../sdk/flywheel/keeper.js');
  const cfg = { ...JSON.parse(readFileSync('keeper/devnet.tdt.json', 'utf8')), pinned_pubkeys: undefined, sources: [] };   // no DBC source configs to look up
  assert.equal(cfg.hook_launch_authority, null);
  const prog = { owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), data: Buffer.from(FX.program.data_base64, 'base64'), lamports: 1, executable: true };
  const pdHeader = Buffer.from(FX.program_data.data_base64, 'base64');
  const accounts = (global: Buffer) => new Map<string, any>([[FX.program.pubkey, prog], [FX.program_data.pubkey, { owner: prog.owner, data: pdHeader, lamports: 1 }], [FX.global.pubkey, { owner: DEFAULT_PROGRAM_ID, data: global, lamports: 1 }]]);
  const conn = (global: Buffer) => { const m = accounts(global); return { getGenesisHash: async () => DEVNET_GENESIS, getAccountInfo: async (k: PublicKey) => m.get(k.toBase58()) ?? null, getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(k => m.get(k.toBase58()) ?? null), rpcEndpoint: 'https://api.devnet.example' } as any; };
  const deps = (global: Buffer) => ({ loadKey: () => Keypair.generate(), connect: async () => conn(global), log: () => {} });
  assert.ok(await startKeeper(cfg, [], deps(V1)));   // control: 42-byte chain Global, pin null
  const migrated = Buffer.concat([V1, Keypair.generate().publicKey.toBuffer()]);
  await assert.rejects(startKeeper(cfg, [], deps(migrated)), (e: any) => e instanceof KeyRuleRefusal && /do not match chain .*launch /.test(e.message));
  await assert.rejects(startKeeper({ ...cfg, hook_launch_authority: pk() }, [], deps(V1)), /do not match chain/);
});

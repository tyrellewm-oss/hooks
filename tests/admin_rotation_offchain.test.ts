// Ticket 8.3b off-chain: rotate-admin refuses mainnet before any RPC, and dry-run is the default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { HookClient, DEFAULT_PROGRAM_ID, GLOBAL_V2_LEN } from '../sdk/hook.js';
import { DEVNET_GENESIS, MAINNET_GENESIS, TESTNET_GENESIS } from '../sdk/cluster.js';
import { runGlobalChange, buildGlobalChangeTx, checkGlobalChange, LaunchAuthorityRefusal, type LaConn, type GlobalSnapshot } from '../sdk/launch_authority.js';
import { parseArgs } from '../scripts/launch_authority.js';

const FX = JSON.parse(readFileSync('tests/fixtures/devnet_hook_authorities.json', 'utf8'));
const V1 = Buffer.from(FX.global.data_base64, 'base64');
const ADMIN = new PublicKey(V1.subarray(8, 40));
const LAUNCH = Keypair.generate().publicKey;
const V2 = Buffer.concat([V1, LAUNCH.toBuffer()]);
const hook = new HookClient(DEFAULT_PROGRAM_ID);
const pk = () => Keypair.generate().publicKey;

function rpc(genesis: string, data: Buffer = V2) {
  const c = { reads: 0, sims: 0, sends: 0, blockhash: 0 };
  const conn: LaConn = {
    getGenesisHash: async () => genesis,
    getAccountInfo: async () => { c.reads++; return { data, lamports: 1, owner: DEFAULT_PROGRAM_ID }; },
    getLatestBlockhash: async () => { c.blockhash++; return { blockhash: pk().toBase58(), lastValidBlockHeight: 1 }; },
    simulateTransaction: async () => { c.sims++; return { value: { err: null, logs: [] } }; },
    sendRawTransaction: async () => { c.sends++; return 'sig'; },
  };
  return { conn, c };
}
const snap = (over: Partial<GlobalSnapshot> = {}): GlobalSnapshot => ({
  address: hook.globalPda().toBase58(), authority: ADMIN.toBase58(), lifted: false,
  launchAuthority: LAUNCH.toBase58(), length: GLOBAL_V2_LEN, lamports: 1, base64: V2.toString('base64'), ...over,
});

test('AC-12 rotate-admin on mainnet, testnet, or an unknown genesis refuses before any read', async () => {
  for (const g of [MAINNET_GENESIS, TESTNET_GENESIS, pk().toBase58()]) {
    const { conn, c } = rpc(g);
    const ch = { op: 'rotate-admin' as const, admin: ADMIN, payer: ADMIN, launch: pk() };
    await assert.rejects(runGlobalChange(conn, 'https://rpc.example', hook, ch, { send: true, signers: [Keypair.generate()] }), /devnet\/local only/);
    await assert.rejects(buildGlobalChangeTx(conn, 'https://rpc.example', hook, ch), LaunchAuthorityRefusal);
    assert.deepEqual(c, { reads: 0, sims: 0, sends: 0, blockhash: 0 });
  }
});

test('AC-13 dry run by default: one simulation, zero sends, and the CLI stays send=false without --send', async () => {
  const { conn, c } = rpc(DEVNET_GENESIS);
  const next = pk();
  const r = await runGlobalChange(conn, 'https://api.devnet.example', hook, { op: 'rotate-admin', admin: ADMIN, payer: ADMIN, launch: next });
  assert.equal(r.sent, false); assert.equal(c.sims, 1); assert.equal(c.sends, 0);
  const base = ['rotate-admin', '--new', next.toBase58(), '--admin', ADMIN.toBase58()];
  assert.equal(parseArgs(base).send, false);
  assert.equal(parseArgs([...base, '--send']).send, true);
  assert.equal(parseArgs(base).op, 'rotate-admin');
  assert.equal(parseArgs(base).launch.toBase58(), next.toBase58());
});

test('preflight refuses a new admin that is zero, the current admin, or the launch key, and a Global that is not 74 bytes with a launch key', () => {
  const ok = { op: 'rotate-admin' as const, admin: ADMIN, payer: ADMIN, launch: pk() };
  checkGlobalChange(ok, snap());
  assert.throws(() => checkGlobalChange({ ...ok, launch: PublicKey.default }, snap()), /zero key/);
  assert.throws(() => checkGlobalChange({ ...ok, launch: ADMIN }, snap()), /current admin/);
  assert.throws(() => checkGlobalChange({ ...ok, launch: LAUNCH }, snap()), /launch key/);
  assert.throws(() => checkGlobalChange(ok, snap({ length: 42, launchAuthority: null })), /not 74/);
  assert.throws(() => checkGlobalChange(ok, snap({ launchAuthority: null })), /not set/);
});

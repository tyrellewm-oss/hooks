// resolveCluster('local') itself must apply the local-validator rule (QA #3 M17): the cluster resolves as local only for a
// localhost RPC URL AND a genesis that is not devnet/mainnet/testnet. Offline: a tiny JSON-RPC server on loopback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { resolveCluster, DEVNET_GENESIS, MAINNET_GENESIS, TESTNET_GENESIS } from '../sdk/cluster.js';

let genesis = '';
// Loopback only: one server on 127.0.0.1 (localhost) and, where the OS allows it, one on 127.0.0.2 (loopback, but not a
// localhost URL by the rule). macOS has no 127.0.0.2 without an `ifconfig lo0 alias`, so the "not localhost" case also runs
// as http://localhost.:<port> (a trailing dot is not the exact spelling, yet it reaches the 127.0.0.1 server).
let server: Server, remote: Server | null = null; let port = 0, remotePort = 0; let noAlias = '';
const rpc = () => createServer((req, res) => {
  let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
    const r = JSON.parse(body); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.method === 'getGenesisHash' ? genesis : null }));
  });
});
const listen = (s: Server, host: string) => new Promise<number>((ok, no) => { s.once('error', no); s.listen(0, host, () => ok((s.address() as AddressInfo).port)); });
before(async () => {
  server = rpc(); port = await listen(server, '127.0.0.1');
  const r = rpc();
  try { remotePort = await listen(r, '127.0.0.2'); remote = r; }
  catch (e: any) { noAlias = `127.0.0.2 not bindable here (${e?.code ?? e}; macOS: sudo ifconfig lo0 alias 127.0.0.2)`; }
});
after(async () => { await new Promise<void>(ok => server.close(() => ok())); if (remote) await new Promise<void>(ok => remote!.close(() => ok())); });
async function resolveLocal(url: string, g: string) {
  genesis = g; const saved = process.env.LOCAL_RPC; process.env.LOCAL_RPC = url;
  try { return await resolveCluster('local'); } finally { if (saved === undefined) delete process.env.LOCAL_RPC; else process.env.LOCAL_RPC = saved; }
}
const UNKNOWN = Keypair.generate().publicKey.toBase58();   // a fresh local validator has its own random genesis

test('resolveCluster("local"): localhost URL + unknown genesis → LOCAL', async () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    const c = await resolveLocal(`http://${host}:${port}`, UNKNOWN);
    assert.equal(c.name, 'local'); assert.equal(c.label, 'LOCAL');
  }
});
test('resolveCluster("local"): localhost URL + devnet or testnet genesis → refused (not a local validator)', async () => {
  for (const g of [TESTNET_GENESIS, DEVNET_GENESIS])
    await assert.rejects(resolveLocal(`http://127.0.0.1:${port}`, g), /refusing: not a local validator/);
  await assert.rejects(resolveLocal(`http://127.0.0.1:${port}`, MAINNET_GENESIS), /refusing: RPC is mainnet-beta/);
});
test('resolveCluster("local"): unknown genesis on a non-localhost URL → refused (the URL test is exact: localhost. is not localhost)', async () => {
  await assert.rejects(resolveLocal(`http://localhost.:${port}`, UNKNOWN), /refusing: not a local validator .*got unknown/);
});
test('resolveCluster("local"): unknown genesis on 127.0.0.2 (loopback, not a localhost URL) → refused', async (t) => {
  if (noAlias) { t.skip(noAlias); return; }   // the reason is named in the test output, never a silent pass
  await assert.rejects(resolveLocal(`http://127.0.0.2:${remotePort}`, UNKNOWN), /refusing: not a local validator .*got unknown/);
});

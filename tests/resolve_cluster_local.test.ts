// resolveCluster('local') itself must apply the local-validator rule (QA #3 M17): the cluster resolves as local only for a
// localhost RPC URL AND a genesis that is not devnet/mainnet/testnet. Offline: a tiny JSON-RPC server on loopback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { resolveCluster, DEVNET_GENESIS, MAINNET_GENESIS, TESTNET_GENESIS } from '../sdk/cluster.js';

let genesis = '';
let server: Server; let port = 0;
before(async () => {
  server = createServer((req, res) => {
    let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
      const r = JSON.parse(body); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.method === 'getGenesisHash' ? genesis : null }));
    });
  });
  await new Promise<void>(ok => server.listen(0, '0.0.0.0', () => ok())); port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>(ok => server.close(() => ok())));
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
test('resolveCluster("local"): unknown genesis on a non-localhost URL → refused (the URL test is exact, 127.0.0.2 is not localhost)', async () => {
  await assert.rejects(resolveLocal(`http://127.0.0.2:${port}`, UNKNOWN), /refusing: not a local validator .*got unknown/);
});

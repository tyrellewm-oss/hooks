// DEVNET ONLY stand-in for the keeper's independent price (ticket #5 criterion 17: "no Jupiter on devnet, use a fake HTTP
// server"). It answers the Jupiter Price API v3 shape on 127.0.0.1 from the pinned DAMM v2 pool's current sqrt_price, so it
// is NOT independent of the pool: it exercises the keeper's HTTP path, blockId freshness and the deviation check only.
//   node --import tsx scripts/devnet_price_standin.ts --config keeper/devnet.loop.json [--port 8787] [--usd-sol 200]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { DEVNET_GENESIS } from '../sdk/cluster.js';
import { cpAmmSqrtDecoder, WSOL_MINT } from '../sdk/flywheel/price_source.js';

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const cfg = JSON.parse(readFileSync(arg('--config', 'keeper/devnet.loop.json')!, 'utf8'));
if (cfg.cluster !== 'devnet') throw new Error('devnet only');
const conn = new Connection(process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error('refusing: not devnet');
const pool = new PublicKey(cfg.route_pool), decode = cpAmmSqrtDecoder(conn), usdSol = Number(arg('--usd-sol', '200'));
const srv = createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ids = (u.searchParams.get('ids') ?? '').split(',');
    const { context, value } = await conn.getAccountInfoAndContext(pool, 'confirmed');
    if (!value) throw new Error('pool not found');
    const sq = decode(value.data);
    // lamports per raw token = sqrt^2 / 2^128; USD per whole token = that x 10^dec / 10^9 x USD per SOL
    const lamportsPerRaw = Number((sq * sq * 10n ** 12n) >> 128n) / 1e12;
    const usdMint = lamportsPerRaw * 10 ** cfg.main_decimals / 1e9 * usdSol;
    const body: Record<string, unknown> = {};
    if (ids.includes(cfg.main_mint)) body[cfg.main_mint] = { usdPrice: usdMint, blockId: context.slot, decimals: cfg.main_decimals };
    if (ids.includes(WSOL_MINT)) body[WSOL_MINT] = { usdPrice: usdSol, blockId: context.slot, decimals: 9 };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    console.log(`${new Date().toISOString()} slot ${context.slot} usdMint ${usdMint}`);
  } catch (e: any) { res.writeHead(503); res.end('{}'); console.log(`error ${String(e?.message ?? e).slice(0, 120)}`); }
});
srv.listen(Number(arg('--port', '8787')), '127.0.0.1', () => console.log(`devnet price stand-in on 127.0.0.1:${arg('--port', '8787')} for pool ${pool.toBase58()} (NOT independent: reads the same pool)`));

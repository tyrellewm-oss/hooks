// Trade indexer CLI (read-only RPC; writes only .index/<cluster>/<mint>.json, gitignored). See sdk/indexer.ts.
//   node --import tsx scripts/indexer.ts run  --cluster devnet              # once, every registry token
//   node --import tsx scripts/indexer.ts loop --cluster devnet --every 30   # keep the index fresh for the page
//   ... --mint <mint> --pool <dbc pool> [--damm <damm v2 pool>]            # one token, explicit pools
// Pools per registry token: the local launch record's DBC pool, else the keeper config's main_dbc_pool; the DAMM v2
// pool from the keeper config's route_pool, else derived from the cluster's DAMM v2 migration config.
import { readdirSync, readFileSync } from 'node:fs';
import { resolveCluster, parseClusterArg, assertNotMainnet } from '../sdk/cluster.js';
import { loadRegistry, REGISTRY_PATH } from '../sdk/registry.js';
import { listLaunches, dammV2MigrationConfigFor } from '../sdk/launch.js';
import { indexToken, dammPoolFor, type IndexTarget } from '../sdk/indexer.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
if (cmd !== 'run' && cmd !== 'loop') { console.log('usage: indexer.ts run|loop --cluster local|devnet [--every <s>] [--mint M --pool P [--damm D]]'); process.exit(cmd === 'help' ? 0 : 1); }
for (const v of [process.env.DEVNET_RPC, process.env.LOCAL_RPC]) if (v) assertNotMainnet(v);

const c = await resolveCluster(parseClusterArg(argv));

async function targets(): Promise<IndexTarget[]> {
  const m = flag('mint');
  if (m) {
    const pools = [{ address: flag('pool')!, venue: 'curve' as const }];
    if (flag('damm')) pools.push({ address: flag('damm')!, venue: 'pool' as const });
    if (!flag('pool')) throw new Error('--mint needs --pool');
    return [{ mint: m, pools }];
  }
  const reg = loadRegistry(c.name, REGISTRY_PATH);
  const records = listLaunches(c.name);
  const keepers = readdirSync('keeper').filter((f) => f.startsWith(`${c.name}.`) && f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(`keeper/${f}`, 'utf8')); } catch { return null; } }).filter(Boolean);
  let dammConfig: string | null = null;
  try { dammConfig = (await dammV2MigrationConfigFor(c)).config.toBase58(); } catch (e: any) { console.log(`(no DAMM v2 config for ${c.name}: ${e.message}; using keeper route pools only)`); }
  const out: IndexTarget[] = [];
  for (const mint of reg) {
    const rec = records.find((r) => r.mint === mint);
    const k = keepers.find((x: any) => x.main_mint === mint);
    const dbc = rec?.pool ?? k?.main_dbc_pool;
    if (!dbc) { console.log(`skip ${mint}: no launch record or keeper config with its pool`); continue; }
    const damm = k?.route_pool ?? (dammConfig ? dammPoolFor(mint, dammConfig) : null);
    out.push({ mint, decimals: k?.main_decimals, pools: [{ address: dbc, venue: 'curve' }, ...(damm ? [{ address: damm, venue: 'pool' as const }] : [])] });
  }
  return out;
}

async function once() {
  const ts = await targets();
  console.log(`[${c.label}] indexing ${ts.length} token(s)`);
  for (const t of ts) {
    try { const r = await indexToken(c.connection, c.name, t, { log: console.log, hookProgram: c.hookProgram }); console.log(`${t.mint}: +${r.added} trade(s), ${r.total} total`); }
    catch (e: any) { console.log(`${t.mint}: FAILED ${String(e?.message ?? e).slice(0, 200)}`); }
  }
}
await once();
if (cmd === 'loop') {
  const every = Math.max(10, Number(flag('every') ?? 30)) * 1000;
  for (;;) { await new Promise((r) => setTimeout(r, every)); await once(); }
}

// Ticket 8.3 operator tool: migrate the hook Global to v2 (set the launch key) or rotate the launch key.
//   node --import tsx scripts/launch_authority.ts migrate --launch <pubkey> --admin <pubkey> [--payer <pubkey>] [--cluster local|devnet]
//   node --import tsx scripts/launch_authority.ts rotate  --launch <pubkey> --admin <pubkey> [--cluster local|devnet]
//   add --send --admin-key <name> [--payer-key <name>] to send (key files must already exist in the cluster's gitignored key dir)
// DRY RUN by default: builds and simulates the tx, prints Global before (and the simulation logs), sends nothing.
// Refuses any cluster that is not devnet or a local validator (genesis check) before a tx is built.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { resolveCluster, parseClusterArg, explorerTx, type ClusterName } from '../sdk/cluster.js';
import { keyDir } from '../sdk/keys.js';
import { resolveQaHookProgram } from '../sdk/launch.js';
import { HookClient } from '../sdk/hook.js';
import { runGlobalChange, type GlobalOp } from '../sdk/launch_authority.js';

export function parseArgs(argv: string[]) {
  const op = argv[0];
  if (op !== 'migrate' && op !== 'rotate') throw new Error('usage: launch_authority.ts migrate|rotate --launch <pubkey> --admin <pubkey> [--payer <pubkey>] [--cluster local|devnet] [--send --admin-key <name> [--payer-key <name>]]');
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const need = (f: string) => { const v = val(f); if (!v || v.startsWith('--')) throw new Error(`missing ${f}`); return v; };
  const admin = new PublicKey(need('--admin'));
  return { op: op as GlobalOp, launch: new PublicKey(need('--launch')), admin, payer: new PublicKey(val('--payer') ?? admin.toBase58()),
    send: argv.includes('--send'), adminKey: val('--admin-key'), payerKey: val('--payer-key') };
}
/** Loads an EXISTING key file from the cluster's gitignored key dir. Never creates one. */
export function loadExistingKey(c: ClusterName, name: string): Keypair {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`bad key name ${name}`);
  const p = join(keyDir(c), `${name}.json`);
  if (!existsSync(p)) throw new Error(`refusing: key file ${name} not found in ${keyDir(c)}/ (this tool never creates keys)`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const a = parseArgs(argv);
  const c = await resolveCluster(parseClusterArg(argv));
  console.log(a.send ? `SENDING [${c.label}] ${a.op}` : `DRY RUN [${c.label}] ${a.op} (simulate only; add --send to send)`);
  const hook = new HookClient(await resolveQaHookProgram(c));
  let signers: Keypair[] = [];
  if (a.send) {
    if (!a.adminKey) throw new Error('--send needs --admin-key <name>');
    signers = [loadExistingKey(c.name, a.adminKey), ...(a.payerKey ? [loadExistingKey(c.name, a.payerKey)] : [])];
  }
  const r = await runGlobalChange(c.connection as any, c.url, hook, { op: a.op, admin: a.admin, payer: a.payer, launch: a.launch }, { send: a.send, signers });
  console.log('Global before:', JSON.stringify(r.before));
  if (r.simulation) { console.log('simulation:', r.simulation.err ? `FAILED ${JSON.stringify(r.simulation.err)}` : 'ok'); for (const l of r.simulation.logs) console.log('  ', l); }
  if (r.sig) console.log('sent:', explorerTx(r.sig, c.name));
  if (r.after) console.log('Global after: ', JSON.stringify(r.after));
  process.exit(r.simulation?.err ? 1 : 0);
}

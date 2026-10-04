// Ticket 8.3: migrate the hook Global to v2 (launch key at bytes 42..74) and rotate the launch key.
// DEVNET / LOCAL only: any other genesis is refused before a transaction is built. Dry run by default: the tx is
// simulated (sigVerify off, so no key is needed) and nothing is sent; only `send: true` with the signer keys sends.
// This module generates no keys and loads none: the caller passes the signers for a send.
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { classifyCluster, type ClusterClass } from './cluster.js';
import { HookClient, decodeGlobal, GLOBAL_V1_LEN, GLOBAL_V2_LEN } from './hook.js';

export class LaunchAuthorityRefusal extends Error { constructor(msg: string) { super(msg); this.name = 'LaunchAuthorityRefusal'; } }
export type GlobalOp = 'migrate' | 'rotate' | 'rotate-admin';
export interface GlobalSnapshot { address: string; length: number; lamports: number; base64: string; authority: string; lifted: boolean; launchAuthority: string | null }
export interface LaConn {
  getGenesisHash(): Promise<string>;
  getAccountInfo(pk: PublicKey, c?: any): Promise<{ data: Uint8Array; lamports: number; owner: PublicKey } | null>;
  getLatestBlockhash(c?: any): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  simulateTransaction(tx: any, config?: any): Promise<{ value: { err: unknown; logs: string[] | null } }>;
  sendRawTransaction(raw: Uint8Array | Buffer, opts?: any): Promise<string>;
  confirmTransaction?(sig: any, c?: any): Promise<unknown>;
}
export interface GlobalChange { op: GlobalOp; admin: PublicKey; payer: PublicKey; launch: PublicKey }
export interface GlobalChangeResult { cluster: ClusterClass; sent: boolean; sig: string | null; simulation: { err: unknown; logs: string[] } | null; before: GlobalSnapshot; after: GlobalSnapshot | null }

/** Only devnet and a local validator. Checked from the RPC's genesis hash (and URL, only to recognise localhost). */
export async function assertDevnetOrLocal(conn: Pick<LaConn, 'getGenesisHash'>, url: string): Promise<ClusterClass> {
  const genesis = await conn.getGenesisHash();
  const cls = classifyCluster(genesis, url);
  if (cls !== 'devnet' && cls !== 'local') throw new LaunchAuthorityRefusal(`refusing: cluster class '${cls}' (genesis ${genesis}); launch-authority changes are devnet/local only`);
  return cls;
}
export async function readGlobal(conn: Pick<LaConn, 'getAccountInfo'>, hook: HookClient): Promise<GlobalSnapshot> {
  const pk = hook.globalPda();
  const ai = await conn.getAccountInfo(pk, 'confirmed');
  if (!ai) throw new LaunchAuthorityRefusal(`refusing: Global ${pk.toBase58()} not found`);
  if (!ai.owner.equals(hook.programId)) throw new LaunchAuthorityRefusal(`refusing: Global owner ${ai.owner.toBase58()} is not the hook program`);
  let g; try { g = decodeGlobal(ai.data); } catch (e: any) { throw new LaunchAuthorityRefusal(`refusing: Global undecodable (${e?.message ?? e})`); }
  return { address: pk.toBase58(), length: ai.data.length, lamports: ai.lamports, base64: Buffer.from(ai.data).toString('base64'),
    authority: g.authority.toBase58(), lifted: g.lifted, launchAuthority: g.launchAuthority?.toBase58() ?? null };
}
/** Off-chain preflight mirroring the program's refusals, so an operator mistake is caught before signing. */
export function checkGlobalChange(ch: GlobalChange, g: GlobalSnapshot): void {
  const no = (m: string): never => { throw new LaunchAuthorityRefusal(`refusing ${ch.op}: ${m}`); };
  if (ch.admin.toBase58() !== g.authority) no(`admin ${ch.admin.toBase58()} is not the Global authority ${g.authority}`);
  if (ch.op === 'rotate-admin') {
    if (ch.launch.equals(PublicKey.default)) no('the new admin is the zero key');
    if (g.length !== GLOBAL_V2_LEN) no(`Global is ${g.length} bytes, not ${GLOBAL_V2_LEN} (migrate first)`);
    if (!g.launchAuthority) no('the launch key is not set');
    if (ch.launch.toBase58() === g.authority) no('the new admin is the current admin');
    if (ch.launch.toBase58() === g.launchAuthority) no('the new admin equals the launch key');
    return;
  }
  if (ch.launch.equals(PublicKey.default)) no('the launch key is the zero key');
  if (ch.launch.toBase58() === g.authority) no('the launch key equals the admin key');
  if (ch.op === 'migrate' && g.length !== GLOBAL_V1_LEN) no(`Global is ${g.length} bytes, not ${GLOBAL_V1_LEN} (already migrated?)`);
  if (ch.op === 'rotate' && g.length !== GLOBAL_V2_LEN) no(`Global is ${g.length} bytes, not ${GLOBAL_V2_LEN} (migrate first)`);
  if (ch.op === 'rotate' && ch.launch.toBase58() === g.launchAuthority) no('the new launch key is the current one');
}
/** Builds the migrate / rotate tx after the cluster check (devnet/local only) and the preflight. */
export async function buildGlobalChangeTx(conn: LaConn, url: string, hook: HookClient, ch: GlobalChange): Promise<{ tx: Transaction; cluster: ClusterClass; before: GlobalSnapshot }> {
  const cluster = await assertDevnetOrLocal(conn, url);   // before any read or build
  const before = await readGlobal(conn, hook);
  checkGlobalChange(ch, before);
  const ix = ch.op === 'migrate' ? hook.migrateGlobalV2(ch.payer, ch.admin, ch.launch)
    : ch.op === 'rotate' ? hook.setLaunchAuthority(ch.admin, ch.launch)
    : hook.rotateAdmin(ch.admin, ch.launch);
  const tx = new Transaction().add(ix);
  tx.feePayer = ch.op === 'migrate' ? ch.payer : ch.admin;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  return { tx, cluster, before };
}
/** Dry run (default): simulate only, nothing sent. `send: true` needs the signers (admin, and the payer for migrate). */
export async function runGlobalChange(conn: LaConn, url: string, hook: HookClient, ch: GlobalChange, o: { send?: boolean; signers?: Keypair[] } = {}): Promise<GlobalChangeResult> {
  const { tx, cluster, before } = await buildGlobalChangeTx(conn, url, hook, ch);
  if (!o.send) {
    // web3.js accepts a simulate config only with a VersionedTransaction (a legacy Transaction plus config throws "Invalid arguments")
    const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' } as any);
    return { cluster, sent: false, sig: null, simulation: { err: sim.value.err, logs: sim.value.logs ?? [] }, before, after: null };
  }
  const need = [ch.admin, ...(ch.op === 'migrate' ? [ch.payer] : [])];
  const signers = o.signers ?? [];
  for (const k of need) if (!signers.some(s => s.publicKey.equals(k))) throw new LaunchAuthorityRefusal(`refusing to send: no signer for ${k.toBase58()}`);
  tx.sign(...signers.filter(s => need.some(k => k.equals(s.publicKey))));
  const sig = await conn.sendRawTransaction(tx.serialize());
  if (conn.confirmTransaction) await conn.confirmTransaction(sig, 'confirmed');
  return { cluster, sent: true, sig, simulation: null, before, after: await readGlobal(conn, hook) };
}

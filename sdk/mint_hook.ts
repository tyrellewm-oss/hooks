// Mint TransferHook rule (QA blocker #7). The mint's own Token-2022 TransferHook extension decides which program runs on
// every transfer and who may repoint or remove it. Before graduation it must point at the gated hook program, with the
// authority held by the DBC program's signer that removes the hook at graduation. After graduation both must be unset.
// Every read failure refuses (no default to "no authority"), like AuthorityReadError for the hook program authorities.
import { PublicKey, Transaction, Message, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { unpackMint, getExtensionData, ExtensionType, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import type { ClusterClass } from './cluster.js';

export class MintHookRefusal extends Error { constructor(m: string) { super(m); this.name = 'MintHookRefusal'; } }

/** Expected mint TransferHook authority before graduation, pinned per genesis class (no fallback to the devnet value).
 *
 *  devnet: FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM, read (read-only getParsedTransaction, devnet genesis
 *  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG) from the TDT curve-completing swap
 *  3F2PoxYigsd9G1CCLDYZ86eFLVCVW4bYrFXbxY9uBECFjsLrktb4ZsdbyVPXjTvGHZKfTp22DQmpvTW5WNzXBcrj (slot 507162210):
 *  DBC Swap2WithTransferHook (top-level ix 4) → Token-2022 TransferHookInstruction::Update with authority
 *  FhVo3mqL…, then Token-2022 SetAuthority (authorityType transferHookProgramId, newAuthority null) signed by the same
 *  FhVo3mqL…, on mint 3Ut8PuPt3G21GBth84SdqjWxMAoSp5yjSfQFKM9aMmtE. It is DBC's shared pool-authority PDA
 *  (findProgramAddressSync(["pool_authority"], DBC program), bump 255): ONE signer for every DBC pool, so a matching
 *  authority alone never proves a mint is ours. The program_id comparison and the pool/config checks are always required
 *  as well. Cross-checks, not the source: the PDA derivation (tests/mint_hook_authority.test.ts) and the live
 *  pre-graduation FW15 mint, which carries the same authority.
 *  local: the same value. scripts/local_validator.sh clones the DBC program at the same address, so its signer is the same.
 *  mainnet / testnet / unknown: unset, so launch() refuses until a later PR pins a value read from that cluster. */
export const MINT_HOOK_AUTHORITY_PINS: Readonly<Record<ClusterClass, string | null>> = Object.freeze({
  devnet: 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',
  local: 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',
  mainnet: null,
  testnet: null,
  unknown: null,
});

export function mintHookAuthorityFor(cls: ClusterClass): PublicKey {
  const pin = MINT_HOOK_AUTHORITY_PINS[cls];
  if (!pin) throw new MintHookRefusal(`refusing: no pinned mint TransferHook authority for cluster class '${cls}'`);
  return new PublicKey(pin);
}

export interface MintTransferHook { programId: PublicKey | null; authority: PublicKey | null }
const TRANSFER_HOOK_LEN = 64;   // OptionalNonZeroPubkey authority (32) + OptionalNonZeroPubkey program_id (32)
const nz = (b: Buffer) => { const k = new PublicKey(b); return k.equals(PublicKey.default) ? null : k; };

/** Pure decode of raw mint bytes (no I/O, no owner): the Token-2022 mint layout plus its TransferHook extension. The
 *  post-simulation account (base64 from simulateTransaction) and the getAccountInfo data both go through this.
 *  MintHookRefusal on unparseable mint data, a missing TransferHook extension, or extension data of the wrong length. */
export function decodeMintTransferHookBytes(mint: PublicKey, data: Uint8Array, what = 'mint'): MintTransferHook {
  let tlv: Buffer;
  try { tlv = unpackMint(mint, { owner: TOKEN_2022_PROGRAM_ID, lamports: 0, executable: false, data: Buffer.from(data) } as any, TOKEN_2022_PROGRAM_ID).tlvData; }
  catch (e: any) { throw new MintHookRefusal(`refusing: ${what} ${mint.toBase58()} data unparseable (${String(e?.message ?? e?.name ?? e).slice(0, 120)})`); }
  let ext: Buffer | null;
  try { ext = getExtensionData(ExtensionType.TransferHook, tlv); }
  catch { throw new MintHookRefusal(`refusing: ${what} ${mint.toBase58()} extension data unparseable`); }
  if (!ext) throw new MintHookRefusal(`refusing: ${what} ${mint.toBase58()} has no TransferHook extension`);
  if (ext.length !== TRANSFER_HOOK_LEN) throw new MintHookRefusal(`refusing: ${what} ${mint.toBase58()} TransferHook extension is ${ext.length} bytes, expected ${TRANSFER_HOOK_LEN}`);
  return { authority: nz(ext.subarray(0, 32)), programId: nz(ext.subarray(32, 64)) };
}
/** A mint account (owner + data), from getAccountInfo or from the simulation: MintHookRefusal on a missing account or a
 *  non-Token-2022 owner, then the pure byte decode above. */
export function decodeMintTransferHook(mint: PublicKey, ai: { owner: PublicKey | string; data: Buffer | Uint8Array } | null | undefined, what = 'mint'): MintTransferHook {
  if (!ai) throw new MintHookRefusal(`refusing: ${what} ${mint.toBase58()} not found`);
  let owner: PublicKey;
  try { owner = new PublicKey(ai.owner); } catch { throw new MintHookRefusal(`refusing: ${what} ${mint.toBase58()} owner unreadable`); }
  if (!owner.equals(TOKEN_2022_PROGRAM_ID)) throw new MintHookRefusal(`refusing: ${what} ${mint.toBase58()} owner ${owner.toBase58()} is not Token-2022`);
  return decodeMintTransferHookBytes(mint, ai.data, what);
}
/** Read the mint's TransferHook extension. MintHookRefusal on an RPC error, else as decodeMintTransferHook. */
export async function readMintTransferHook(conn: { getAccountInfo(pk: PublicKey, c?: any): Promise<any> }, mint: PublicKey): Promise<MintTransferHook> {
  let ai: any;
  try { ai = await conn.getAccountInfo(mint, 'confirmed'); }
  catch (e: any) { throw new MintHookRefusal(`refusing: RPC error reading mint ${mint.toBase58()}: ${String(e?.message ?? e).slice(0, 200)}`); }
  return decodeMintTransferHook(mint, ai);
}

// ---------------- pre-send simulation of the create-pool tx (blocker #7)
/** DBC initialize_virtual_pool_with_token2022_transfer_hook: Anchor discriminator and the base_mint account index
 *  (accounts: config 0, pool_authority 1, creator 2, base_mint 3; DBC IDL in @meteora-ag/dynamic-bonding-curve-sdk 1.5.13). */
export const DBC_INIT_POOL_T22_HOOK_DISC = Buffer.from([182, 13, 233, 177, 42, 145, 135, 2]);
export const DBC_INIT_POOL_BASE_MINT_INDEX = 3;
/** The base mint as the built tx itself names it: account 3 of its one DBC create-pool instruction. */
export function poolTxBaseMint(tx: Transaction, dbcProgram: PublicKey): PublicKey {
  const ixs = tx.instructions.filter(ix => ix.programId.equals(dbcProgram) && Buffer.from(ix.data.subarray(0, 8)).equals(DBC_INIT_POOL_T22_HOOK_DISC));
  if (ixs.length !== 1) throw new MintHookRefusal(`refusing: the built create-pool tx has ${ixs.length} DBC initialize_virtual_pool_with_token2022_transfer_hook instructions, expected 1`);
  const k = ixs[0].keys[DBC_INIT_POOL_BASE_MINT_INDEX];
  if (!k) throw new MintHookRefusal('refusing: the DBC create-pool instruction has no base_mint account');
  return k.pubkey;
}
/** True when two serialized legacy messages are identical apart from the recent blockhash. */
export function sameMessageExceptBlockhash(a: Uint8Array, b: Uint8Array): boolean {
  let ma: Message, mb: Message;
  try { ma = Message.from(Buffer.from(a)); mb = Message.from(Buffer.from(b)); } catch { return false; }
  const withHash = new Message({ header: ma.header, accountKeys: ma.accountKeys, recentBlockhash: mb.recentBlockhash, instructions: ma.instructions });
  return Buffer.from(withHash.serialize()).equals(Buffer.from(b));
}
export interface SimulatedMintHook { messageBytes: Buffer; mint: PublicKey; hook: MintTransferHook; unitsConsumed?: number }
/** Simulate exactly these message bytes (no signatures: sigVerify false, the RPC swaps in a fresh blockhash) and decode
 *  the mint as it would be after the tx. MintHookRefusal on an RPC error, a simulation error (err non-null), a missing or
 *  null returned account, or anything decodeMintTransferHook refuses. */
export async function simulateMintTransferHook(conn: { simulateTransaction(tx: VersionedTransaction, cfg?: any): Promise<any> }, messageBytes: Uint8Array, mint: PublicKey): Promise<SimulatedMintHook> {
  const bytes = Buffer.from(messageBytes);
  const vtx = new VersionedTransaction(VersionedMessage.deserialize(bytes));
  let res: any;
  try { res = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { addresses: [mint.toBase58()], encoding: 'base64' } }); }
  catch (e: any) { throw new MintHookRefusal(`refusing: RPC error simulating the create-pool tx: ${String(e?.message ?? e).slice(0, 200)}`); }
  const v = res?.value;
  if (!v) throw new MintHookRefusal('refusing: create-pool simulation returned no result');
  if (v.err !== null && v.err !== undefined) throw new MintHookRefusal(`refusing: create-pool simulation failed: ${JSON.stringify(v.err).slice(0, 200)}${(v.logs ?? []).length ? ` (last log: ${String(v.logs[v.logs.length - 1]).slice(0, 160)})` : ''}`);
  const acc = Array.isArray(v.accounts) ? v.accounts[0] : undefined;
  if (!acc) throw new MintHookRefusal(`refusing: create-pool simulation returned no account for mint ${mint.toBase58()}`);
  let data: Buffer;
  if (Array.isArray(acc.data)) {
    if (acc.data[1] !== 'base64' || typeof acc.data[0] !== 'string') throw new MintHookRefusal(`refusing: simulated mint ${mint.toBase58()} data is not base64`);
    data = Buffer.from(acc.data[0], 'base64');
  } else throw new MintHookRefusal(`refusing: simulated mint ${mint.toBase58()} data is not base64`);
  const hook = decodeMintTransferHook(mint, { owner: acc.owner, data }, 'simulated mint');
  return { messageBytes: bytes, mint, hook, unitsConsumed: v.unitsConsumed };
}

export type GraduationPhase = 'pre' | 'post';
/** DBC pool migration_progress: 0 = PreBondingCurve (before graduation). 1..3 = curve complete, so the hook was removed in
 *  the same swap that completed it. Anything else refuses. */
export function graduationPhase(pool: { migrationProgress?: unknown } | null | undefined): GraduationPhase {
  const p = pool?.migrationProgress;
  if (p === 0) return 'pre';
  if (p === 1 || p === 2 || p === 3) return 'post';
  throw new MintHookRefusal(`refusing: DBC pool migration progress unreadable (${String(p)})`);
}

export interface MintHookExpectation { hookProgram: PublicKey; authority: PublicKey; forbidden?: Record<string, string | null | undefined> }
/** Problems with the mint's TransferHook for a phase (empty = fine). Before graduation: program == gated hook,
 *  authority == pinned DBC signer (and never one of our keys). After graduation: both unset. */
export function mintHookProblems(th: MintTransferHook, phase: GraduationPhase, exp: MintHookExpectation): string[] {
  const out: string[] = [];
  const name = (k: PublicKey) => Object.entries(exp.forbidden ?? {}).filter(([, v]) => v === k.toBase58()).map(([r]) => r);
  if (phase === 'pre') {
    if (!th.programId) out.push('TransferHook program_id is unset before graduation');
    else if (!th.programId.equals(exp.hookProgram)) out.push(`TransferHook program_id ${th.programId.toBase58()} != gated hook ${exp.hookProgram.toBase58()}`);
    if (!th.authority) out.push('TransferHook authority is unset before graduation');
    else if (!th.authority.equals(exp.authority)) {
      const roles = name(th.authority);
      out.push(`TransferHook authority ${th.authority.toBase58()}${roles.length ? ` (our ${roles.join('/')} key)` : ''} != pinned DBC signer ${exp.authority.toBase58()}`);
    }
  } else {
    if (th.programId) out.push(`TransferHook program_id still set after graduation (${th.programId.toBase58()})`);
    if (th.authority) out.push(`TransferHook authority still set after graduation (${th.authority.toBase58()})`);
  }
  return out;
}
/** The pinned authority must never be one of our own keys (a mis-set pin would hand the hook to a key we hold). */
export function assertPinNotOurs(authority: PublicKey, forbidden: Record<string, string | null | undefined>): void {
  const hit = Object.entries(forbidden).filter(([, v]) => v && v === authority.toBase58()).map(([r]) => r);
  if (hit.length) throw new MintHookRefusal(`refusing: pinned mint TransferHook authority ${authority.toBase58()} is our ${hit.join('/')} key`);
}
/** Read + check in one step: MintHookRefusal on any read failure or any problem. */
export async function assertMintHook(conn: { getAccountInfo(pk: PublicKey, c?: any): Promise<any> }, mint: PublicKey, phase: GraduationPhase, exp: MintHookExpectation): Promise<MintTransferHook> {
  const th = await readMintTransferHook(conn, mint);
  const p = mintHookProblems(th, phase, exp);
  if (p.length) throw new MintHookRefusal(`refusing: mint ${mint.toBase58()} (${phase === 'pre' ? 'before' : 'after'} graduation): ${p.join('; ')}`);
  return th;
}

// Hand-written client for programs/trenches-hook (no generated IDL: the host
// IDL build needs a newer proc-macro2 than the MSRV-1.84 lockfile allows).
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction, AccountMeta } from '@solana/web3.js';
import type { CapConfig, Step } from './capMath.js';
import { classifyCluster, type ClusterClass } from './cluster.js';

export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
export const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const DBC_POOL_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], DBC_PROGRAM_ID)[0];
export const DAMM_V2_POOL_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], DAMM_V2_PROGRAM_ID)[0];

/** Hook program id pins per genesis-based cluster class (classifyCluster). null = no pinned value:
 *  - mainnet / testnet: no deployed hook program yet. Resolution refuses, with or without HOOK_PROGRAM_ID; a later PR sets the pin.
 *  - local (localhost URL + unknown genesis): HOOK_PROGRAM_ID must be set (local_validator.sh deploys the hook keypair's id).
 *  - unknown: refused.
 *  There is no fallback to the devnet id on any non-devnet class. */
export const HOOK_PROGRAM_ID_DEVNET = 'FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz';
export const HOOK_PROGRAM_ID_PINS: Readonly<Record<ClusterClass, string | null>> = Object.freeze({
  devnet: HOOK_PROGRAM_ID_DEVNET, mainnet: null, testnet: null, local: null, unknown: null,
});
/** Offline default (litesvm tests, log attribution). Not read from env: on a live cluster the id comes from resolveHookProgramId. */
export const DEFAULT_PROGRAM_ID = new PublicKey(HOOK_PROGRAM_ID_DEVNET);
export class HookProgramPinRefusal extends Error {}
export interface HookProgramResolution { programId: PublicKey; override: string | null; clusterClass: ClusterClass }
/** Resolve the hook program id from the RPC's genesis hash (+ URL, only to recognise a local validator).
 *  devnet and local: a valid HOOK_PROGRAM_ID override is allowed. mainnet/testnet: the override must equal the pin, and
 *  no pin refuses. unknown: refuse. Throws HookProgramPinRefusal. */
export function resolveHookProgramId(genesis: string, url: string | undefined, env: NodeJS.ProcessEnv = process.env): HookProgramResolution {
  const cls = classifyCluster(genesis, url);
  const raw = env.HOOK_PROGRAM_ID;
  const override = raw !== undefined && raw !== '' ? raw : null;
  const pinned = HOOK_PROGRAM_ID_PINS[cls];
  const overridable = cls === 'devnet' || cls === 'local';
  if (override === null) {
    if (pinned === null) throw new HookProgramPinRefusal(`refusing: no pinned hook program id for cluster class '${cls}' (genesis ${genesis})${cls === 'local' ? '; set HOOK_PROGRAM_ID for a local validator' : ''}`);
    return { programId: new PublicKey(pinned), override: null, clusterClass: cls };
  }
  if (!overridable && (pinned === null || override !== pinned))
    throw new HookProgramPinRefusal(`refusing HOOK_PROGRAM_ID override ${override} on cluster class '${cls}' (genesis ${genesis}): ${pinned === null ? 'no pinned value, so no override is allowed' : `only the pinned value ${pinned} is allowed`}`);
  let pk: PublicKey; try { pk = new PublicKey(override); } catch { throw new HookProgramPinRefusal(`HOOK_PROGRAM_ID override is not a valid address: ${override}`); }
  return { programId: pk, override, clusterClass: cls };
}

const disc = (ns: string, name: string) => createHash('sha256').update(`${ns}:${name}`).digest().subarray(0, 8);
export const IX = {
  initializeGlobal: disc('global', 'initialize_global'),
  initializeExtraAccountMetaList: disc('global', 'initialize_extra_account_meta_list'),
  liftGlobal: disc('global', 'lift_global'),
  liftMintCap: disc('global', 'lift_mint_cap'),
  raiseMintCap: disc('global', 'raise_mint_cap'),
  viewSchedule: disc('global', 'view_schedule'),
};
export const ACC = { Global: disc('account', 'Global'), MintConfig: disc('account', 'MintConfig'), LiftState: disc('account', 'LiftState') };
export const EVT = { RestrictionsLifted: disc('event', 'RestrictionsLifted') };
export const ERRORS = ['WalletCapExceeded', 'ConfigFrozen', 'Unauthorized', 'InvalidCapSchedule', 'NotTransferring', 'InvalidMint'] as const;
export type HookErrorName = (typeof ERRORS)[number];
export const errorFromCode = (code: number): HookErrorName | null => (code >= 6000 && code < 6000 + ERRORS.length ? ERRORS[code - 6000] : null);

export class HookClient {
  constructor(public programId: PublicKey = DEFAULT_PROGRAM_ID) {}
  pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  globalPda = () => this.pda(Buffer.from('global'));
  configPda = (mint: PublicKey) => this.pda(Buffer.from('config'), mint.toBuffer());
  liftPda = (mint: PublicKey) => this.pda(Buffer.from('lift'), mint.toBuffer());
  extraMetasPda = (mint: PublicKey) => this.pda(Buffer.from('extra-account-metas'), mint.toBuffer());
  programDataPda = () => PublicKey.findProgramAddressSync([this.programId.toBuffer()], BPF_UPGRADEABLE)[0];

  initializeGlobal(payer: PublicKey, authority: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: this.globalPda(), isSigner: false, isWritable: true },
        { pubkey: this.programId, isSigner: false, isWritable: false },
        { pubkey: this.programDataPda(), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([IX.initializeGlobal, authority.toBuffer()]),
    });
  }

  initializeExtraAccountMetaList(p: {
    payer: PublicKey; authority: PublicKey; mint: PublicKey; steps: Step[]; uncappedAfter: bigint; supplyRef: bigint; exemptOwners?: PublicKey[];
  }): TransactionInstruction {
    const ex = p.exemptOwners ?? [];
    const b = Buffer.alloc(8 + 4 + p.steps.length * 10 + 8 + 8 + 4 + ex.length * 32);
    let o = 0;
    IX.initializeExtraAccountMetaList.copy(b, o); o += 8;
    b.writeUInt32LE(p.steps.length, o); o += 4;
    for (const s of p.steps) { b.writeBigUInt64LE(s.slotOffset, o); o += 8; b.writeUInt16LE(s.maxBps, o); o += 2; }
    b.writeBigUInt64LE(p.uncappedAfter, o); o += 8;
    b.writeBigUInt64LE(p.supplyRef, o); o += 8;
    b.writeUInt32LE(ex.length, o); o += 4;
    for (const k of ex) { k.toBuffer().copy(b, o); o += 32; }
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: p.payer, isSigner: true, isWritable: true },
        { pubkey: p.authority, isSigner: true, isWritable: false },
        { pubkey: this.globalPda(), isSigner: false, isWritable: false },
        { pubkey: p.mint, isSigner: false, isWritable: false },
        { pubkey: this.extraMetasPda(p.mint), isSigner: false, isWritable: true },
        { pubkey: this.configPda(p.mint), isSigner: false, isWritable: true },
        { pubkey: this.liftPda(p.mint), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: b,
    });
  }

  liftGlobal(authority: PublicKey) {
    return new TransactionInstruction({ programId: this.programId, data: Buffer.from(IX.liftGlobal), keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: this.globalPda(), isSigner: false, isWritable: true },
    ] });
  }
  liftMintCap(authority: PublicKey, mint: PublicKey) {
    return new TransactionInstruction({ programId: this.programId, data: Buffer.from(IX.liftMintCap), keys: this.liftKeys(authority, mint) });
  }
  raiseMintCap(authority: PublicKey, mint: PublicKey, newFloorBps: number) {
    const d = Buffer.alloc(10); IX.raiseMintCap.copy(d, 0); d.writeUInt16LE(newFloorBps, 8);
    return new TransactionInstruction({ programId: this.programId, data: d, keys: this.liftKeys(authority, mint) });
  }
  private liftKeys(authority: PublicKey, mint: PublicKey): AccountMeta[] {
    return [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: this.globalPda(), isSigner: false, isWritable: false },
      { pubkey: this.liftPda(mint), isSigner: false, isWritable: true },
    ];
  }
  viewSchedule(mint: PublicKey) {
    return new TransactionInstruction({ programId: this.programId, data: Buffer.from(IX.viewSchedule), keys: [
      { pubkey: this.configPda(mint), isSigner: false, isWritable: false },
      { pubkey: this.liftPda(mint), isSigner: false, isWritable: false },
      { pubkey: this.globalPda(), isSigner: false, isWritable: false },
    ] });
  }
  /** Extra accounts Token-2022 needs for a transfer of `mint` (static resolution of our 3 metas). */
  transferHookExtraAccounts(mint: PublicKey): AccountMeta[] {
    return [
      { pubkey: this.configPda(mint), isSigner: false, isWritable: false },
      { pubkey: this.liftPda(mint), isSigner: false, isWritable: false },
      { pubkey: this.globalPda(), isSigner: false, isWritable: false },
      { pubkey: this.programId, isSigner: false, isWritable: false },
      { pubkey: this.extraMetasPda(mint), isSigner: false, isWritable: false },
    ];
  }
}

// ---------- decoders
const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));
export interface GlobalAcc { authority: PublicKey; lifted: boolean }
export function decodeGlobal(data: Uint8Array): GlobalAcc {
  const b = Buffer.from(data); if (!b.subarray(0, 8).equals(ACC.Global)) throw new Error('not Global');
  return { authority: pk(b, 8), lifted: b[40] === 1 };
}
export interface MintConfigAcc { mint: PublicKey; launchSlot: bigint; supplyRef: bigint; steps: Step[]; uncappedAfter: bigint; exemptOwners: PublicKey[]; testSlotsBuild: boolean; launcher: PublicKey }
export function decodeMintConfig(data: Uint8Array): MintConfigAcc {
  const b = Buffer.from(data); if (!b.subarray(0, 8).equals(ACC.MintConfig)) throw new Error('not MintConfig');
  let o = 8; const mint = pk(b, o); o += 32;
  const launchSlot = b.readBigUInt64LE(o); o += 8; const supplyRef = b.readBigUInt64LE(o); o += 8;
  const raw: Step[] = []; for (let i = 0; i < 8; i++) { raw.push({ slotOffset: b.readBigUInt64LE(o), maxBps: b.readUInt16LE(o + 8) }); o += 10; }
  const stepCount = b[o]; o += 1; const uncappedAfter = b.readBigUInt64LE(o); o += 8;
  const ex: PublicKey[] = []; for (let i = 0; i < 4; i++) { ex.push(pk(b, o)); o += 32; }
  const exemptCount = b[o]; o += 1; const testSlotsBuild = b[o] === 1; o += 1; const launcher = pk(b, o);
  return { mint, launchSlot, supplyRef, steps: raw.slice(0, stepCount), uncappedAfter, exemptOwners: ex.slice(0, exemptCount), testSlotsBuild, launcher };
}
export const toCapConfig = (c: MintConfigAcc): CapConfig => ({ launchSlot: c.launchSlot, supply: c.supplyRef, steps: c.steps, uncappedAfter: c.uncappedAfter });
export interface LiftAcc { mint: PublicKey; lifted: boolean; raisedFloorBps: number }
export function decodeLift(data: Uint8Array): LiftAcc {
  const b = Buffer.from(data); if (!b.subarray(0, 8).equals(ACC.LiftState)) throw new Error('not LiftState');
  return { mint: pk(b, 8), lifted: b[40] === 1, raisedFloorBps: b.readUInt16LE(41) };
}
export interface RestrictionsLiftedEvt { scope: number; scopeName: string; mint: PublicKey; oldFloorBps: number; newFloorBps: number; lifted: boolean; slot: bigint; signer: PublicKey }
/** Parse Anchor `emit!` events (`Program data: <base64>`) from tx logs. */
export function parseRestrictionsLifted(logs: string[]): RestrictionsLiftedEvt[] {
  const out: RestrictionsLiftedEvt[] = [];
  for (const l of logs) {
    const m = l.match(/^Program data: (.+)$/); if (!m) continue;
    const b = Buffer.from(m[1], 'base64'); if (b.length < 8 || !b.subarray(0, 8).equals(EVT.RestrictionsLifted)) continue;
    const scope = b[8];
    out.push({ scope, scopeName: ['global', 'mint-lift', 'mint-raise'][scope] ?? '?', mint: pk(b, 9), oldFloorBps: b.readUInt16LE(41), newFloorBps: b.readUInt16LE(43), lifted: b[45] === 1, slot: b.readBigUInt64LE(46), signer: pk(b, 54) });
  }
  return out;
}
/** Walk Solana program logs keeping the invoke stack ("Program <id> invoke [n]" / "success" / "failed"),
 *  and call `fn(line, executingProgramId, failedProgramId?)` for every line. Lets callers attribute
 *  "Program log:" lines and "failed: custom program error" lines to the program that produced them (QA M-12). */
export function walkLogs(logs: string[], fn: (line: string, current: string | null, failed?: { program: string; rest: string }) => void) {
  const stack: string[] = [];
  for (const l of logs) {
    let m = l.match(/^Program (\w+) invoke \[\d+\]/);
    if (m) { stack.push(m[1]); fn(l, m[1]); continue; }
    m = l.match(/^Program (\w+) success$/);
    if (m) { fn(l, stack[stack.length - 1] ?? null); if (stack[stack.length - 1] === m[1]) stack.pop(); continue; }
    m = l.match(/^Program (\w+) failed: (.*)$/);
    if (m) { fn(l, stack[stack.length - 1] ?? null, { program: m[1], rest: m[2] }); if (stack[stack.length - 1] === m[1]) stack.pop(); continue; }
    fn(l, stack[stack.length - 1] ?? null);
  }
}
/** Our hook's custom error NAME, only from AnchorError lines logged while OUR program is executing
 *  ("Program log: AnchorError occurred|thrown in ... Error Code: X"). Names logged by DBC or any other
 *  program (DBC also has e.g. `Unauthorized` = 6053) are ignored. */
export function hookErrorFromLogs(logs: string[], programId: PublicKey = DEFAULT_PROGRAM_ID): HookErrorName | null {
  const ours = programId.toBase58(); let found: HookErrorName | null = null;
  walkLogs(logs, (l, cur) => {
    if (found || cur !== ours) return;
    const m = l.match(/^Program log: AnchorError\b.*?Error Code: (\w+)/);
    if (m && (ERRORS as readonly string[]).includes(m[1])) found = m[1] as HookErrorName;
  });
  if (found) return found;
  // Fallback: name from our program's own numeric failure code.
  const code = hookCodeFromLogs(logs, programId);
  return code === null ? null : errorFromCode(code);
}
/** Numeric custom error code raised by OUR program only ("Program <ours> failed: custom program error: 0x1770").
 *  DBC and Token-2022 re-raise or own overlapping 6000+ codes; those lines are ignored. */
export function hookCodeFromLogs(logs: string[], programId: PublicKey = DEFAULT_PROGRAM_ID): number | null {
  const ours = programId.toBase58(); let code: number | null = null;
  walkLogs(logs, (_l, _cur, failed) => {
    if (code !== null || !failed || failed.program !== ours) return;
    const m = failed.rest.match(/custom program error: (0x[0-9a-f]+)/i);
    if (m) { const n = parseInt(m[1], 16); if (errorFromCode(n)) code = n; }
  });
  return code;
}
export function capHitDetails(logs: string[]) {
  for (const l of logs) {
    // Current program: "token_account=<dest account> owner=<dest owner>"; builds before the rename log "wallet=<dest owner>".
    const n = l.match(/WalletCapExceeded: token_account=(\w+) owner=(\w+) balance=(\d+) cap=(\d+) slot=(\d+)/);
    if (n) return { tokenAccount: n[1], owner: n[2], balance: BigInt(n[3]), cap: BigInt(n[4]), slot: BigInt(n[5]) };
    const m = l.match(/WalletCapExceeded: wallet=(\w+) balance=(\d+) cap=(\d+) slot=(\d+)/);
    if (m) return { tokenAccount: null as string | null, owner: m[1], balance: BigInt(m[2]), cap: BigInt(m[3]), slot: BigInt(m[4]) };
  }
  return null;
}

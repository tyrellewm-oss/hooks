// litesvm 1.5 (Kit-style API: string addresses, { messageBytes, signatures } transactions) behind the small
// web3.js-style surface the simulations use. 1.5, not the repo tests' 0.8: 0.8's Linux build aborts with
// std::bad_alloc when a program resizes an account (migrate_global_v2, DBC pool creation).
import { LiteSVM } from 'litesvm15';
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import { HookClient, TOKEN_2022, BPF_UPGRADEABLE } from '../../sdk/hook.js';

const A = (k: PublicKey) => k.toBase58() as any;
export interface TxResult { ok: boolean; logs: string[]; err: string | null }
export interface Acc { data: Buffer; executable: boolean; lamports: number; owner: PublicKey }

export class Env15 {
  svm: any = new LiteSVM();
  hook: HookClient;
  upgradeAuth = Keypair.generate();
  payer = Keypair.generate();
  constructor(hookBytes: Uint8Array, programId: PublicKey) {
    this.hook = new HookClient(programId);
    this.svm.addProgram(A(programId), hookBytes);
    // make upgradeAuth the hook's upgrade authority (initialize_global requires it)
    const pd = this.svm.getAccount(A(this.hook.programDataPda()));
    const data = new Uint8Array(pd.data); data[12] = 1; data.set(this.upgradeAuth.publicKey.toBytes(), 13);
    this.svm.setAccount({ ...pd, data });
    this.fund(this.payer.publicKey, 100_000_000_000n);
    this.fund(this.upgradeAuth.publicKey, 10_000_000_000n);
  }
  addProgram(id: PublicKey, bytes: Uint8Array) { this.svm.addProgram(A(id), bytes); }
  get slot(): bigint { return BigInt(this.svm.getClock().slot); }
  get unixTimestamp(): bigint { return BigInt(this.svm.getClock().unixTimestamp); }
  warpToSlot(slot: bigint) { this.svm.warpToSlot(slot); }
  latestBlockhash(): string { return this.svm.latestBlockhash(); }
  fund(k: PublicKey, lamports = 5_000_000_000n) { this.svm.airdrop(A(k), lamports); }
  lamports(k: PublicKey): bigint { return BigInt(this.svm.getBalance(A(k)) ?? 0n); }
  rent(len: number): bigint { return BigInt(this.svm.minimumBalanceForRentExemption(BigInt(len))); }

  getAccount(k: PublicKey): Acc | null {
    const a = this.svm.getAccount(A(k));
    if (!a?.exists) return null;
    return { data: Buffer.from(a.data), executable: a.executable, lamports: Number(a.lamports), owner: new PublicKey(a.programAddress) };
  }
  accountData(k: PublicKey) { return this.getAccount(k)?.data ?? null; }
  setAccountData(k: PublicKey, data: Buffer, owner: PublicKey = this.hook.programId, lamports?: bigint) {
    this.svm.setAccount({ address: A(k), data: new Uint8Array(data), executable: false, lamports: lamports ?? this.rent(data.length), programAddress: A(owner), space: BigInt(data.length) });
  }

  /** Send an already signed web3.js Transaction (blockhash from latestBlockhash()). */
  sendTx(tx: Transaction): TxResult {
    const signatures: Record<string, Uint8Array | null> = {};
    for (const s of tx.signatures) signatures[s.publicKey.toBase58()] = s.signature ? new Uint8Array(s.signature) : null;
    const r = this.svm.sendTransaction({ messageBytes: new Uint8Array(tx.serializeMessage()), signatures });
    this.svm.expireBlockhash();
    const failed = typeof r.err === 'function';
    const logs: string[] = (failed ? r.meta().logs() : r.logs()) ?? [];
    return { ok: !failed, logs, err: failed ? String(r.err()) : null };
  }
  send(ixs: TransactionInstruction[], signers: Keypair[]): TxResult {
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = this.latestBlockhash(); tx.feePayer = signers[0].publicKey; tx.sign(...signers);
    return this.sendTx(tx);
  }
  initGlobal(authority: PublicKey) { return this.send([this.hook.initializeGlobal(this.upgradeAuth.publicKey, authority)], [this.upgradeAuth]); }
  migrateGlobal(admin: Keypair, launchAuthority: PublicKey) { return this.send([this.hook.migrateGlobalV2(this.payer.publicKey, admin.publicKey, launchAuthority)], [this.payer, admin]); }

  balance(tokenAccount: PublicKey): bigint {
    const a = this.getAccount(tokenAccount);
    if (!a) return 0n;
    return unpackAccount(tokenAccount, { ...a, lamports: a.lamports, rentEpoch: 0 } as any, TOKEN_2022).amount;
  }
  tokenBalance(mint: PublicKey, owner: PublicKey) { return this.balance(getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022)); }
}
export { BPF_UPGRADEABLE };

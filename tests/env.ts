// LOCAL test harness (litesvm, in-process). Keypairs are generated in memory per run; nothing is written to disk.
import { LiteSVM, FailedTransactionMetadata, TransactionMetadata } from 'litesvm';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  ExtensionType, getMintLen, createInitializeTransferHookInstruction, createInitializeMintInstruction,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  createSetAuthorityInstruction, AuthorityType, createTransferCheckedInstruction, unpackAccount,
} from '@solana/spl-token';
import { HookClient, TOKEN_2022, DEFAULT_PROGRAM_ID, hookErrorFromLogs, BPF_UPGRADEABLE } from '../sdk/hook.js';

export const RELEASE_SO = process.env.HOOK_SO ?? 'target/deploy/trenches_hook.so';
export const TEST_SLOTS_SO = process.env.HOOK_TEST_SLOTS_SO ?? 'target/deploy-test-slots/trenches_hook.so';

export interface SendResult { ok: boolean; logs: string[]; err?: string; hookError: string | null; customCode?: number; returnData?: Buffer }

export class Env {
  svm: LiteSVM;
  hook: HookClient;
  upgradeAuth = Keypair.generate();
  payer = Keypair.generate();
  constructor(so = RELEASE_SO, programId: PublicKey = DEFAULT_PROGRAM_ID) {
    this.svm = new LiteSVM();
    this.hook = new HookClient(programId);
    this.svm.addProgramFromFile(programId, so);
    // litesvm deploys with upgrade authority None: patch ProgramData so upgradeAuth is the upgrade authority.
    const pd = this.hook.programDataPda();
    const acc = this.svm.getAccount(pd)!;
    const data = Buffer.from(acc.data);
    data[12] = 1; this.upgradeAuth.publicKey.toBuffer().copy(data, 13);
    this.svm.setAccount(pd, { ...acc, data, owner: BPF_UPGRADEABLE });
    this.svm.airdrop(this.payer.publicKey, 100_000_000_000n);
    this.svm.airdrop(this.upgradeAuth.publicKey, 10_000_000_000n);
  }
  get slot() { return this.svm.getClock().slot; }
  warp(slot: bigint) { this.svm.warpToSlot(slot); }
  fund(k: PublicKey, lamports = 5_000_000_000n) { this.svm.airdrop(k, lamports); }

  send(ixs: TransactionInstruction[], signers: Keypair[], simulate = false): SendResult {
    const tx = new Transaction();
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = signers[0].publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    const r = simulate ? this.svm.simulateTransaction(tx) : this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    if (r instanceof FailedTransactionMetadata) {
      const logs = r.meta().logs();
      const e = r.err() as any;
      let customCode: number | undefined;
      try { const inner = e.err?.(); if (inner && typeof inner.code === 'number') customCode = inner.code; } catch {}
      return { ok: false, logs, err: String(e?.toString?.() ?? e), hookError: hookErrorFromLogs(logs), customCode };
    }
    const meta = (simulate ? (r as any).meta() : r) as TransactionMetadata;
    let returnData: Buffer | undefined;
    // only simulations read return data (view_schedule): on Linux, reading it from a send with none aborts the process
    if (simulate) { try { returnData = Buffer.from(meta.returnData().data()); } catch {} }
    return { ok: true, logs: meta.logs(), hookError: null, returnData };
  }

  initGlobal(authority: PublicKey) {
    return this.send([this.hook.initializeGlobal(this.upgradeAuth.publicKey, authority)], [this.upgradeAuth]);
  }
  /** 8.3: admin-only Global migration (42 -> 74 bytes) that sets the launch key; the env payer pays the rent increase. */
  migrateGlobal(admin: Keypair, launchAuthority: PublicKey) {
    return this.send([this.hook.migrateGlobalV2(this.payer.publicKey, admin.publicKey, launchAuthority)], [this.payer, admin]);
  }
  /** Global as a fresh deploy sets it up after 8.3: init (admin) then migrate (launch key). */
  initGlobalV2(admin: Keypair, launch: Keypair) {
    const a = this.initGlobal(admin.publicKey); if (!a.ok) return a;
    return this.migrateGlobal(admin, launch.publicKey);
  }
  /** Overwrite an account (tests only: load recorded devnet bytes, or forge a state the program must refuse). */
  setAccountData(k: PublicKey, data: Buffer, owner: PublicKey = this.hook.programId, lamports?: bigint) {
    const rent = this.svm.minimumBalanceForRentExemption(BigInt(data.length));
    this.svm.setAccount(k, { lamports: Number(lamports ?? rent), data, owner, executable: false, rentEpoch: 0 } as any);   // rentEpoch: litesvm's Linux build aborts (std::bad_alloc) without it
  }

  /** Token-2022 mint with TransferHook -> our program, full supply minted to `holderOwner`'s ATA, mint authority then set to None. */
  createHookMint(opts: { supply: bigint; decimals?: number; holderOwner: PublicKey; hookProgram?: PublicKey }) {
    const mint = Keypair.generate();
    const decimals = opts.decimals ?? 6;
    const len = getMintLen([ExtensionType.TransferHook]);
    const rent = this.svm.minimumBalanceForRentExemption(BigInt(len));
    const ata = getAssociatedTokenAddressSync(mint.publicKey, opts.holderOwner, true, TOKEN_2022);
    const r = this.send([
      SystemProgram.createAccount({ fromPubkey: this.payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: Number(rent), programId: TOKEN_2022 }),
      createInitializeTransferHookInstruction(mint.publicKey, this.payer.publicKey, opts.hookProgram ?? this.hook.programId, TOKEN_2022),
      createInitializeMintInstruction(mint.publicKey, decimals, this.payer.publicKey, null, TOKEN_2022),
      createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, ata, opts.holderOwner, mint.publicKey, TOKEN_2022),
      createMintToInstruction(mint.publicKey, ata, this.payer.publicKey, opts.supply, [], TOKEN_2022),
      createSetAuthorityInstruction(mint.publicKey, this.payer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022),
    ], [this.payer, mint]);
    if (!r.ok) throw new Error('createHookMint failed: ' + r.logs.join('\n'));
    return { mint: mint.publicKey, decimals, holderAta: ata };
  }

  ata(mint: PublicKey, owner: PublicKey) {
    const a = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022);
    if (!this.svm.getAccount(a)) {
      const r = this.send([createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, a, owner, mint, TOKEN_2022)], [this.payer]);
      if (!r.ok) throw new Error('ata failed ' + r.logs.join('\n'));
    }
    return a;
  }
  balance(a: PublicKey): bigint {
    const acc = this.svm.getAccount(a);
    if (!acc) return 0n;
    return unpackAccount(a, { ...acc, data: Buffer.from(acc.data) } as any, TOKEN_2022).amount;
  }
  transferIx(mint: PublicKey, decimals: number, src: PublicKey, dst: PublicKey, owner: PublicKey, amount: bigint) {
    const ix = createTransferCheckedInstruction(src, mint, dst, owner, amount, decimals, [], TOKEN_2022);
    ix.keys.push(...this.hook.transferHookExtraAccounts(mint));
    return ix;
  }
  transfer(mint: PublicKey, decimals: number, from: Keypair, toOwner: PublicKey, amount: bigint) {
    const src = getAssociatedTokenAddressSync(mint, from.publicKey, true, TOKEN_2022);
    const dst = this.ata(mint, toOwner);
    return this.send([this.transferIx(mint, decimals, src, dst, from.publicKey, amount)], [this.payer, from]);
  }
  accountData(k: PublicKey) { const a = this.svm.getAccount(k); return a ? Buffer.from(a.data) : null; }
}

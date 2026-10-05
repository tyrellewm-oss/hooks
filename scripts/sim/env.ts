// A litesvm world with the deployed DBC + Hookd hook programs, plus a minimal Connection over it so the Meteora SDK
// and our SDK build real transactions against it. Keys are generated in memory per run; nothing touches a network
// after the program bytes are cached (programs.ts).
import { writeFileSync, mkdirSync } from 'node:fs';
import { Keypair, PublicKey, Transaction, type AccountInfo } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { MINT_SIZE, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Env } from '../../tests/env.js';
import { programBytes, DBC_PROGRAM, HOOK_PROGRAM, SIM_DIR } from './programs.js';

export async function simEnv() {
  // SIM_HOOK_SO: a hook build from this checkout (target/deploy/trenches_hook.so); default: the deployed devnet program
  let hookFile = process.env.SIM_HOOK_SO;
  if (!hookFile) {
    const hookBytes = await programBytes(HOOK_PROGRAM);
    mkdirSync(SIM_DIR, { recursive: true });
    hookFile = `${SIM_DIR}/${HOOK_PROGRAM.toBase58()}.so`;
    writeFileSync(hookFile, hookBytes);
  }
  const dbcBytes = await programBytes(DBC_PROGRAM);
  console.log(`[sim] hook ${hookFile}, DBC ${dbcBytes.length} bytes`);
  const env = new Env(hookFile, HOOK_PROGRAM);
  console.log('[sim] hook program loaded');
  env.svm.addProgram(DBC_PROGRAM, dbcBytes);
  console.log('[sim] DBC program loaded');
  // wrapped SOL's mint (the curve's quote token) is not in a fresh litesvm: write the canonical native mint
  const nm = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 9, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, nm);
  env.setAccountData(NATIVE_MINT, nm, TOKEN_PROGRAM_ID, 1_000_000_000n);
  return new Sim(env);
}

export class Sim {
  conn: any;
  dbc: DynamicBondingCurveClient;
  constructor(public env: Env) {
    const svm = env.svm;
    const info = (k: PublicKey): AccountInfo<Buffer> | null => {
      const a = svm.getAccount(k);
      return a ? { data: Buffer.from(a.data), executable: a.executable, lamports: Number(a.lamports), owner: new PublicKey(a.owner), rentEpoch: 0 } : null;
    };
    const ctx = () => ({ slot: Number(svm.getClock().slot) });
    this.conn = {
      commitment: 'confirmed', rpcEndpoint: 'litesvm://local',
      getAccountInfo: async (k: PublicKey) => info(k),
      getAccountInfoAndContext: async (k: PublicKey) => ({ context: ctx(), value: info(k) }),
      getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(info),
      getMultipleAccountsInfoAndContext: async (ks: PublicKey[]) => ({ context: ctx(), value: ks.map(info) }),
      getSlot: async () => Number(svm.getClock().slot),
      getBlockTime: async () => Number(svm.getClock().unixTimestamp),
      getLatestBlockhash: async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000 }),
      getMinimumBalanceForRentExemption: async (n: number) => Number(svm.minimumBalanceForRentExemption(BigInt(n))),
      getBalance: async (k: PublicKey) => Number(svm.getBalance(k) ?? 0n),
    };
    this.dbc = new DynamicBondingCurveClient(this.conn, 'confirmed');
  }
  get slot() { return this.env.svm.getClock().slot; }
  warp(slots: bigint) { this.env.svm.warpToSlot(this.slot + slots); }
  /** Sign and send a built tx (all signers given); returns ok + logs. */
  send(tx: Transaction, signers: Keypair[]) {
    tx.recentBlockhash = this.env.svm.latestBlockhash();
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    const r = this.env.svm.sendTransaction(tx);
    this.env.svm.expireBlockhash();
    if (r instanceof FailedTransactionMetadata) return { ok: false, logs: r.meta().logs(), err: String(r.err()) };
    return { ok: true, logs: r.logs(), err: null as string | null };
  }
  lamports(k: PublicKey) { return BigInt(this.env.svm.getBalance(k) ?? 0n); }
}

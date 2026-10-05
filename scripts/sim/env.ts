// A litesvm world with the deployed DBC + Hookd hook programs, plus a minimal Connection over it so the Meteora SDK
// and our SDK build real transactions against it. Keys are generated in memory per run; nothing touches a network
// after the program bytes are cached (programs.ts).
import { writeFileSync, mkdirSync } from 'node:fs';
import { Keypair, PublicKey, Transaction, type AccountInfo } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Env } from '../../tests/env.js';
import { programBytes, DBC_PROGRAM, HOOK_PROGRAM, SIM_DIR } from './programs.js';

export async function simEnv() {
  const hookBytes = await programBytes(HOOK_PROGRAM);
  const dbcBytes = await programBytes(DBC_PROGRAM);
  mkdirSync(SIM_DIR, { recursive: true });
  const hookFile = `${SIM_DIR}/${HOOK_PROGRAM.toBase58()}.so`;
  writeFileSync(hookFile, hookBytes);
  const env = new Env(hookFile, HOOK_PROGRAM);
  env.svm.addProgram(DBC_PROGRAM, dbcBytes);
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

// A litesvm world with the deployed DBC program and the Hookd hook (deployed devnet bytes, or this checkout's build
// via SIM_HOOK_SO), plus a minimal Connection over it so the Meteora SDK and our SDK build real transactions
// against it. Keys are generated in memory per run; nothing touches a network after the program bytes are cached.
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, Transaction, type AccountInfo } from '@solana/web3.js';
import { MINT_SIZE, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Env15 } from './svm15.js';
import { programBytes, DBC_PROGRAM, HOOK_PROGRAM, trimElf } from './programs.js';

export async function simEnv() {
  const hookBytes = process.env.SIM_HOOK_SO ? trimElf(readFileSync(process.env.SIM_HOOK_SO)) : await programBytes(HOOK_PROGRAM);
  const dbcBytes = await programBytes(DBC_PROGRAM);
  console.log(`[sim] hook ${process.env.SIM_HOOK_SO ?? 'deployed devnet build'} (${hookBytes.length} bytes), DBC ${dbcBytes.length} bytes`);
  const env = new Env15(hookBytes, HOOK_PROGRAM);
  env.addProgram(DBC_PROGRAM, dbcBytes);
  // wrapped SOL's mint (the curve's quote token) is not in a fresh litesvm: write the canonical native mint
  const nm = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 9, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, nm);
  env.setAccountData(NATIVE_MINT, nm, TOKEN_PROGRAM_ID, 1_000_000_000n);
  return new Sim(env);
}

export class Sim {
  conn: any;
  dbc: DynamicBondingCurveClient;
  constructor(public env: Env15) {
    const info = (k: PublicKey): AccountInfo<Buffer> | null => {
      const a = env.getAccount(k);
      return a ? { ...a, rentEpoch: 0 } : null;
    };
    const ctx = () => ({ slot: Number(env.slot) });
    this.conn = {
      commitment: 'confirmed', rpcEndpoint: 'litesvm://local',
      getAccountInfo: async (k: PublicKey) => info(k),
      getAccountInfoAndContext: async (k: PublicKey) => ({ context: ctx(), value: info(k) }),
      getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(info),
      getMultipleAccountsInfoAndContext: async (ks: PublicKey[]) => ({ context: ctx(), value: ks.map(info) }),
      getSlot: async () => Number(env.slot),
      getBlockTime: async () => Number(env.unixTimestamp),
      getLatestBlockhash: async () => ({ blockhash: env.latestBlockhash(), lastValidBlockHeight: 1_000_000 }),
      getMinimumBalanceForRentExemption: async (n: number) => Number(env.rent(n)),
      getBalance: async (k: PublicKey) => Number(env.lamports(k)),
    };
    this.dbc = new DynamicBondingCurveClient(this.conn, 'confirmed');
  }
  get slot() { return this.env.slot; }
  warp(slots: bigint) { this.env.warpToSlot(this.slot + slots); }
  /** Sign and send a built tx (signers[0] pays). */
  send(tx: Transaction, signers: Keypair[]) {
    tx.recentBlockhash = this.env.latestBlockhash();
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    return this.env.sendTx(tx);
  }
  lamports(k: PublicKey) { return this.env.lamports(k); }
}

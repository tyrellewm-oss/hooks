// Shared offline helper: the recorded devnet TDT / FW15 mint accounts (tests/fixtures/devnet_tdt_mint_hook.json).
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/devnet_tdt_mint_hook.json', import.meta.url), 'utf8'));
export const MINT_HOOK_FIXTURE = fx;
export type FixtureName = 'tdt_pre' | 'tdt_post' | 'fw15_pre';
/** The recorded account as getAccountInfo returns it (fresh Buffer each call, so tests may mutate it). */
export function fixtureMint(name: FixtureName) {
  const r = fx[name];
  return { pubkey: new PublicKey(r.pubkey), info: { owner: new PublicKey(r.owner), executable: false, lamports: Number(r.lamports), data: Buffer.from(r.data_base64, 'base64') } };
}
/** Offset of the 64-byte TransferHook value (authority 32 + program_id 32) inside the recorded mint data. */
export const TRANSFER_HOOK_OFFSET: number = fx.tdt_pre.transfer_hook_offset;

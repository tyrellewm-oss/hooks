// Launch + trade helpers for the local simulation, using the same builders the server uses
// (curveConfigParams, buildCreatePoolTx) so what passes here is what the site sends.
import BN from 'bn.js';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { curveConfigParams, buildCreatePoolTx, type LaunchOpts } from '../../sdk/launch.js';
import { TOKEN_2022 } from '../../sdk/hook.js';
import { HOOK_PROGRAM } from './programs.js';
import type { Sim } from './env.js';

export interface Launched { mint: PublicKey; config: PublicKey; pool: PublicKey; launchSlot: bigint }

export function hookAdmin(sim: Sim) {
  const admin = Keypair.generate(), launch = Keypair.generate();
  sim.env.fund(admin.publicKey); sim.env.fund(launch.publicKey);
  const r = sim.env.initGlobal(admin.publicKey);
  if (!r.ok) throw new Error('hook global init failed:\n' + r.logs.join('\n'));
  // migrate_global_v2 resizes Global (42 -> 74 bytes); litesvm's Linux build aborts (std::bad_alloc) on account
  // resizes, so write the migrated state directly: the v1 bytes unchanged + the launch key at 42..74.
  const g = sim.env.hook.globalPda();
  const v1 = sim.env.accountData(g)!;
  if (v1.length !== 42) throw new Error(`unexpected Global length ${v1.length}`);
  sim.env.setAccountData(g, Buffer.concat([v1, launch.publicKey.toBuffer()]));
  return { admin, launch };
}

/** Config (own tx) then create-pool + hook config (one tx), exactly as Launchpad.launch / buildUserLaunch build them.
 *  `configOverride` lets a caller swap fee settings the shared builder does not expose yet. */
export async function launchToken(sim: Sim, keys: { admin: Keypair; launch: Keypair }, o: LaunchOpts, configOverride: (p: any) => any = (p) => p): Promise<Launched> {
  const payer = sim.env.payer;
  const configKp = Keypair.generate(), mintKp = Keypair.generate();
  const cfgTx: Transaction = await sim.dbc.partner.createConfigWithTransferHook({
    config: configKp.publicKey, feeClaimer: payer.publicKey, leftoverReceiver: payer.publicKey, payer: payer.publicKey,
    quoteMint: NATIVE_MINT, transferHookProgram: HOOK_PROGRAM, ...configOverride(curveConfigParams(o)),
  } as any);
  const r1 = sim.send(cfgTx, [payer, configKp]);
  if (!r1.ok) throw new Error('create config failed:\n' + r1.logs.slice(-12).join('\n'));
  const auth = { upgradeAuthority: sim.env.upgradeAuth.publicKey.toBase58(), liftAuthority: keys.admin.publicKey.toBase58(), launchAuthority: keys.launch.publicKey.toBase58() };
  const poolTx = await buildCreatePoolTx({ dbc: sim.dbc, hook: sim.env.hook }, o, { payer: payer.publicKey, config: configKp.publicKey, mint: mintKp.publicKey, launchAuthority: keys.launch.publicKey }, auth);
  const launchSlot = sim.slot;
  const r2 = sim.send(poolTx, [payer, mintKp, keys.launch]);
  if (!r2.ok) throw new Error('create pool failed:\n' + r2.logs.slice(-15).join('\n'));
  return { mint: mintKp.publicKey, config: configKp.publicKey, pool: deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, configKp.publicKey), launchSlot };
}

export function trader(sim: Sim, sol = 50n) {
  const k = Keypair.generate();
  sim.env.fund(k.publicKey, sol * 1_000_000_000n);
  return k;
}

/** Buy on the curve with exact SOL in (the DBC SDK's own swap builder, transfer-hook accounts resolved). */
export async function buy(sim: Sim, l: Launched, who: Keypair, lamports: bigint) {
  const virtualPool: any = await sim.dbc.state.getPool(l.pool);
  const tx: Transaction = await (sim.dbc.pool as any).swap2WithTransferHook({
    owner: who.publicKey, pool: l.pool, swapBaseForQuote: false, referralTokenAccount: null,
    amountIn: new BN(lamports.toString()), minimumAmountOut: new BN(0), swapMode: 0,
  });
  const quoteFeesBefore = await quoteFees(sim, l.pool);
  const tokensBefore = tokenBalance(sim, l.mint, who.publicKey);
  const r = sim.send(tx, [who]);
  const tokens = tokenBalance(sim, l.mint, who.publicKey) - tokensBefore;
  const fee = (await quoteFees(sim, l.pool)) - quoteFeesBefore;
  return { ...r, tokens, fee, feePct: Number(fee * 1_000_000n / lamports) / 10_000, virtualPool };
}

export function tokenBalance(sim: Sim, mint: PublicKey, owner: PublicKey) {
  return sim.env.balance(getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022));
}

/** Total trading fees the pool has collected in SOL (partner + creator + protocol + referral shares). */
export async function quoteFees(sim: Sim, pool: PublicKey): Promise<bigint> {
  const p: any = await sim.dbc.state.getPool(pool);
  const f = (x: any) => BigInt((x ?? 0).toString());
  return f(p.partnerQuoteFee) + f(p.creatorQuoteFee) + f(p.protocolQuoteFee);
}

export const sys = SystemProgram;

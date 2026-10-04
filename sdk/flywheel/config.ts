// Keeper config (spec §13 C8). Addresses only; key *names* refer to files in the gitignored key dir, never key material.
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { KeyRuleRefusal } from '../keyrules.js';
import type { PriceSourceConfig } from './price_source.js';

export interface SourceDbc { kind: 'dbc'; pool: string; config: string; base_mint: string }
export interface SourceDamm { kind: 'damm_v2'; pool: string; position: string; position_nft_mint: string }
export type Source = SourceDbc | SourceDamm;

export interface KeeperConfig {
  name: string;
  cluster: 'devnet' | 'local' | 'mainnet' | string;
  main_mint: string; main_decimals: number; main_token_program: string;
  main_dbc_pool: string;
  route: 'damm_v2_direct'; route_pool: string | null;
  sources: Source[];
  /** Key file names for the keys the keeper SIGNS with. There is no dev entry: the dev wallet only receives. */
  keys: { claim_signer: string; treasury: string; gas: string };
  pinned_pubkeys?: { claim_signer?: string; treasury?: string; gas?: string };
  /** Dev payout destination (15% of each claim, as wSOL to its token account). A pubkey only: the keeper never signs
   *  as the dev wallet, so it never loads a dev keypair. */
  dev_payout: string;
  hook_program: string;
  hook_upgrade_authority: string | null; hook_lift_authority: string | null;   // pinned; verified on chain at start
  max_swap_lamports_per_run: string;
  max_slippage_bps: number; max_price_impact_bps: number; max_halvings: number; price_band_pct: number;
  min_claim_lamports: string; cadence_seconds: number; auto_pause_after_failures: number;
  gas_min_lamports: string;
  state_dir: string; public_log: string;
  force_fail_swap?: boolean; paused?: boolean;
  /** Ticket #5: TWAP, independent price and min_out settings. Required: a missing or invalid value refuses (checkPriceConfig). */
  price_source: PriceSourceConfig;
  /** devnet-only: scripted trades between unattended runs (lamports bought then sold back on route_pool). */
  test_trades_between_runs?: string;
}

/** The keys the keeper loads and signs with. Every one of them goes through the §12a key-separation checks. */
export const KEEPER_KEY_ROLES = ['claim_signer', 'treasury', 'gas'] as const;
export type KeeperKeyRole = (typeof KEEPER_KEY_ROLES)[number];

/** Offline key-config check, run before any key file is opened. Throws KeyRuleRefusal:
 *  - `keys` may only name the signing roles; a dev keypair path (`keys.dev`) is refused, so no unneeded secret is kept;
 *  - `pinned_pubkeys.dev` is refused too (the dev wallet is configured once, as `dev_payout`);
 *  - `dev_payout` must be a valid on-curve wallet address (its wSOL token account is derived from it). */
export function checkKeyConfig(cfg: KeeperConfig): void {
  const keys = (cfg as any).keys;
  if (!keys || typeof keys !== 'object') throw new KeyRuleRefusal('refusing: config has no keys section');
  for (const role of Object.keys(keys)) {
    if (role === 'dev') throw new KeyRuleRefusal(`refusing: keys.dev is set, but the keeper never signs as the dev wallet. Delete the dev keypair path from the config (and do not keep that secret for the keeper); set "dev_payout" to the dev wallet's pubkey instead`);
    if (!(KEEPER_KEY_ROLES as readonly string[]).includes(role)) throw new KeyRuleRefusal(`refusing: unknown key role keys.${role} (allowed: ${KEEPER_KEY_ROLES.join(', ')})`);
  }
  for (const role of KEEPER_KEY_ROLES) if (typeof keys[role] !== 'string' || keys[role] === '') throw new KeyRuleRefusal(`refusing: keys.${role} is missing`);
  for (const role of Object.keys(cfg.pinned_pubkeys ?? {})) {
    if (role === 'dev') throw new KeyRuleRefusal('refusing: pinned_pubkeys.dev is not used; the dev wallet is configured once, as "dev_payout"');
    if (!(KEEPER_KEY_ROLES as readonly string[]).includes(role)) throw new KeyRuleRefusal(`refusing: unknown pinned_pubkeys.${role}`);
  }
  const d = (cfg as any).dev_payout;
  if (typeof d !== 'string' || d === '') throw new KeyRuleRefusal('refusing: dev_payout (the dev wallet pubkey) is missing');
  let pk: PublicKey; try { pk = new PublicKey(d); } catch { throw new KeyRuleRefusal(`refusing: dev_payout is not a valid address: ${d}`); }
  if (!PublicKey.isOnCurve(pk.toBytes())) throw new KeyRuleRefusal(`refusing: dev_payout ${d} is off-curve (a PDA); it must be a wallet address`);
}

/** `--dev-payout <pubkey>` for setup scripts (scripts/flywheel_fw15.ts): required, and validated like `dev_payout`
 *  (a valid, on-curve wallet address). The operator names the dev wallet; nothing is generated or thrown away. */
export function devPayoutArg(argv: string[]): string {
  const i = argv.indexOf('--dev-payout');
  const d = i >= 0 ? argv[i + 1] : undefined;
  if (!d || d.startsWith('--')) throw new KeyRuleRefusal('refusing: --dev-payout <pubkey> is required (the dev wallet that receives the 15% payout)');
  let pk: PublicKey; try { pk = new PublicKey(d); } catch { throw new KeyRuleRefusal(`refusing: --dev-payout is not a valid address: ${d}`); }
  if (!PublicKey.isOnCurve(pk.toBytes())) throw new KeyRuleRefusal(`refusing: --dev-payout ${d} is off-curve (a PDA); it must be a wallet address`);
  return pk.toBase58();
}

/** Env overrides are test knobs (devnet). Returns the config plus a list of active overrides (logged in every run). */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): { cfg: KeeperConfig; overrides: string[] } {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as KeeperConfig;
  checkKeyConfig(cfg);   // every CLI command refuses a config that still carries a dev keypair path
  return applyOverrides(cfg, env);
}
export function applyOverrides(base: KeeperConfig, env: NodeJS.ProcessEnv): { cfg: KeeperConfig; overrides: string[] } {
  const cfg: KeeperConfig = JSON.parse(JSON.stringify(base));
  const o: string[] = [];
  const set = (envKey: string, f: (v: string) => void) => { const v = env[envKey]; if (v !== undefined && v !== '') { f(v); o.push(`${envKey}=${v}`); } };
  set('FW_MAX_SWAP_LAMPORTS', v => (cfg.max_swap_lamports_per_run = BigInt(v).toString()));
  set('FW_MIN_CLAIM_LAMPORTS', v => (cfg.min_claim_lamports = BigInt(v).toString()));
  set('FW_MAX_IMPACT_BPS', v => (cfg.max_price_impact_bps = Number(v)));
  set('FW_CADENCE_SECONDS', v => (cfg.cadence_seconds = Number(v)));
  set('FW_FORCE_FAIL_SWAP', v => (cfg.force_fail_swap = v === '1'));
  set('FW_PAUSED', v => (cfg.paused = v === '1'));
  set('FW_ROUTE_POOL', v => (cfg.route_pool = v));
  set('FW_PUBLIC_LOG', v => (cfg.public_log = v));
  set('FW_STATE_DIR', v => (cfg.state_dir = v));
  set('FW_CLUSTER', v => (cfg.cluster = v));
  return { cfg, overrides: o };
}

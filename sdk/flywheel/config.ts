// Keeper config (spec §13 C8). Addresses only; key *names* refer to files in the gitignored key dir, never key material.
import { readFileSync } from 'node:fs';

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
  keys: { claim_signer: string; treasury: string; dev: string; gas: string };   // key file names
  pinned_pubkeys?: { claim_signer?: string; treasury?: string; dev?: string; gas?: string };
  hook_program: string;
  hook_upgrade_authority: string | null; hook_lift_authority: string | null;   // pinned; verified on chain at start
  max_swap_lamports_per_run: string;
  max_slippage_bps: number; max_price_impact_bps: number; max_halvings: number; price_band_pct: number;
  min_claim_lamports: string; cadence_seconds: number; auto_pause_after_failures: number;
  gas_min_lamports: string;
  state_dir: string; public_log: string;
  force_fail_swap?: boolean; paused?: boolean;
  /** devnet-only: scripted trades between unattended runs (lamports bought then sold back on route_pool). */
  test_trades_between_runs?: string;
}

/** Env overrides are test knobs (devnet). Returns the config plus a list of active overrides (logged in every run). */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): { cfg: KeeperConfig; overrides: string[] } {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as KeeperConfig;
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

# Ticket #5: independent price source for the keeper buyback

**Status (2026-10-04):** done on branch `feat/flywheel-price-source` (base `main` `1bfd402`, code commit `d139102`). Pushed. **No PR opened and not merged.** The PR step was skipped at the owner's request; `main` is unchanged. A reviewer still has to open the PR and merge it (see "Next steps").

Spec: research note `blocker5_price_source.md` (internal; §3 design and defaults, §4 criteria 1-17, mutants table).

## What changed
Before any swap is built (after graduation, on the pinned DAMM v2 pool), the keeper now checks, in order. Every failure refuses, builds nothing and sends nothing:

| # | Check | Refusal |
|---|---|---|
| 1 | `price_source` config is valid | `refuse_config` |
| 2 | Pinned route pool, its mints are a registry mint and wSOL, token order is (main mint, wSOL) | `mismatch_pool` / `mismatch_registry` (+ pause) |
| 3 | Chain time of the current slot exists | `refuse_twap_stale` |
| 4 | Graduation is at least `min_post_grad_age_s` old | `hold_twap_warmup` |
| 5 | Samples: same pool, one sampler session covering a full window, coverage, gaps, freshness | `mismatch_pool`, `refuse_twap_coverage`, `refuse_twap_stale` |
| 6 | Spot vs TWAP within `max_spot_twap_dev_bps` | `refuse_spot_vs_twap` |
| 7 | Jupiter Price API v3 (one call, both ids, `blockId` fresh) vs TWAP within `max_indep_twap_dev_bps` | `refuse_indep_unavailable`, `refuse_indep_vs_twap` |

Then `min_out = min(quoteOut, twapOut(in)) × (10,000 − slippage − impact) / 10,000` (spec §3.7).

Main's existing quote-vs-spot check (slippage + impact) and auto-pause are unchanged. The new checks add to them.

Other parts:
- **Warm-up holds:** they don't count toward auto-pause until they last longer than `twap_window_s + 900 s` (2,700 s) of chain time. The ceiling is fixed, not a config key. The hold start is saved in the state file (`price_hold`) next to the graduation slot (`price_grad`), so it survives sampler and keeper restarts.
- **Sampler:** read-only and keyless. One pool read per 15 s, stored as JSONL in `<state_dir>/price_samples.jsonl` as (pool, slot, block time, sqrt_price, session). A torn last line is cut at start and before each append.
- **Jupiter:** `https://api.jup.ag/price/v3`, keyless by default. The optional `FW_JUPITER_API_KEY` is sent only as the `x-api-key` header and is redacted everywhere.
- **Scrubbing:** URL `user:pass@` and credential query values are removed from `run.reason`, the state file and the public log. For fetch errors, only `cause.code` is logged.

Files: `sdk/flywheel/price_source.ts` (new), `sdk/flywheel/keeper.ts`, `sdk/flywheel/config.ts`, `sdk/flywheel/dryrun.ts`, `sdk/redact.ts`, `sdk/registry.ts`, `scripts/flywheel.ts`, `keeper/devnet.*.json`, `tests/price_source.test.ts` (new), `scripts/mutants_price_source.ts` (new), README env table.

## Parameters (spec defaults, in `keeper/devnet.tdt.json` and `keeper/devnet.fw15.json`)
| Param | Value |
|---|---|
| `sample_interval_s` | 15 |
| `twap_window_s` | 1800 |
| `min_coverage_pct` | 80 |
| `max_sample_gap_s` | 60 |
| `max_latest_sample_age_s` | 30 |
| `max_spot_twap_dev_bps` | 300 |
| `max_indep_twap_dev_bps` | 500 |
| `indep_max_age_slots` | 150 |
| `require_independent` | true |
| `min_post_grad_age_s` | 1800 |

Config fails closed: a missing, unknown or out-of-range key, a 0 s window, any `*_bps` above 2,000, or a non-boolean `require_independent` refuses to start.

## Testing (LOCAL)
- `CI_SKIP_CARGO=1 pnpm check`: 361 tests, 325 pass, 33 fail, 2 skipped. The 33 are the same setup failures as on `main`, nothing new:
  - 32 in `tests/hook.test.ts` need `target/deploy/*.so` (no Rust or Solana toolchain on the machine).
  - 1 in `tests/resolve_cluster_local.test.ts` times out because macOS doesn't answer on `127.0.0.2`.
  - Parse check, forbidden-word scan, secret scan and mainnet grep: all pass.
- Keeper, flywheel, price-source, redact and registry tests: 132/132 pass. `tests/price_source.test.ts` has one test per criterion 1-17 plus boundary tests:
  - Spot ±300 at the default limit (largest passing Q64 sqrt, then one step past it).
  - Exact-equality limits: +201 / −1,900 with sqrt 101·X64 and 90·X64 against 100·X64.
  - Independent price ±500 passes, ±501 refuses.
  - Warm-up 2,700 s passes, 2,701 s counts, including across a sampler restart and a keeper restart.
  - API key header, no-leak, token order and torn tail.
- Mutants: `node --import tsx scripts/mutants_price_source.ts` → 47 killed, 0 survived.

## Known limits
- A missing or stale sampler means refuse (the safe default). The keeper pauses once the warm-up ceiling has passed.
- Future-dated samples (block time after the current slot) are ignored.
- No live mainnet test. Criterion 17's devnet run (a scripted "pump before run" on the devnet pool) hasn't been done. It's covered offline only, with a fake Jupiter HTTP server.
- If our DAMM v2 pool is the only liquidity, Jupiter prices from that same pool. The independent check then catches a stale or broken read, not a pump. A pump held for the whole 30-min window gets through; the defence is the window plus the max per run.
- **Needs confirmation:** with the spec's min_out formula, the quote leg also loses the impact bps. When the quote binds, min_out is up to `max_price_impact_bps` (200 bps) lower than the earlier WIP's `quoteOut × (1 − slippage)`.

## Next steps / open
1. Open the PR `feat/flywheel-price-source` → `main` (title `keeper (ticket #5): independent price source`), review, merge (King). The `gh` CLI isn't installed on the Mac; use the GitHub web UI or install `gh`.
2. Owner decisions: ★ values (window, bands, `require_independent`, max per run), where the sampler runs, mainnet RPC provider and Jupiter key choice.
3. Criterion 17 live devnet run.
4. Ticket 8.3 (launch authority) needs the Rust, Solana and Anchor toolchain; then 8.3b (admin rotation spec).

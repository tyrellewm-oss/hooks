# hooks: DEVNET prototype

> ## ⚠️ UNAUDITED EXPERIMENT: DEVNET ONLY, NOT FOR MAINNET
> **DEVNET TEST: no real value.** This is an unaudited experiment. The code has had internal and volunteer review only, no paid audit. It is experimental and may have bugs. There is no mainnet code path anywhere in this repo (mainnet RPCs are refused at runtime and in CI). Not an investment and not financial advice. Nobody promises any price, gain or future work.

## What it is
A launchpad prototype on Solana **devnet**:
- **Meteora Dynamic Bonding Curve (DBC)** pools for Token-2022 tokens, with a **transfer hook** attached while the token is on the curve.
- The transfer-hook program (`programs/trenches-hook`, program id `FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz`) enforces one rule on the curve: **each receiving token account can hold at most X% of supply, and X only rises** (it can't be tightened, only lifted).
- A minimal launch page (`app/`) with a pre-trade checklist, a rules-and-risks block and a "Why did my trade fail?" explainer, plus an SDK (`sdk/`), scripts and tests.

## Status (as of 2026-10-04 ICT)
- **DEVNET LIVE** (2026-10-04 ICT): the program is deployed on devnet at [`FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz`](https://explorer.solana.com/address/FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz?cluster=devnet) (devnet only, throwaway upgrade key). One test launch ran on devnet from launch to DAMM v2 migration: cap hit, sells, graduation, post-migration buy. Every tx is linked in [`launch_log.md`](launch_log.md).
- Devnet program sha256: `02d402bc2e2db90d69c6eb7155483364d7afca1cc500c010a90e5de36927bead` (release build of commit `f8803e8`; the program dumped from devnet has the same sha256).
- Other results (replay, litesvm, local validator) are LOCAL.
- **`solana-verify` has not been run** (its Docker build image does not fit this box's disk); see "Verifiable build" below.
- QA (Deployer QA) reviews every PR. QA's material lives on its own branch (`qa/devnet-v0`) and isn't part of this package.

## Design limits (read these before using it)
Wording follows the page copy (`research/page_content.md`, v0-devnet-2026-10-04e, Research), which is what the page shows to users.

1. **Unaudited experiment, devnet only.** Internal and volunteer review only, no paid audit. DEVNET TEST: no real value. Not an investment.
2. **The cap is per token account, not per wallet.** A single wallet may own several token accounts, and anyone can split across wallets, so this slows snipers down but does not stop them.
3. **The cap ends at graduation or after the ramp (`uncapped_after`), whichever comes first.** When the curve completes (graduation), Meteora DBC removes the hook and the token becomes a plain Token-2022 token on DAMM v2 with no cap. After that, including buys from the pool right after migration, there is no cap.
4. **Selling back into the curve is never blocked by the rule.** The pool vault and the graduation (migration) path are exempt from the cap.
5. **Admin power.** Program upgrades are controlled by the upgrade key (on devnet: a throwaway devnet test key). The same key has one switch that can only lift the rule (raise or remove the cap), never add or tighten it. Every use of the switch emits an on-chain `RestrictionsLifted` event and is announced (announcement channel TBD; the page lists the switch history).
6. **Anti-sniper fee: curve only, and it applies to every buyer, not only bots.** Buying in the first part of the fee schedule costs more; if you don't want to pay it, wait until it reaches the end fee. After migration, only the pool's flat trading fee applies (no anti-sniper fee).
7. **What is approved and what isn't.**
   - **Approved (King, Oct 4, 2026): the Balanced cap schedule.** 1% of supply per token account from launch, 2% from slot +150, 4% from slot +1,500, and no cap after slot +4,500 (about 30 min at ~0.4 s/slot, an estimate). Defined in `sdk/schedules.ts`.
   - **Not approved: fees, curve size and supply sold.** The values below are only the **current devnet defaults, pending King's decision** (`DEFAULT_LAUNCH_FEES` and `DEFAULT_PERCENTAGE_SUPPLY_ON_MIGRATION` in `sdk/launch.ts`; the page fills them from each launch's config, never hard-coded):

     | Setting | Current devnet default (not approved) |
     |---|---|
     | Anti-sniper fee (curve only) | starts at 50%, falls to 1% over 150 slots (10 steps; ~1 min, estimate), then stays at 1% until graduation |
     | Pool fee after migration | 0.25% flat (DAMM v2, `MigrationFeeOption.FixedBps25`) |
     | Creator trading-fee share | 0% (non-protocol share goes to the studio test key; Meteora takes its protocol share) |
     | Curve size (migration threshold) | 1 SOL by default in the SDK (the devnet demo command below uses `--threshold 0.2`) |
     | Supply sold on the curve | 80% (`percentageSupplyOnMigration` 20: 20% goes to the DAMM v2 pool at graduation; option range 1–49) |

### Replay results (LOCAL simulation, not on-chain)
From `docs/replay_results_v0.md` (generated by `scripts/replay_report.ts`, checked by `tests/replay.test.ts`): Research's 5 mainnet bonding-curve launch fixtures (read-only data, anonymised as fixtures A–E) replayed through the same cap math the program uses, per token account.
- Under Balanced (1% cap at slot +0), every crew curve buy in the fixtures is blocked as-is. The crews bought 78.00–79.31% of supply per fixture, and each buy would put a token account over the cap.
- That does **not** stop a determined crew: with the **same** token accounts, a resized crew still reaches up to 4.00%. To reach its original curve share at the slot-0 cap, a crew needs ~78–80 token accounts, and splitting across accounts defeats any per-account cap.
- **Post-graduation buys are uncapped. This is a design limit.** In 3 of the 5 fixtures (C, D, E), one wallet bought ~20% (20.11–20.34%) from the new pool right after migration. No schedule stops that, because the hook is gone after graduation.
- Caveats: simulation of the cap math only (no program, DBC, prices or fees; the anti-sniper fee isn't modelled). All fixture curve buys are at slot +0, so later steps aren't exercised. In fixtures D and E, the link between the crew wallets is inferred, not proven. See the full doc for all assumptions.

## Known limitations
- **Signing (AC-21), by page.** Studio launches in the new front end (`web/`) are signed in the user's browser wallet (`/api/studio/launch/build` + `/submit`, `sdk/launch_user.ts`); the server co-signs only with the launch key that ticket 8.3 pins on chain plus the fresh config/mint keypairs, and relays only transactions it built. Trades have browser-wallet endpoints (`/api/wallet/build` + `/submit`, `sdk/wallet_tx.ts`) but the new token page has no buy/sell panel yet. The classic page (`app/public`, the e2e target) still signs on the backend with devnet throwaway keys created on your machine.
- It binds to 127.0.0.1 only, its endpoints are unauthenticated, and it must not be exposed or hosted.
- Browser-wallet signing (AC-21) is required before any hosted or public page: done for studio launches in `web/`; the classic page's server-signed trades (QA item PR 3 / H-7) remain accepted only for the LOCAL/devnet demo and must not be hosted.
- The optional hooks (max single buy, per-slot buy limit, buy pot, slow mode) need the v2 hook program; a creator lock (DBC locked vesting: 1-10% of supply for the creator, unlocked in one piece a chosen number of slots after migration) is config-only and works on the current devnet program. **The devnet program is still the v1 build** (`launch_log.md`: last upgrade `5290ec1`), so a devnet launch with any optional hook on is refused with the "needs the program upgrade" hint until the v2 build is deployed.
- The on-chain error text ('Destination token account would be over the current cap', error code `WalletCapExceeded`) is in the devnet build; the raw cap-hit logs are in `launch_log.md`.
- Everything in "Design limits" above also applies.

## Layout
| Path | What |
|---|---|
| `crates/cap-math` | pure `no_std` cap math (`validate`, `cap_at`, `next_change`, `effective_cap`, lift rules) plus proptests |
| `sdk/capMath.ts` | TS mirror of cap-math (used by the page and tests; parity-tested) |
| `programs/trenches-hook` | Anchor program: `initialize_global`, `migrate_global_v2` / `set_launch_authority` (8.3, separate launch key), `initialize_extra_account_meta_list`, `transfer_hook`, `lift_global`, `lift_mint_cap`, `raise_mint_cap`, `view_schedule` |
| `sdk/` | `hook.ts` hand-written client, `launch.ts` DBC flow, `cluster.ts` (LOCAL default; devnet only with a flag; mainnet refused), `keys.ts` (throwaway keys) |
| `scripts/` | `build.sh`, `ci.sh`, `local_validator.sh`, `dbc_flow.ts`, `qa_schedule.ts`, `airdrop_loop.sh` |
| `app/` | launch page (`server.ts` + `public/`) |
| `web/` | new launch page front end (Vite + React), work in progress: same backend API, same copy and cap math as `app/public` |
| `tests/` | litesvm integration tests (LOCAL), TS parity tests, `e2e/page.e2e.ts` |

## Setup
Requirements: see Toolchain below.
```bash
pnpm install
```
No secrets are needed for the LOCAL flow. Throwaway keys are created on first use in `.devnet-keys/` / `.local-keys/` (gitignored, mode 600). **Never commit keys.**

Environment variables (names only; all optional):

| Name | Used in | Purpose |
|---|---|---|
| `DEVNET_RPC` | `sdk/cluster.ts`, `tests/env.ts` | devnet RPC override (anything containing "mainnet" is refused; the genesis hash must be devnet's) |
| `LOCAL_RPC` | `sdk/cluster.ts`, `tests/env.ts` | local validator RPC override |
| `HOOK_PROGRAM_ID` | `sdk/hook.ts` | hook program id override: allowed on devnet and on a local validator (localhost RPC URL + a genesis that is not devnet/mainnet/testnet), where it is required; refused on any other cluster (genesis-pinned, no fallback to the devnet id) |
| `DAMM_V2_MIGRATION_CONFIG` | `sdk/launch.ts` | DAMM v2 migration config override: allowed on devnet and on a local validator; elsewhere it must equal the pinned value (genesis-pinned) |
| `TXLOG_DIR` | `sdk/launch.ts` | tx log directory override (default: the repo's tx log dir; tests point it at a temp dir) |
| `HOOK_SO`, `HOOK_TEST_SLOTS_SO` | `tests/env.ts`, `scripts/local_validator.sh` | paths to the release / test-slots `.so` |
| `PORT` | `app/server.ts` | launch page port (default 5175) |
| `PAGE_URL`, `CHROME`, `MINT` | `tests/e2e/page.e2e.ts` | e2e page URL, headless Chrome path, existing mint to test |
| `REPLAY_FIXTURES_DIR` | `scripts/replay_report.ts` | Research replay fixtures directory |
| `CI_SKIP_CARGO`, `CI_PROGRAM_HOST`, `PROPTEST_CASES` | `scripts/ci.sh`, `crates/cap-math` | CI switches (skip cargo tests / run program host tests / proptest case count) |
| `CLONE_URL` | `scripts/local_validator.sh` | devnet RPC to clone Meteora programs from |
| `STUDIO_WALLETS` | `app/server.ts`, `sdk/studio_auth.ts` | comma-separated wallet addresses allowed into the studio (create a launch, edit token details); they sign in by signing a challenge message. Unset: studio **closed** on devnet, open on a local validator. A malformed entry stops the server at start |
| `FW_JUPITER_API_KEY` | `sdk/flywheel/price_source.ts` | optional Jupiter Price API key for the keeper's independent price check; sent only as the `x-api-key` header and redacted everywhere. Unset: keyless |

## Tests
```bash
pnpm check                       # = scripts/ci.sh: cap-math cargo tests + proptests, LOCAL litesvm + TS tests,
                                 #   forbidden-word scan of page copy, secret scan (full history), mainnet grep
CI_SKIP_CARGO=1 pnpm check       # same without the cargo step (JS/copy-only changes)
pnpm test                        # node --test tests/*.test.ts (litesvm integration, parity, copy, schedules, replay)
node --import tsx --test tests/replay.test.ts   # replay tests only (uses tests/fixtures/replay_v0.min.json)
node --import tsx scripts/replay_report.ts      # regenerate docs/replay_results_v0.md (needs REPLAY_FIXTURES_DIR)
node --import tsx scripts/mutants_price_source.ts   # mutation check of the keeper price checks (each mutant must fail a test)
node --import tsx scripts/mutants_launch_authority.ts   # mutation check of the 8.3 launch-key separation (rebuilds the .so per Rust mutant)
node --import tsx scripts/launch_authority.ts migrate --launch <pubkey> --admin <pubkey> [--cluster devnet]   # 8.3 Global migration: DRY RUN unless --send
cargo test -p cap-math                          # cap math unit + proptests
PROPTEST_CASES=1000000 cargo test -p cap-math --release
pnpm build                       # = scripts/build.sh (cargo build-sbf; release build, test-slots OFF)
anchor build                     # alternative if your anchor toolchain works (anchor idl build doesn't in our setup)
```
Last run (LOCAL, macOS arm64, 2026-10-04): `CI_PROGRAM_HOST=1 pnpm check` ALL GREEN: cap-math cargo tests + proptests (20,000 cases), program host tests 2/2, 398 node tests pass, 2 named skips (the anonymised full replay fixtures are not in the repo; the 127.0.0.2 case needs `sudo ifconfig lo0 alias 127.0.0.2` on macOS).

## Toolchain
Versions come from the repo's pins where there is one (`Anchor.toml`, `Cargo.toml`, `pnpm-lock.yaml`); otherwise the tested version is given.
1. **Rust** via [rustup](https://rustup.rs) (stable). The crates declare `rust-version = "1.84"`; the Solana platform tools ship their own cargo for SBF builds.
2. **Solana / Agave CLI 3.0.x** (tested with 3.0.14; provides `cargo build-sbf` and `solana-test-validator`). Install from the official Anza release.
3. **Anchor CLI 0.32.2** (`Anchor.toml` `anchor_version`; the program uses `anchor-lang` / `anchor-spl` 0.32.1). `avm install 0.32.2 && avm use 0.32.2`.
4. **Node.js 20+** (tested with 20.19.2) and **pnpm 10** (tested with 10.33.4; lockfile v9). No `engines` pin yet.
5. `pnpm install`, then `pnpm check` (see Tests).

Note: the TS client in `sdk/hook.ts` is hand-written from the Anchor discriminators (no generated IDL).

## Build (details)
```bash
pnpm build      # = scripts/build.sh (refuses to build when < 1.5 GB is free on /)
```
It produces two artifacts:

| Artifact | Command | Use |
|---|---|---|
| `target/deploy/trenches_hook.so` | `cargo build-sbf --manifest-path programs/trenches-hook/Cargo.toml --sbf-out-dir target/deploy` | **The only artifact ever deployed to devnet. test-slots is OFF (no `--features`).** |
| `target/deploy-test-slots/trenches_hook.so` | `cargo build-sbf --manifest-path programs/trenches-hook/Cargo.toml --features test-slots --sbf-out-dir target/deploy-test-slots` | LOCAL only (litesvm / local validator) |

**AC-5: `test-slots` must be OFF in every devnet build.** Release limits: at least 10 slots per step and a ramp of at least 150 slots (~1 min). test-slots limits: 1 slot per step and a ramp of 2 slots. Every build has a maximum ramp of 6,480,000 slots (~30 days, estimate).

### Checking which schedule is active (QA)
- Every `MintConfig` PDA stores `test_slots_build` (true only if the config was written by a test-slots binary), along with the frozen steps and `uncapped_after`.
- At init, and on every `view_schedule` call, the program logs (example, demo schedule):
  ```
  schedule: mint=… launch_slot=… supply_ref=… uncapped_after=300 test_slots_build=false
  schedule step: offset=0 max_bps=100
  schedule step: offset=150 max_bps=200
  build: profile=release min_step_slots=10 min_ramp_slots=150
  ```
  `view_schedule` also sets a Borsh `ScheduleView` as its return data.
- One command checks all of it (read-only: reads accounts and simulates `view_schedule`; no signing, no fee):
  ```bash
  pnpm qa-schedule <mint> --cluster devnet
  ```
  It prints the upgrade authority, whether the deployed bytes match `target/deploy/trenches_hook.so` (release) or the test-slots build, the frozen schedule, the program's own logs, and a VERDICT line. LOCAL example: `launches/local/CZbnd…qa_schedule.txt` (LOCAL run record, kept in local history only; not in the public repo).

## LOCAL validator (Meteora programs cloned from devnet)
```bash
pnpm validator           # solana-test-validator: clones DBC + DAMM v2 + DAMM configs from devnet, loads target/deploy/trenches_hook.so,
                         # and deactivates the 28 features that are inactive on devnet (scripts/devnet_inactive_features.txt)
pnpm demo                # LOCAL: launch -> buy -> cap hit -> sells mid-ramp -> cap rises -> no cap -> curve fill -> DAMM v2 migration
pnpm lift-demo           # LOCAL: lift the cap to 3% -> lower (fails) -> lift -> re-enable (fails), each use emits RestrictionsLifted
pnpm test                # node test suite (litesvm uses target/deploy/*.so; no validator needed)
```
The local ledger grows quickly. It's capped with `--limit-ledger-size 500000`. Delete `test-ledger/` when you're done.

## Devnet deploy (throwaway key; explicit flag required)
```bash
# keys are created on first use in .devnet-keys/ (gitignored, mode 600); never commit them
pnpm build    # release .so, test-slots OFF
solana program deploy target/deploy/trenches_hook.so \
  --program-id .devnet-keys/trenches_hook-keypair.json --keypair .devnet-keys/deployer.json \
  --url https://solana-devnet.api.onfinality.io/public
node --import tsx scripts/dbc_flow.ts demo --cluster devnet --threshold 0.2 --wallet-sol 0.3   # default schedule on devnet: Balanced ("approved by King (Oct 4, 2026)"); ~30 min ramp. --schedule demo for a 2-min ramp
node --import tsx scripts/dbc_flow.ts lift-demo --cluster devnet
pnpm qa-schedule <mint> --cluster devnet
```
- Env vars: `DEVNET_RPC` (optional devnet RPC override; anything containing "mainnet" is refused, and the genesis hash must be devnet's), `HOOK_PROGRAM_ID` (override; devnet or a local validator only, required for a local validator), `CHROME` (e2e browser path).
- Cost estimate: about 2.8 SOL of rent for the 393 KB program plus about 0.5–1 SOL for the demos (estimate). All devnet SOL, no real value.
- Every devnet tx is appended to `txlog/devnet.jsonl` (local, gitignored) with its explorer link (`?cluster=devnet`), ICT time and purpose.

## Flywheel keeper (devnet)

Monitoring (go-live G7, detection half): `node --import tsx scripts/keeper_watch.ts --cluster devnet [--loop 60]` reads the keeper's public logs (registry mints only, same loader as the transparency page) and alerts when the newest run is stale, several runs failed in a row, or a keeper is paused — stdout plus a non-zero exit for supervisors, and an optional https webhook from `KEEPER_ALERT_WEBHOOK`. Who receives alerts and who may pause is King's G7 decision. Rules in `sdk/keeper_health.ts` (unit-tested).

Fee keeper: claim → 15/85 split → capped buyback on DAMM v2 → verified burn. Code in `sdk/flywheel/`, CLI in `scripts/flywheel.ts`, devnet configs in `keeper/`, dry-run write-up in `flywheel_dryrun_log.md`.

**`run` and `loop` are DRY RUNS by default.** A dry run executes the real keeper code path against a throwaway copy of the saved state. It builds and simulates each step (`simulateTransaction`, read-only) and broadcasts nothing. The saved state, journal and public log are not changed, so a later real run starts from exactly the same place. Only an explicit `--send` broadcasts. Each command prints a `DRY RUN` or `SENDING` banner first.

```bash
node --import tsx scripts/flywheel.ts run  --config keeper/devnet.tdt.json              # DRY RUN (default): simulate each step, print the plan
node --import tsx scripts/flywheel.ts run  --config keeper/devnet.tdt.json --send       # SENDING: one real run (current cadence window)
node --import tsx scripts/flywheel.ts loop --config keeper/devnet.tdt.json --runs 5     # 5 dry runs, one per window
node --import tsx scripts/flywheel.ts loop --config keeper/devnet.tdt.json --runs 5 --send
node --import tsx scripts/flywheel.ts pause|unpause|verify --config keeper/devnet.tdt.json
node --import tsx scripts/flywheel.ts help                                             # full command list
```

**Keys.** The keeper loads exactly three keypairs, the ones it signs with: `keys.claim_signer` (fee claimer / position owner), `keys.treasury` (signs the dev transfer, swap and burn) and `keys.gas` (fee payer). Each value is a key-file name in the gitignored key dir, and each key goes through the §12a separation checks (FW-23/24/25) and the optional `pinned_pubkeys` check. The dev wallet only receives the 15% payout, so it is configured as a **pubkey**, `dev_payout`, and no dev keypair is loaded or needed. A config that still has a dev keypair path (`keys.dev`) is refused at start with a message to delete it and set `dev_payout`; `pinned_pubkeys.dev`, unknown key roles, a missing or off-curve `dev_payout`, and a `dev_payout` equal to one of the keeper's own keys are refused too. `setup` creates the dev payout's wSOL token account from `dev_payout` (gas pays the rent).

In a dry run, a step that can only succeed after an earlier step has landed (the burn needs the swap's tokens) is reported as `dependent` rather than as an error. `loop --trade-lamports` sends scripted test trades, so it requires `--send`. The setup and test-trade commands (`setup`, `trade*`) are devnet operator tools that send when invoked.

## Launch page
```bash
pnpm page                    # LOCAL (needs pnpm validator)  -> http://127.0.0.1:5175
pnpm page -- --cluster devnet
pnpm e2e                     # headless Chrome: create -> 8-box gate -> buy -> cap-hit explainer -> sell (LOCAL)
```
The classic page signs with backend throwaway test wallets, not the user's browser wallet. This is a deliberate deviation from AC-21 (the brief said to use backend throwaway keys) and is accepted for the LOCAL/devnet demo only; the new front end below signs launches in the browser wallet. See "Known limitations" above.

### New front end (`web/`, work in progress)
A redesign of the launch page: token list, token page (cap schedule chart with a live "now" marker, lifecycle stage, the token's hooks with live values, rules and risks, switch history; no buy/sell panel), a home page (hero, live preview tiles, closest to graduation, latest burns; token list moved to `/tokens`), a Hooks page (one card and diagram per hook: cap per token account, anti-sniper fee, lift-only switch, buyback & burn), "How the cap works" and the studio launch tool (with a hooks picker). It talks to the same backend (`app/server.ts`) and imports the tested shared modules directly (`sdk/capMath.ts`, `sdk/schedules.ts`, `app/public/{pagevars,format,explainer}.js`, `research/page_content.json`), so copy, cap math and error mapping have one source. The old page in `app/public` is unchanged and stays the e2e target until the new one replaces it.
```bash
cd web && pnpm install
pnpm dev:fixtures            # simulated data, no backend or validator needed  -> http://127.0.0.1:5176
pnpm page -- --cluster devnet   # (repo root) backend on :5175, then in web/:
pnpm dev                     # new UI against the real backend (proxies /api)  -> http://127.0.0.1:5176
```
- Binds 127.0.0.1 only, like the backend. Studio launches are signed in the connected browser wallet (AC-21; the server co-signs with the 8.3 launch key). With no wallet connected, the server-signed test path is used (LOCAL, or a studio session on devnet).
- The AC-23 banner and the DEVNET badge show on every page. In fixture mode nothing is chain data and no transaction is sent.
- `scripts/ci.sh` covers it: forbidden words and the mainnet grep include `web/src`, and `web/` is type-checked when `web/node_modules` exists. Pure page logic is tested in `tests/web_token_logic.test.ts`.

### Backend pieces for the new UI
| What | How | Notes |
|---|---|---|
| Host the new UI | `cd web && pnpm build`, then `pnpm page -- --cluster devnet --web` | `app/static.ts`: serves `web/dist`, client routes fall back to `index.html`; without `--web` the classic page is served (e2e target) |
| Browser-wallet signing (AC-21) | `POST /api/wallet/build`, `POST /api/wallet/submit` | `sdk/wallet_tx.ts`: unsigned swap for the user's wallet, simulated first; the relay forwards only transactions this server built (one use, 90 s). Curve sells and all pool trades carry a quote-minus-slippage limit. The build reply is hex because `send()`'s redaction mangles base64 |
| Transparency page | `GET /api/flywheel`, page `/transparency` | `app/flywheel_public.ts`: the keeper's public logs (`flywheel/`), registry mints only, every claim/payout/swap/burn linked |
| Trade indexer | `node --import tsx scripts/indexer.ts loop --cluster devnet --every 30` | `sdk/indexer.ts`, read-only RPC, writes `.index/<cluster>/` (gitignored). Amounts from the pool side; cap-hit failures kept as blocked rows. `GET /api/token/:mint/trades` feeds the price chart and trades feed |
| Token details | launch form, or "Edit details" on the token page (`POST /api/token/:mint/metadata`) | `sdk/metadata.ts`: image (PNG/JPEG/WebP/GIF by file bytes, 512 KB), description (280 chars, site forbidden words refused), https links (X on x.com/twitter.com, Telegram on t.me). Stored in `metadata/<cluster>/` (gitignored, like `launches/`). The on-chain URI stays the devnet placeholder until there is a public host |

All `/api/token/<mint>/...` routes go through `app/site_registry.ts`: registry mints with a local launch record only. The studio routes (`/api/create`, `POST /api/token/<mint>/metadata`) need a studio sign-in (`STUDIO_WALLETS`, `sdk/studio_auth.ts`). `/api/trade` (the server's throwaway test wallets) is open on LOCAL and needs a studio sign-in on any other cluster.

## Admin powers (disclosed)
- **Program upgrade authority:** a throwaway key on devnet. It can replace the program. This is the largest power, and mainnet would need a multisig plus timelock (**out of scope**).
- **Lift-only switch** (`raise_mint_cap`, `lift_mint_cap`, `lift_global`): it can only raise or remove a cap, never lower it or re-enable it. Every use emits `RestrictionsLifted`, and the page lists those events.
- Nothing else: no fee, withdraw, pause, freeze, custody or allowlist. Exemptions are limited to the DBC and DAMM v2 pool authority PDAs; there are no manual exemptions.

## Verifiable build (AC-35)
`solana-verify build` was not run: its Docker build image does not fit this box's disk. On a machine with Docker and ~10 GB free, the whole check is one command: `bash scripts/verify_build.sh` (builds reproducibly, compares the local and deployed hashes, exits non-zero on a mismatch; devnet only).
What was checked instead: the release `.so` built from commit `f8803e8` (`cargo build-sbf`, no features; solana-cli / cargo-build-sbf 3.0.14, platform-tools v1.51) has sha256 `02d402bc2e2db90d69c6eb7155483364d7afca1cc500c010a90e5de36927bead`, and `solana program dump` of the devnet program gives the same sha256 (393,592 bytes, no padding). `pnpm qa-schedule` also compares the deployed bytes with the local release `.so`. This is not a reproducible (Docker) build.

## License
MIT, see `LICENSE` (copyright tyrellewm-oss). Contributing: see `CONTRIBUTING.md`. Branch history and merge plan: `docs/BRANCH_CONSOLIDATION.md`.

---
Repository: [tyrellewm-oss/hooks](https://github.com/tyrellewm-oss/hooks).

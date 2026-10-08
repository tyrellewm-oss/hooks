# Threat model: trenches-hook (devnet prototype, unaudited)

Scope: `programs/trenches-hook` + how Meteora DBC / DAMM v2 call it. DEVNET-only prototype. No paid audit, and none is claimed.

## Accounts and PDAs (all owned by the program, created once, never closed)
| PDA | Seeds | Contents | Writable after creation by |
|---|---|---|---|
| Global | `["global"]` | lift authority, `lifted` (global kill = allow everything) | `lift_global` only (false → true, one-way) |
| MintConfig | `["config", mint]` | launch_slot, supply_ref, steps (≤8), uncapped_after, `test_slots_build`, launcher, exempt list (always empty since QA H-1) | **nobody** (immutable; the config-bytes test covers this) |
| LiftState | `["lift", mint]` | `lifted`, `raised_floor_bps` (UI label: "raised minimum cap") | `lift_mint_cap` / `raise_mint_cap` only (one-way, upward only) |
| ExtraAccountMetaList | `["extra-account-metas", mint]` | config, lift, global PDAs (seed-derived from the mint) | nobody |

## Signers and powers
| Who | Can do | Can't do |
|---|---|---|
| Program upgrade authority (devnet: throwaway key; LOCAL: `3FxUH19…`) | `initialize_global` once; **upgrade the program** (the biggest power: an upgrade can change any rule) | — |
| Global authority (set at global init; same throwaway key) | init a mint config; raise or lift a mint's cap; global lift | lower a cap, re-enable a cap, edit a schedule, freeze, pause, withdraw, take fees, custody anything |
| Anyone | trigger `view_schedule` (read-only) | everything else |
| Token-2022 (CPI) | calls Execute during transfers | — |

No instruction moves tokens or SOL except rent at init. The hook makes no CPI.

## The rule and its checks (transfer_hook)
1. The mint is Token-2022 with TransferHook pointing at this program (`InvalidMint`).
2. The source token account has the `transferring` flag, so a direct call is rejected (`NotTransferring`).
3. Source, destination and mint match. Config, lift and global are the canonical PDAs, enforced by Anchor seeds. A spoofed config gets rejected (tested).
4. If the destination owner is the DBC pool authority `FhVo3mq…` or the DAMM v2 pool authority `HLnpSz9…`, allow. These are constants, and a test checks the derivation from the Meteora program ids. **No caller-supplied exemptions** (QA H-1, fixed).
5. Otherwise: if the destination post-balance is above `effective_cap(slot)`, reject with `WalletCapExceeded` and log the wallet, balance, cap and next change.

## Threats and status
| # | Threat | Status |
|---|---|---|
| T1 | Sells blocked (honeypot) | Sells go to accounts owned by the pool authority, which are exempt. The source is never checked. LOCAL: 150 random mid-ramp sells, QA 2,000 fuzzed sells, and 3 real DBC sells: 0 rejected |
| T2 | Launcher whitelists insiders | **Fixed** (H-1): `exempt_owners` must be empty, otherwise `InvalidCapSchedule` |
| T3 | Cap kept forever | **Fixed** (H-3): `uncapped_after ≤ MAX_RAMP_SLOTS = 6,480,000` (~30 days, estimate). DBC also revokes the hook at curve completion (LOCAL evidence) |
| T4 | Admin tightens the rule | Not possible: config is immutable, the switch only goes upward or lifts, and every use emits `RestrictionsLifted` (tested) |
| T5 | Program upgrade changes the rules | **Open.** The upgrade authority can replace the code. Devnet: throwaway key. Mainnet plan (out of scope): multisig plus timelock, or make immutable after verification |
| T6 | Test build on devnet (short ramps) | Release build has test-slots OFF. `test_slots_build` is stored in each config, and `view_schedule` logs `build: profile=release min_step_slots=10 min_ramp_slots=150`. `scripts/qa_schedule.ts` compares the deployed bytes with the release `.so` |
| T7 | Evading the cap | **Partly closed (G6).** One owner with several token accounts no longer holds more: while capped, only the owner's associated token account has the cap allowance, other accounts have cap 0 (`tests/hook.test.ts`, "per-owner cap (G6)"). **Still accepted / disclosed:** many wallets can hold more (QA H-2). The copy must say so (Research owns the copy) |
| T8 | Missing or corrupted global PDA blocks all transfers (QA M-4) | Global is created before any mint config (enforced: mint init needs the global authority signature). Program-owned, never closed |
| T9 | Griefing by pre-funding a PDA | `create_pda_once` handles pre-funded system accounts (tested) |
| T10 | Arithmetic overflow | u128 internally, saturating ops, proptests (QA: 9 properties × 1M cases); TS mirror saturates too (L-1 fixed) |
| T11 | Compute | A capped transfer stays well under the limit. DBC pool and hook init run in one tx with a 600k CU limit |
| T12 | Bundles / snipers | **Not protected** beyond the per-account cap and the DBC anti-sniper fee schedule. Disclosed |

## Pre-mainnet checklist (NOT done; mainnet is out of scope)
External audit · multisig upgrade authority plus timelock · verified build (`solana-verify`) · decide per-owner vs per-account cap · final copy review · rate limits and monitoring (R4 stop rule).

# Mainnet go-live checklist (DRAFT — nothing here is built, approved or signed)

**Status:** draft by Agent B, 2026-10-04, for review by Agent A and King. **This repo has no mainnet code path, by design:**
- `sdk/cluster.ts` refuses mainnet RPCs and the mainnet genesis;
- `--cluster` accepts only `local` and `devnet`;
- the mainnet hook program pin is `null` (`sdk/hook.ts`);
- CI fails on mainnet endpoints.

This checklist describes what a go-live **would** need. Every transaction below is **prepared unsigned** by tooling that doesn't exist yet. QA checks the exact bytes, and **King signs**. No agent ever signs or broadcasts on mainnet.

## 0. Gates before any mainnet work starts
| # | Gate | Owner | Status |
|---|---|---|---|
| G1 | Devnet definition of done: 8.3/8.3b upgrade and Global migration on devnet (before/after recorded), one full devnet loop (launch with the separate launch key → trades → graduation → keeper claim → price check → buyback → burn) with every signature in `launch_log.md`, Agent B PASS | agents | blocked (upgrade key and devnet keys, see #14) |
| G2 | External audit of `programs/trenches-hook` and the keeper (threat model "Pre-mainnet checklist") | King | not started |
| G3 | Verifiable build: `solana-verify build` hash == deployed hash (README "Verifiable build") | agents + King | not run (disk) |
| G4 | **Spec + `KING:` approval for an unsigned-mainnet-tx tool.** It reverses the "no mainnet code path" rule, so it needs its own ticket: what it builds, how QA compares the message bytes, where the unsigned bytes go, and tests that it can never sign or send. Until then, items T1–T9 are a paper list | Agent A spec, Agent B review, King approval | not started |
| G5 | Mainnet pins in code, behind G4: hook program id (`HOOK_PROGRAM_ID_PINS.mainnet`), DBC signer, partner config pin, `keeper/registry.json` mainnet list. The DAMM v2 migration config pin `7F6dnUcR…` already exists | agents (PR), King approves | not started |
| G6 | Final page-copy review (Research) and the per-token-account vs per-owner cap decision | King / Research | open |
| G7 | Monitoring and the R4 stop rule: who watches the keeper, the alerts, and who can pause it | King | open |

## 1. Decisions King must make first (no defaults; agents don't guess)
1. **Keys M1–M4:** who holds M1 the program upgrade authority (multisig + timelock?), M2 the Global admin (lift) key, M3 the fee claimer / treasury, and M4 the keeper hot keys (gas, claim signer).
2. **Launch-key custody:** a hot key, or King signing each launch. 8.3 requires it to differ from the admin, upgrade and fee-claimer keys and from every keeper key.
3. **Mint keypair:** generated on King's side. Agents only ever see the public key.
4. **Fee / curve / supply preset** (`research/fee_curve_supply_options.md`) and **flat vs dynamic pool fee** after migration.
5. **15% dev payout destination** (`dev_payout` pubkey).
6. **Max buyback per run** and **keeper cadence**.
7. **Where the price sampler runs** (always-on host), the mainnet **RPC provider**, and whether a **Jupiter API key** is used. It goes in the `FW_JUPITER_API_KEY` env var only, never committed.
8. Ticket #5 ★ values for mainnet: TWAP window, spot / independent bands, `require_independent`.

## 2. Transactions, in order (all prepared UNSIGNED; King signs; QA signs off on each)
For every item, QA checks before King signs:
- the message bytes match what was simulated;
- every program id is pinned;
- every account matches the plan;
- no agent key appears as a signer.

The post-check runs read-only after it lands.

| # | Transaction | Signer(s) | QA pre-check | Post-check |
|---|---|---|---|---|
| T1 | Write the program buffer from the **verified** release build (test-slots OFF) | upgrade authority (M1) | `.so` sha256 == the `solana-verify` hash (G3) | the buffer hash matches |
| T2 | Deploy the program from the buffer; set the upgrade authority to the multisig | M1 | program id == the planned pin (G5) | ProgramData authority == multisig; `qa-schedule` VERDICT release |
| T3 | `initialize_global(admin)` | upgrade authority | admin == the M-key decision, != the launch key | Global 42 bytes, `authority` == admin |
| T4 | `migrate_global_v2(launch_authority)` (payer may differ) | admin + payer | launch key != admin / upgrade / fee claimer / keeper keys (four-role rule) | Global 74 bytes; bytes 0..42 unchanged; tail == launch key |
| T5 | DBC partner config with transfer hook (fee / curve / supply preset) | partner payer, config keypair | preset == King's pick (decision 4); `feeClaimer` per M-keys; `launchConfigChecks` clean | the config account is owned by DBC and matches |
| T6 | Create pool + hook config (one tx), mint keypair from King | payer, **launch key**, mint keypair (King) | pre-send simulation: mint TransferHook == the pinned program + DBC signer; `buildCreatePoolTx` launch-key check | pool / mint / hook checks (blocker #7); `MintConfig.launcher` == the launch key |
| T7 | Registry PR: add the mainnet mint to `keeper/registry.json` | repo PR (Agent A/B review, King merges) | exact mint string | site and keeper see only the registry mint |
| T8 | Keeper setup: treasury / dev wSOL and token accounts | keeper gas | owners per M-keys; `dev_payout` == decision 5 | accounts exist with the right owners |
| T9 | Keeper runs (recurring): claim → 15/85 split → price check → capped buyback → burn | keeper hot keys (M4: gas, claim signer) | `run` dry run first; price checks (#5) pass; max per run == decision 6 | every run reconciles; burn verified; public log written |

Not on the list: `lift_global`, `lift_mint_cap`, `raise_mint_cap`, `set_launch_authority` and `rotate_admin`. These are emergency or rotation actions only. Each one is a separate, explicit King decision.

## 3. Known limits to accept or fix before go-live (from the merged tickets)
- **Cap is per token account, not per wallet** (README design limit 2); post-graduation buys are uncapped (design limit 3).
- **#5 price source:** with a single-pool token, Jupiter prices from our own pool, so it catches a stale or broken read, not a pump. A pump held for the whole 30-min window gets through (the defence is the window plus the max per run). min_out per spec §3.7 was confirmed by King. Missing or stale sampler → refuse, then pause after the warm-up ceiling.
- **8.3:** a devnet launch is refused until the devnet Global is migrated (fail closed). The same applies on mainnet: T4 before T6.
- **8.3b:** `rotate_admin` does not rotate the BPF upgrade authority.
- **Unaudited; no verifiable build yet** (G2, G3). The upgrade authority can replace the program: the multisig + timelock decision is part of M1.
- The page signs with backend throwaway keys today (AC-21 / H-7). It needs **browser-wallet signing before any hosted or public page.**

## 4. Sign-off record (to fill in at go-live)
| Step | Prepared by / SHA | QA PASS (Agent B) | King signed (tx) | Post-check |
|---|---|---|---|---|
| G1–G7 | | | | |
| T1–T9 | | | | |

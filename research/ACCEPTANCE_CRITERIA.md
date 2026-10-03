# Trenches launchpad: acceptance criteria (devnet-only lean Option 1)

**Author:** Deployer Research. **Date:** Oct 3 2026, ~22:40 ICT.
**Scope:** King's go at 22:31 ICT covers a **devnet-only** build. The custom-program exception applies to **devnet only**. Mainnet, real keys and spending are all forbidden.
**Sources:** Engineer's lean plan, QA's lean gates L1–L10 and Research's experiment framing, all in `concepts/hook_launchpad_feasibility_v0.md`. NEO's requirements:
- never call the cap "anti-bundle";
- the pool vault and migration path are exempt from the cap;
- the lift-only switch is disclosed, and every use is announced.

`launchpad/qa/` did not exist at the time of writing. QA should add test IDs next to each AC.

**Verify types:**
- **U** = unit test
- **F** = fuzz/property test (Trident or proptest)
- **L** = local validator test (`solana-test-validator` + `test-slots` feature)
- **D** = devnet transaction (link recorded in `research/DEVNET_TX.md` or `STATUS.md`)
- Note: `STATUS.md` (AC-14, AC-15, AC-33) is the team's internal status doc, kept in local history only and not in the public repo. The public status summary is the README's "Status" section.
- **UI** = manual or Playwright check of the launch page
- **R** = repo or grep check

Proposed error names (Engineer may rename; then update `page_content.json` to match):
- `WalletCapExceeded`
- `ConfigFrozen`
- `Unauthorized`
- `InvalidCapSchedule`
- `NotTransferring`
- `InvalidMint`

---

## (a) Hook program

| AC | Criterion | Pass condition | Verify | QA gate |
|---|---|---|---|---|
| AC-1 | **One rule only:** a rising per-token-account cap | The program has exactly one restricting check: the destination token account's balance after the transfer ≤ `cap(slot)`. No sell cap, no tax, no allowlist, no app gating, no time-of-day rules. | Code review + U | L2, L5 |
| AC-2 | **Cap math is a pure function** callable off-chain | `cap_at(config, current_slot) -> Option<u64>` (None = no cap) lives in a no-Solana-deps module or crate and is used by both the program and the UI/SDK. Same inputs give the same output on-chain and off-chain. | U (table tests: before start, each step, after end, u64 edges) + F (monotonic, no overflow) | L5, L6 |
| AC-3 | **Cap only rises** | For every config and every `s1 < s2`: `cap_at(s2) ≥ cap_at(s1)`, and None (no cap) is never followed by Some. | F (≥1M cases) | L6 |
| AC-4 | **Config validation at init** | Init rejects schedules that start above the end, decrease, have zero length, exceed 100% of supply, or start below a floor (e.g. 0.1% of supply). Error `InvalidCapSchedule`. | U | L2 |
| AC-5 | **Test flag for slots** | A `test-slots` Cargo feature (or config) shortens the ramp so the cap rises within ~seconds on a local validator. **Off in any devnet release build.** The release build is tested without the feature. | L (warp slots / wait) + R (feature absent in deploy script) | L6, L7 |
| AC-6 | **Receive-side block only, per token account** | The hook rejects only when the *destination token account's* post-transfer balance > cap (not per owner or wallet: one owner can hold several token accounts, as shown in QA's LOCAL test). Sending, moving to another token account below the cap, and transfers out never fail because of the hook. All copy says "per token account", never "per wallet". | U + F (including a test that the same owner with 2 token accounts can hold 2× the cap, documented as expected behaviour) | L3 |
| AC-7 | **Exit guarantee: sells into the curve always succeed** | For random wallets, amounts and slots (including mid-ramp), a sell into the DBC pool is never rejected by the hook. | F (model) + L + D (≥3 sells mid-ramp, links recorded) | L3 (veto) |
| AC-8 | **Pool vault and migration path exempt** | DBC base vault, the pool authority, and every account the DBC migration (DAMM v2) touches are exempt as receivers. Graduation can't fail because of the cap. | U (exempt list derived from DBC PDAs, not typed by hand) + L/D (migration if feasible, see AC-17) | L3, HOOK-4 |
| AC-9 | **Hook correctness checklist** | Checks `transferring` flag (rejects direct invocation, `NotTransferring`); validates mint (`InvalidMint`) and token account owners; ExtraAccountMetaList matches the accounts actually read; no CPI back into Token-2022; checked math only; spoofed accounts rejected. | U (one negative test per item) + review log | L5 |
| AC-10 | **Rules frozen per token at launch** | The per-mint config is written once at init. No instruction can change any field except via AC-11. Re-init fails (`ConfigFrozen`). | U (call every instruction against a live config and confirm none tightens or edits it) + F | L2 (veto) |
| AC-11 | **Lift-only switch** | A single instruction, signed only by the configured authority, can only (a) disable the cap for a mint, or a global kill = allow all; and optionally (b) raise the cap. It can never lower the cap, re-enable after disabling, or touch funds. Non-authority signers fail with `Unauthorized`. | U + F (no sequence of switch calls lowers `cap_at`) | L1, L2 |
| AC-12 | **Every switch use emits an event** | Each successful switch call emits an Anchor event (`RestrictionsLifted { mint or global, old, new, slot, signer }`) that the indexer picks up. The UI and status doc show it. | U (event parsed in test) + D (one devnet use, link recorded) + UI | L9 |
| AC-13 | **Inert after graduation** | Once the DBC curve completes, the mint's transfer hook is None (DBC `revoke_transfer_hook`), **or**, if not reachable on devnet, the hook allows every transfer when the pool is marked complete. | L/D: read the mint extension after migration and confirm `TransferHook.program_id == None` | L3, L9 |
| AC-14 | **No other admin powers** | No withdraw, no pause on existing tokens, no freeze, no fee collection, no token/SOL custody, no allowlist editing. The program owns no token accounts holding value. | Code review (list every instruction in STATUS.md) + U ("hook can't move tokens or SOL" invariant) | L1, L6 |
| AC-15 | **Upgrade authority noted** | On devnet: a throwaway keypair generated in test code, never committed, with its pubkey recorded in STATUS.md. Mainnet plan (2-of-3 human Squads, then immutable) is written in the README as **out of scope**. | R + `solana program show` output in STATUS.md | L1 |

## (b) DBC wiring on devnet

| AC | Criterion | Pass condition | Verify | QA gate |
|---|---|---|---|---|
| AC-16 | **Launch a test token via the DBC transfer-hook pool path** | A Token-2022 mint with the TransferHook extension pointing to our program, mint authority None, freeze None, a DBC config with migration to DAMM v2 and the anti-sniper fee scheduler (linear or exponential, **no rate limiter**). The pool is created on devnet. | D (create-config + pool tx links) | L7, L8 |
| AC-17 | **Buy, sell, cap-hit, graduation** | (1) A buy under the cap succeeds via `swap2_with_transfer_hook`. (2) A sell succeeds. (3) A buy that would exceed the cap fails with `WalletCapExceeded` visible in the logs. (4) After the ramp ends, a large buy succeeds. (5) Graduation and migration if feasible on devnet (small threshold); otherwise recorded as blocked with the reason. | D (link for each, in a table) | L3, L7 |
| AC-18 | **Clear error** | The cap-hit tx log contains the error name and the token account's current cap and balance (msg!), so the UI can show the explainer. | D log excerpt | L9 |
| AC-19 | **Fee scheduler matches config** | The fee charged in the first slots vs later slots matches the configured cliff and decay within rounding. | D or L (2 swaps, compare) | SNP-1–6 |
| AC-20 | **Devnet tx log** | Every tx above is listed with its explorer link (`?cluster=devnet`), time (ICT) and purpose. | R | L7 |

## (c) Launch page

| AC | Criterion | Pass condition | Verify | QA gate |
|---|---|---|---|---|
| AC-21 | **Create token** flow (devnet) | The form takes name, ticker and cap schedule (validated by the same `cap_at` rules as AC-4), builds unsigned txs, and the user signs in their own browser wallet on devnet. No server-side keys. | UI + D | L1 |
| AC-22 | **Trade** | Buy and sell panel on the token page via the DBC transfer-hook swap. A preview shows the destination token account's remaining room under the cap (computed with `cap_at`). | UI + D | L3 |
| AC-23 | **Banner** | The banner string from `page_content.json` shows on every page, plus a visible **"DEVNET TEST – no real value"** badge. | UI (each route) | L8d |
| AC-24 | **8-box pre-trade checklist gates trading** | The Buy/Sell buttons stay disabled until all 8 boxes are ticked. The state is stored locally, expires after 30 days, and resets if the copy version changes. | UI (Playwright: 7 ticked = disabled; 8 = enabled) | L8d |
| AC-25 | **Rules-and-risks block** | Shown on every token page, with placeholders filled from on-chain config: cap schedule described **per token account** (one wallet can hold several accounts; anyone can split across wallets), the line "can't be tightened; can only be lifted (see Admin power)", multisig/authority, announce channel, exempt accounts, graduation behaviour, fees, and the line that the cap ends at graduation or after {CAP_RAMP}, whichever comes first, with no cap afterwards (including pool buys right after migration; checklist item 3 and 6 say the same). No line may imply the cap lasts beyond graduation. No unfilled `{…}` placeholders are visible. | UI + U (renderer fails on a leftover `{`) | L8d |
| AC-26 | **"Why did my trade fail" mapping** | All six program errors are keyed in `page_content.json`: `WalletCapExceeded` shows the cap-hit explainer with the token account's cap, balance and next step; `NotTransferring`/`InvalidMint` show the hook-compatible-wallet text; `Unauthorized`/`InvalidCapSchedule` show the launcher-error text; `ConfigFrozen` is never shown as a trade-retry message. Unknown errors show the generic text plus the raw error. A failed sell shows the "report it" text. | UI (force a cap hit on devnet) | L9 |
| AC-27 | **Forbidden words** | A case-insensitive grep over built UI strings and `page_content.*` finds none of: `safe`, `secure`, `audited`, `anti-bundle`, `antibundle`, `sniper-proof`, `bot-proof`, `rug-proof`, `rugproof`, `honeypot-free`, `no admin`, `0 keys`, `moon`, `100x`, `guaranteed`, `profit`, `returns`, `investment opportunity`, `presale`, `floor`, `pump it`. Allowed: "not an investment", "unaudited", "exit guarantee" (wording in page_content is reviewed). | R (CI script; allowlist for the exact phrases above) | L8d |
| AC-28 | **No unverified stats** | The page shows only numbers read live from devnet (supply, cap, balance, fee). No "X launches", volume or user counts. | UI + code review | L8d |
| AC-29 | **Switch transparency** | The page links to the announce channel and lists every `RestrictionsLifted` event (from AC-12) for that token. | UI | L1, L9 |
| AC-30 | **No mainnet RPC** | The config has only devnet/localnet endpoints. The build fails if `mainnet` or a mainnet RPC host appears in config/env. The cluster is shown in the UI. | R (grep + build-time assert) + UI | hard rule |

## (d) Repo hygiene

| AC | Criterion | Pass condition | Verify | QA gate |
|---|---|---|---|---|
| AC-31 | **No secrets or keypairs committed** | `git log -p` and the tree contain no keypair JSON (64-byte arrays), no `.env` with keys, no seed phrases. `.gitignore` covers `*.json` keypairs, `.env*` and `target/`. Keypairs are generated in test code at runtime. | R (gitleaks or regex scan over full history) | L1, hard rule |
| AC-32 | **README run steps** | A fresh clone gets to (1) a unit/fuzz run, (2) a local validator test with `test-slots`, (3) a devnet deploy with a throwaway key, (4) the page served locally against devnet, each with exact commands. | R (follow on a clean checkout) | L4 |
| AC-33 | **Status doc** | `STATUS.md` lists what works, what's blocked, devnet program ID, upgrade authority pubkey, tx links (AC-20), known issues, and the date/time (ICT). | R | L9 |
| AC-34 | **Dry-run / devnet default** | Every script defaults to dry-run or localnet. Devnet needs an explicit flag. **There is no mainnet code path at all.** | R + run scripts without flags | hard rule |
| AC-35 | **Verifiable build ready** | `solana-verify build` reproduces the deployed devnet program hash (or the steps are documented if tooling isn't available offline). | R/D | L4 |
| AC-36 | **Tests in CI script** | One command runs unit + fuzz (reduced count) + forbidden-word grep + secret scan. All green before Engineer commits a PR. | R | L5, L6 |

---

## Out of scope for the devnet build
- Any mainnet deploy, mainnet RPC, real SOL, or real keys. Any spending, including paid RPC.
- The 2-of-3 Squads multisig and the immutability step (mainnet plan only, documented).
- Public self-serve launches, third-party creators, and moderation tooling.
- External audit, bug bounty, ToS and legal review (NEO/counsel, pre-mainnet).
- Geo-blocking (documented as required before mainnet).
- Extra rules: sell caps, anti-bundle, sniper priority-fee cap, app/venue gating, taxes, market hours.
- A launchpad token, fee claiming to a treasury, revenue dashboards.
- Jupiter/aggregator routing (we test our own swap path only).
- Exclusion feed / wall integration (QA L10). Required before mainnet; on devnet only document the hook-up point.
- Anything appearing in King's content or alerts.

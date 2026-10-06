# Go-live readiness, test plan and positioning (2026-10-06)

Written from a review of the repo at `b319e4e` plus a read of five competitor products. Facts about this repo come from the code and docs; everything about competitors comes from their public copy and GitHub (their sites were not directly reachable from the review box, so details marked "unconfirmed" should be checked by hand).

## 1. Where the product stands today

**One hook, four phases.** The launchpad attaches exactly one Token-2022 transfer hook (`programs/trenches-hook`) to every token while it is on the Meteora DBC curve. The hook enforces a per-token-account holding cap that only rises. The approved **Balanced** schedule has four phases, which is probably what "the 4 hooks" refers to:

| Phase | From slot | Cap per token account |
|---|---|---|
| 1 | launch | 1% of supply |
| 2 | +150 (~1 min) | 2% |
| 3 | +1,500 (~10 min) | 4% |
| 4 | +4,500 (~30 min) or graduation | no cap |

All four phases are one schedule frozen into the mint's `MintConfig` at launch. They cannot be applied separately; a launch gets the whole ramp. Two other schedules (Strict, Loose) exist in `sdk/schedules.ts` but are labelled "not approved".

**Devnet only, by design.** `sdk/cluster.ts` refuses mainnet RPCs, the mainnet hook pin is `null`, and CI greps for mainnet endpoints. "Going live" therefore means one of two things, and they are very different amounts of work:

1. **Devnet public beta** (hosted page, real browser wallets, devnet SOL). Mostly done; blockers are listed in §3.
2. **Mainnet launch.** Blocked on gates G1–G7 in `docs/mainnet_golive_checklist.md`: audit, verifiable build, an unsigned-mainnet-tx tool with its own approval, key custody decisions, and the fee/curve/supply preset choice. None of these can be closed by code alone.

## 2. What was verified in this review

| Check | Result |
|---|---|
| `cargo test -p cap-math` (unit + proptests) | 10/10 pass |
| `pnpm test` (node suite) | 401 pass, 3 skipped, **56 fail: every failure is "Failed to add program: No such file"**, i.e. `target/deploy/trenches_hook.so` is absent because the box has no `cargo build-sbf` |
| `CI_SKIP_CARGO=1 pnpm check` | parse check 86/86, forbidden-word scan clean, secret scan clean (full history), no mainnet endpoints, web typecheck ok; fails only on the same missing-binary tests |
| `web/` typecheck | ok |
| Devnet RPC reachability from the review box | blocked (proxy 403 on api.devnet.solana.com, onfinality, ankr, helius); Agave/Anza release downloads also blocked |

So the whole local suite is green except for tests that need the compiled program, and nothing on-chain could be exercised from here. The on-chain run below must happen on a machine with the Solana CLI and devnet access.

## 3. Blockers before any hosted page (devnet beta)

| # | Blocker | Where | Status |
|---|---|---|---|
| B1 | Browser-wallet signing on the page (AC-21 / QA H-7). The backend endpoints exist (`/api/wallet/build`, `/api/wallet/submit`, `sdk/wallet_tx.ts`) and the web app calls them, but the README still says signing is server-side with throwaway keys | `web/src/components/TradePanel.tsx`, `app/server.ts` | verify end-to-end in a browser; update README once confirmed |
| B2 | Server binds 127.0.0.1 only and `/api/trade` (server test wallets) must stay studio-gated off LOCAL | `app/server.ts` | gate is tested (`site_registry.test.ts`); needs a reverse proxy + TLS plan for hosting |
| B3 | `STUDIO_WALLETS` set to the real studio wallets; unset = studio closed on devnet | env | decide who can create launches in the beta |
| B4 | Fee / curve size / supply preset still "pending King" (`research/fee_curve_supply_options.md`). Research recommends Balanced: 90% → 1% over 150 slots, 0.25% base pool fee, 3 SOL curve, 80% sold on curve | `sdk/launch.ts` `DEFAULT_LAUNCH_FEES` | decide, then make it the default and re-launch one devnet token to confirm the page copy |
| B5 | Flat vs dynamic pool fee after migration (Fixed presets have dynamic fee on, ~0.30% max) | `sdk/launch.ts` migration option | decide; page copy currently says "can rise" |
| B6 | Announcement channel for `RestrictionsLifted` events is still "TBD" in the README | README, page copy | pick one (X account or Telegram) before beta |
| B7 | 8.3 Global migration on devnet (separate launch key) must be done or new devnet launches are refused (fail closed) | `scripts/launch_authority.ts migrate` | run, record before/after in `launch_log.md` |
| B8 | Token metadata URI is still the devnet placeholder until there is a public host | `sdk/metadata.ts` | needs the hosted URL |

## 4. Test plan for today (run on a machine with Solana CLI 3.0.x, Anchor 0.32.2, devnet access)

Each step names the pass condition. Record every signature in `launch_log.md` as before.

**A. Build and local gate**
1. `pnpm install && pnpm build` → `target/deploy/trenches_hook.so`, sha256 noted. `test-slots` must be OFF.
2. `CI_PROGRAM_HOST=1 pnpm check` → `CI: ALL GREEN` (this is the run that was failing here for lack of the `.so`).
3. `pnpm validator` then `pnpm demo` → the full LOCAL loop: launch → buy → cap hit → sells mid-ramp → cap rises → no cap → curve fill → DAMM v2 migration.
4. `pnpm lift-demo` → lift to 3% ok, lower refused, re-enable refused, each lift emits `RestrictionsLifted`.
5. `pnpm e2e` → headless Chrome: create → 8-box checklist → buy → cap-hit explainer → sell.

**B. Devnet: are the hooks applying to every launch?**
Repeat for at least three launches, one per schedule (`--schedule balanced`, `strict`, `loose`) so you can see the schedule frozen correctly each time:
1. `node --import tsx scripts/dbc_flow.ts demo --cluster devnet --threshold 0.2 --wallet-sol 0.3 --schedule <id>`.
2. `pnpm qa-schedule <mint> --cluster devnet` → VERDICT line says release build, deployed bytes match the local `.so`, the printed steps match the chosen schedule, `test_slots_build=false`.
3. On each mint, check via explorer that the mint's TransferHook extension points to `FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz` and the authority is the DBC signer (the SDK's blocker #7 check does this before building the pool tx; confirm the `mintHookCheck` field in the launch record is "ok").
4. Phase tests on the Balanced launch (this is the "all four phases apply" test):
   - Phase 1: buy 0.5% ok; buy that would reach 1.1% → `WalletCapExceeded` (6000).
   - Sell into the curve → always ok.
   - Phase 2 (after +150 slots): buy to 1.8% ok; to 2.1% → fails.
   - Phase 3 (after +1,500): buy to 3.9% ok; to 4.1% → fails.
   - Phase 4 (after +4,500): buy 10% ok.
   - A second token account for the same wallet can buy another 1% in phase 1 (this is the documented per-account limit, not a bug, but confirm the page says so).
5. Graduate (fill the threshold) → hook revoked on the mint, DAMM v2 pool created, a post-migration buy of >4% succeeds with no cap. Check the pool's fee (base 0.25%, dynamic on) matches the page copy.
6. Run `scripts/indexer.ts loop --cluster devnet` during the above and confirm the token page chart and trades feed show the buys, sells and blocked rows.

**C. Devnet: page and wallet**
1. `pnpm page -- --cluster devnet --web` with `STUDIO_WALLETS` set; sign in with a studio wallet, create a launch from the form, edit token details (image, description, links).
2. With a non-studio browser wallet: buy and sell through `/api/wallet/build` + `/api/wallet/submit`. Confirm the signed tx was built by the server (the relay refuses anything else), the cap-hit explainer appears on a blocked buy, and the slippage-protected sell lands.
3. Confirm `/api/trade` is refused for a non-studio session on devnet.
4. Confirm the DEVNET badge and the AC-23 banner show on every page and the switch history lists any lift events.

**D. Keeper**
1. `scripts/flywheel.ts run --config keeper/devnet.tdt.json` (dry run) → every step simulates; then `--send` once → claim, 15/85 split, price check, capped buyback, verified burn, public log written and shown on `/transparency`.

## 5. Competitors (public copy; see caveats at top)

| Product | Chain | What a "hook" is | How users choose | Fees |
|---|---|---|---|---|
| hookr.fun | Robinhood Chain (EVM) | Uniswap v4 pool hooks: anti-snipe, surge fees, auto-burn, LP rewards, Nth-buy pot | Modular builder, up to 5 blocks per pool, frozen at launch; publishable "blueprints" with author royalties | Creator 50–80% of pool fees; hook fees split 80/20 with protocol |
| autodev.fun | unknown | could not be resolved (likely new or unindexed; check by hand) | | |
| bnbhooks.online | BNB Chain | DEX pool hooks (dynamic fees, access control, rewards, auto-LP). Explorer/workspace more than a launchpad | Browse and inspect, then build and deploy | none stated |
| pickhooks.com | BNB Chain / PancakeSwap | Token-level trade rules, 40 available (max wallet, 100-holder club, slow mode, jackpot, dev lock...) | User picks up to 8 of 40 at launch, immutable after | 0.01 BNB launch; per-trade fee split creator / $hooks buyback-burn |
| tryhookmind.com | **Solana** (Token-2022) | A transfer hook driven by a persistent AI "mind" (model, character, objectives) that decides how transfers are handled; hook lasts the token's life | Configure token + AI identity, launch | unconfirmed (~0.1 SOL) |

Two more Solana transfer-hook launchpads surfaced in the search and are closer to us than the five above: **hookedpad.com** (one rule per token at launch: holder caps, vesting, dividends, royalties) and **hookrz.fun / hookrs.fun** (rule blocks with an in-browser simulator). So "nobody has done this on Solana" is no longer true; HookMind and Hooked are live. The differentiation has to come from something else (§7).

## 6. All four phases at launch, or let users pick?

**Recommendation: keep the full ramp mandatory on every launch for v1, and give creators a choice between the three existing schedules (Strict / Balanced / Loose) rather than letting them switch phases on and off.** Reasons:

- The four phases are not independent features. They are one monotone ramp, and the program's release limits (first step at slot 0, steps ≥10 slots apart, ramp ≥150 slots, caps never decrease) exist so the rule can't be configured into something meaningless. Letting a creator drop phase 1 ("no cap for the first minute") deletes the only part that does anything against slot-0 snipers, which is the product's whole promise.
- The promise to buyers is "every token here has the same protection". pickhooks' "up to 8 of 40" model means a buyer has to read each coin's rules; our edge is that a buyer never has to. That is a stronger message for a bonding-curve launchpad where buyers are fast and don't read.
- Every new hook type is new on-chain code in the transfer path, which means audit scope, compute budget per swap, and a bigger test matrix (the current suite already has ~460 tests for one rule). Shipping a menu before an audit of the one rule you have would be backwards.
- Choice between Strict / Balanced / Loose is cheap: the schedules exist, `resolveSchedule` and `qa-schedule` already handle them, and the page already shows the active schedule. It gives creators a visible knob ("how sniper-resistant do you want to be") without new program code. Balanced stays the default and the only one labelled approved until the others are reviewed.

If you want a per-launch picker later, make it a picker of **presets** (schedule × fee curve), not of individual phases. hookr's "blueprint" idea (publish a preset, earn a share when others reuse it) is the version of this that also creates a reason to come back.

## 7. How to be different on Solana

Ranked by how much of it already exists in the repo.

1. **Rules that sunset, with a receipt.** HookMind and Hooked keep the hook for the token's life. Ours is removed at graduation by Meteora DBC and the token becomes a plain Token-2022 token on DAMM v2. "Protection while it matters, no strings after" is a clean message, and it is already true. Lean into it in the copy.
2. **Provable fairness, not promised fairness.** `qa-schedule` reads the frozen schedule from the chain and prints a verdict; the lift switch can only loosen and emits an event every time; the page lists switch history; the replay report shows what the cap would have done to five real sniped launches. None of the competitors publish evidence like this. Put the QA verdict and the lift history on the token page as a "proof" panel, and publish the replay report as a public page.
3. **The flywheel with a public ledger.** Fee claim → split → price-checked buyback → verified burn, every tx linked on `/transparency`. pickhooks does buyback-burn but of its own platform token; ours burns the launched token itself. Make the transparency page a first-class tab on every token.
4. **Close the post-graduation gap.** Our own replay shows one wallet taking ~20% from the new pool right after migration in 3 of 5 fixtures, and no competitor handles this either. Options to research: a short DAMM v2 launch-fee ramp through the Customizable migration config, or a graduation-time holder snapshot that drives a short post-migration cap in a second hook attached before DBC revokes the first. The second needs a custom migration path and is real engineering; the first is a config question worth a day.
5. **Per-owner cap instead of per-account** (README design limit 2, open gate G6). Token-2022 lets the hook see the destination owner; aggregating across an owner's accounts needs an owner-indexed PDA updated on each transfer. It is the single most-asked question a sceptical trader will have ("can't I just open two accounts?") and answering "no" is a differentiator none of the Solana hook pads currently claim.
6. **A simulator on the page.** hookrz has an in-browser rule simulator. We have `sdk/capMath.ts` and the "room under cap" preview. Expose a "what would my buy do at slot +N" slider on the token page; it's mostly UI.
7. **Creator presets with revenue share** (hookr's blueprint royalty) once §6's preset picker exists.

Not recommended: an AI "mind" deciding transfers (HookMind). It is the opposite of provable fairness and would undo point 2.

## 8. Decisions needed from you to proceed

1. Beta target: hosted devnet page first, or straight to the mainnet gate work.
2. Fee / curve / supply preset (B4) and flat vs dynamic pool fee (B5).
3. Who is in `STUDIO_WALLETS` for the beta (B3).
4. Announcement channel for lift events (B6).
5. Whether to expose the Strict / Loose schedules to creators now (needs their "not approved" label changed) or keep Balanced only.

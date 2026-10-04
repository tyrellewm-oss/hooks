# Fee, curve size and supply-sold options for King (asked for by NEO and QA)

Deployer Research, Oct 4 2026, ~04:40 ICT. Design only, devnet only. **Every value is a proposal** unless it has a source. King approved the cap schedule as **Balanced cap** (1% → 2% → 4%, `uncappedAfter` = 4,500 slots; `sdk/schedules.js`, `cap_schedule_options.md` @ 8be77ca).

## What the config accepts (repo + Meteora DBC SDK 1.5.13)
`J` = `node_modules/.pnpm/@meteora-ag+dynamic-bonding-curve-sdk@1.5.13…/dist/index.js`.

| LaunchOpts field (`sdk/launch.ts:43-50`) | Default (`sdk/launch.ts:53`, `:81`, `:90-91`) | Maps to | Allowed / validation |
|---|---|---|---|
| `feeStartBps` | 5000 | `feeSchedulerParam.startingFeeBps` (`launch.ts:83`), linear scheduler | ≤ 9,900 (`J:128`, `J:2493`); ≥ end |
| `feeEndBps` | 100 | `endingFeeBps` | ≥ 25 (`J:127`, `J:2498`); ≤ start (`J:2503`) |
| `feePeriods` | 10 | `numberOfPeriod` | > 0 (`J:2490`). Period length = duration ÷ periods (`J:2515`), so pick a duration that divides evenly |
| `feeDurationSlots` | 150 | `totalDuration` (slots, `ActivationType.Slot`, `launch.ts:89`) | > 0 (`J:2508`) |
| `creatorTradingFeePercentage` | 0 | DBC `creator_trading_fee_percentage` (`launch.ts:84`) | 0–100 (`J:3782`). In the beta partner = creator = launcher (`launch.ts:95`), so the split is cosmetic |
| `migrationFeeOption` | `FixedBps25` | DAMM v2 pool fee after migration (`launch.ts:86`) | Enum `FixedBps25`=0, `FixedBps30`=1, `FixedBps100`=2, `FixedBps200`=3, `FixedBps400`=4, `FixedBps600`=5, `Customizable`=6 (`index.d.ts:5831`). The page maps these to 25/30/100/200/400/600 bps (`app/public/format.js:21`). Only 0–5 pass `validateMigrationFeeOption` (`J:3472`) |
| `migrationQuoteThresholdSol` | 1 | `migrationQuoteThreshold` in whole SOL (`launch.ts:91`; converted with 9 decimals, `J:4172`). **This is the curve size** | > 0 (`J:3876`) |
| `totalSupply` | 1,000,000,000 | `totalTokenSupply` (`launch.ts:81`) | Also the hook's `supplyRef` (`launch.ts:113`), so caps are a % of this |
| `percentageSupplyOnMigration` | 20 (optional setting since PR 9 `146f346`; default 20) | % of supply that seeds the DAMM v2 pool. The curve sells ≈ the rest: `swapAmount = total − migrationBase − vesting − leftover` (`J:4192`) | **1–49 only** (checked by Engineer and independently by QA against the real DBC `buildCurve`, values 0–99 at 1/3/10/100 SOL): 50–99 overflow in the DAMM v2 builder, 0 divides by zero. So at least 51% of supply always sells on the curve. |

**Page display:**
- `app/public/format.js:34-44` fills {SNIPER_FEE_START}, {SNIPER_FEE_END}, {SNIPER_FEE_DURATION} and {POOL_FEE} from these fields.
- There is **no {CURVE_SIZE} placeholder**. The token page shows "X SOL of Y SOL threshold" instead (`app/public/app.js:103`).

## Context (sourced)
- **Slot-0 buyout:** in the replay fixtures the whole pump.fun curve was taken in slot 0. Fixture A's 4 crew wallets took 78.03% for 81.226 SOL; Fixture C's create tx bought 79.31% (the entire curve) for 85.005 SOL (`../../replay_fixtures_v0.md`). So **the anti-sniper fee has to be at its maximum at slot 0**, and the cap has to make one-shot buyouts need many token accounts.
- **Fee levels elsewhere:**
  - pump.fun charges 1.25% on the curve ([pump.fun fees](https://pump.fun/docs/fees)).
  - Bags' default is 2% ([Bags fees](https://docs.bags.fm/how-to-guides/customize-token-fees)).
  - DBC's fee scheduler allows up to a 99% total fee ([Meteora fee scheduler](https://docs.meteora.ag/core-products/dbc/fees/fee-scheduler.md)).
  - Meteora takes 20% of trading fees ([DBC fees](https://docs.meteora.ag/core-products/dbc/fees/overview.md)).
- **Typical DBC thresholds:** I found no public typical value. Any SOL threshold below is a proposal.

## Options (proposals)
| | Current defaults (reference) | **Conservative** | **Balanced (recommended)** | **Aggressive** |
|---|---|---|---|---|
| `feeStartBps` → page {SNIPER_FEE_START} | 5000 → "50%" | 9900 → "99%" | **9000 → "90%"** | 2500 → "25%" |
| `feeEndBps` → {SNIPER_FEE_END} | 100 → "1%" | 100 → "1%" | **100 → "1%"** | 100 → "1%" |
| `feePeriods` (period length) | 10 (15 slots) | 30 (15 slots) | **10 (15 slots)** | 5 (30 slots) |
| `feeDurationSlots` → {SNIPER_FEE_DURATION} | 150 → "~60 s (approx., 150 slots)" | 450 → "~3 min (approx., 450 slots)" | **150 → "~60 s (approx., 150 slots)"** | 150 → "~60 s (approx., 150 slots)" |
| `creatorTradingFeePercentage` | 0 | 0 | **0** | 50 |
| `migrationFeeOption` → {POOL_FEE} | FixedBps25 → "0.25%" | FixedBps100 → "1%" | **FixedBps25 → "0.25%"** | FixedBps25 → "0.25%" |
| `migrationQuoteThresholdSol` (curve size; page "of Y SOL threshold") | 1 | 1 | **3** | 10 |
| `totalSupply` | 1,000,000,000 | 1,000,000,000 | **1,000,000,000** | 1,000,000,000 |
| `percentageSupplyOnMigration` (≈ sold on curve) | 20 (≈80%) | 20 (≈80%) | **20 (≈80%)** | 30 (≈70%), uses PR 9's option |
| Token accounts needed to buy the whole curve while the cap is 1% (first 150 slots) | ~80 | ~80 | **~80** | ~70 |
| Fee in slots 0–14 / at ~30 s (slot 75) | 50% / ~25.5% | 99% / ~83% | **90% / ~45.5%** | 25% / ~15.4% |

Fee mid-points are linear-scheduler estimates from the built configs: Balanced drops 8.9% per 15-slot period, Conservative 3.27%, defaults 4.9%, Aggressive 4.8% per 30 slots.

## Raw configs (paste into the builder; all proposals)
```json
{ "Conservative": { "feeStartBps": 9900, "feeEndBps": 100, "feePeriods": 30, "feeDurationSlots": 450, "creatorTradingFeePercentage": 0, "migrationFeeOption": "FixedBps100", "migrationQuoteThresholdSol": 1, "totalSupply": 1000000000, "percentageSupplyOnMigration": 20 },
  "Balanced":     { "feeStartBps": 9000, "feeEndBps": 100, "feePeriods": 10, "feeDurationSlots": 150, "creatorTradingFeePercentage": 0, "migrationFeeOption": "FixedBps25",  "migrationQuoteThresholdSol": 3, "totalSupply": 1000000000, "percentageSupplyOnMigration": 20 },
  "Aggressive":   { "feeStartBps": 2500, "feeEndBps": 100, "feePeriods": 5,  "feeDurationSlots": 150, "creatorTradingFeePercentage": 50, "migrationFeeOption": "FixedBps25",  "migrationQuoteThresholdSol": 10, "totalSupply": 1000000000, "percentageSupplyOnMigration": 30 } }
```
`migrationFeeOption` uses SDK enum names: FixedBps25 = 0, FixedBps100 = 2.

## Trade-offs
- **Anti-sniper fee vs the Balanced cap:**
  - For Balanced and the defaults, the fee schedule runs over exactly the cap's first step (slots 0–150, 1% cap).
  - So a slot-0 crew needs ~80 token accounts (cap is per token account; ~80% sold on the curve) **and** pays 90% fees in the first 15 slots.
  - Conservative keeps a high fee into the 2% cap step (to slot 450).
  - The fee ends long before `uncappedAfter` (4,500) in every option. After 150–450 slots, only the cap slows large buys.
- **Ordinary buyers in minute one** pay a lot under Conservative and Balanced. The page's `HighEarlyFee` explainer covers this. The steady 1% matches pump.fun's 1.25% band and is below Bags' 2%.
- **Pool fee after migration:**
  - 0.25% is the lowest enum value and is normal for trading.
  - 1% (Conservative) means more fee per trade, which looks worse to traders.
  - There's no anti-sniper fee after migration in any option, so the post-migration buys the replay showed are uncapped and pay only {POOL_FEE}.
- **Curve size:**
  - A smaller threshold means a smaller worst-case loss per token (QA L8) and an easier devnet graduation test.
  - It doesn't change the token-account count, because the cap is a % of supply.
  - 10 SOL (Aggressive) takes more devnet SOL to graduate, and with the airdrop limits that may not be practical (estimate).
- **Supply sold:**
  - 80/20 is the current hard-coded value.
  - 70/30 seeds a deeper pool but needs a code change and leaves less for curve buyers.
- **Creator share:** cosmetic in the beta (we are both partner and creator). Aggressive's 50 exists only to test the split display.

## Recommendation
**Balanced:** `feeStartBps` 9000 → `feeEndBps` 100 over `feeDurationSlots` 150 in `feePeriods` 10, `creatorTradingFeePercentage` 0, `migrationFeeOption` FixedBps25, `migrationQuoteThresholdSol` 3, `totalSupply` 1B, `percentageSupplyOnMigration` 20.

Why:
- The fee is maximal at slot 0, which is where the fixtures were bought out.
- It ends with the 1% cap step.
- It needs no code change apart from the threshold value.
- The curve is small enough for a devnet graduation test.

> **King decision:** pick Conservative, Balanced or Aggressive (or your own values) for the anti-sniper fee, pool fee, curve size and supply sold. Research recommends **Balanced** (90% → 1% over ~60 s, 0.25% pool fee, 3 SOL curve, 80% sold on the curve).

## Disclosures unchanged by any option
None of these options changes the page rules:
- The cap is per token account. One wallet can hold several token accounts, and anyone can split across wallets.
- The schedule can't be tightened; it can only be lifted.
- The pool vault and the migration path are exempt from the cap.
- The one-way switch can only lift the cap, and every use is announced.

## Validation (offline, no network, no keys)
- **Script:** `research/validate_fee_options.ts`, run with `node --import tsx research/validate_fee_options.ts`.
- **What it does:**
  - Builds each option with the same object as `Launchpad.configParams`. For percentage 20 it compares byte-for-byte with the real method: **YES** for defaults, Conservative and Balanced.
  - Runs the SDK's `validateConfigParameters` with `isTransferHook: true` and our hook program: **OK for all 4**.
  - Renders the full `page_content.json` with each option's fee config through `pageVars`/`fill`, as `tests/copy_v0d.test.ts` does: **no raw {...} in any option**.
- **Negative checks:** start 9,901 bps, end 24 bps, end > start and creator 101% are all rejected by the SDK.
- No Rust build was needed (disk had 2.9 GB free).

## Open questions
- `app/server.ts:96` passes only `thresholdSol` from the launch form, so fee fields can't be set from the page yet. Should King's choice become `DEFAULT_LAUNCH_FEES` (`launch.ts:53`)? That's an Engineer change.
- Aggressive uses `percentageSupplyOnMigration` 30, available since PR 9. Its real-SDK check is in PR 9's `supply_option` tests; `validate_fee_options.ts` builds Aggressive through its own copy of the builder.
- The real per-buyer fee impact on a DBC curve. Measure on devnet with 2 swaps (AC-19).
- Mainnet curve size and worst-case loss: still a King sign-off under QA L8, not decided here.

## Devnet finding: the pool fee after migration is not flat (2026-10-04)

QA's on-chain check of the devnet launch ([DAMM v2 pool](https://explorer.solana.com/address/BokKAyHoNp4NVgeECKrfnoXdL5f2LyKiSco1YE5qhPjr?cluster=devnet)) found that `FixedBps25` gives a base fee of 0.25% with **dynamic fee on**, capped at about 0.30% total. Setting `migratedDynamicFee=0` did not turn it off. So "FixedBps25 → 0.25%" in the tables above is the **base** fee, not a flat fee. The page copy (v0f) says "base {POOL_FEE}, can rise when volatility is high".

Flat versus dynamic is part of King's pick. Engineer checked this against DBC SDK 1.5.13 and the DBC program source. A truly flat fee needs `migrationFeeOption` `Customizable` (6) with `migratedPoolFee { poolFeeBps: 25, dynamicFee: 0, collectFeeMode: 0 }` (`poolFeeBps` must be 10–1000), and migration goes through the Customizable DAMM v2 config. With any Fixed option, every Fixed preset has dynamic fee on, and the extra fee is capped at 20% of the base fee (0.25% base, about 0.30% max). If King picks flat, the copy goes back to "flat {POOL_FEE}", and a fresh devnet launch verifies it.

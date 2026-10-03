# Replay results v0: Research sniper fixtures through the cap math (LOCAL simulation)

**LOCAL / cap-math simulation, not on-chain.** Generated 2026-10-04 05:10:58 ICT by `scripts/replay_report.ts` and checked by `tests/replay.test.ts`. Inputs: Research's `replay_fixtures_v0` (5 mainnet bonding-curve launches, read-only data, **anonymised as fixtures A–E**; owners, token accounts and tx ids are replaced by per-fixture labels) and the schedules in `sdk/schedules.ts` (proposals from `research/cap_schedule_options.md`; none is production).

How it works: every fixture row with a token-balance change is replayed in (slot, block index) order through `sdk/capMath.ts`, the same math the program uses, with balance tracked **per token account**. Rule mirrored from `programs/trenches-hook`: the receiving token account's post-balance must be ≤ cap(slot offset). Exempt receivers are only accounts owned by the DBC or DAMM v2 pool authority PDAs. The source is never checked. **A tx with any over-cap transfer reverts as a whole**, because the hook rejects the transfer and the tx fails.

## Crew results per fixture × schedule
Key:
- *orig* = % of supply the crew got in the fixture.
- *as-is* = the crew's holdings if the same txs were replayed unchanged.
- *resized* = best case on the curve with the **same token accounts** (each buy shrunk to fit its account's cap).
- *post-grad* = crew buys after graduation, which have no cap.
- *accounts needed* = token accounts needed at the slot-0 cap to reach the crew's original curve %.

| Fixture | Crew | Schedule | Cap at slot +0 | Crew orig | Curve part | Blocked (as-is) | Crew as-is | Resized (same accounts) | Post-grad, uncapped | Accounts needed |
|---|---|---|---|---|---|---|---|---|---|---|
| A | S1+S2+S3+S4 | Strict | 0.50% | 78.03% | 78.03% | 78.03% | 0.00% | 2.00% | 0.00% | 157 |
| A | S1+S2+S3+S4 | Balanced | 1.00% | 78.03% | 78.03% | 78.03% | 0.00% | 4.00% | 0.00% | 79 |
| A | S1+S2+S3+S4 | Loose | 2.00% | 78.03% | 78.03% | 78.03% | 0.00% | 8.00% | 0.00% | 40 |
| A | S1+S2+S3+S4 | Current test (demo) | 1.00% | 78.03% | 78.03% | 78.03% | 0.00% | 4.00% | 0.00% | 79 |
| B | S1+S2+S3+S4 | Strict | 0.50% | 78.00% | 78.00% | 78.00% | 0.00% | 2.00% | 0.00% | 156 |
| B | S1+S2+S3+S4 | Balanced | 1.00% | 78.00% | 78.00% | 78.00% | 0.00% | 4.00% | 0.00% | 78 |
| B | S1+S2+S3+S4 | Loose | 2.00% | 78.00% | 78.00% | 78.00% | 0.00% | 8.00% | 0.00% | 39 |
| B | S1+S2+S3+S4 | Current test (demo) | 1.00% | 78.00% | 78.00% | 78.00% | 0.00% | 4.00% | 0.00% | 78 |
| C | B1+B2+B3+B4+DEV | Strict | 0.50% | 99.56% | 79.31% | 79.31% | 20.25% | 2.00% | 20.25% | 159 |
| C | B1+B2+B3+B4+DEV | Balanced | 1.00% | 99.56% | 79.31% | 79.31% | 20.25% | 4.00% | 20.25% | 80 |
| C | B1+B2+B3+B4+DEV | Loose | 2.00% | 99.56% | 79.31% | 79.31% | 20.25% | 8.00% | 20.25% | 40 |
| C | B1+B2+B3+B4+DEV | Current test (demo) | 1.00% | 99.56% | 79.31% | 79.31% | 20.25% | 4.00% | 20.25% | 80 |
| D | DEV+POOL_BUYER | Strict | 0.50% | 99.65% | 79.31% | 79.31% | 20.34% | 0.50% | 20.34% | 159 |
| D | DEV+POOL_BUYER | Balanced | 1.00% | 99.65% | 79.31% | 79.31% | 20.34% | 1.00% | 20.34% | 80 |
| D | DEV+POOL_BUYER | Loose | 2.00% | 99.65% | 79.31% | 79.31% | 20.34% | 2.00% | 20.34% | 40 |
| D | DEV+POOL_BUYER | Current test (demo) | 1.00% | 99.65% | 79.31% | 79.31% | 20.34% | 1.00% | 20.34% | 80 |
| E | DEV+POOL_BUYER | Strict | 0.50% | 99.42% | 79.31% | 79.31% | 20.11% | 0.50% | 20.11% | 159 |
| E | DEV+POOL_BUYER | Balanced | 1.00% | 99.42% | 79.31% | 79.31% | 20.11% | 1.00% | 20.11% | 80 |
| E | DEV+POOL_BUYER | Loose | 2.00% | 99.42% | 79.31% | 79.31% | 20.11% | 2.00% | 20.11% | 40 |
| E | DEV+POOL_BUYER | Current test (demo) | 1.00% | 99.42% | 79.31% | 79.31% | 20.11% | 1.00% | 20.11% | 80 |

## Per-sniper detail (Balanced, the devnet default "approved by King (Oct 4, 2026)")
| Fixture | Member | Phase | Bought (orig) | Received as-is | Max in that account | Blocked | Accounts needed for that buy |
|---|---|---|---|---|---|---|---|
| A | S1 | curve | 43.77% | 0.00% | 1.00% | 43.77% | 44 |
| A | S2 | curve | 18.23% | 0.00% | 1.00% | 18.23% | 19 |
| A | S3 | curve | 9.97% | 0.00% | 1.00% | 9.97% | 10 |
| A | S4 | curve | 6.05% | 0.00% | 1.00% | 6.05% | 7 |
| B | S1 | curve | 43.78% | 0.00% | 1.00% | 43.78% | 44 |
| B | S2 | curve | 18.15% | 0.00% | 1.00% | 18.15% | 19 |
| B | S3 | curve | 10.00% | 0.00% | 1.00% | 10.00% | 10 |
| B | S4 | curve | 6.07% | 0.00% | 1.00% | 6.07% | 7 |
| C | B1 | curve | 44.70% | 0.00% | 1.00% | 44.70% | 45 |
| C | B2 | curve | 18.36% | 0.00% | 1.00% | 18.36% | 19 |
| C | B3 | curve | 10.01% | 0.00% | 1.00% | 10.01% | 11 |
| C | B4 | curve | 6.24% | 0.00% | 1.00% | 6.24% | 7 |
| C | DEV | post-graduation | 20.25% | 20.25% | no cap | 0.00% | n/a (uncapped) |
| D | DEV | curve | 79.31% | 0.00% | 1.00% | 79.31% | 80 |
| D | POOL_BUYER | post-graduation | 20.34% | 20.34% | no cap | 0.00% | n/a (uncapped) |
| E | DEV | curve | 79.31% | 0.00% | 1.00% | 79.31% | 80 |
| E | POOL_BUYER | post-graduation | 20.11% | 20.11% | no cap | 0.00% | n/a (uncapped) |

## Specific checks
- **Same tx, 2 owners, 2 token accounts (fixture C, block idx 947 and 948):** the cap is checked **per receiving token account**, once per transfer, not once per tx. Under Balanced: B1 blocked (tx reverted), B2 blocked (tx reverted), B3 blocked (tx reverted), B4 blocked (tx reverted). Because a rejected transfer fails the tx, the other buy in the same tx is rolled back too.
- **1 owner, 2 token accounts (synthetic, AC-6):** the owner holds **2× the cap**, because the cap is per token account by design (see `tests/replay.test.ts`). A third buy into either account above its cap is blocked.
- **Post-graduation buys show as uncapped. This is a design limit, stated plainly.** Once the curve completes, DBC revokes the transfer hook, so the rule stops. In fixtures C, D and E, one wallet bought ~20% from the new pool right after migration. No schedule stops that, because `uncapped_after` doesn't matter once the hook is gone. In this replay we use the fixture's own migration point. With a cap in place the curve probably would **not** have completed at that point (the crew's curve buys revert), so the post-graduation rows show what the design allows, not what would have happened.

## Assumptions and caveats
1. Simulation of the cap math only. It doesn't run the program, DBC, fees or prices. It uses **% of supply (tokens)**, not SOL, as the fixture notes recommend. The DBC curve and fee schedule would change prices, and the anti-sniper fee isn't modelled here.
2. Launch slot = the fixture's creation slot (our hook config is created in the pool-creation tx), so slot offset = fixture `slot_offset`. All fixture curve buys are at +0, so only the first step of each schedule is ever reached. The later steps and `uncapped_after` aren't exercised by these fixtures (Research notes there's no +1..+3 curve sniping in v0).
3. **Pool-authority info:** fixture rows record owners and token accounts but not DBC/DAMM pool vaults. They're rows from another launchpad's curve and AMM, and none of the owners is the DBC or DAMM v2 pool authority, so **no row is exempt**. Sells (negative token deltas) go into a pool vault, which is an exempt receiver, so they're never blocked.
4. D and E: the "DEV" curve buy is inside the token's create tx. In our flow the hook config is initialised in the pool-creation tx, and any later buy in that tx would be capped the same way. We don't do a creator first-buy.
5. Crew membership comes from Research's linking evidence: co-signer and funder for A and B, creator funding for C. **In fixtures D and E, the link between the crew wallets is inferred, not proven** (consecutive block indexes only).
6. "Accounts needed" = ceil(orig curve % / slot-0 cap). Each account can be a fresh wallet or another token account of the same owner, and the cap can't tell them apart. Splitting across accounts defeats any per-account cap. With Balanced, the 4-wallet crew snipe becomes ~78–80 accounts.
7. Fixture data is read-only research data, used as test input only. Token names and all mainnet addresses (mints, wallets, token accounts, tx ids) are removed: fixtures are labelled A–E and ids are per-fixture labels.

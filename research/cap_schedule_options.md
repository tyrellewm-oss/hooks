# Cap schedule options for King (answers QA M-8)

Deployer Research, Oct 3 2026, ~23:25 ICT. Design only. **Every number is a proposal or an estimate** unless a source is cited.

> **APPROVED (Oct 4, 2026, 04:16 ICT): King picked Balanced**: steps (0,100) (150,200) (1500,400), `uncapped_after` 4500 (1% of supply rising to 4%, no cap after ~30 min, estimate at 0.4 s/slot). Strict and Loose are **not approved**. Fee values, curve size and supply sold are still open.

## What the config accepts (from `crates/cap-math/src/lib.rs`, PR 4)
- **Steps:** `steps[] = (slot_offset, max_bps)`. The offset counts slots from `launch_slot`, and caps are in **bps of the reference supply** (100 bps = 1%). From `uncapped_after` slots on, there is no cap.
- **Release limits:**
  - 1–8 steps; the first step must be at offset 0.
  - Steps at least 10 slots apart; the total ramp at least 150 slots.
  - `uncapped_after` ≤ 6,480,000 slots (~30 days).
  - Caps between 10 bps (0.1%) and 10,000 bps; they must never decrease.
- **The cap applies per token account** (QA H-2). One wallet can open many token accounts, so the counts below are "token accounts needed", which can mean one wallet or many.
- **Time:** ~0.4 s per slot (estimate), so 150 slots ≈ 1 min, 1,500 ≈ 10 min, 9,000 ≈ 1 h.

## Options (proposals)
| | **Strict** | **Balanced** (APPROVED by King, Oct 4 2026) | **Loose** |
|---|---|---|---|
| `steps` (slot_offset, max_bps) | (0, 50), (150, 100), (750, 200), (2250, 400) | (0, 100), (150, 200), (1500, 400) | (0, 200), (150, 500) |
| `uncapped_after` | 9,000 slots (~1 h) | 4,500 slots (~30 min) | 1,500 slots (~10 min) |
| In plain words | 0.5% for 1 min → 1% to 5 min → 2% to 15 min → 4% to 1 h → no cap | 1% for 1 min → 2% to 10 min → 4% to 30 min → no cap | 2% for 1 min → 5% to 10 min → no cap |
| Page placeholders | {CAP_START}=0.5%, {CAP_END}=4%, {CAP_RAMP}=about 1 hour | 1%, 4%, about 30 minutes | 2%, 5%, about 10 minutes |
| Token accounts a crew needs to take **78%** in the first minute (Fixture A) | **156** | **78** | **39** |
| Normal buyer at the first step (cost estimate*) | ≤~0.14 SOL | ≤~0.28 SOL | ≤~0.56 SOL |
| Step shape | 4 steps, doubling | 3 steps, doubling | 2 steps |

\* Estimate from the fixture: on a pump-style curve, 0.1 SOL bought 0.3565% at launch (replay fixtures, Fixture A dev buy). DBC curve parameters differ, and the same % costs more later as the price rises.

## What a cap does and doesn't do against the fixtures
- **The pattern:** in the fixtures, snipers took **78–79% in slot 0 with 4 wallets**, one token account each, and Fixture A's curve completed and migrated in slot +0 (`replay_fixtures_v0.md`).
- **What any cap does:** it turns "4 buys" into dozens of buys. With Balanced, that's ~78 swaps.
- **Why that matters:** at maybe ~4–5 hooked swaps per tx (compute estimate, not measured), that's ~16–20 txs. A Jito bundle holds at most 5 txs ([Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)), so the crew can't take most of the curve atomically in one bundle in slot 0. Real users get a window, and every extra slot costs the crew the anti-sniper fee.
- **What it doesn't do:** it doesn't stop a crew willing to open 78+ token accounts. Token-account rent is tiny, ~0.002 SOL each (estimate). Splitting defeats any cap. **This is why the copy says "slows snipers down, doesn't stop them", never "anti-bundle".**
- **Cap vs supply:** caps count against the **reference supply**. If the curve sells only part of the supply (DBC config), a 1% cap is a bigger share of what's actually for sale. Pick caps together with the curve size (QA L8 small curves).

## Interaction with the anti-sniper fee and graduation
- **The fee does the slot-0 work; the cap does the size work.** Set DBC's fee scheduler with its **maximum cliff fee at slot 0**, decaying over the **first cap step (150 slots, ~1 min)** ([fee scheduler](https://docs.meteora.ag/core-products/dbc/fees/fee-scheduler.md); the total fee is capped at 99%). Splitting into many txs then has to happen while the fee is high.
- **Graduation removes the hook** (DBC `revoke_transfer_hook`, [transfer-hook pools](https://docs.meteora.ag/core-products/dbc/transfer-hook-pools.md)), so **the cap only matters before graduation**.
  - Small curves may fill in minutes to hours (estimate; the pump fixture filled in slot 0).
  - If the curve fills before `uncapped_after`, the later steps never happen. That's fine, because sells are always exempt.
  - So a ramp much longer than the typical curve life adds nothing. That's why I didn't propose anything near the 30-day maximum.
- **The lift-only switch** can end any schedule early, for example if real buyers are hitting the cap too often. Every use is announced (AC-11/12).

## Recommendation
**Balanced:** 1% → 2% → 4% over ~30 minutes, with the anti-sniper fee at its maximum in slot 0 and decaying over the first minute.
- It matches Engineer's example (1% first ~150 slots, 2% to ~1,500).
- It keeps normal first-minute buys around a few tenths of a SOL (estimate).
- It forces a 78%-crew into ~78 token accounts and many txs.
- It's short enough to test AC-5 on devnet in one sitting with real slot offsets (QA's `qa_schedule` prints the verdict).

Use **Strict** if King cares more about sniper resistance than early-buyer friction. **Loose** only works as a demo setting.

> **King decision (Oct 4, 2026, 04:16 ICT): Balanced approved.** Strict and Loose not approved. Schedule values unchanged from the proposal above.

**Open:**
- Hooked-swap compute per tx on DBC (measure on devnet).
- The DBC curve size and sold share for beta tokens (Engineer/QA L8).
- Fee scheduler values (cliff %, periods) to pair with the schedule.

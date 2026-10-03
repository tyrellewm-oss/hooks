# Trenches launchpad: page content (devnet build)

Final page strings, made from the disclosure copy in `concepts/hook_launchpad_feasibility_v0.md` (Research, experiment framing) and updated for NEO's three requirements, QA review b6ffd85 (H-2, M-5, M-6), the graduation finding (`docs/replay_results_v0.md`) and the fee model in `sdk/launch.ts` (version v0-devnet-2026-10-04f):
- the cap is described as per token account (not per wallet) and splittable, never with the banned bundle term;
- the pool vault and migration path are exempt;
- the lift-only switch is disclosed, and every use is announced;
- the cap ends at graduation or after {CAP_RAMP}, whichever comes first; after that, including pool buys right after migration, there is no cap;
- the anti-sniper fee applies on the curve only; after migration only the pool's trading fee applies (base {POOL_FEE}, can rise when volatility is high). No fee numbers are hard-coded.

The machine-readable copy is `page_content.json`; keep the two in sync. Placeholders are in `{BRACES}` and must all be filled before render (AC-25). The QA copy check (AC-27) must pass on this text.

## Devnet label (badge, every page)
> DEVNET TEST - no real value

## Banner (every page)
> ⚠️ DEVNET TEST - no real value. Unaudited experiment: experimental code, tiny test tokens. On mainnet you could lose everything you put in. Not an investment.

## Pre-trade checklist (all 8 must be ticked to enable Buy/Sell; AC-24)
**Before you trade, confirm each line:**

1. ☐ This is an unaudited experiment. The code has had internal and volunteer review only, no paid audit.
2. ☐ The code is experimental and may have bugs. I can lose everything I put in.
3. ☐ The rule: while the token is on the bonding curve, each token account can hold at most {CAP_START} of supply, rising to {CAP_END}. The cap ends at graduation or after {CAP_RAMP}, whichever comes first. A buy that would push a token account over the cap fails. The cap is per token account, not per wallet: one wallet can hold several token accounts, and anyone can split across wallets, so this slows snipers down but does not stop them.
4. ☐ Selling back into the curve is never blocked by the rule. The pool vault and the graduation (migration) path are exempt from the cap.
5. ☐ Keys: program upgrades are controlled by {MULTISIG}. The same key has one switch that can only lift the rule (raise or remove the cap), never add or tighten it. Every use of the switch is announced at {ANNOUNCE_CHANNEL}.
6. ☐ When the curve completes (graduation), the rule is removed automatically and the token becomes a plain token. After that, including buys from the pool right after migration, there is no cap: only the pool's trading fee applies: base {POOL_FEE}, can rise when volatility is high (no anti-sniper fee), plus normal trading.
7. ☐ This is not an investment. Nobody promises any price, gain or future work. Trading fees go to {FEE_SPLIT}.
8. ☐ I am not in a restricted jurisdiction ({RESTRICTED_LIST}) and I am not using a VPN to get around it.

Button: **I understand - enable trading**

## Rules and risks block (every token page; AC-25)
**Rules and risks: {TICKER}**

- Status: DEVNET TEST - no real value. Unaudited experiment. Source: {REPO_COMMIT}. Program: {PROGRAM_ID}.
- Rule (curve only): each token account can hold at most {CAP_START} of supply, rising to {CAP_END}. The cap ends at graduation or after {CAP_RAMP}, whichever comes first. Fixed at launch. It can't be tightened; it can only be lifted (see Admin power).
- Not protected against: one wallet holding several token accounts, or one person using many wallets (the cap is per token account, not per wallet); buys after the cap ends (at graduation or after {CAP_RAMP}, whichever comes first), which have no cap; buys from the pool right after migration, where only the pool's trading fee applies: base {POOL_FEE}, can rise when volatility is high (no anti-sniper fee); bugs; the price going to zero.
- Always allowed: selling back into the curve. The pool vault and the graduation (migration) path are exempt from the cap.
- Admin power: {MULTISIG} can (1) upgrade the program and (2) use a one-way switch that only raises or removes the cap. Every switch use emits an on-chain event and is announced at {ANNOUNCE_CHANNEL}. Switch history: {SWITCH_HISTORY}.
- At graduation: the hook is removed by Meteora DBC, and the token trades as a plain Token-2022 token on DAMM v2 with no cap.
- Fees: on the bonding curve only, an anti-sniper fee starts at {SNIPER_FEE_START} and falls to {SNIPER_FEE_END} over {SNIPER_FEE_DURATION}, then stays at {SNIPER_FEE_END} until graduation. This fee applies to every buyer, not only bots: buying in the first {SNIPER_FEE_DURATION} costs more, so if you don't want to pay it, wait until it reaches {SNIPER_FEE_END}. After migration, only the pool's trading fee applies: base {POOL_FEE}, can rise when volatility is high (no anti-sniper fee). Meteora takes its protocol share; the rest goes to {FEE_SPLIT}.
- Our tokens: this beta only launches tokens made by the studio. They are never promoted in any content or alerts, and the team does not trade them.

## Why did my trade fail? (AC-26)

| Error code | Text |
|---|---|
| `WalletCapExceeded` | Token account cap: this buy would put your token account over the current cap. It holds {WALLET_BALANCE}; the cap right now is {WALLET_CAP}. Try a smaller amount, or wait: the cap rises to {NEXT_CAP} at {NEXT_CAP_TIME}. The cap is per token account and is the only rule on this token. The cap ends at graduation or after {CAP_RAMP}, whichever comes first. |
| `NotTransferring` | Your wallet or app didn't add the extra accounts this transfer-hook token needs, so the transfer was refused. Try the trade panel on this page or a hook-compatible wallet from the list: {COMPAT_LINK}. |
| `InvalidMint` | Your wallet or app didn't add the extra accounts this transfer-hook token needs, so the transfer was refused. Try the trade panel on this page or a hook-compatible wallet from the list: {COMPAT_LINK}. |
| `Unauthorized` | Launcher error: this is not caused by your trade. Please report it at {REPORT_CONTACT} with the transaction link: {TX_LINK}. |
| `InvalidCapSchedule` | Launcher error: this is not caused by your trade. Please report it at {REPORT_CONTACT} with the transaction link: {TX_LINK}. |
| `ConfigFrozen` | This token's rule is fixed and can't be tightened. |
| `HookNotSupported` | Your wallet or app didn't add the extra accounts this transfer-hook token needs, so the transfer was refused. Try the trade panel on this page or a hook-compatible wallet from the list: {COMPAT_LINK}. |
| `HighEarlyFee` | Not a failure: on the bonding curve, the anti-sniper fee starts at {SNIPER_FEE_START} and falls to {SNIPER_FEE_END} over {SNIPER_FEE_DURATION}. Your trade went through but cost more. After migration there is no anti-sniper fee. |
| `SlippageOrBalance` | The price moved past your slippage limit, or your wallet doesn't have enough devnet SOL for fees and account rent. Try again with more slippage or more devnet SOL. |
| `SellFailed` | A sell into the curve should never be blocked by the rule. Please report it now at {REPORT_CONTACT} with the transaction link. A hook-blocked sell pauses all new launches until we post a review. |
| `Unknown` | The trade failed with an error we don't recognise: {RAW_ERROR}. Check the transaction on the explorer: {TX_LINK}. |

## Footer
> DEVNET TEST - no real value. Unaudited experiment. Open source: {REPO_COMMIT}. Upgrade key: {MULTISIG}. Switch announcements: {ANNOUNCE_CHANNEL}. Not an investment and not financial advice. Not available in {RESTRICTED_LIST}.

## Placeholders
| Placeholder | Meaning / source / display |
|---|---|
| `{CAP_START}` | starting cap, % of supply (e.g. 1%) |
| `{CAP_END}` | last cap before no cap (e.g. 2%) |
| `{CAP_RAMP}` | ramp length in plain words (e.g. about 10 minutes) |
| `{MULTISIG}` | devnet: 'a throwaway devnet test key ({AUTHORITY_PUBKEY})'; mainnet plan: '2-of-3 multisig {ADDRESS} (members: names)' |
| `{ANNOUNCE_CHANNEL}` | status page URL / X handle (King decision N3) |
| `{FEE_SPLIT}` | who receives the non-protocol share, e.g. 'the creator and the studio' with % from the DBC config (creator_trading_fee_percentage) |
| `{RESTRICTED_LIST}` | counsel decides; devnet placeholder 'restricted regions (list pending)' |
| `{TICKER}` | token ticker |
| `{REPO_COMMIT}` | repo URL@commit |
| `{PROGRAM_ID}` | devnet program id |
| `{SWITCH_HISTORY}` | list of RestrictionsLifted events or 'none' |
| `{WALLET_BALANCE}` | destination token account's balance |
| `{WALLET_CAP}` | cap_at(now), per token account |
| `{NEXT_CAP}` | next cap step or 'no cap' |
| `{NEXT_CAP_TIME}` | approx time of next step |
| `{COMPAT_LINK}` | compat table URL |
| `{REPORT_CONTACT}` | bug report contact |
| `{RAW_ERROR}` | raw program error |
| `{TX_LINK}` | explorer link with ?cluster=devnet |
| `{SNIPER_FEE_START}` | anti-sniper fee at launch, curve only. Source: launch config feeStartBps (sdk/launch.ts). Display: % (bps/100, e.g. '50%') |
| `{SNIPER_FEE_END}` | curve fee after the schedule ends, until graduation. Source: feeEndBps. Display: % (bps/100) |
| `{SNIPER_FEE_DURATION}` | length of the anti-sniper fee schedule. Source: feeDurationSlots. Display: human time at ~0.4 s/slot, e.g. 'about 1 minute' |
| `{POOL_FEE}` | base trading fee of the DAMM v2 pool after migration (no anti-sniper fee schedule). The pool's dynamic fee is on, so the charged fee can be higher when volatility is high; copy must say "base" and "can rise" unless the config turns dynamic fee off. Source: the DBC config's migration fee option (MigrationFeeOption, e.g. FixedBps25). Display: % (bps/100) |

All six program errors are keyed: WalletCapExceeded (cap hit); NotTransferring and InvalidMint (wallet didn't add the hook's extra accounts, same text as HookNotSupported); Unauthorized and InvalidCapSchedule (admin/launcher-only, not caused by a trade); ConfigFrozen (shown only on re-init or a repeated switch use, never as a trade-retry message). HookNotSupported, HighEarlyFee, SlippageOrBalance and SellFailed are UI-side classifications; Unknown is the fallback. Placeholder names {WALLET_BALANCE}/{WALLET_CAP} are kept for compatibility but refer to the token account. Fee placeholders (v03d): {SNIPER_FEE_START}, {SNIPER_FEE_END}, {SNIPER_FEE_DURATION} (curve only) and {POOL_FEE} (after migration) replace {CLIFF_FEE}, {FEE_PERIOD} and {BASE_FEE}.

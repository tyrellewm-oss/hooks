# Devnet launch log (v0.1.0-devnet-unaudited)

**DEVNET ONLY. UNAUDITED EXPERIMENT. Test tokens with no real value.** All keys below are throwaway devnet keys.
Times are ICT (UTC+7), Sunday Oct 4, 2026. Cluster: Solana devnet (genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, checked before deploy), RPC `https://solana-devnet.api.onfinality.io/public`.

## 1. Build

| | |
|---|---|
| Source | `public-main` commit `f8803e8dfd71f8ea5366fcbe4d1a2f6d77afc2d4` (worktree `launchpad-public`) |
| `git status --porcelain --untracked-files=no` | empty (only untracked: the `node_modules` and `target` symlinks, not part of the tree) |
| Command | `CARGO_TARGET_DIR=<launchpad>/target cargo build-sbf --manifest-path programs/trenches-hook/Cargo.toml --sbf-out-dir <launchpad>/target/deploy` (no `--features`: test-slots OFF, release schedule guards on) |
| Output | `trenches_hook.so`, 393,592 bytes |
| **sha256 (built .so)** | `02d402bc2e2db90d69c6eb7155483364d7afca1cc500c010a90e5de36927bead` |
| Toolchain | solana-cli 3.0.14 (Agave, src:f516a892), solana-cargo-build-sbf 3.0.14, platform-tools v1.51 (rustc 1.84.1 for SBF), host rustc/cargo 1.85.1, anchor-lang 0.32.2 (Cargo.lock), anchor-cli 0.32.2, node v20.19.2, pnpm 10.33.4 |
| Binary checks | contains `Destination token account would be over the current cap`, the `token_account=` log label, `test_slots_build=release`; no `per-wallet` string |
| Full `pnpm check` (cargo ON) | cap-math 10/10, TS 117/117 (0 skipped; the litesvm hook tests ran against this .so), secret scan clean, `CI: ALL GREEN` |

`solana-verify build` was skipped (its Docker image does not fit the disk). Instead, compare the program dumped from devnet with the built .so:

## 2. Deploy

| | |
|---|---|
| Program ID | [`FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz`](https://explorer.solana.com/address/FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz?cluster=devnet) |
| ProgramData | `DnaLcoznENi7obxvVPMv6GJjmhKC3o5485f9etNS2hoT`, data length 393,592, last deployed slot 507156100 |
| Upgrade authority | `9DVuoJSvxq97wyC9GmvB3GbAGfKywAvtK7VAXgiroFDu` (throwaway devnet key; also the lift-switch authority in `global`) |
| Deploy tx (05:55:15 ICT, blockTime) | [`3B68U43f…`](https://explorer.solana.com/tx/3B68U43fm6BFHt4SJtVx4Mw87gwN75e3WjgH4jpMkN19eJpTP6szfKSckvHNJwUbbMqFSUyW6dFv8XeqhrZ9aZxh?cluster=devnet) (buffer `A4Ppv3L9uzA2HFPeX6fmzDpVvJqm8BFp2RFNcfN1bEqG`; first write attempt hit RPC "Max retries exceeded", the resumed deploy succeeded) |
| **`solana program dump` sha256** | `02d402bc2e2db90d69c6eb7155483364d7afca1cc500c010a90e5de36927bead` (dump is 393,592 bytes, no padding; trimmed-to-.so-length sha256 is the same) → **matches the built .so** |

## 3. Global and launch

Schedule: **Balanced** (1% from +0, 2% from +150, 4% from +1500 slots, no cap from +4500). Fees, curve and supply sold: SDK devnet defaults pending King (anti-sniper fee 50% → 1% over 10 periods / 150 slots, creator fee 0, migration fee option FixedBps25, threshold 1 SOL, 1B supply, `percentageSupplyOnMigration` 20).

| Step | Link |
|---|---|
| `initialize_global` (sets lift authority) | [`4qxK46CL…`](https://explorer.solana.com/tx/4qxK46CLSC5gC6da6SUkmFu65LRaHXcYq8ksGxYNLG4qxBU51BzhD7roSXR54Mw6ke46ZU1G6y7TtzY4TJpCzdju?cluster=devnet) |
| DBC config (`create_config_with_transfer_hook`) | [`2Bw1xivy…`](https://explorer.solana.com/tx/2Bw1xivyhQbWxH8u4u2dRWoyXsLpspSEnYVndYffnCUAXsuBscvZxC8NxxXxc1QmuLYiz34uCtVkySUUe9jV2uYJ?cluster=devnet), config [`5MRwHkx7nmEFWUHjBjb8Y4XLFPvmtr9nxZ6beHt3Ja1h`](https://explorer.solana.com/address/5MRwHkx7nmEFWUHjBjb8Y4XLFPvmtr9nxZ6beHt3Ja1h?cluster=devnet) |
| Token + DBC pool + hook meta list (06:00:50) | [`3ZUiBVdF…`](https://explorer.solana.com/tx/3ZUiBVdFEjoCubVLEXjCEtx16zFEAaWvrr5MvyoVAFExkg8Q8f1xbyLuaWfgsp3iA46d67Es9ch3iXWLAvCmdHHg?cluster=devnet) |
| Mint (TDT, Token-2022) | [`3Ut8PuPt3G21GBth84SdqjWxMAoSp5yjSfQFKM9aMmtE`](https://explorer.solana.com/address/3Ut8PuPt3G21GBth84SdqjWxMAoSp5yjSfQFKM9aMmtE?cluster=devnet) |
| DBC pool | [`6CXB1RQJNtLCkQZMKTRbZaAF6xYbzvfHJ71ZDUdJg8iK`](https://explorer.solana.com/address/6CXB1RQJNtLCkQZMKTRbZaAF6xYbzvfHJ71ZDUdJg8iK?cluster=devnet) |
| Launch slot | 507157521 (uncapped from 507162021) |

Test wallets (throwaway): A = `6hvzTwKNLhEp5Hd6M7AV5iPasUCkkceWA8B68HJUgEGd`, B = `Ah5h1yHBMmoa1rLV4dBJrv15fPtkZYRAWQyGd3PCtCkK`.

## 4. Curve phase (hook active)

| # | Action | Result | Tx |
|---|---|---|---|
| 1 | A buys 0.5% (cap 1%) | OK | [`4AM8ewH7…`](https://explorer.solana.com/tx/4AM8ewH7ChYLGD7Lhwd77rosWXZnmjrUWWZhTZaw229eYGJuiCrE9zf97eD8Sgzue46nuawaCfT6DkoYSkSjzbyc?cluster=devnet) |
| 2 | **Cap hit:** A buys +0.6% (would hold 1.1% > 1%), slot 507157667 = launch+146, 06:01:23 | **FAIL, `WalletCapExceeded` (6000)** as intended | [`4ZkvyxEH…`](https://explorer.solana.com/tx/4ZkvyxEHMD6nW4XcQDDPE1f3xRHVZM5EcmRcmwoCF5PoZkFrooH12hkknQVrEQjUyDANSnBusE6ibzePFDLRWU6m?cluster=devnet) |
| 3 | **SELL:** A sells 0.2% into the curve | OK (selling not blocked) | [`3qd5MvJm…`](https://explorer.solana.com/tx/3qd5MvJmuZGBVMLsS9kDg6ezhiaVbsfs8GxQjDfJ23eMbxSgB3siUhhZka9rA9UkGm6Yrt7xaY6RgTXRmnZRr5cd?cluster=devnet) |
| 4 | B buys 0.9% | OK | [`YVXimruS…`](https://explorer.solana.com/tx/YVXimruSm2KAHwFNiNM4rvUSKrkxe1FUkdNRriB5TRZjmZHCsic8m5XydBxMatANoVugZ7orXffygMzTkrWkZf9?cluster=devnet) |
| 5 | SELL: B sells 0.45% | OK | [`Mi2qYHkK…`](https://explorer.solana.com/tx/Mi2qYHkKTHF72QPR2Eu2yMxMvDNDBwXyFfgDkTH7VCMn6EuoVX2smMGFmdW5NtKbRveioTUiRd8Ct6qXjyGTWig?cluster=devnet) |
| 6 | SELL: B sells all | OK | [`25zLtBdp…`](https://explorer.solana.com/tx/25zLtBdp5BEQysaXAtAgQHLkF7x3w254fyjiEtbaNLxYDFhSFj3yXrCP2maUvTe15434KbfNUp2icQZpA4X678pc?cluster=devnet) |
| 7 | Cap rose to 2% (launch+150): A buys +0.8% | OK | [`5pzYWKyZ…`](https://explorer.solana.com/tx/5pzYWKyZNRCxVwsoVZcLXJX9jPzvfnDRj3A49x8sC57umuGVynKT3dxcjCjB4A77H2CpHifYxEXMsUgingXdNxpS?cluster=devnet) |
| 8 | Cap hit at 2% step: A buys +1.0% (would hold 2.1%), slot 507158057 | FAIL, `WalletCapExceeded` as intended | [`2WaNPXP9…`](https://explorer.solana.com/tx/2WaNPXP9mnoLMXsrauJPQDKXGgyor5co2pD66FZHCrHbdrBBP8oFNDrBN64ea7sZZzAVV3EL6rBQ1Ck4W18AeR2x?cluster=devnet) |
| 9 | After the ramp (no cap): A buys +3% | OK | [`wmKBD7qk…`](https://explorer.solana.com/tx/wmKBD7qkGsJCrLufGP9QGKCA9ZmZ4kaMhJiK8L18EwqCUzyB1qfYP3yVzMmW3w78o1RMDwJRvnxwL1bDCPK9L7R?cluster=devnet) |
| 10 | Graduation: B buys 1.25 SOL in (fills the 1 SOL threshold) | OK, hook revoked on the mint | [`3F2PoxYi…`](https://explorer.solana.com/tx/3F2PoxYigsd9G1CCLDYZ86eFLVCVW4bYrFXbxY9uBECFjsLrktb4ZsdbyVPXjTvGHZKfTp22DQmpvTW5WNzXBcrj?cluster=devnet) |

Raw log lines of the cap-hit tx (#2), from `getTransaction` (commitment confirmed), verbatim:

```
Program ComputeBudget111111111111111111111111111111 invoke [1]
Program ComputeBudget111111111111111111111111111111 success
Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1]
Program log: CreateIdempotent
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 179 of 394499 compute units
Program return: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA pQAAAAAAAAA=
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success
Program 11111111111111111111111111111111 invoke [2]
Program 11111111111111111111111111111111 success
Program log: Initialize the associated token account
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 37 of 389410 compute units
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 229 of 386949 compute units
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success
Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL consumed 13413 of 399850 compute units
Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success
Program 11111111111111111111111111111111 invoke [1]
Program 11111111111111111111111111111111 success
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 201 of 386287 compute units
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success
Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN invoke [1]
Program log: Instruction: Swap2WithTransferHook
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 112 of 362597 compute units
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]
Program log: Instruction: TransferChecked
Program FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz invoke [3]
Program log: Instruction: TransferHook
Program log: WalletCapExceeded: token_account=up8a7VmrxUgEjBjpQAaMqCNMyzwjAu1AFgjcEYcZ7kQ owner=6hvzTwKNLhEp5Hd6M7AV5iPasUCkkceWA8B68HJUgEGd balance=11000000000000 cap=10000000000000 slot=507157667 next_change=Some((507157671, Some(200)))
Program log: AnchorError thrown in programs/trenches-hook/src/lib.rs:190. Error Code: WalletCapExceeded. Error Number: 6000. Error Message: Destination token account would be over the current cap.
Program FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz consumed 26839 of 299610 compute units
Program FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz failed: custom program error: 0x1770
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb consumed 58596 of 331367 compute units
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1770
Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN consumed 113315 of 386086 compute units
Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: 0x1770
```

The #8 cap hit logs the same lines with `balance=21000000000000 cap=20000000000000 slot=507158057 next_change=Some((507159021, Some(400)))`.

Note: the demo's own console tagged #2 only as `FAIL` (not `FAIL (WalletCapExceeded)`); the public RPC was rate-limiting (HTTP 429) at the time, so the script likely could not read the logs back. The on-chain logs above confirm the error.

## 5. Migration and after

| | |
|---|---|
| Migration to DAMM v2 (`migration_damm_v2`) | [`5SJ7mq8n…`](https://explorer.solana.com/tx/5SJ7mq8n6UWtFuHNNzrsUa6g1SyoDJF7L7KaYex1nMG4fSbw52pZEA4VNudF2S7EpGBV6nYbfLJaZf9CwSegzLf4?cluster=devnet) |
| DAMM v2 pool | [`BokKAyHoNp4NVgeECKrfnoXdL5f2LyKiSco1YE5qhPjr`](https://explorer.solana.com/address/BokKAyHoNp4NVgeECKrfnoXdL5f2LyKiSco1YE5qhPjr?cluster=devnet) (config `7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd`) |
| Hook after graduation | mint TransferHook extension: program **null**, authority **null** (revoked by DBC at curve completion); DBC pool `isMigrated = 1` |
| Post-migration buy: A buys with 0.02 SOL from the DAMM v2 pool | OK [`59sM9GP2…`](https://explorer.solana.com/tx/59sM9GP2YQQj3ZcHmWjticVRt1zpqJcgmPjkkqyXdWFqgAni1gucurdwZhgDiFx31R4RLa7XTs5oZ6JKAKXVEQwE?cluster=devnet). Hook program not invoked (absent from the logs). A went from 41,000,000,000,000 to 44,911,803,141,732 base units (4.10% → 4.49% of supply, above the 4% top step), so pool buys after graduation are uncapped, as the README states. |
| DAMM v2 pool fee | base fee 2,500,000 / 1,000,000,000 = **0.25% (25 bps)**, `FeeTimeSchedulerLinear` with 0 periods (constant). Dynamic fee **enabled** on this pool (set by the DAMM config), so the charged fee can be above 0.25% in volatile periods. Protocol share 20%, collect-fee mode 1 (fees in the quote token, SOL). |

## 6. SOL

| | SOL |
|---|---|
| Deployer start | 5.00000000 |
| Deploy (program rent 2.0003262, still held in ProgramData, plus fees) | −2.00312432 |
| Launch run (wallet funding, config/pool rent, curve buys incl. the 1 SOL threshold, migration, post-migration buy) | −1.07074661 (net across deployer + A + B) |
| Left: deployer / A / B | 1.05995504 / 0.26443236 / 0.60174167 = **1.92612907** |

## 7. Reproduce

```
pnpm tsx scripts/dbc_flow.ts demo --cluster devnet --wallet-sol 0.3        # stopped at the ramp wait (RPC 503)
pnpm tsx scripts/devnet_finish.ts <mint> <dbcPool> --cluster devnet         # after-ramp buy, graduation, migration
pnpm tsx scripts/devnet_postmig.ts <mint> <dbcPool> --cluster devnet --sol 0.02   # hook state, DAMM v2 fee, post-migration buy
```
The demo process exited at slot ~507158333 while waiting for the ramp to end (`StructError … Backend error, StatusCode: 503` from the public RPC). `devnet_finish.ts` resumed the same launch after slot 507162021.

Screenshots of the devnet page (home, migrated token page): `artifacts/screens/devnet/` (gitignored, local only).

## 8. Full devnet loop with the separate launch key (tickets #5, 8.3, 8.3b together), 2026-10-04 ICT

**DEVNET.** Program `FieaX…` upgraded to `main` `5290ec1` (release, test-slots OFF). Devnet throwaway keys live outside the repo. Re-checked on chain by Agent B (getTransaction signers, token balance deltas, mint supply).

**Upgrade and migration**
| Step | Tx | Result |
|---|---|---|
| Extend ProgramData by 32,864 bytes | [31vwEJ3d…](https://explorer.solana.com/tx/31vwEJ3dKXnpSpvjjZGuZn8a9Edr7nCiTxwiBCPfhc9GQ87VXuUEcbdfMZMG9ZftZFTt4MT36duF1Kk6Cwjtzwr2?cluster=devnet) | 393,592 → 426,456 bytes |
| Deploy the `5290ec1` release build | [BjqDFdAs…](https://explorer.solana.com/tx/BjqDFdAsJQACjChAWTcrX5RbJaQSeoe7pjnj7UmMonkchH7E52ZP3bGrubck9FWCJGraiBug2CJ9176Vkeun6mm?cluster=devnet) | dumped bytes == build (sha256 `f4b17d05…ac1e`) |
| `migrate_global_v2` (launch key `ApupQ3…`) | [NaBbrAdm…](https://explorer.solana.com/tx/NaBbrAdm6okQQQZY3nfyZfiNFqnxoCznBa63Aen6ANzwvDghGj7pKhh9rGtv7VJpRnsMuLYneaVAiar6vQEGzfS?cluster=devnet) | Global 42 → 74 bytes; bytes 0..42 identical (`tests/fixtures/devnet_global_migration.json`) |

**Launch → graduation.** Mint `89BfATjv5WEP3Jrdd3ZndkvACY4zo8XAVhW6ZXM45KmD`, DBC pool `HCvz2BHFRkts7PjXRMvEsFfW41Ks3eYY1M93p6NdWVb2`, DAMM v2 pool `3A581XLrwgTfnwSUz7sjRWaMpkmLV1MXxG2bY5q5jZuf`. Demo schedule (1% → 2% at +150 slots, no cap from +300), threshold 0.2 SOL. Keys: creator `ydSuhQ…` (payer, partner, fee claimer), launch key `ApupQ3…`. **The Global admin `9DVu…` only funded wallets and signed no launch tx.**
| Step | Tx | Result |
|---|---|---|
| DBC config | [Th52yCoK…](https://explorer.solana.com/tx/Th52yCoKYD5KDGx5azKPe3FZ2rNUKQtc1DwYQXg8Tkq4kFGibFfKQZF4hCSrnThBh4WsrHPJNKpRZcwAtuZSFeC?cluster=devnet) | signers: creator, config |
| Pool + hook config | [mPvCAYFM…](https://explorer.solana.com/tx/mPvCAYFMfbwVfLiVYBt6X9fBktiiKEMdgHishRzGd2U3fFrk72m6ccY2qY2cJVVuGKJuP3HhThg6a1xKea98GVa?cluster=devnet) | signers: creator, mint, launch key; `MintConfig.launcher` = launch key |
| A buys 0.5% | 41dx4AkF… | ok |
| A buys +0.6% (would hold 1.1%) | dSSdxsSC… | failed `WalletCapExceeded` (expected) |
| A sells 0.2% mid-ramp | uegpD1Vv… | ok |
| B buys 0.9% | 5kjFuF5L… | ok |
| Cap at 2% (+150 slots): A +0.8% | 2989QSDw… | ok |
| After the ramp: A +3% | 3WEXtFtj… | ok |
| Curve fill (graduation) | [gsofRSJj…](https://explorer.solana.com/tx/gsofRSJji328d2fmva4YTvPw2PetaHE8EF3NPXmHuRgQDDGzFKsHmmkNBY3S99q98rhBoEb8RZCeaK69sn7sqeU?cluster=devnet) | mint TransferHook program and authority unset |
| DBC → DAMM v2 migration | [4WeSqCgR…](https://explorer.solana.com/tx/4WeSqCgRuk9ndD3cmoCbCbtbKAzQjQJUTpzNiobEeCwaZFurcLPEeG8W9CixDa2KqPsTxeSbjUbEaYRf4ikaVnxo?cluster=devnet) | mint-hook check `post` ok |

**Keeper** (`keeper/devnet.loop.json`; claim signer = creator; separate treasury, gas and dev-payout throwaways; public log `flywheel/devnet-loop.json`)
| Step | Tx | On-chain check |
|---|---|---|
| Setup: fund gas / 3 token accounts | [3eyXJ1D2…](https://explorer.solana.com/tx/3eyXJ1D2kiqfZVRP2URWmgFob8uVoMNjaTpxx6PnhddjwZZ53ByUMaf173aMepVvJRYwjnK2bBn56XYLkTzgGBF5?cluster=devnet) / [5vVQo69P…](https://explorer.solana.com/tx/5vVQo69PypTVxpqk54obBAsutddCL6LV4y42AuXFNXoLcvCujUiQXoaW42TEAxcM93HhpCR19Hq8CFmxF9ksqYAY?cluster=devnet) | ok |
| Run 1: claim DBC partner fee | [3Ts6ExgN…](https://explorer.solana.com/tx/3Ts6ExgNW6qMFNdxxPEAgVe1hev7StnNyG4nDuWKfpPorGpDjU5WoY67LNuXf177SHLe7oy8GmTVnEydXt4S6weN?cluster=devnet) | treasury wSOL +1,828,259 (signers: gas, claim signer) |
| Run 1: dev 15% | [3LbGYe6t…](https://explorer.solana.com/tx/3LbGYe6t9ZWiW75V8WJa2B58vLMRLrnM174MamArqZnnF7zpeuP5gcxrKwRMUXybv4Jre7J7TWEN4Fm4Ag9LRHjU?cluster=devnet) | dev wSOL +274,238 |
| Run 1: buyback | — | **held** `hold_twap_warmup` (graduation seen 0 s ago; needs 1,800 s; not counted toward auto-pause) |
| Run 2: price check | — | TWAP 118/120 samples (98%), max gap 18 s, latest 14 s; spot vs TWAP 0 bps; independent vs TWAP 0 bps; min_out = min(quote, TWAP-out) × 0.97 = 1,492,043,433,918 (quote leg) |
| Run 2: buyback swap (DAMM v2) | [67inv7rU…](https://explorer.solana.com/tx/67inv7rUNWJs8DaEDS3muJwKbX7jhRyEamJjxupwL87f1jkeWDviJGdTFKDnW1bwnv4Bfo6tSh8vdeP1M9m5KiMd?cluster=devnet) | treasury wSOL −1,554,021 → HLOOP +1,538,189,107,132 (≥ min_out) |
| Run 2: burn | [5YS4Ps7s…](https://explorer.solana.com/tx/5YS4Ps7sT2k5KrRDsEg1NqnzWSmUq6bMG59Xph6PN3YU2FaNiCBhukEJXmFYE8MtFqwMyowrGWNSokojT2HHnFHa?cluster=devnet) | supply 1,000,000,000,000,000 → 998,461,810,892,868; reconcile ok |

**Limits of this run:**
- **The "independent" price was a local stand-in** (`scripts/devnet_price_standin.ts`) because Jupiter has no devnet prices. It reads the same DAMM v2 pool, so it tested the keeper's HTTP, freshness and deviation path, not an independent market.
- The pool had no other trades during the window, so spot = TWAP (0 bps). A pump-before-run on the live pool wasn't run.
- The devnet upgrade / lift authority is still one throwaway key, `9DVu…` (accepted devnet exception).

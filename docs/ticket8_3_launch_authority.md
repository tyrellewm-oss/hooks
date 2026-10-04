# Ticket 8.3: a separate launch key on the hook

**Status (2026-10-04):** built on branch `feat/launch-authority` (base `main` `1bfd402` + the ticket #5 branch, stacked). LOCAL only: **nothing is deployed or migrated on devnet** (needs King's OK and about 2.1–2.9 SOL; see "Devnet"). Not merged.

Spec: `ac_8_3_launch_authority.md` (internal; 17 acceptance criteria, 16 mutants). King picked option A: launches get their own key; the Global admin key (`authority`, which also lifts) leaves day-to-day launches.

## What changed
**Program (`programs/trenches-hook`)**
- Global keeps its 42 bytes and its Rust struct (`authority`, `lifted`, `bump`). The launch key sits at bytes 42..74, read only through `launch_authority_of()` (None when the account is shorter than 74 bytes or the bytes are all zero). Adding the field to the struct would make every existing 42-byte Global undecodable, and all transfers would fail until migration (spec trap 1, mutant M11).
- `migrate_global_v2(launch_authority)`: admin-only, once.
  - Checks by hand that Global is the canonical PDA, program-owned, has the Global discriminator and is exactly 42 bytes. Anchor's `realloc` isn't used.
  - Tops up rent from a separate payer, resizes to 74 and writes only bytes 42..74.
  - The zero key or the admin key → `Unauthorized`. A second run → `ConfigFrozen`.
- `set_launch_authority(new)`: admin-only rotation. The zero key or the admin key → `Unauthorized`; the current key → `ConfigFrozen`.
- Launch path (`initialize_extra_account_meta_list`): Global must be 74 bytes, the launch key set, signer == launch key and signer != admin; otherwise `Unauthorized`. `MintConfig.launcher` records the launch key.
- `lift_global`, `lift_mint_cap` and `raise_mint_cap` stay admin-only. `lift_global`'s write-back leaves bytes 42..74 as they are.
- Error names are unchanged (the page is keyed on them).

**Off-chain**
- `sdk/hook.ts`:
  - builders `migrateGlobalV2` / `setLaunchAuthority`;
  - `decodeGlobal` accepts 42 or ≥74 bytes (`launchAuthority` null when unset) and refuses other lengths;
  - `readHookAuthorities` returns `launchAuthority`.
- `sdk/keyrules.ts`: four roles. Each of these refuses off devnet/local and warns on devnet/local:
  - launch == upgrade;
  - launch == lift;
  - feeClaimer == launch;
  - keeper key == launch;
  - an unknown launch key (off devnet/local).
- Keeper: pinned `hook_launch_authority` must match the chain. The devnet configs pin `null`, because the devnet Global isn't migrated. It's also on the keeper's forbidden-key list.
- `sdk/launch.ts`:
  - `buildCreatePoolTx` takes a separate `launchAuthority` and refuses before building if it differs from the chain, equals the lift key, or the chain has none;
  - `launch(deployer, opts, launchKey)` signs the hook config with the launch key;
  - `ensureLaunchAuthority()` migrates on devnet/local;
  - `status()` shows the launch key.
- Devnet/local tools (`app/server.ts`, `scripts/dbc_flow.ts`, `scripts/flywheel_fw15.ts`): a third throwaway key, `launch`, in the gitignored key dir.
- `scripts/launch_authority.ts` (`sdk/launch_authority.ts`): migrate / rotate.
  - **Dry run by default** (simulate only); `--send` sends with existing key files only.
  - Refuses any genesis that isn't devnet or local before anything is built.
  - Prints Global before and after (address, length, lamports, base64).

## Testing (LOCAL, macOS arm64; release + test-slots `.so` built with `cargo build-sbf`, Agave 3.0.14)
- `CI_PROGRAM_HOST=1 pnpm check`: cap-math cargo tests pass and program host tests are 2/2. Node tests: 384, 382 pass, 1 skipped. The only failure is `resolve_cluster_local` (macOS needs the 127.0.0.2 alias), which is the baseline.
- `tests/launch_authority.test.ts` (litesvm):
  - AC-1..AC-12 and AC-14.
  - AC-15: the recorded devnet Global bytes (42 bytes, admin `9DVu…`) at their PDA, migrated under the new program. The admin signs with an empty signature (signature checks off, copy only). Bytes 0..42 stay unchanged, a rerun refuses, and a launch plus transfer works.
- `tests/launch_authority_offchain.test.ts`: AC-13 (key rules, keeper pin, `buildCreatePoolTx`), AC-16 (mainnet / testnet / unknown genesis refused before any read, build or send) and AC-17 (dry run by default, 0 sends).
- Mutants: `node --import tsx scripts/mutants_launch_authority.ts` → 31 killed, 0 survived (the 16 spec mutants, several in more than one form; Rust mutants rebuild the `.so`, which is restored with the same sha256 afterwards). Ticket #5 mutants still 47/47.

## Devnet (not done; needs King's OK)
- **Program size:** the new release `.so` is 415,456 bytes. The devnet ProgramData is 393,637, so `solana program extend` by about 21,900 bytes comes first. That rent isn't refunded: about 0.11 SOL at the devnet rate.
- **Upgrade buffer:** about 2.0–2.8 SOL (spec §6 estimates), refunded when the buffer closes.
- **Order:** upgrade, then `scripts/launch_authority.ts migrate --cluster devnet --launch <launch pubkey> --admin 9DVu…` as a dry run, then `--send`. Record Global before and after in a fixture (AC-15, devnet half), then set `hook_launch_authority` in `keeper/devnet.*.json`.
- **Upgrade window:** existing devnet hook mints keep transferring between the upgrade and the migration. AC-6 covers this locally.

## Known limits / open
- Launch-key custody (hot key vs King's signer per launch) is King's call (part of M1–M4). The devnet tools use a throwaway key.
- `scripts/build.sh` uses GNU `df` / `sha256sum` and fails on macOS; the two `cargo build-sbf` commands work directly.
- `cargo build-sbf` writes a program keypair file into `target/deploy/` (gitignored, never committed).
- 8.3b (admin rotation) is specced by Agent A (`docs/ac_8_3b_admin_rotation.md` on their branch), to build on this.

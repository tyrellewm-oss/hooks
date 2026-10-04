# 8.3b: rotate the hook admin key (spec and acceptance criteria)

Status: implemented on `feat/admin-rotation`, stacked on ticket 8.3. Oct 4 2026. Follows 8.3 (separate launch key). King asked, in 8.3 §7.3, whether `authority` can be rotated before that key moves to cold storage or a multisig. This ticket is that instruction. **Devnet only, through the QA gate, no mainnet.**

Depends on 8.3. 8.3b does not edit `migrate_global_v2`, `set_launch_authority`, or the launch-path signer check. It adds one instruction, `rotate_admin`.

Code refs below are the pre-8.3 tree at `0e676c7` unless marked "8.3". `lib.rs` = `programs/trenches-hook/src/lib.rs`, `state.rs` = `programs/trenches-hook/src/state.rs`. 8.3's public note is `docs/ticket8_3_launch_authority.md`.

## 0. What the source says today (verified)
- `Global` = `{ authority: Pubkey, lifted: bool, bump: u8 }` (state.rs L5–12). Space is 42 bytes. `authority` is the lift-switch admin.
- `initialize_global` sets that key once (lib.rs L43–56). Only the program upgrade authority can call it (L345). It refuses the zero key (L44) and a second run (`create_pda_once`, ConfigFrozen).
- There is **no instruction that changes `authority` after init.** `lift_global`, `lift_mint_cap` and `raise_mint_cap` all use `has_one = authority` (L396, L403).
- **8.3 (other agent, not landed on this branch):** after `migrate_global_v2`, Global is 74 bytes. Bytes 0..42 keep today's meaning. `launch_authority` is bytes 42..74, read by `launch_authority_of()`, which returns "not set" when the length is under 74 or those bytes are zero. The Rust `Global` struct stays 42 bytes. `set_launch_authority` rotates the **launch** key and is admin-only. It is not this ticket.
- `write_account` (lib.rs L327–331) serializes a whole value from offset 0. A rotate must not use it: a full rewrite is the clobber mutant.
- Error names stay `Unauthorized` and `ConfigFrozen` (errors.rs L3–11). The launch page is keyed on those names. Don't add new names.
- Off-chain, `sdk/keyrules.ts` is still the three-key rule on this branch. 8.3 turns it into the four-role rule. 8.3b consumes that, and does not re-specify it.

## 1. On-chain change
One instruction, `rotate_admin(new_authority)`.

- **Signer:** the current admin. It must equal Global bytes 8..40. The launch key, the program upgrade authority (unless it is also the current admin), and any other key are refused with `Unauthorized`. No separate payer: the account is already funded.
- **Account:** the canonical `["global"]` PDA, owned by the hook program, with the Global discriminator. Anything else is `Unauthorized` and is not written.
- **Preconditions (else `ConfigFrozen`, nothing written):**
  - length is exactly 74 (8.3 migration has already run);
  - `launch_authority_of()` is set (bytes 42..74 are not all zero);
  - `new_authority != Pubkey::default()`;
  - `new_authority !=` the current admin (a no-op fails loudly);
  - `new_authority !=` the launch key.
- **Write:** store `new_authority` at bytes 8..40 only. A 32-byte copy. Do not call `write_account`. Do not reserialize `Global`. Bytes 0..8, 40..41 (`lifted`, `bump`) and 42..74 stay byte-identical. Length stays 74.
- **After a successful rotate:** the old admin fails `lift_global`, `lift_mint_cap`, `raise_mint_cap`, `set_launch_authority` and `rotate_admin`. The new admin succeeds at those admin paths. The launch path is unchanged: signer is still the launch key, and the launch key still cannot lift, raise, set the launch key, or rotate the admin.
- **This does not touch the program upgrade authority.** BPF `ProgramData.upgrade_authority_address` is a different field. Rotating Global admin does not change who can upgrade the program.
- **Do not add `launch_authority` to the Rust `Global` struct.** That is 8.3's upgrade-window rule and still applies.
- **`initialize_global` stays one-shot** and still writes 42 bytes. Rotation is only legal after 8.3's migration.

`Unauthorized` means "this signer may not call this". `ConfigFrozen` means "the account is the right one, but this rotation is not a legal change".

## 2. Why a new instruction, not a reuse of 8.3
`set_launch_authority` changes bytes 42..74 and refuses `new == authority`. The admin key lives at bytes 8..40 and is what `has_one = authority` checks. One instruction must not write both fields. A second admin key stored anywhere except bytes 8..40 would leave `lift_global` on the old key.

Refusing `new == launch key` on-chain is the point of the ticket. 8.3 already refuses the opposite direction (`launch key != admin`) at migrate and at `set_launch_authority`. Without this check, an admin rotate could collapse the two roles after 8.3 had separated them. The launch-path check `signer != authority` would then make the launch key unable to launch, or a later mutant could accept either key. Fail at the rotate instead.

Devnet only: the program change is for the devnet hook. No mainnet program, no mainnet buffer, no mainnet send. The script and the SDK builder refuse a genesis that is not devnet or local before they build a transaction.

## 3. Off-chain changes
- **`sdk/hook.ts`:** add a `rotateAdmin` builder next to 8.3's `setLaunchAuthority`. It does not change `decodeGlobal`: admin is still bytes 8..40, launch key is still 42..74.
- **Builder checks, before any transaction exists:** refuse if `new` is the zero key, the current admin, or the launch key. Refuse if the decoded Global is not 74 bytes or the launch key is null.
- **Script** (sibling of 8.3's migrate/rotate script, or a `--rotate-admin` mode on it if 8.3's script already exists and can take the mode without changing migrate behaviour):
  - dry run by default; `--send` is required to send;
  - refuses a genesis that is not devnet or local;
  - prints Global bytes before and after;
  - holds no admin key; the admin signs;
  - does not write keeper config.
- **Keeper:** no new pin. After a real rotate, the operator updates the existing lift-authority pin to the new admin. A stale pin keeps the keeper refused, which is the current fail-closed behaviour.
- **keyrules:** no new rule. 8.3's four-role rule already treats admin == launch as a problem. The chain check is what this ticket adds.

## 4. Acceptance criteria
1. **[non-admin]** On a migrated 74-byte Global, `rotate_admin` signed by the launch key or by a random key fails with `Unauthorized`. Length and all 74 bytes are unchanged.
2. **[new == launch key]** `rotate_admin(launch key)` fails with `ConfigFrozen`. Bytes unchanged. This includes the case where the caller is the current admin.
3. **[zero key]** `rotate_admin(default)` fails with `ConfigFrozen`. Bytes unchanged.
4. **[no-op]** `rotate_admin(current admin)` fails with `ConfigFrozen`. Bytes unchanged.
5. **[pre-migration]** On a 42-byte Global, `rotate_admin` fails with `ConfigFrozen`. The account stays 42 bytes.
6. **[unset launch key]** On a 74-byte Global whose bytes 42..74 are zero, `rotate_admin` fails with `ConfigFrozen`. Bytes unchanged.
7. **[byte-identical except admin]** A legal rotate changes bytes 8..40 to `new_authority` and leaves bytes 0..8, 40..74 and the length identical. Run it once with `lifted = false` and once with `lifted = true`.
8. **[old admin dies, new admin works]** After rotating A1 → A2: A1 fails `lift_global`, `lift_mint_cap`, `raise_mint_cap`, `set_launch_authority` and `rotate_admin`; A2 succeeds at `lift_global` and at a further legal `rotate_admin`; the launch key still fails all of those.
9. **[transfers survive]** Hook transfers and `view_schedule` succeed before the rotate, after the rotate, and after `lift_global` by the new admin. Bytes 42..74 are unchanged across the lift.
10. **[launch path unchanged]** After the rotate, a launch signed by the new admin fails, and a launch signed by the launch key succeeds. `MintConfig.launcher` is still the launch key.
11. **[bad account]** A non-canonical address, a wrong owner, or a wrong discriminator fails with `Unauthorized` and is not written.
12. **[nothing touches mainnet]** The builder and the script refuse a mainnet genesis before building a transaction. A test with a mainnet genesis stub asserts 0 sends.
13. **[dry run default]** Without `--send`, the script simulates only. A test asserts 0 calls to `sendTransaction`.

## 5. Mutants
| # | Mutant | Killed by |
|---|---|---|
| M1 | Admin signer check removed | AC-1 |
| M2 | `new` compared to bytes 8..40 (the admin) instead of bytes 42..74 | AC-2 |
| M3 | `new == launch key` accepted | AC-2 |
| M4 | 42-byte account, or a zero launch tail, accepted | AC-5, AC-6 |
| M5 | Rotate rewrites the account from offset 0 (`write_account` or a full serialize), so `lifted`, `bump` or bytes 42..74 change | AC-7, AC-9 |
| M6 | `new == current admin` accepted | AC-4 |
| M7 | Old admin still passes `has_one = authority` after the rotate (stale key cached, or the write went somewhere other than bytes 8..40) | AC-8 |
| M8 | Script or builder defaults to send, or accepts a mainnet genesis | AC-12, AC-13 |

## 6. Devnet SOL
No resize and no new account. Rent is unchanged. The only cost is the devnet transaction fee, and only when `--send` is passed. This ticket does not upgrade the program by itself: it ships in the same devnet upgrade as 8.3, whose buffer rent is estimated in the 8.3 spec §6.

## 7. Open questions (King / NEO)
1. **Name.** `rotate_admin` is the name in this spec. `set_authority` is the alternative if NEO wants it next to `set_launch_authority`.
2. **Upgrade authority.** This ticket does not rotate the BPF upgrade authority. Say if that should be a later ticket. It stays out of 8.3b.
3. **When to run it.** Default: only after 8.3's migration and a set launch key, and before the admin key is moved to the multisig. The on-chain checks enforce the first two. Custody of the new admin key is King's, same as the launch-key custody question in 8.3 §7.1.

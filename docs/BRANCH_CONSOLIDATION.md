# Branch consolidation plan (PLAN ONLY: nothing merged)

Prepared by Engineer on 2026-10-04 ICT, updated after NEO's publishing decision. **Do not run any of this until QA has passed every PR and NEO/King approve.** The squashed `public-main` is built locally (single orphan commit). Target: `tyrellewm-oss/hooks` `main`, pushed by NEO after QA PASS.

## The stack is linear
Checked with `git merge-base --is-ancestor <parent> <child>` for each consecutive pair: **all yes**. There are 0 merge commits between `main` and the tip. `main` (`82ed872`, "chore: init repo with gitignore") is an ancestor of every branch.

`qa/devnet-v0` (QA-owned) is **not** in the stack (it isn't an ancestor of the tip) and stays out of this plan. Don't merge it into `main`.

| # | Branch | Commit range (parent..branch) | Commits | PR file | QA verdict (LOCAL) |
|---|---|---|---|---|---|
| 1 | `feat/hook-program` | `82ed872..7b4a533` | 3 | `prs/1-hook-program.md` (internal, local history only) | PASS with PR 4 on top (alone: FAIL on H-1, H-3, L-1) |
| 2 | `feat/dbc-integration` | `7b4a533..6701c69` | 2 | `prs/2-dbc-integration.md` (internal, local history only) | PASS (LOCAL); devnet items BLOCKED (devnet SOL) |
| 3 | `feat/launch-page` | `6701c69..84f4233` | 1 | `prs/3-launch-page.md` (internal, local history only) | **FAIL (pending)**: H-7 / AC-21 server-side signing, accepted for the devnet demo but still FAIL against the AC text |
| 4 | `feat/qa-fixes` | `84f4233..8362566` | 2 | `prs/4-qa-fixes.md` (internal, local history only) | PASS (H-1, H-3, L-1, L-3 fixed) |
| 5 | `feat/page-copy-v0b` | `8362566..1c878ed` | 4 | `prs/5-page-copy.md` (internal, local history only) | PASS |
| 6 | `feat/replay-test` | `1c878ed..f46461b` | 3 | `prs/6-replay-test.md` (internal, local history only) | PASS |
| 7 | `feat/page-copy-v0d` | `f46461b..dec0845` | 1 | `prs/7-page-copy-v0d.md` (internal, local history only) | PASS |
| 8 | `feat/approved-schedule` | `dec0845..8be77ca` | 3 | `prs/8-approved-schedule.md` (internal, local history only) | PASS |
| 9 | `feat/supply-option` | `8be77ca..b4aae90` | 4 | `prs/9-supply-option.md` (internal, local history only) | PASS |
| 10 | `feat/repo-package` | `b4aae90..<tip>` | 2+ | `prs/10-repo-package.md` (internal, local history only) | PASS (package); follow-up pending |

Verdict sources: QA reviews and `MORNING_REPORT.md` (QA v1.2 section; internal, local history only). Overall QA status: PARTIAL, no CRITICAL; devnet BLOCKED.

## Before merging (gates)
1. **PR 3**: QA re-verdict, or a recorded King/NEO acceptance of the H-7 demo deviation (backend throwaway wallets sign instead of the user's wallet).
2. **PR 10 follow-up** (anonymised fixtures, README changes, this plan): QA review, plus QA's official secret scan of `public-main` once built.
3. ~~Choose the LICENSE owner and repo name~~ Done (King, 2026-10-04): repo `tyrellewm-oss/hooks` (public), MIT, owner `tyrellewm-oss`. NEO pushes `public-main` to `main` only after QA PASS.
4. `CI_SKIP_CARGO=1 pnpm check` green on the tip, and a full `pnpm check` (cargo) once disk allows.

## Decision (NEO, 2026-10-04): full history stays LOCAL; publish only a fresh squashed `main`
- **Keep the full stacked history LOCAL.** All `feat/*` branches stay as they are, including `launches/local/*.json` and `txlog/local.jsonl`. Nothing is removed from them. QA's sha references and Research authorship stay valid locally.
- **Publish only a fresh squashed public `main`**, built as an orphan branch from the final tree, so it has one commit and no stacked history.
- **Never `git push --all` or `git push --mirror`.** Push only the public branch, explicitly, once a remote exists and King approves.
- **`qa/devnet-v0` is never pushed.**
- **The public `main` excludes `launches/local/*.json`, `txlog/`, `docs/INTERNAL_TOOLCHAIN.md`, `docs/screens/` and the internal ops notes (PR files, status and morning report).** They stay in local history only.

Why squash for the public repo: the local history contains run records and old commit messages with superseded wording (an early commit described the cap per owner; the design is per token account). A single clean commit avoids publishing those. Squashing also means the public history can't carry anything that was later removed from the tree.

## Local consolidation (optional; local only)
Since the stack is linear, local `main` can be fast-forwarded to the tip after QA PASS. This is local bookkeeping, not publishing:
```bash
git checkout main
git merge --ff-only feat/repo-package
git tag -a v0.1.0-devnet-unaudited-local -m "LOCAL full history (not for publishing)"
```

## Building the public squashed `main` (local only)
Build it in a **separate worktree** so the main working directory (ignored keys, `launches/local/`, `node_modules/`) is never touched by a checkout:
```bash
git status --porcelain                                     # must print nothing
git worktree add --detach ../launchpad-public feat/repo-package
cd ../launchpad-public
git checkout --orphan public-main                          # no parents; index = final tree
git rm -r --cached --quiet launches/local txlog docs/INTERNAL_TOOLCHAIN.md docs/screens prs MORNING_REPORT.md STATUS.md   # internal notes stay in local history only
rm -rf launches txlog docs/INTERNAL_TOOLCHAIN.md docs/screens prs MORNING_REPORT.md STATUS.md   # in this worktree only
# then append public-only ignore entries for those paths to .gitignore and git add .gitignore
git ls-files | grep -E '^(qa/|launches/|txlog/)|\.csv$|INTERNAL_TOOLCHAIN|keypair|\.env|\.log$' && echo "STOP: excluded path still tracked"
ln -s ../launchpad/node_modules node_modules && CI_SKIP_CARGO=1 pnpm check   # node_modules is gitignored
git -c user.name=Deployer-Engineer -c user.email=engineer@deployers.local \
  commit -m "Initial public import: devnet-only unaudited launchpad prototype (v0.1.0-devnet-unaudited)"
cd ../launchpad && bash qa/tests/public_main_gate.sh public-main
```

Later, only with King's approval, a remote and an owner/name chosen:
```bash
git push <remote> public-main:main                        # this one branch only
git push <remote> v0.1.0-devnet-unaudited                 # this one tag only
# never: git push --all / --mirror; never push qa/devnet-v0 or any feat/* branch
```
Checks before any push: QA's official secret scan on `public-main`, `git log public-main` shows exactly one commit, and `git ls-files` on `public-main` has no `qa/`, `launches/local/`, `txlog/local.jsonl` or key paths.

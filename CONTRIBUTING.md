# Contributing

This is an **unaudited devnet experiment**. Read the README's design limits first.

## Flow
1. **Branch** from the current tip (branches are stacked: `feat/<topic>`). Never commit straight to `main`.
2. **PR description**: open a GitHub PR (PR files under `prs/` are internal, kept in local history only). The description must contain:
   - what changed and why, the base branch, and acceptance criteria as a checklist;
   - test results (`pnpm check`, or `CI_SKIP_CARGO=1 pnpm check` for JS/copy-only changes), labelled **LOCAL** or **DEVNET**;
   - a line **`On-chain impact: ...`** (e.g. `none`, or what was deployed/changed on devnet, with explorer links `?cluster=devnet`).
3. **QA review** (Deployer QA) writes a verdict of **PASS** or **FAIL**. Each finding uses:
   - **ISSUE**: what is wrong;
   - **IMPACT**: what it breaks or risks;
   - **OWNER**: who fixes or decides;
   - **ACTION**: the fix or decision needed.
   Fixes go in a follow-up commit on the same branch (or a stacked fix branch), and QA re-checks.
4. **Merge to `main`** only after QA PASS, by the reviewer (see `docs/BRANCH_CONSOLIDATION.md`). Engineers don't merge their own PRs.

## Hard rules
- **No mainnet.** No mainnet RPCs, deploys or keys. The SDK refuses mainnet URLs and checks the devnet genesis hash; CI greps for mainnet endpoints.
- **No keys in the repo.** Throwaway keys live in `.devnet-keys/` / `.local-keys/` (gitignored). No keypair JSON, seed phrases, `.env` files or API keys in commits. `pnpm check` scans the full history for keypair-like arrays and tracked secret files.
- **Label results.** Every result is **LOCAL** (litesvm / local validator / offline) or **DEVNET** (with explorer link). Never present a LOCAL result as a devnet one.
- **Research copy is committed as-is.** Files under `research/` (page copy, acceptance criteria, options) are written by Research. Engineers commit them unchanged, as a separate commit or with a `Co-authored-by: Deployer-Research <research@deployers.local>` trailer, noting "Copy by Deployer research; committed as-is by Engineer." Request copy changes from Research instead of editing.
- **Page copy rules**: no audit claims, no price promises, and none of the banned terms listed in `scripts/ci.sh`; the CI forbidden-word scan and QA's copy check must pass. Fee and cap numbers on the page come from the launch config, never hard-coded.
- **QA material** stays on QA's branch (`qa/devnet-v0`); don't commit `qa/` from feature branches.
- **Release builds** for devnet are built with `test-slots` OFF (`pnpm build`).

#!/usr/bin/env bash
# Devnet test day: runs the go-live test plan (docs/go_live_readiness_2026-10-06.md §4) top to bottom.
# Run on a machine with Solana/Agave CLI 3.0.x (cargo build-sbf), pnpm, and devnet access — NOT in a cloud container.
#
#   bash scripts/devnet_testday.sh            # everything, with pauses at the manual steps
#   bash scripts/devnet_testday.sh B          # start from a section: A, B0, B, C, D
#
# Automated sections stop on the first failure. Browser/wallet steps print a checklist and wait for Enter.
# Everything is appended to devnet_testday.log (plus txlog/devnet.jsonl, which the tools write anyway).
set -u -o pipefail
cd "$(dirname "$0")/.."
LOG=devnet_testday.log
START="${1:-A}"
RPC="${DEVNET_RPC:-https://solana-devnet.api.onfinality.io/public}"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*" | tee -a "$LOG"; }
run()  { printf '\n\033[1m$ %s\033[0m\n' "$*" | tee -a "$LOG"; "$@" 2>&1 | tee -a "$LOG"; local rc=${PIPESTATUS[0]}; [ "$rc" -eq 0 ] || { printf '\033[1;31mFAILED (exit %s): %s\033[0m\n' "$rc" "$*" | tee -a "$LOG"; exit "$rc"; }; }
pause(){ printf '\n\033[1;33m%s\033[0m\n' "$*"; read -r -p "Press Enter when done (Ctrl-C to abort)... "; }
SCOPE=""; seen=0
for s in A B0 B C D; do [ "$s" = "$START" ] && seen=1; [ "$seen" -eq 1 ] && SCOPE="$SCOPE $s"; done
[ "$seen" -eq 1 ] || { echo "unknown section: $START (use A, B0, B, C or D)"; exit 1; }
in_scope() { [[ " $SCOPE " == *" $1 "* ]]; }

say "Devnet test day $(date) — log: $LOG, RPC: $RPC"

# ---------- preflight ----------
say "Preflight"
for c in pnpm cargo-build-sbf solana node; do command -v "$c" >/dev/null || { echo "missing: $c (README 'Prerequisites')"; exit 1; }; done
run solana --version
run pnpm install

if in_scope A; then
  # ---------- A. Build and local gate ----------
  say "A1. Release build (test-slots OFF)"
  run pnpm build
  run sha256sum target/deploy/trenches_hook.so

  say "A2. Full CI including program host tests"
  run env CI_PROGRAM_HOST=1 pnpm check

  say "A3-A4. Local validator loop"
  pause "In ANOTHER terminal run:  pnpm validator   — wait until it prints the RPC is up"
  run pnpm demo        # launch -> buy -> cap hit -> sells mid-ramp -> cap rises -> no cap -> curve fill -> DAMM v2 migration
  run pnpm lift-demo   # lift to 3% ok; lower refused; re-enable refused; RestrictionsLifted emitted

  say "A5. Headless browser e2e (create -> 8-box gate -> buy -> cap-hit explainer -> sell)"
  run pnpm e2e
  say "A: ALL GREEN. You can stop the local validator now (and delete test-ledger/ later)."
fi

if in_scope B0; then
  # ---------- B0. Deploy hook program v2 to devnet ----------
  say "B0. Deploy the v2 program to devnet (enables hooks 05-08: max buy, per-slot, pot, slow mode)"
  [ -f target/deploy/trenches_hook.so ] || run pnpm build
  if [ -f .devnet-keys/deployer.json ]; then
    run solana balance --keypair .devnet-keys/deployer.json --url "$RPC"
    echo "An upgrade of the 393 KB program needs the deployer funded (fresh deploy ~2.8 SOL rent; devnet SOL via 'solana airdrop' or scripts/airdrop_loop.sh)."
  fi
  pause "Confirm you want to deploy/upgrade program FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz on devnet"
  run solana program deploy target/deploy/trenches_hook.so \
    --program-id .devnet-keys/trenches_hook-keypair.json --keypair .devnet-keys/deployer.json --url "$RPC"
  echo "Record the deploy signature + the sha256 from A1 in launch_log.md." | tee -a "$LOG"
  pause "If you have an existing v1 mint, verify it still works:  pnpm qa-schedule <mint> --cluster devnet"
fi

if in_scope B; then
  # ---------- B. Devnet: hooks apply on every launch ----------
  # Each demo runs the whole phase loop itself: launch -> buy -> cap hit -> sells mid-ramp -> cap rises -> no cap -> fill -> migration.
  for sched in balanced strict loose; do
    say "B. Devnet launch with the '$sched' schedule (full phase loop; Balanced ramp is ~30 min)"
    run node --import tsx scripts/dbc_flow.ts demo --cluster devnet --threshold 0.2 --wallet-sol 0.3 --schedule "$sched"
    pause "Copy the MINT it printed, then run:  pnpm qa-schedule <mint> --cluster devnet
  PASS = VERDICT says release build, deployed bytes match the local .so, steps match '$sched', test_slots_build=false.
  Also open the mint in the explorer (?cluster=devnet): TransferHook -> FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz, and mintHookCheck=ok in launches/devnet/<mint>.json"
  done

  say "B7-B8. Optional hooks + creator lock (through the launch page — the real user path)"
  cat <<'EOT'
  In another terminal:  STUDIO_WALLETS=<your wallet> pnpm page -- --cluster devnet --web   -> http://127.0.0.1:5175
  Launch TWO tokens from the form with a browser wallet connected (THIS IS THE PATH FIXED IN 7318eca — it must work end to end):

  Token 1 — everything on:
    [ ] optional hooks: max single buy 0.5%, per-slot 1.5%, slow mode 25 slots, pot every 50th buy; creator lock 5% / ~1 day
    [ ] a 0.6% buy fails with the max-buy message
    [ ] two quick buys: the second inside the 25-slot gap fails with the slow-mode message; one after the gap lands
    [ ] two buys in one slot totalling >1.5% fail on the second
    [ ] after the opening window, all of the above pass
    [ ] token page shows every optional hook + "5% locked"; curve sells 5% less
    [ ] after graduation: creator cannot claim before the cliff, can after

  Token 2 — all extras off:
    [ ] token page shows the 4 core hooks only, no optional rows

  Error UX (do these on purpose):
    [ ] reject the launch in the wallet -> "You declined in the wallet. Nothing was launched."
    [ ] wait >90 s before approving -> "signing window expired - press Launch again"
    [ ] switch wallet account after studio sign-in -> amber mismatch warning on the Review step
EOT
  pause "Work through the checklist above"
fi

if in_scope C; then
  # ---------- C. Devnet: page and wallet ----------
  say "C. Page + wallet checks (page still running from B)"
  cat <<'EOT'
    [ ] sign in with a studio wallet; edit a token's image/description/links
    [ ] with a NON-studio wallet: buy and sell via the trade panel (server-built tx, relay refuses anything else)
    [ ] a blocked buy shows the cap-hit explainer; a slippage-protected sell lands
    [ ] /api/trade is refused for a non-studio session on devnet
    [ ] DEVNET badge + AC-23 banner on every page; switch history lists any lift events
EOT
  pause "Work through the checklist above"
fi

if in_scope D; then
  # ---------- D. Keeper ----------
  say "D. Keeper: dry run first (simulates every step, broadcasts nothing)"
  run node --import tsx scripts/flywheel.ts run --config keeper/devnet.tdt.json
  pause "If the dry run is clean, send one real run:  node --import tsx scripts/flywheel.ts run --config keeper/devnet.tdt.json --send
  PASS = claim -> 15/85 split -> price check -> capped buyback -> verified burn; public log on /transparency"
fi

say "DONE. Record signatures in launch_log.md. Remaining before mainnet: the decisions in docs/go_live_readiness_2026-10-06.md (B3-B6) and the mainnet deploy/pin steps."

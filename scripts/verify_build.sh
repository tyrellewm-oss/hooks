#!/usr/bin/env bash
# AC-35 / go-live G3: reproducible-build check for programs/trenches-hook, ready to run on a machine with
# Docker and ~10 GB free (the solana-verify build image does not fit the current dev box; README "Verifiable build").
# Read-only: builds locally and compares hashes; deploys nothing and signs nothing.
set -euo pipefail

PROGRAM_ID="${1:-FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz}"
CLUSTER_URL="${2:-devnet}"   # devnet only; this repo has no mainnet code path (AC-30/AC-34)
case "$CLUSTER_URL" in *mainnet*) echo "refusing: devnet only (AC-30)"; exit 2;; esac

command -v solana-verify >/dev/null || { echo "solana-verify not installed: cargo install solana-verify"; exit 2; }

echo "== 1. reproducible build (Docker)"
solana-verify build --library-name trenches_hook

echo "== 2. hash of the local reproducible build"
LOCAL_HASH=$(solana-verify get-executable-hash target/deploy/trenches_hook.so)
echo "local:    $LOCAL_HASH"

echo "== 3. hash of the deployed program ($PROGRAM_ID on $CLUSTER_URL)"
DEPLOYED_HASH=$(solana-verify get-program-hash -u "$CLUSTER_URL" "$PROGRAM_ID")
echo "deployed: $DEPLOYED_HASH"

if [ "$LOCAL_HASH" = "$DEPLOYED_HASH" ]; then
  echo "MATCH: the deployed program is this source tree's reproducible build"
else
  echo "MISMATCH: the deployed program does not match this source tree" >&2
  exit 1
fi

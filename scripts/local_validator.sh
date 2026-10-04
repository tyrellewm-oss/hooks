#!/usr/bin/env bash
# LOCAL fallback: solana-test-validator with Meteora DBC + DAMM v2 cloned from DEVNET (read-only clone, nothing is sent to devnet).
# Features inactive on devnet (scripts/devnet_inactive_features.txt, from `solana feature status`) are deactivated
# so the local runtime matches devnet.
# Results from this validator are labelled LOCAL, never DEVNET.
set -euo pipefail
cd "$(dirname "$0")/.."
source ~/.deployer_env 2>/dev/null || true
CLONE_URL=${CLONE_URL:-https://solana-devnet.api.onfinality.io/public}
case "$CLONE_URL" in *mainnet*) echo "refusing: mainnet URL"; exit 1;; esac
SO=${HOOK_SO:-target/deploy/trenches_hook.so}
HOOK_ID=$(solana-keygen pubkey .devnet-keys/trenches_hook-keypair.json)
AUTH=$(solana-keygen pubkey .local-keys/local.json)
# TS scripts on --cluster local need the hook id explicitly (no fallback to the devnet id on a local validator):
echo "local validator: hook program $HOOK_ID; run scripts with HOOK_PROGRAM_ID=$HOOK_ID" >&2
exec solana-test-validator --reset --quiet --ledger test-ledger --url "$CLONE_URL" \
  --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  --clone 7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd \
  --clone A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck \
  --upgradeable-program "$HOOK_ID" "$SO" "$AUTH" \
  --limit-ledger-size 500000 \
  $(for f in $(cat scripts/devnet_inactive_features.txt); do echo --deactivate-feature $f; done) "$@"

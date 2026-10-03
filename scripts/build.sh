#!/usr/bin/env bash
# Build both artifacts (each into its own out dir; any build error stops the script):
#   target/deploy/trenches_hook.so             RELEASE (devnet) build, test-slots OFF  <- the only one ever deployed to devnet
#   target/deploy-test-slots/trenches_hook.so  LOCAL-only build with --features test-slots
set -euo pipefail
cd "$(dirname "$0")/.."
source ~/.deployer_env 2>/dev/null || true
# NEO disk rule: never build when free space on / is below 1.5 GB.
free_kb=$(df --output=avail / | tail -1)
if [ "$free_kb" -lt 1572864 ]; then echo "STOP: only $((free_kb/1024)) MB free on / (< 1.5 GB). Not building."; exit 3; fi
M=programs/trenches-hook/Cargo.toml
echo "== LOCAL test-slots build: cargo build-sbf --manifest-path $M --features test-slots --sbf-out-dir target/deploy-test-slots"
cargo build-sbf --manifest-path $M --features test-slots --sbf-out-dir target/deploy-test-slots
echo "== DEVNET release build (test-slots OFF): cargo build-sbf --manifest-path $M --sbf-out-dir target/deploy"
cargo build-sbf --manifest-path $M --sbf-out-dir target/deploy
sha256sum target/deploy/trenches_hook.so target/deploy-test-slots/trenches_hook.so

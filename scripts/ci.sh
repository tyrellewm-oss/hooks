#!/usr/bin/env bash
# One command: unit + property (reduced) + LOCAL integration tests + forbidden-word grep + secret scan + mainnet grep (AC-36).
set -uo pipefail
cd "$(dirname "$0")/.."
source ~/.deployer_env 2>/dev/null || true
fail=0; step() { echo; echo "== $*"; }
if [ "${CI_SKIP_CARGO:-0}" = 1 ]; then echo; echo "== cap-math cargo tests SKIPPED (CI_SKIP_CARGO=1: no-rebuild run; JS/copy-only change)"; else
step "cap-math unit + proptest (PROPTEST_CASES=${PROPTEST_CASES:=20000})"
PROPTEST_CASES=$PROPTEST_CASES cargo test -q -p cap-math 2>&1 | grep 'test result'; [ "${PIPESTATUS[0]}" = 0 ] || fail=1
fi
if [ "${CI_PROGRAM_HOST:-0}" = 1 ]; then
step "program host unit tests (exempt PDAs derive from Meteora program ids; needs ~1.5 GB disk)"
cargo test -q -p trenches-hook --lib 2>&1 | grep 'test result'; [ "${PIPESTATUS[0]}" = 0 ] || fail=1
else echo; echo "== program host unit tests skipped (set CI_PROGRAM_HOST=1; last run 2026-10-03 22:5x ICT: 2 passed)"; fi
step "LOCAL litesvm integration + TS parity tests (needs target/deploy/*.so from scripts/build.sh)"
# --test-timeout: a hung or spinning test file is cancelled and counts as a failure (fail fast, never a silent hang)
out=$(node --import tsx --test --test-timeout=60000 tests/*.test.ts 2>&1); rc=$?; [ $rc = 0 ] || fail=1
echo "$out" | grep -E '^# (tests|pass|fail|skipped)'
# skipped tests are listed by name so a missing input (e.g. the replay full fixtures, kept outside the repo) is visible
echo "$out" | grep -E '^ *ok [0-9]+ - .*# SKIP' | sed -E 's/^ *ok [0-9]+ - /SKIPPED: /' || true
step "forbidden words (AC-27, case-insensitive) in UI + page copy"
WORDS='\bsafe\b|\bsecure\b|(^|[^n])audited|anti-bundle|antibundle|sniper-proof|bot-proof|rug-proof|rugproof|honeypot-free|no admin|0 keys|\bmoon\b|100x|guaranteed|\bprofit|\breturns\b|investment opportunity|presale|\bfloor\b|pump it'
if grep -rniE "$WORDS" app/public research/page_content.json research/page_content.md; then echo "FORBIDDEN WORD FOUND"; fail=1; else echo "none found"; fi
step "secret scan: no keypair-like 64-byte arrays, no .env, no key dirs tracked (full history)"
if git log --all -p | grep -nE '\[([0-9]{1,3},\s*){63}[0-9]{1,3}\]' >/dev/null; then echo "KEYPAIR-LIKE ARRAY IN HISTORY"; fail=1; else echo "history clean"; fi
if git ls-files | grep -E '(^|/)\.env($|\.)|\.devnet-keys|\.local-keys|keypair\.json$|id\.json$' | grep -v '.env.example'; then echo "SECRET FILE TRACKED"; fail=1; else echo "no secret files tracked"; fi
step "no mainnet endpoints in code/config (AC-30)"
if grep -rniE 'mainnet-beta|api\.mainnet|mainnet\.helius|https?://[^ ]*mainnet' --include='*.ts' --include='*.js' --include='*.json' --include='*.toml' --include='*.sh' sdk scripts app Anchor.toml package.json | grep -v 'assertNotMainnet\|refusing\|MAINNET_GENESIS\|/mainnet/i'; then echo "MAINNET REFERENCE"; fail=1; else echo "none"; fi
echo; [ $fail = 0 ] && echo "CI: ALL GREEN" || echo "CI: FAILED"; exit $fail

#!/usr/bin/env bash
# Devnet-only faucet retry loop (free requestAirdrop, small amounts, backoff). Logs to .devnet-keys/airdrop.log
source ~/.deployer_env
KP=${1:-.devnet-keys/deployer.json}; TARGET=${2:-6}
RPCS=(https://solana-devnet.api.onfinality.io/public https://api.devnet.solana.com)
PK=$(solana-keygen pubkey $KP); sleep_s=30
while true; do
  bal=$(solana balance $PK --url ${RPCS[0]} 2>/dev/null | awk '{print $1}')
  echo "$(date '+%F %T') balance=$bal" >> .devnet-keys/airdrop.log
  awk "BEGIN{exit !($bal >= $TARGET)}" && break
  for r in "${RPCS[@]}"; do for amt in 1 0.5; do
    out=$(timeout 40 solana airdrop $amt $PK --url $r 2>&1 | tail -1)
    echo "$(date '+%F %T') $r $amt: $out" >> .devnet-keys/airdrop.log
    [[ "$out" == *SOL* && "$out" != *rror* ]] && sleep_s=20 && break 2
  done; done
  sleep $sleep_s; sleep_s=$(( sleep_s < 600 ? sleep_s*2 : 600 ))
done

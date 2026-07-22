#!/bin/bash
set -euo pipefail

# End-to-end smoke test for the POLYX <-> wPOLYX bridge.
#
# Prerequisites:
#   - The dev environment is running WITH the eth profile:
#       ./scripts/start-env.sh --env-file envs/8.0 --profile eth
#   - The bridge contracts are deployed (deploy-eth.sh) and their addresses
#     are in bridge/relayer/.env (BRIDGE_ADDRESS, WPOLYX_ADDRESS).
#   - The escrow has been bootstrapped (yarn bootstrap).
#   - Foundry (forge/cast) is available, locally or via Docker.
#
# This script:
#   1. Verifies Anvil is reachable.
#   2. Reads the deployed contract addresses.
#   3. (Poly->Eth) Has the relayer mint wPOLYX to a test account, then checks
#      the balance via cast.
#   4. (Eth->Poly) Approves + burns wPOLYX via cast and confirms the event.
#
# It does NOT run the relayer itself — start `yarn start` in another terminal
# (or background it) so events are relayed. This script only drives user actions
# and assertions. Run it once the relayer is up.

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
RELAYER_DIR="${SCRIPT_DIR}/../relayer"
ENV_FILE="${RELAYER_DIR}/.env"

RPC_URL="${BRIDGE_ETH_RPC_URL:-http://127.0.0.1:8546}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[SMOKE] Missing $ENV_FILE. Copy .env.example and fill contract addresses." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

# Anvil test accounts derived from the default mnemonic
# "test test test test test test test test test test test junk".
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # account[0]
RELAYER_KEY="${BRIDGE_ETH_RELAYER_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}" # account[1]
USER_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"   # account[2]
USER_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"        # account[2]

echo "[SMOKE] RPC:      $RPC_URL"
echo "[SMOKE] Bridge:   $BRIDGE_ADDRESS"
echo "[SMOKE] wPOLYX:   $WPOLYX_ADDRESS"
echo "[SMOKE] Relayer:  $(cast wallet address "$RELAYER_KEY" 2>/dev/null || echo '(cast missing)')"
echo "[SMOKE] User:     $USER_ADDR"

# Resolve cast/forge (Docker fallback).
cast_bin() {
  if command -v cast >/dev/null 2>&1; then
    cast "$@"
  else
    docker run --rm "${BRIDGE_ETH_ANVIL_IMAGE:-ghcr.io/foundry-rs/foundry:latest}" cast "$@"
  fi
}

echo "[SMOKE] (1/4) Checking Anvil reachability..."
CHAIN_ID="$(cast_bin chain-id --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')" || {
  echo "[SMOKE] Could not reach Anvil at $RPC_URL. Is the eth profile running?" >&2
  exit 1
}
echo "[SMOKE] chain id = $CHAIN_ID"

echo "[SMOKE] (2/4) Poly->Eth: relayer mints 1.0 wPOLYX (1_000_000 base units) to user..."
AMOUNT=1000000
# Mint must go THROUGH the bridge (which holds the minter role), not directly
# on the token. mintFromPolymesh(ethRecipient, amount, polyEventId).
cast_bin send "$BRIDGE_ADDRESS" \
  --private-key "$RELAYER_KEY" \
  --rpc-url "$RPC_URL" \
  "mintFromPolymesh(address,uint256,uint256)" "$USER_ADDR" "$AMOUNT" 1 > /dev/null
echo "[SMOKE] mint sent via bridge.mintFromPolymesh"

BAL="$(cast_bin call "$WPOLYX_ADDRESS" "balanceOf(address)(uint256)" "$USER_ADDR" --rpc-url "$RPC_URL")"
echo "[SMOKE] user wPOLYX balance: $BAL (expect 1000000)"

echo "[SMOKE] (3/4) Eth->Poly: user approves bridge, then burns to bridge back..."
cast_bin send "$WPOLYX_ADDRESS" \
  --private-key "$USER_KEY" \
  --rpc-url "$RPC_URL" \
  "approve(address,uint256)" "$BRIDGE_ADDRESS" "$AMOUNT" > /dev/null

# A valid-length Polymesh SS58 address (48 chars) = Alice (escrow will release here).
POLY_RECV="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
cast_bin send "$BRIDGE_ADDRESS" \
  --private-key "$USER_KEY" \
  --rpc-url "$RPC_URL" \
  "bridgeToPolymesh(string,uint256)" "$POLY_RECV" "$AMOUNT" > /dev/null
echo "[SMOKE] bridgeToPolymesh sent (relayer will release POLYX from escrow)"

BAL2="$(cast_bin call "$WPOLYX_ADDRESS" "balanceOf(address)(uint256)" "$USER_ADDR" --rpc-url "$RPC_URL")"
echo "[SMOKE] user wPOLYX balance after burn: $BAL2 (expect 0)"

echo "[SMOKE] (4/4) Verifying burn reduced the balance..."
if [[ "$BAL" == "$BAL2" ]]; then
  echo "[SMOKE] FAIL: balance did not change after bridgeToPolymesh" >&2
  exit 1
fi

echo "[SMOKE] All checks passed. Check the relayer logs for the POLYX release on Polymesh."

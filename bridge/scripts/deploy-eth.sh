#!/bin/bash
set -euo pipefail

# Deploys the bridge contracts (WrappedPolyx + PolyxBridge) to the local Anvil
# chain started via `--profile eth`.
#
# Usage:
#   ./bridge/scripts/deploy-eth.sh [--relayer 0x...] [--private-key 0x...]
#
# Environment overrides:
#   BRIDGE_ETH_RPC_URL   RPC endpoint (default http://127.0.0.1:8546)
#   RELAYER_ADDRESS      Relayer address authorized to mint
#   DEPLOYER_KEY         Deployer private key (default Anvil account[0])
#
# Forge resolution order: local `forge` if available, otherwise Docker
# (ghcr.io/foundry-rs/foundry, the same image used by eth-anvil).

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
CONTRACTS_DIR="${SCRIPT_DIR}/../contracts"

RPC_URL="${BRIDGE_ETH_RPC_URL:-http://127.0.0.1:${BRIDGE_ETH_RPC_PORT:-8546}}"
DEPLOYER_KEY="${DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}" # Anvil account[0]

# Allow overriding the relayer via flag.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --relayer) RELAYER_ADDRESS="$2"; shift 2 ;;
    --private-key) DEPLOYER_KEY="$2"; shift 2 ;;
    *) echo "[DEPLOY] Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Default relayer: Anvil account[1] (so deployer != relayer, matching the tests).
RELAYER_ADDRESS="${RELAYER_ADDRESS:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"

echo "[DEPLOY] RPC URL: $RPC_URL"
echo "[DEPLOY] Relayer: $RELAYER_ADDRESS"

run_forge() {
  if command -v forge >/dev/null 2>&1; then
    (cd "$CONTRACTS_DIR" && forge "$@")
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm \
      -v "$CONTRACTS_DIR":/work \
      -w /work \
      "${BRIDGE_ETH_ANVIL_IMAGE:-ghcr.io/foundry-rs/foundry:latest}" \
      forge "$@"
  else
    echo "[DEPLOY] ERROR: neither 'forge' nor 'docker' is available to run Foundry." >&2
    echo "[DEPLOY] Install Foundry (https://book.getfoundry.sh) or run this script" >&2
    echo "[DEPLOY] where Docker is available." >&2
    exit 1
  fi
}

echo "[DEPLOY] Building contracts..."
run_forge build

echo "[DEPLOY] Deploying..."
# Pass the deployer key explicitly via --private-key (forge 1.7 no longer reads
# the PRIVATE_KEY env var for `script`).
run_forge script script/Deploy.s.sol:Deploy \
  --private-key "$DEPLOYER_KEY" \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --slow

echo "[DEPLOY] Done. Addresses are logged above (WPOLYX_ADDRESS / BRIDGE_ADDRESS)."

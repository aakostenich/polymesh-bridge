#!/bin/bash
set -euo pipefail

# Deploy WrappedPolyx + PolyxBridge to local Anvil or Ethereum Sepolia.
#
# Usage:
#   ./bridge/scripts/deploy-eth.sh                          # local Anvil
#   ./bridge/scripts/deploy-eth.sh --network local
#   ./bridge/scripts/deploy-eth.sh --network sepolia \
#       --private-key 0x... --relayer 0x...
#
# Environment:
#   BRIDGE_ETH_RPC_URL   RPC (overrides network default)
#   BRIDGE_ETH_CHAIN_ID  chain id (overrides network default)
#   DEPLOYER_KEY         deployer private key
#   RELAYER_ADDRESS      address authorized to mint (must match relayer key)
#   ETHERSCAN_API_KEY    optional; verify on Sepolia when set
#
# Writes addresses to bridge/deployments/<network>.json

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
CONTRACTS_DIR="${SCRIPT_DIR}/../contracts"
DEPLOYMENTS_DIR="${SCRIPT_DIR}/../deployments"
NETWORK="local"
VERIFY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --relayer) RELAYER_ADDRESS="$2"; shift 2 ;;
    --private-key) DEPLOYER_KEY="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    --rpc-url) BRIDGE_ETH_RPC_URL="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "[DEPLOY] Unknown argument: $1" >&2; exit 1 ;;
  esac
done

case "$NETWORK" in
  local|anvil)
    NETWORK=local
    RPC_URL="${BRIDGE_ETH_RPC_URL:-http://127.0.0.1:${BRIDGE_ETH_RPC_PORT:-8546}}"
    CHAIN_ID="${BRIDGE_ETH_CHAIN_ID:-1337}"
    DEPLOYER_KEY="${DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
    RELAYER_ADDRESS="${RELAYER_ADDRESS:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"
    ;;
  sepolia|testnet)
    NETWORK=sepolia
    RPC_URL="${BRIDGE_ETH_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
    CHAIN_ID="${BRIDGE_ETH_CHAIN_ID:-11155111}"
    if [[ -z "${DEPLOYER_KEY:-}" ]]; then
      echo "[DEPLOY] ERROR: Sepolia requires DEPLOYER_KEY or --private-key (funded Sepolia wallet)." >&2
      exit 1
    fi
    if [[ -z "${RELAYER_ADDRESS:-}" ]]; then
      echo "[DEPLOY] ERROR: Sepolia requires RELAYER_ADDRESS or --relayer (must match BRIDGE_ETH_RELAYER_KEY)." >&2
      exit 1
    fi
    ;;
  *)
    echo "[DEPLOY] Unknown network: $NETWORK (use local|sepolia)" >&2
    exit 1
    ;;
esac

# Allow env overrides after network defaults
RPC_URL="${BRIDGE_ETH_RPC_URL:-$RPC_URL}"
CHAIN_ID="${BRIDGE_ETH_CHAIN_ID:-$CHAIN_ID}"

echo "[DEPLOY] network:  $NETWORK"
echo "[DEPLOY] RPC URL:  $RPC_URL"
echo "[DEPLOY] chain id: $CHAIN_ID"
echo "[DEPLOY] Relayer:  $RELAYER_ADDRESS"

# Quick RPC reachability
if command -v cast >/dev/null 2>&1; then
  GOT_ID="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$GOT_ID" && "$GOT_ID" != "$CHAIN_ID" ]]; then
    echo "[DEPLOY] WARNING: RPC chain id is $GOT_ID, expected $CHAIN_ID" >&2
  fi
  if [[ -z "$GOT_ID" ]]; then
    echo "[DEPLOY] WARNING: could not query chain id (cast failed); continuing anyway" >&2
  fi
fi

run_forge() {
  if command -v forge >/dev/null 2>&1; then
    (cd "$CONTRACTS_DIR" && RELAYER_ADDRESS="$RELAYER_ADDRESS" forge "$@")
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm \
      -e RELAYER_ADDRESS="$RELAYER_ADDRESS" \
      -v "$CONTRACTS_DIR":/work \
      -w /work \
      --network host \
      "${BRIDGE_ETH_ANVIL_IMAGE:-ghcr.io/foundry-rs/foundry:latest}" \
      forge "$@"
  else
    echo "[DEPLOY] ERROR: neither 'forge' nor 'docker' is available." >&2
    exit 1
  fi
}

echo "[DEPLOY] Building contracts..."
run_forge build

FORGE_ARGS=(
  script script/Deploy.s.sol:Deploy
  --private-key "$DEPLOYER_KEY"
  --rpc-url "$RPC_URL"
  --broadcast
  --slow
)

if [[ "$VERIFY" == "1" || -n "${ETHERSCAN_API_KEY:-}" ]]; then
  if [[ "$NETWORK" == "sepolia" && -n "${ETHERSCAN_API_KEY:-}" ]]; then
    FORGE_ARGS+=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
    echo "[DEPLOY] verification enabled (Etherscan)"
  fi
fi

echo "[DEPLOY] Deploying..."
# Capture output for address scraping
set +e
OUT="$(run_forge "${FORGE_ARGS[@]}" 2>&1)"
STATUS=$?
set -e
echo "$OUT"

if [[ $STATUS -ne 0 ]]; then
  echo "[DEPLOY] forge failed with exit $STATUS" >&2
  exit "$STATUS"
fi

WPOLYX="$(echo "$OUT" | grep -Eo 'WPOLYX_ADDRESS[=:] ?0x[a-fA-F0-9]{40}' | tail -1 | grep -Eo '0x[a-fA-F0-9]{40}' || true)"
BRIDGE="$(echo "$OUT" | grep -Eo 'BRIDGE_ADDRESS[=:] ?0x[a-fA-F0-9]{40}' | tail -1 | grep -Eo '0x[a-fA-F0-9]{40}' || true)"

# Fallback: latest broadcast run-latest.json
if [[ -z "$WPOLYX" || -z "$BRIDGE" ]]; then
  LATEST="$(ls -t "$CONTRACTS_DIR"/broadcast/Deploy.s.sol/*/run-latest.json 2>/dev/null | head -1 || true)"
  if [[ -n "$LATEST" ]] && command -v python3 >/dev/null 2>&1; then
    read -r WPOLYX BRIDGE < <(python3 - <<PY
import json
with open("$LATEST") as f:
    data = json.load(f)
w = b = None
for tx in data.get("transactions", []):
    name = tx.get("contractName")
    addr = tx.get("contractAddress")
    if name == "WrappedPolyx" and addr:
        w = addr
    if name == "PolyxBridge" and addr:
        b = addr
print(w or "", b or "")
PY
)
  fi
fi

mkdir -p "$DEPLOYMENTS_DIR"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT_JSON="$DEPLOYMENTS_DIR/${NETWORK}.json"

if [[ -n "$WPOLYX" && -n "$BRIDGE" ]]; then
  cat >"$OUT_JSON" <<EOF
{
  "network": "$NETWORK",
  "chainId": $CHAIN_ID,
  "rpcUrl": "$RPC_URL",
  "wPolyx": "$WPOLYX",
  "bridge": "$BRIDGE",
  "relayer": "$RELAYER_ADDRESS",
  "deployedAt": "$TS"
}
EOF
  echo ""
  echo "[DEPLOY] Wrote $OUT_JSON"
  echo "[DEPLOY] Add to your relayer env:"
  echo "  WPOLYX_ADDRESS=$WPOLYX"
  echo "  BRIDGE_ADDRESS=$BRIDGE"
  echo "  BRIDGE_ETH_CHAIN_ID=$CHAIN_ID"
  echo "  BRIDGE_ETH_RPC_URL=$RPC_URL"
  if [[ "$NETWORK" == "sepolia" ]]; then
    echo ""
    echo "[DEPLOY] Next: fund escrow with test POLYX, set BRIDGE_ETH_RELAYER_KEY, then:"
    echo "  cd bridge/relayer && yarn start:testnet"
    echo "  See bridge/TESTNET.md"
  fi
else
  echo "[DEPLOY] WARNING: could not parse addresses from forge output." >&2
  echo "[DEPLOY] Check logs above for WPOLYX_ADDRESS / BRIDGE_ADDRESS." >&2
fi

echo "[DEPLOY] Done."

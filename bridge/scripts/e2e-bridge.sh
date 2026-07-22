#!/bin/bash
set -euo pipefail

# Full E2E for POLYX ↔ wPOLYX:
#   1) Poly → Eth via intent-id memo + lock CLI
#   2) Wait for transfer status = completed
#   3) Relayer restart resilience (kill + start mid-flight optional path)
#   4) Eth → Poly burn + wait for release completed
#
# Prerequisites:
#   - Dev env with --profile eth
#   - Contracts deployed; bridge/relayer/.env filled
#   - Escrow bootstrapped
#   - cast available (or docker foundry image)
#
# Usage:
#   ./bridge/scripts/e2e-bridge.sh
#   ./bridge/scripts/e2e-bridge.sh --restart   # also kill/restart relayer after lock

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT_DIR="${SCRIPT_DIR}/../.."
RELAYER_DIR="${SCRIPT_DIR}/../relayer"
ENV_FILE="${RELAYER_DIR}/.env"
RPC_URL="${BRIDGE_ETH_RPC_URL:-http://127.0.0.1:8546}"
INTENT_API="${BRIDGE_INTENT_API_URL:-http://127.0.0.1:3006}"
API_TOKEN="${BRIDGE_API_TOKEN:-dev-bridge-token}"
DO_RESTART=0
RELAYER_PID=""
RELAYER_LOG="${RELAYER_DIR}/.e2e-relayer.log"

auth_hdr=()
if [[ -n "$API_TOKEN" && "$API_TOKEN" != "off" && "$API_TOKEN" != "none" ]]; then
  auth_hdr=(-H "Authorization: Bearer ${API_TOKEN}")
fi

for arg in "$@"; do
  case "$arg" in
    --restart) DO_RESTART=1 ;;
    *) echo "[E2E] Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[E2E] Missing $ENV_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

USER_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
USER_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
POLY_RECV="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" # Alice
AMOUNT_HUMAN="1.5"
AMOUNT_BASE="1500000"

cast_bin() {
  if command -v cast >/dev/null 2>&1; then
    cast "$@"
  else
    docker run --rm --network host \
      "${BRIDGE_ETH_ANVIL_IMAGE:-ghcr.io/foundry-rs/foundry:latest}" cast "$@"
  fi
}

cleanup() {
  if [[ -n "${RELAYER_PID}" ]] && kill -0 "$RELAYER_PID" 2>/dev/null; then
    echo "[E2E] stopping relayer pid=$RELAYER_PID"
    kill "$RELAYER_PID" 2>/dev/null || true
    wait "$RELAYER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_relayer() {
  echo "[E2E] starting relayer..."
  (
    cd "$RELAYER_DIR"
    yarn start
  ) >"$RELAYER_LOG" 2>&1 &
  RELAYER_PID=$!
  for i in $(seq 1 40); do
    if curl -sf "$INTENT_API/health" >/dev/null 2>&1; then
      echo "[E2E] relayer healthy (pid=$RELAYER_PID)"
      return 0
    fi
    sleep 0.5
  done
  echo "[E2E] relayer failed to become healthy. Log:" >&2
  tail -50 "$RELAYER_LOG" >&2 || true
  exit 1
}

wait_status() {
  local intent_id="$1"
  local want="$2"
  local timeout_s="${3:-120}"
  local start
  start=$(date +%s)
  echo "[E2E] waiting for intent=$intent_id status=$want (timeout ${timeout_s}s)"
  while true; do
    local body status
    body="$(curl -sf "${auth_hdr[@]}" "$INTENT_API/transfers/$intent_id" 2>/dev/null || true)"
    if [[ -n "$body" ]]; then
      status="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["transfer"]["status"])' <<<"$body" 2>/dev/null || true)"
      echo "[E2E]   status=$status"
      if [[ "$status" == "$want" ]]; then
        return 0
      fi
      if [[ "$status" == "failed" ]]; then
        echo "[E2E] transfer failed: $body" >&2
        exit 1
      fi
    fi
    if (( $(date +%s) - start > timeout_s )); then
      echo "[E2E] timeout waiting for $want (last=$status)" >&2
      tail -40 "$RELAYER_LOG" >&2 || true
      exit 1
    fi
    sleep 2
  done
}

echo "[E2E] === setup ==="
echo "[E2E] RPC=$RPC_URL bridge=$BRIDGE_ADDRESS wpolyx=$WPOLYX_ADDRESS"

cast_bin chain-id --rpc-url "$RPC_URL" >/dev/null
echo "[E2E] Anvil OK"

# If something is already on 3006, use it; else start ours.
if curl -sf "$INTENT_API/health" >/dev/null 2>&1; then
  echo "[E2E] using existing relayer at $INTENT_API"
  RELAYER_PID=""
else
  start_relayer
fi

BAL_BEFORE="$(cast_bin call "$WPOLYX_ADDRESS" "balanceOf(address)(uint256)" "$USER_ADDR" --rpc-url "$RPC_URL" | head -1 | tr -d '[:space:]')"
# cast may return "1500000 [1.5e6]" — take first token
BAL_BEFORE="${BAL_BEFORE%%\[*}"
BAL_BEFORE="$(echo "$BAL_BEFORE" | awk '{print $1}')"
echo "[E2E] user wPOLYX before: $BAL_BEFORE"

echo "[E2E] === Poly → Eth (intent memo) ==="
(
  cd "$RELAYER_DIR"
  yarn lock //Bob "$USER_ADDR" "$AMOUNT_HUMAN"
) | tee /tmp/e2e-lock.out

INTENT_ID="$(grep -Eo 'intentId=[0-9a-fA-F]+' /tmp/e2e-lock.out | head -1 | cut -d= -f2 || true)"
if [[ -z "$INTENT_ID" ]]; then
  # Fallback: parse latest transfer
  INTENT_ID="$(curl -sf "${auth_hdr[@]}" "$INTENT_API/transfers?limit=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["transfers"][0]["intentId"])')"
fi
echo "[E2E] intentId=$INTENT_ID"

if [[ "$DO_RESTART" == "1" ]]; then
  echo "[E2E] === relayer restart resilience ==="
  if [[ -n "$RELAYER_PID" ]]; then
    kill "$RELAYER_PID" 2>/dev/null || true
    wait "$RELAYER_PID" 2>/dev/null || true
    RELAYER_PID=""
  else
    # Best-effort kill process listening on intent port
    if command -v lsof >/dev/null 2>&1; then
      PIDS="$(lsof -tiTCP:3006 -sTCP:LISTEN || true)"
      if [[ -n "$PIDS" ]]; then
        echo "[E2E] killing existing listeners on :3006 → $PIDS"
        # shellcheck disable=SC2086
        kill $PIDS 2>/dev/null || true
        sleep 1
      fi
    fi
  fi
  sleep 2
  start_relayer
fi

wait_status "$INTENT_ID" "completed" 180

BAL_AFTER="$(cast_bin call "$WPOLYX_ADDRESS" "balanceOf(address)(uint256)" "$USER_ADDR" --rpc-url "$RPC_URL" | head -1)"
BAL_AFTER="${BAL_AFTER%%\[*}"
BAL_AFTER="$(echo "$BAL_AFTER" | awk '{print $1}')"
echo "[E2E] user wPOLYX after mint: $BAL_AFTER"

python3 - <<PY
before=int("${BAL_BEFORE}")
after=int("${BAL_AFTER}")
need=int("${AMOUNT_BASE}")
if after - before < need:
    raise SystemExit(f"FAIL: expected +{need} wPOLYX, got before={before} after={after}")
print(f"[E2E] mint OK (+{after-before})")
PY

echo "[E2E] === Eth → Poly (burn + release) ==="
# Use a unique amount if user has balance; burn 0.5 wPOLYX = 500000
BURN_BASE="500000"
cast_bin send "$WPOLYX_ADDRESS" \
  --private-key "$USER_KEY" \
  --rpc-url "$RPC_URL" \
  "approve(address,uint256)" "$BRIDGE_ADDRESS" "$BURN_BASE" >/dev/null

cast_bin send "$BRIDGE_ADDRESS" \
  --private-key "$USER_KEY" \
  --rpc-url "$RPC_URL" \
  "bridgeToPolymesh(string,uint256)" "$POLY_RECV" "$BURN_BASE" >/dev/null
echo "[E2E] bridgeToPolymesh sent"

# Find newest eth_to_poly transfer and wait for completed
ETH_INTENT=""
for i in $(seq 1 60); do
  ETH_INTENT="$(
    curl -sf "${auth_hdr[@]}" "$INTENT_API/transfers?limit=20" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for t in data.get("transfers", []):
    if t.get("direction") == "eth_to_poly" and str(t.get("amount")) == "500000":
        print(t["intentId"])
        break
'
  )"
  if [[ -n "$ETH_INTENT" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "$ETH_INTENT" ]]; then
  echo "[E2E] could not find eth_to_poly transfer record" >&2
  tail -40 "$RELAYER_LOG" >&2 || true
  exit 1
fi

wait_status "$ETH_INTENT" "completed" 180
echo "[E2E] Eth→Poly release completed (intent=$ETH_INTENT)"

echo "[E2E] === ALL PASSED ==="

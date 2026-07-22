#!/bin/bash
set -euo pipefail

# Wrapper: run readiness checks against testnet env.
#   ./bridge/scripts/check-testnet-ready.sh [--strict]

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
RELAYER_DIR="${SCRIPT_DIR}/../relayer"

export BRIDGE_NETWORK=testnet
if [[ -f "${RELAYER_DIR}/.env.testnet" ]]; then
  echo "[CHECK] using ${RELAYER_DIR}/.env.testnet"
else
  echo "[CHECK] WARNING: no .env.testnet — falling back to defaults / .env" >&2
  echo "[CHECK] Copy: cp ${RELAYER_DIR}/.env.testnet.example ${RELAYER_DIR}/.env.testnet" >&2
fi

cd "$RELAYER_DIR"
yarn check:testnet "$@"

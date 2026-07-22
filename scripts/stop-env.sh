#!/bin/bash
set -e

# This script cleans up the test environment

# Get the directory where this script is located, regardless of where it's called from
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

COMPOSE_ENV_DEFAULT="${SCRIPT_DIR}/../envs/latest"
COMPOSE_ENV="${COMPOSE_ENV:-$COMPOSE_ENV_DEFAULT}"
COMPOSE_PROFILES="${COMPOSE_PROFILES:-}"
# By default the teardown removes named volumes (chain data, Vault keys,
# Blockscout DB, ...). Pass --keep-volumes to stop the containers but retain
# the data so the next start resumes from the existing state.
KEEP_VOLUMES=false

while [[ $# -gt 0 ]]; do
	case "$1" in
		--env-file)
			COMPOSE_ENV="$2"
			shift 2
			;;
		--profile)
			COMPOSE_PROFILES="$2"
			shift 2
			;;
		--keep-volumes)
			KEEP_VOLUMES=true
			shift
			;;
		*)
			echo "[STOP ENV] Unknown argument: $1"
			exit 1
			;;
	esac
done

# Always tear down with the `evm` and `eth` profiles enabled so profile-gated
# services (eth-rpc, Blockscout, the bridge's standalone Anvil node, ...) are
# removed even when the caller omits --profile. Without this, `down` leaves
# those containers running.
case ",$COMPOSE_PROFILES," in
	*,evm,*) ;;
	*) COMPOSE_PROFILES="${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}evm" ;;
esac
case ",$COMPOSE_PROFILES," in
	*,eth,*) ;;
	*) COMPOSE_PROFILES="${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}eth" ;;
esac

if [[ "${COMPOSE_ENV}" != /* ]]; then
	COMPOSE_ENV="${SCRIPT_DIR}/../${COMPOSE_ENV}"
fi

if [[ ! -f "$COMPOSE_ENV" ]]; then
	echo "[STOP ENV] Env file not found: $COMPOSE_ENV"
	exit 1
fi

COMPOSE_ARGS=(--env-file "$COMPOSE_ENV")

if [[ -n "$COMPOSE_PROFILES" ]]; then
	IFS=',' read -r -a PROFILE_ARRAY <<< "$COMPOSE_PROFILES"
	for profile in "${PROFILE_ARRAY[@]}"; do
		COMPOSE_ARGS+=(--profile "$profile")
	done
fi

DOWN_ARGS=(down)
if [[ "$KEEP_VOLUMES" == true ]]; then
	echo "[STOP ENV] Stopping the docker environment (named volumes preserved)..."
else
	DOWN_ARGS+=(--volumes)
	echo "[STOP ENV] Cleaning up the docker environment (removing named volumes)..."
fi

docker compose "${COMPOSE_ARGS[@]}" "${DOWN_ARGS[@]}"

echo "[STOP ENV] docker env cleaned up"

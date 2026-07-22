#!/bin/bash
set -e

# This script starts the test environment

# Get the directory where this script is located, regardless of where it's called from
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

COMPOSE_ENV_DEFAULT="${SCRIPT_DIR}/../envs/latest"
COMPOSE_ENV="${COMPOSE_ENV:-$COMPOSE_ENV_DEFAULT}"
COMPOSE_PROFILES="${COMPOSE_PROFILES:-}"
# Image pull policy passed through to `docker compose up --pull`.
# Empty leaves Docker's default (missing). Recommended `always` when using
# floating tags such as `latest` so the newest image is fetched on every start.
COMPOSE_PULL_POLICY="${COMPOSE_PULL_POLICY:-}"

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
		--pull)
			# Policy argument is optional; a bare `--pull` means `always`.
			if [[ -n "${2:-}" && "$2" != -* ]]; then
				COMPOSE_PULL_POLICY="$2"
				shift 2
			else
				COMPOSE_PULL_POLICY="always"
				shift
			fi
			;;
		*)
			echo "[START ENV] Unknown argument: $1"
			exit 1
			;;
	esac
done

if [[ "${COMPOSE_ENV}" != /* ]]; then
	COMPOSE_ENV="${SCRIPT_DIR}/../${COMPOSE_ENV}"
fi

if [[ ! -f "$COMPOSE_ENV" ]]; then
	echo "[START ENV] Env file not found: $COMPOSE_ENV"
	exit 1
fi

COMPOSE_ARGS=(--env-file "$COMPOSE_ENV")

if [[ -n "$COMPOSE_PROFILES" ]]; then
	IFS=',' read -r -a PROFILE_ARRAY <<< "$COMPOSE_PROFILES"
	for profile in "${PROFILE_ARRAY[@]}"; do
		COMPOSE_ARGS+=(--profile "$profile")
	done
fi

UP_ARGS=(--detach)
if [[ -n "$COMPOSE_PULL_POLICY" ]]; then
	UP_ARGS+=(--pull "$COMPOSE_PULL_POLICY")
	echo "[START ENV] Image pull policy: $COMPOSE_PULL_POLICY"
fi

echo "[START ENV] Starting env using $COMPOSE_ENV"
docker compose "${COMPOSE_ARGS[@]}" up "${UP_ARGS[@]}"

echo "[START ENV] Waiting for a fully initialized environment..."
# `|| true` swallows all errors, but `docker wait` exits with non-zero in the expected case
docker compose "${COMPOSE_ARGS[@]}" wait environment-ready >/dev/null || true

echo "[START ENV] Polymesh dev environment started"

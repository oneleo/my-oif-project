#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/lib.sh"
ensure_foundry_tooling_on_path
require_cmd anvil
require_cmd cast

cd "$UNIVERSAL_REPO_ROOT"

RPC_INPUT="${1:?Usage: $0 <ALCHEMY_NETWORK_LABEL|RPC_URL> [--only <contractKey>]}"
ONLY_KEY=""
shift || true

while [[ $# -gt 0 ]]; do
	case "$1" in
	--only)
		ONLY_KEY="${2:?missing value for --only}"
		validate_target_key "$ONLY_KEY"
		shift 2
		;;
	*)
		echo "error: unknown arg: $1" >&2
		exit 1
		;;
	esac
done

load_deploy_env_file

ANVIL_PORT="$(pick_free_local_port)"
LOCAL_RPC="http://127.0.0.1:${ANVIL_PORT}"

ensure_target_addresses_file dry-run
FORK_RPC_URL="$(resolve_alchemy_rpc_url "$RPC_INPUT")"
EXPECTED_CHAIN_ID="$(cast chain-id --rpc-url "$FORK_RPC_URL")"

echo "Forking chainId=$EXPECTED_CHAIN_ID from $FORK_RPC_URL"

anvil --fork-url "$FORK_RPC_URL" --port "$ANVIL_PORT" &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT

timeout 10 bash -c 'until cast chain-id --rpc-url "$0" >/dev/null 2>&1; do sleep 0.2; done' "$LOCAL_RPC"

fund_fork_deployer_from_anvil_account_zero "$LOCAL_RPC"

DEPLOY_ARGS=( "$LOCAL_RPC" )
[[ -n "$ONLY_KEY" ]] && DEPLOY_ARGS+=( --only "$ONLY_KEY" )

bash "$(dirname "$0")/deploy-one-chain.sh" "${DEPLOY_ARGS[@]}"

echo "Dry run finished -> chainId=$EXPECTED_CHAIN_ID addresses=$DEPLOY_ADDRESSES_PATH"

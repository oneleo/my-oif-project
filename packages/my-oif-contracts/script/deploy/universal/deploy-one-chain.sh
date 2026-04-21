#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/lib.sh"
ensure_foundry_tooling_on_path
require_cmd cast
require_cmd forge

cd "$UNIVERSAL_REPO_ROOT"

RPC_INPUT="${1:?Usage: $0 <ALCHEMY_NETWORK_LABEL|RPC_URL> [--verify] [--only <contractKey>]}"
DO_VERIFY=0
ONLY_KEY=""
shift || true

while [[ $# -gt 0 ]]; do
	case "$1" in
	--verify)
		DO_VERIFY=1
		shift
		;;
	--only)
		ONLY_KEY="${2:?missing value for --only}"
		shift 2
		;;
	*)
		echo "error: unknown arg: $1" >&2
		exit 1
		;;
	esac
done

load_deploy_env_file

ensure_target_addresses_file production
RPC_URL="$(resolve_alchemy_rpc_url "$RPC_INPUT")"
export RPC_URL
CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"

ensure_chain_entry "$DEPLOY_ADDRESSES_PATH" "$CHAIN_ID"
ensure_create2_factory "$RPC_URL"

echo "chainId=$CHAIN_ID rpc=$RPC_URL"
echo "addresses=$DEPLOY_ADDRESSES_PATH"

mapfile -t TARGET_KEYS < <(emit_target_keys "$ONLY_KEY")

for key in "${TARGET_KEYS[@]}"; do
	script_path="$(target_script_for "$key")"
	echo ">>> forge script $script_path"
	forge script "$script_path" --rpc-url "$RPC_URL" --broadcast
done

if [[ "$DO_VERIFY" -eq 1 ]]; then
	VERIFY_ARGS=( "$RPC_INPUT" )
	[[ -n "$ONLY_KEY" ]] && VERIFY_ARGS+=( --only "$ONLY_KEY" )
	bash "$(dirname "$0")/verify-one-chain.sh" "${VERIFY_ARGS[@]}"
fi

echo "Done -> chainId=$CHAIN_ID addresses=$DEPLOY_ADDRESSES_PATH"

#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/lib.sh"
ensure_foundry_tooling_on_path
require_cmd cast
require_cmd forge
require_cmd jq

cd "$UNIVERSAL_REPO_ROOT"

RPC_INPUT="${1:?Usage: $0 <ALCHEMY_NETWORK_LABEL|RPC_URL> [--only <contractKey>] [--addresses-path <path>] [--soft-fail]}"
ONLY_KEY=""
SOFT_FAIL=0
shift || true

while [[ $# -gt 0 ]]; do
	case "$1" in
	--only)
		ONLY_KEY="${2:?missing value for --only}"
		shift 2
		;;
	--addresses-path)
		DEPLOY_ADDRESSES_PATH="${2:?missing value for --addresses-path}"
		DEPLOY_REFERENCE_ADDRESSES_PATH="${2:?missing value for --addresses-path}"
		shift 2
		;;
	--soft-fail)
		SOFT_FAIL=1
		shift
		;;
	*)
		echo "error: unknown arg: $1" >&2
		exit 1
		;;
	esac
done

load_deploy_env_file

configure_deploy_addresses_paths verify
export DEPLOY_ADDRESSES_PATH
require_etherscan_key

RPC_URL="$(resolve_alchemy_rpc_url "$RPC_INPUT")"
CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"

ensure_chain_entry "$DEPLOY_ADDRESSES_PATH" "$CHAIN_ID"

mapfile -t TARGET_KEYS < <(emit_target_keys "$ONLY_KEY")

OK=0
FAIL=0
SKIP=0

for key in "${TARGET_KEYS[@]}"; do
	address_key="$(target_address_key_for "$key")"
	source_ref="$(target_source_for "$key")"
	addr="$(jq -r --arg cid "$CHAIN_ID" --arg k "$address_key" '.[$cid][$k] // empty' "$DEPLOY_ADDRESSES_PATH")"

	if [[ -z "$addr" || "$addr" == "null" || "${addr,,}" == "0x0000000000000000000000000000000000000000" ]]; then
		echo ">>> skip $key"
		SKIP=$((SKIP + 1))
		continue
	fi

	echo ">>> verify $key $addr"
	set +e
	forge verify-contract "$addr" "$source_ref" \
		--chain "$CHAIN_ID" \
		--rpc-url "$RPC_URL" \
		--guess-constructor-args \
		--etherscan-api-key "$ETHERSCAN_API_KEY" \
		--watch
	status=$?
	set -e

	if [[ "$status" -eq 0 ]]; then
		OK=$((OK + 1))
	else
		echo "!!! fail $status $key" >&2
		FAIL=$((FAIL + 1))
	fi
done

echo "summary ok=$OK fail=$FAIL skip=$SKIP chain=$CHAIN_ID"

if [[ "$FAIL" -gt 0 ]]; then
	[[ "$SOFT_FAIL" -eq 1 ]] && exit 0
	exit 1
fi

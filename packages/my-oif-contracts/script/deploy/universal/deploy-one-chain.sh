#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/lib.sh"
ensure_foundry_tooling_on_path
require_cmd cast
require_cmd forge

cd "$UNIVERSAL_REPO_ROOT"

RPC_INPUT="${1:?Usage: $0 <ALCHEMY_NETWORK_LABEL|RPC_URL> [--verify] [--only <contractKey>] [--profile <foundry_profile>] [--gas-estimate-multiplier <int>] [--legacy]}"
DO_VERIFY=0
ONLY_KEY=""
FORGE_PROFILE=""
GAS_ESTIMATE_MULTIPLIER=""
USE_LEGACY=0
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
	--profile)
		# 指定 Foundry profile（見 foundry.toml）
		# 例：--profile size  → 開啟 optimizer + via_ir，用於低 gas limit 鏈（Hyperliquid 等）
		FORGE_PROFILE="${2:?missing value for --profile}"
		shift 2
		;;
	--gas-estimate-multiplier)
		# 控制 eth_estimateGas 的倍率（Foundry 預設為 130）
		# 例：--gas-estimate-multiplier 100 可避免 3M block limit 鏈被 1.3x 推爆
		GAS_ESTIMATE_MULTIPLIER="${2:?missing value for --gas-estimate-multiplier}"
		shift 2
		;;
	--legacy)
		# 強制使用 legacy tx（type 0），避免部分鏈在 EIP-1559 fee estimation 出錯
		USE_LEGACY=1
		shift
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

if is_hyperliquid_chain "$CHAIN_ID"; then
	# Hyperliquid（998/999）固定採用 size profile + multiplier=100。
	# 目的是在 3M block gas limit 下，避免估算倍率或 profile 選錯造成 tx 被拒，
	# 並避免 EIP-1559 fee estimation 在部分 RPC 端出錯（invalid block range）。
	ensure_foundry_profile_exists "size"
	if [[ -n "$FORGE_PROFILE" && "$FORGE_PROFILE" != "size" ]]; then
		echo "error: Hyperliquid requires --profile size (chainId=$CHAIN_ID)" >&2
		exit 1
	fi
	if [[ -n "$GAS_ESTIMATE_MULTIPLIER" && "$GAS_ESTIMATE_MULTIPLIER" != "100" ]]; then
		echo "error: Hyperliquid requires --gas-estimate-multiplier 100 (chainId=$CHAIN_ID)" >&2
		exit 1
	fi

	[[ -z "$FORGE_PROFILE" ]] && FORGE_PROFILE="size"
	[[ -z "$GAS_ESTIMATE_MULTIPLIER" ]] && GAS_ESTIMATE_MULTIPLIER="100"
	USE_LEGACY=1
fi

echo "chainId=$CHAIN_ID rpc=$RPC_URL"
echo "addresses=$DEPLOY_ADDRESSES_PATH"
if is_hyperliquid_chain "$CHAIN_ID"; then
	echo "Hyperliquid defaults applied: profile=$FORGE_PROFILE gas_estimate_multiplier=$GAS_ESTIMATE_MULTIPLIER"
	size_optimizer_runs="$(foundry_profile_setting "size" "optimizer_runs" || true)"
	size_via_ir="$(foundry_profile_setting "size" "via_ir" || true)"
	[[ -n "$size_optimizer_runs" ]] && echo "Hyperliquid detected foundry.toml -> profile.size.optimizer_runs=$size_optimizer_runs"
	[[ -n "$size_via_ir" ]] && echo "Hyperliquid detected foundry.toml -> profile.size.via_ir=$size_via_ir"
fi
if [[ "$USE_LEGACY" -eq 1 ]]; then
	echo "tx_mode=legacy"
fi

mapfile -t TARGET_KEYS < <(emit_target_keys "$ONLY_KEY")

# 設定 Foundry profile（影響 optimizer / via_ir 等編譯選項）
if [[ -n "$FORGE_PROFILE" ]]; then
	export FOUNDRY_PROFILE="$FORGE_PROFILE"
	echo "FOUNDRY_PROFILE=$FOUNDRY_PROFILE"
fi

FORGE_ARGS=( --rpc-url "$RPC_URL" --broadcast )
[[ -n "$GAS_ESTIMATE_MULTIPLIER" ]] && FORGE_ARGS+=( --gas-estimate-multiplier "$GAS_ESTIMATE_MULTIPLIER" )
[[ "$USE_LEGACY" -eq 1 ]] && FORGE_ARGS+=( --legacy )

for key in "${TARGET_KEYS[@]}"; do
	script_path="$(target_script_for "$key")"
	echo ">>> forge script $script_path"
	forge script "$script_path" "${FORGE_ARGS[@]}"
done

if [[ "$DO_VERIFY" -eq 1 ]]; then
	VERIFY_ARGS=( "$RPC_INPUT" )
	[[ -n "$ONLY_KEY" ]] && VERIFY_ARGS+=( --only "$ONLY_KEY" )
	bash "$(dirname "$0")/verify-one-chain.sh" "${VERIFY_ARGS[@]}"
fi

echo "Done -> chainId=$CHAIN_ID addresses=$DEPLOY_ADDRESSES_PATH"

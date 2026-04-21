#!/usr/bin/env bash

UNIVERSAL_LIB_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
UNIVERSAL_REPO_ROOT="$(cd "$UNIVERSAL_LIB_SH_DIR/../../.." && pwd)"

PROD_ADDRESSES_PATH="./script/deploy/addresses.json"
DRYRUN_ADDRESSES_PATH="./script/deploy/addresses.dry-run.json"
CREATE2_FACTORY="0x4e59b44847b379578588920cA78FbF26c0B4956C"

configure_deploy_addresses_paths() {
	case "${1:?mode: production|dry-run|verify}" in
	production)
		: "${DEPLOY_ADDRESSES_PATH:=$PROD_ADDRESSES_PATH}"
		: "${DEPLOY_REFERENCE_ADDRESSES_PATH:=$PROD_ADDRESSES_PATH}"
		;;
	dry-run)
		: "${DEPLOY_ADDRESSES_PATH:=$DRYRUN_ADDRESSES_PATH}"
		: "${DEPLOY_REFERENCE_ADDRESSES_PATH:=$PROD_ADDRESSES_PATH}"
		;;
	verify)
		: "${DEPLOY_ADDRESSES_PATH:=$PROD_ADDRESSES_PATH}"
		: "${DEPLOY_REFERENCE_ADDRESSES_PATH:=$DEPLOY_ADDRESSES_PATH}"
		;;
	*)
		echo "error: unknown mode '$1'" >&2
		exit 1
		;;
	esac
	export DEPLOY_ADDRESSES_PATH DEPLOY_REFERENCE_ADDRESSES_PATH
}

ensure_target_addresses_file() {
	configure_deploy_addresses_paths "$1"
	if [[ ! -f "$DEPLOY_ADDRESSES_PATH" ]]; then
		mkdir -p "$(dirname "$DEPLOY_ADDRESSES_PATH")"
		printf '{}\n' >"$DEPLOY_ADDRESSES_PATH"
	fi
}

ensure_chain_entry() {
	local path="$1" cid="$2"
	jq -e --arg c "$cid" 'has($c)' "$path" >/dev/null 2>&1 && return 0

	local tmp
	tmp="$(jq --arg c "$cid" '.[$c] = {}' "$path")"
	printf '%s\n' "$tmp" >"$path"
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "error: missing command: $1" >&2
		exit 1
	}
}

ensure_foundry_tooling_on_path() {
	if command -v forge >/dev/null 2>&1 \
		&& command -v cast >/dev/null 2>&1 \
		&& command -v anvil >/dev/null 2>&1; then
		return 0
	fi

	local mise_bin="/home/linuxbrew/.linuxbrew/bin/mise"
	if [[ -x "$mise_bin" ]]; then
		eval "$("$mise_bin" activate bash)"
	fi
}

require_etherscan_key() {
	[[ -n "${ETHERSCAN_API_KEY:-}" ]] || {
		echo "error: set ETHERSCAN_API_KEY" >&2
		exit 1
	}
}

load_deploy_env_file() {
	local prev_addr_path="${DEPLOY_ADDRESSES_PATH-}"
	local prev_ref_path="${DEPLOY_REFERENCE_ADDRESSES_PATH-}"
	local had_addr_path=0
	local had_ref_path=0

	[[ ${DEPLOY_ADDRESSES_PATH+x} ]] && had_addr_path=1
	[[ ${DEPLOY_REFERENCE_ADDRESSES_PATH+x} ]] && had_ref_path=1

	[[ -f .env ]] || return 0
	# shellcheck disable=SC1091
	source .env

	if [[ -z "${DEPLOY_ADDRESSES_PATH:-}" ]]; then
		if [[ "$had_addr_path" -eq 1 ]]; then
			export DEPLOY_ADDRESSES_PATH="$prev_addr_path"
		else
			unset DEPLOY_ADDRESSES_PATH
		fi
	fi

	if [[ -z "${DEPLOY_REFERENCE_ADDRESSES_PATH:-}" ]]; then
		if [[ "$had_ref_path" -eq 1 ]]; then
			export DEPLOY_REFERENCE_ADDRESSES_PATH="$prev_ref_path"
		else
			unset DEPLOY_REFERENCE_ADDRESSES_PATH
		fi
	fi
}

resolve_alchemy_rpc_url() {
	local input="${1:?Set RPC URL or Alchemy network label}"
	if [[ "$input" == http://* || "$input" == https://* ]]; then
		echo "$input"
		return
	fi

	[[ -n "${ALCHEMY_API_KEY:-}" ]] || {
		echo "error: set ALCHEMY_API_KEY to resolve '$input'" >&2
		exit 1
	}
	echo "https://${input}.g.alchemy.com/v2/${ALCHEMY_API_KEY}"
}

ensure_create2_factory() {
	local rpc_url="${1:?rpc url required}"
	local code
	code="$(cast code "$CREATE2_FACTORY" --rpc-url "$rpc_url" 2>/dev/null || true)"
	[[ -n "$code" && "$code" != "0x" ]] || {
		echo "error: Nick CREATE2 factory missing at $CREATE2_FACTORY on $rpc_url" >&2
		exit 1
	}
}

ANVIL_UNLOCKED_SENDER="${ANVIL_UNLOCKED_SENDER:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"

fund_fork_deployer_from_anvil_account_zero() {
	local rpc_url="${1:?rpc url required}"
	[[ -n "${PRIVATE_KEY:-}" ]] || {
		echo "error: PRIVATE_KEY must be set for fork prefund" >&2
		exit 1
	}

	local deployer sender="${ANVIL_UNLOCKED_SENDER}"
	deployer="$(cast wallet address --private-key "$PRIVATE_KEY")"
	if [[ "${deployer,,}" == "${sender,,}" ]]; then
		return 0
	fi

	cast send "$deployer" \
		--rpc-url "$rpc_url" \
		--from "$sender" \
		--unlocked \
		--value "1000 ether" >/dev/null
}

validate_target_key() {
	local key="${1:?target key required}"
	case "$key" in
	inputSettlerEscrow|inputSettlerCompact|outputSettlerSimple|hyperlaneOracle|catsMulticallHandler) ;;
	*)
		echo "error: unsupported --only value '$key'" >&2
		echo "supported values: $(supported_only_values_csv)" >&2
		exit 1
		;;
	esac
}

supported_only_values_csv() {
	echo "inputSettlerEscrow, inputSettlerCompact, outputSettlerSimple, hyperlaneOracle, catsMulticallHandler"
}

emit_target_keys() {
	local only_key="${1:-}"
	if [[ -n "$only_key" ]]; then
		validate_target_key "$only_key"
		printf '%s\n' "$only_key"
		return
	fi

	printf '%s\n' \
		"inputSettlerEscrow" \
		"inputSettlerCompact" \
		"outputSettlerSimple" \
		"hyperlaneOracle" \
		"catsMulticallHandler"
}

target_script_for() {
	local key="${1:?target key required}"
	case "$key" in
	inputSettlerEscrow) echo "./script/deploy/entry/DeployInputSettlerEscrow.s.sol" ;;
	inputSettlerCompact) echo "./script/deploy/entry/DeployInputSettlerCompact.s.sol" ;;
	outputSettlerSimple) echo "./script/deploy/entry/DeployOutputSettlerSimple.s.sol" ;;
	hyperlaneOracle) echo "./script/deploy/entry/DeployHyperlaneOracle.s.sol" ;;
	catsMulticallHandler) echo "./script/deploy/entry/DeployCatsMulticallHandler.s.sol" ;;
	*) validate_target_key "$key" ;;
	esac
}

target_source_for() {
	local key="${1:?target key required}"
	case "$key" in
	inputSettlerEscrow) echo "lib/oif-contracts/src/input/escrow/InputSettlerEscrow.sol:InputSettlerEscrow" ;;
	inputSettlerCompact) echo "lib/oif-contracts/src/input/compact/InputSettlerCompact.sol:InputSettlerCompact" ;;
	outputSettlerSimple) echo "lib/oif-contracts/src/output/simple/OutputSettlerSimple.sol:OutputSettlerSimple" ;;
	hyperlaneOracle) echo "lib/oif-contracts/src/integrations/oracles/hyperlane/HyperlaneOracle.sol:HyperlaneOracle" ;;
	catsMulticallHandler) echo "lib/oif-contracts/src/integrations/CatsMulticallHandler.sol:CatsMulticallHandler" ;;
	*) validate_target_key "$key" ;;
	esac
}

target_address_key_for() {
	local key="${1:?target key required}"
	case "$key" in
	inputSettlerEscrow) echo "inputSettlerEscrow" ;;
	inputSettlerCompact) echo "inputSettlerCompact" ;;
	outputSettlerSimple) echo "outputSettlerSimple" ;;
	hyperlaneOracle) echo "hyperlaneOracle" ;;
	catsMulticallHandler) echo "catsMulticallHandler" ;;
	*) validate_target_key "$key" ;;
	esac
}

pick_free_local_port() {
	local port
	for ((port = 8545; port <= 8599; port++)); do
		if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then
			continue
		fi
		echo "$port"
		return 0
	done

	echo "error: no free local port found in 8545-8599" >&2
	exit 1
}

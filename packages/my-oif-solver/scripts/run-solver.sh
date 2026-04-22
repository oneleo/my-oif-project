#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/run-solver.sh <config-json> [solver args...]

Load env vars, render the JSON config to a temporary file, and run
solver-service with --bootstrap-config <rendered-config>.

Examples:
  bash scripts/run-solver.sh config/sepolia_base-sepolia.json
  bash scripts/run-solver.sh config/sepolia_base-sepolia.json --force-seed
  ENV_FILE=.env.test bash scripts/run-solver.sh config/custom.json --force-seed
EOF
}

if [ "$#" -lt 1 ]; then
  usage >&2
  exit 1
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
caller_cwd="$PWD"

resolve_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$caller_cwd" "$1" ;;
  esac
}

config_input="$(resolve_path "$1")"
shift

if [ ! -f "$config_input" ]; then
  printf 'Config not found: %s\n' "$config_input" >&2
  exit 1
fi

if [ -n "${ENV_FILE:-}" ]; then
  env_file_path="$(resolve_path "$ENV_FILE")"
else
  env_file_path="$package_root/.env"
fi

if [ -f "$env_file_path" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file_path"
  set +a
fi

if ! command -v cargo >/dev/null 2>&1; then
  if [ -x "$HOME/.cargo/bin/cargo" ]; then
    PATH="$HOME/.cargo/bin:$PATH"
  elif [ -x "$HOME/.local/share/mise/shims/cargo" ]; then
    PATH="$HOME/.local/share/mise/shims:$PATH"
  fi
fi

if ! command -v cargo >/dev/null 2>&1; then
  printf 'cargo not found on PATH. Activate your Rust toolchain and try again.\n' >&2
  exit 1
fi

rendered_config="$(mktemp "${TMPDIR:-/tmp}/oif-solver-config.XXXXXX.json")"
cleanup() {
  rm -f "$rendered_config"
}
trap cleanup EXIT

cd "$package_root"
ENV_FILE="$env_file_path" bash "$script_dir/render-config-env.sh" "$config_input" "$rendered_config" >/dev/null

cargo run \
  --manifest-path lib/oif-solver/Cargo.toml \
  -p solver-service \
  -- \
  --bootstrap-config "$rendered_config" \
  "$@"

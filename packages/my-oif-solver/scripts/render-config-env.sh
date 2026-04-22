#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/render-config-env.sh <input-json> [output-json]

Expand ${VAR} and ${VAR:-default} placeholders in a JSON config using the
current environment. If output-json is omitted, a temp file is created and its
path is printed to stdout.

Environment:
  ENV_FILE   Optional env file to source before rendering (defaults to .env
             when that file exists)
EOF
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage >&2
  exit 1
fi

input_json="$1"
output_json="${2:-}"

if [ ! -f "$input_json" ]; then
  printf 'Input config not found: %s\n' "$input_json" >&2
  exit 1
fi

env_file="${ENV_FILE:-.env}"
if [ -n "$env_file" ] && [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

if [ -z "$output_json" ]; then
  output_json="$(mktemp "${TMPDIR:-/tmp}/oif-rendered-config.XXXXXX.json")"
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'jq is required to render config placeholders.\n' >&2
  exit 1
fi

mkdir -p "$(dirname "$output_json")"

jq '
  def walk(f):
    . as $in
    | if type == "object" then
        reduce keys_unsorted[] as $key
          ({};
            . + { ($key): ($in[$key] | walk(f)) })
        | f
      elif type == "array" then
        map(walk(f)) | f
      else
        f
      end;
  def render_string:
    gsub(
      "\\$\\{(?<name>[A-Z_][A-Z0-9_]{0,127})(?::-(?<default>[^}]{0,256}))?\\}";
      (env[.name] // .default // error("Environment variable \"" + .name + "\" not found"))
    );
  walk(if type == "string" then render_string else . end)
' "$input_json" > "$output_json"

printf '%s\n' "$output_json"

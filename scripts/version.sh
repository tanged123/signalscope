#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  exec "$script_dir/dev.sh" "$0" "$@"
fi

exec node "$script_dir/version.mjs" "$@"

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1 || ! command -v rustfmt >/dev/null 2>&1; then
  exec "$script_dir/dev.sh" "$0" "$@"
fi

node "$script_dir/../protocol/scripts/generate-types.mjs"
rustfmt --edition 2024 \
  "$script_dir/../protocol/src/generated.rs" \
  "$script_dir/../core/scope-core/src/session/generated.rs"

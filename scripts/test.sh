#!/usr/bin/env bash
set -euo pipefail

if [ -z "${IN_NIX_SHELL:-}" ]; then
  exec "$(dirname "$0")/dev.sh" "$0" "$@"
fi

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

cargo test --workspace
pnpm test

#!/usr/bin/env bash
set -euo pipefail

if [ -z "${IN_NIX_SHELL:-}" ]; then
  exec "$(dirname "$0")/dev.sh" "$0" "$@"
fi

pnpm install --frozen-lockfile

echo "SignalScope dependencies are ready."

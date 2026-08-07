#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

case "${1:-}" in
--update-lock)
  pnpm install --lockfile-only
  ;;
"")
  pnpm install --frozen-lockfile
  ;;
*)
  echo "usage: ./scripts/setup.sh [--update-lock]" >&2
  exit 2
  ;;
esac

echo "SignalScope dependencies are ready."

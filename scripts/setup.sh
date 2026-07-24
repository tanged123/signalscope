#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

pnpm install --frozen-lockfile

echo "SignalScope dependencies are ready."

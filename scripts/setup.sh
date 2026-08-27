#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

"$signalscope_scripts_dir/chartgpu-submodule.sh" init
pnpm install --frozen-lockfile

echo "SignalScope dependencies are ready."

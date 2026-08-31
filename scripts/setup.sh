#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [ "${SIGNALSCOPE_WINDOWS_BUILD:-}" = 1 ]; then
  cd "$signalscope_root" || exit 1
else
  ensure_dev_shell "$@"
fi

"$signalscope_scripts_dir/chartgpu-submodule.sh" init
case "${1:-}" in
--update-lock)
  pnpm install --lockfile-only
  ;;
--update-nix-lock)
  nix flake lock
  ;;
"")
  pnpm install --frozen-lockfile
  ;;
*)
  echo "usage: ./scripts/setup.sh [--update-lock|--update-nix-lock]" >&2
  exit 2
  ;;
esac

echo "SignalScope dependencies are ready."

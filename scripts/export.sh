#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

show_help() {
  cat <<'EOF'
Usage: ./scripts/export.sh [--no-build] --data <file>... [--workspace <file>]
                           [--range visible|all]
                           [--fidelity preview|standard|high|full] --out <path>

Bakes a self-contained HTML snapshot from data files. Defaults to all/full.
Builds the frontend snapshot template first unless --no-build is supplied.
EOF
}

case "${1:-}" in
-h | --help | help | "")
  show_help
  exit 0
  ;;
esac

if [ "${1:-}" = "--no-build" ]; then
  shift
else
  "$signalscope_scripts_dir/build.sh" web
fi
cargo run --quiet --release -p scope-core --bin scope-bake -- "$@"

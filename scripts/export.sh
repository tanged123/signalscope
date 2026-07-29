#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

show_help() {
  cat <<'EOF'
Usage: ./scripts/export.sh --data <file>... [--workspace <file>] --out <path>

Bakes a self-contained HTML snapshot from data files (all-loaded scope).
Builds the frontend snapshot template first, then runs the scope-bake CLI.
EOF
}

case "${1:-}" in
-h | --help | help | "")
  show_help
  exit 0
  ;;
esac

"$signalscope_scripts_dir/build.sh" web
cargo run --quiet -p scope-core --bin scope-bake -- "$@"

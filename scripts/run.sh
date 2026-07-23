#!/usr/bin/env bash
set -euo pipefail

if [ -z "${IN_NIX_SHELL:-}" ]; then
  exec "$(dirname "$0")/dev.sh" "$0" "$@"
fi

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/run.sh [native|web]

  native  Launch the Tauri workbench (default).
  web     Launch the shared frontend in a browser at http://127.0.0.1:4173.

Native compilation is capped at two jobs by default. Override with:
  CARGO_BUILD_JOBS=4 ./scripts/run.sh native
EOF
}

mode="${1:-native}"
case "$mode" in
  native)
    shift || true
    cd shell/src-tauri
    exec cargo tauri dev "$@"
    ;;
  web)
    shift || true
    exec pnpm dev "$@"
    ;;
  -h | --help | help)
    show_help
    ;;
  *)
    echo "Unknown run mode: $mode" >&2
    show_help >&2
    exit 2
    ;;
esac

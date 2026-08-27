#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

show_help() {
  cat <<'EOF'
Usage: ./scripts/run.sh [app|dev|web]

  app     Launch the built browser host (default).
  dev     Launch scope-server and Vite with the /api proxy.
  web     Launch the shared frontend in a browser at http://127.0.0.1:4173.
EOF
}

mode="${1:-app}"
case "$mode" in
app)
  shift || true
  if [ ! -d frontend/dist ]; then
    "$signalscope_scripts_dir/build.sh" web
  fi
  exec cargo run --release -p scope-server "$@"
  ;;
dev)
  shift || true
  server_pid=""
  cleanup() {
    if [ -n "$server_pid" ]; then
      kill "$server_pid" 2>/dev/null || true
      wait "$server_pid" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT INT TERM
  cargo run -p scope-server -- --no-auth --no-open &
  server_pid=$!
  pnpm dev "$@"
  ;;
web)
  shift || true
  # Port 4173 is also used by Playwright against the shared frontend host.
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

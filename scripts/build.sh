#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="${1:-app}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/build.sh [app|web] [additional arguments]

  app     Build the browser frontend and scope-server release binary (default).
  web     Build only the browser frontend and snapshot-template.html.
EOF
}

ensure_dev_shell "$@"

case "$mode" in
app)
  shift || true
  pnpm --filter @signalscope/frontend build "$@"
  cargo build --release -p scope-server
  mkdir -p build/app
  cp target/release/scope-server build/app/scope-server
  rm -rf build/app/frontend
  cp -R frontend/dist build/app/frontend
  tar -C build/app -czf build/app/signalscope-linux.tar.gz scope-server frontend
  ;;
web)
  shift || true
  exec pnpm build "$@"
  ;;
-h | --help | help)
  show_help
  ;;
*)
  echo "Unknown build mode: $mode" >&2
  show_help >&2
  exit 2
  ;;
esac

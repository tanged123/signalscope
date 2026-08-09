#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="${1:-native}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/build.sh [native|host|appimage|windows|web] [additional arguments]

  native  Build the Electron desktop TypeScript, Rust host, and frontend.
  host    Build the shell-independent Rust host executable.
  appimage
          Build the Linux AppImage in an Ubuntu/FHS environment. Run
          ./scripts/setup-appimage.sh once before using this mode.
  windows
          Build the Windows NSIS installer. Runs outside the Nix shell using
          Git Bash and the runner-provided Rust, Node, and npm toolchain.
  web     Build only the browser frontend and snapshot-template.html.
EOF
}

if [ "$mode" = "appimage" ]; then
  shift || true
  exec "$signalscope_scripts_dir/build-appimage.sh" "$@"
fi

if [ "$mode" = "windows" ]; then
  shift || true
  exec "$signalscope_scripts_dir/build-windows.sh" "$@"
fi

ensure_dev_shell "$@"

case "$mode" in
host)
  shift || true
  exec cargo build -p scope-server --bin signalscope-host "$@"
  ;;
native)
  shift || true
  pnpm --filter @signalscope/frontend build
  pnpm --filter @signalscope/desktop build
  exec cargo build --release -p scope-server --bin signalscope-host "$@"
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

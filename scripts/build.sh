#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="${1:-native}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/build.sh [native|host|appimage|windows|web] [additional arguments]

  native  Build and package the Electron desktop, Rust host, and frontend.
  host    Build the shell-independent Rust host executable.
  appimage Build the Linux AppImage through the Electron package wrapper.
  windows
          Build the Windows NSIS installer through the Electron package wrapper.
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

if [ "${SIGNALSCOPE_WINDOWS_BUILD:-}" = 1 ]; then
  cd "$signalscope_root" || exit 1
else
  ensure_dev_shell "$@"
fi

case "$mode" in
host)
  shift || true
  exec cargo build -p scope-server --bin signalscope-host "$@"
  ;;
native)
  shift || true
  pnpm --filter @signalscope/frontend build
  pnpm --filter @signalscope/desktop build
  cargo build --release -p scope-server --bin signalscope-host
  node "$signalscope_root/desktop/scripts/stage.mjs"
  exec pnpm --filter @signalscope/desktop exec electron-builder \
    --config electron-builder.yml "$@"
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

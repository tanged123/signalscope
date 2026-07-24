#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="${1:-native}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/build.sh [native|appimage|web] [additional arguments]

  native  Build supported Tauri bundles and shared snapshot frontend (default).
          Linux builds .deb and .rpm packages; other platforms use their defaults.
  appimage
          Build the Linux AppImage in an Ubuntu/FHS environment. Run
          ./scripts/setup-appimage.sh once before using this mode.
  web     Build only the browser frontend and snapshot-template.html.
EOF
}

if [ "$mode" = "appimage" ]; then
  shift || true
  exec "$signalscope_scripts_dir/build-appimage.sh" "$@"
fi

ensure_dev_shell "$@"

case "$mode" in
  native)
    shift || true
    cd shell/src-tauri
    if [ "$(uname -s)" = "Linux" ]; then
      exec cargo tauri build --bundles deb,rpm "$@"
    fi
    exec cargo tauri build "$@"
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

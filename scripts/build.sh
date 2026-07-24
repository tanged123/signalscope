#!/usr/bin/env bash
set -euo pipefail

mode="${1:-native}"
if [ "$mode" = "appimage" ]; then
  shift || true
  exec "$(dirname "$0")/build-appimage.sh" "$@"
fi

if [ -z "${IN_NIX_SHELL:-}" ]; then
  exec "$(dirname "$0")/dev.sh" "$0" "$@"
fi

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

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

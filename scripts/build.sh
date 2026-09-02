#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="${1:-app}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/build.sh [app|server|web] [electron-builder arguments]

  app     Build the official package for the current OS: AppImage, NSIS, or DMG.
  server  Build the shell-independent scope-server release binary.
  web     Build only the browser frontend and snapshot-template.html.
EOF
}

is_windows() {
  case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) return 0 ;;
  *) return 1 ;;
  esac
}

prepare_environment() {
  if is_windows && [ "${SIGNALSCOPE_WINDOWS_BUILD:-}" = 1 ]; then
    cd "$signalscope_root" || exit 1
  else
    ensure_dev_shell "$@"
  fi
}

configure_windows_signing() {
  if [ -n "${WINDOWS_CERTIFICATE:-}" ] || [ -n "${WINDOWS_CERTIFICATE_PASSWORD:-}" ]; then
    if [ -z "${WINDOWS_CERTIFICATE:-}" ] || [ -z "${WINDOWS_CERTIFICATE_PASSWORD:-}" ]; then
      echo "WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD must be set together" >&2
      return 1
    fi
    export CSC_LINK="$WINDOWS_CERTIFICATE"
    export CSC_KEY_PASSWORD="$WINDOWS_CERTIFICATE_PASSWORD"
  elif [ "${SIGNALSCOPE_REQUIRE_SIGNING:-}" = 1 ]; then
    echo "Windows signing is required but no certificate is configured" >&2
    return 1
  fi
}

configure_macos_signing() {
  local configured=0
  local name
  for name in MACOS_CERTIFICATE MACOS_CERTIFICATE_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
    if [ -n "${!name:-}" ]; then
      configured=$((configured + 1))
    fi
  done
  if [ "$configured" -ne 0 ] && [ "$configured" -ne 5 ]; then
    echo "macOS certificate and notarization credentials must be configured together" >&2
    return 1
  fi
  if [ "$configured" -eq 5 ]; then
    export CSC_LINK="$MACOS_CERTIFICATE"
    export CSC_KEY_PASSWORD="$MACOS_CERTIFICATE_PASSWORD"
    return 0
  fi
  if [ "${SIGNALSCOPE_REQUIRE_SIGNING:-}" = 1 ]; then
    echo "macOS signing is required but no credentials are configured" >&2
    return 1
  fi
  return 2
}

build_server_release() {
  if [ "$(uname -s)" = Linux ]; then
    local rust_target=x86_64-unknown-linux-gnu
    cargo zigbuild --release -p scope-server --target "$rust_target.2.35" "$@"
    SIGNALSCOPE_SERVER_BIN="target/$rust_target/release/scope-server"
    export SIGNALSCOPE_SERVER_BIN
    "$signalscope_scripts_dir/check-linux-server.sh" "$SIGNALSCOPE_SERVER_BIN"
  else
    cargo build --release -p scope-server "$@"
  fi
}

package_app() {
  local version platform arch signing_status
  local -a builder_args
  version="$("$signalscope_scripts_dir/version.sh" get)"
  case "$(uname -s)" in
  Linux)
    if [ "$(uname -m)" != x86_64 ]; then
      echo "Linux packages require an x86_64 build host" >&2
      return 1
    fi
    platform=linux
    arch=x64
    builder_args=(--linux AppImage --x64)
    ;;
  Darwin)
    if [ "$(uname -m)" != arm64 ]; then
      echo "macOS packages require an arm64 build host" >&2
      return 1
    fi
    platform=mac
    arch=arm64
    builder_args=(--mac dmg --arm64)
    signing_status=0
    configure_macos_signing || signing_status=$?
    if [ "$signing_status" -eq 1 ]; then
      return 1
    elif [ "$signing_status" -eq 0 ]; then
      builder_args+=(--config.mac.notarize=true)
    else
      export CSC_IDENTITY_AUTO_DISCOVERY=false
    fi
    ;;
  MINGW* | MSYS* | CYGWIN*)
    platform=windows
    arch=x64
    configure_windows_signing
    builder_args=(--win nsis --x64)
    ;;
  *)
    echo "desktop packaging is unsupported on $(uname -s)" >&2
    return 1
    ;;
  esac

  pnpm --filter @signalscope/frontend build
  pnpm --filter @signalscope/desktop build
  build_server_release
  node desktop/scripts/stage.mjs
  node desktop/scripts/clean.mjs --release
  pnpm --filter @signalscope/desktop exec electron-builder \
    --config electron-builder.yml "${builder_args[@]}" "$@"
  if [ "$platform" = linux ]; then
    tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
      -C build/desktop-stage -czf \
      "desktop/release/SignalScope-$version-linux-$arch-server.tar.gz" \
      bin frontend version
  fi
  node desktop/scripts/collect.mjs "$platform" "$arch" "$version"
}

case "$mode" in
app | server | web) prepare_environment "$@" ;;
esac

case "$mode" in
app)
  shift || true
  package_app "$@"
  ;;
server)
  shift || true
  build_server_release "$@"
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

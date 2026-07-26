#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="${1:-all}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/ci.sh [all|flake|format|rust|frontend|e2e|build|appimage]

Each named mode matches the GitHub Actions job with the same name:

  flake     nix flake check; includes the treefmt formatting gate.
  format    treefmt --fail-on-change (fast local shortcut for the flake gate).
  rust      cargo clippy plus the full cargo test suite.
  frontend  pnpm lint, typecheck, codegen check, unit tests, web build, and
            snapshot artifact checks.
  e2e       Playwright desktop and mobile-review smoke tests.
  build     Native Tauri bundles via ./scripts/build.sh native.
  appimage  Ubuntu-only AppImage build; runs outside the Nix shell.

`all` runs format, rust, frontend, and e2e sequentially with Cargo capped at
two jobs by default — the complete local quality gate.
EOF
}

case "$mode" in
-h | --help | help)
  show_help
  exit 0
  ;;
flake)
  exec nix flake check
  ;;
appimage)
  exec "$signalscope_scripts_dir/build-appimage.sh"
  ;;
esac

ensure_dev_shell "$@"

check_format() {
  treefmt --fail-on-change
}

check_e2e() {
  pnpm e2e
}

case "$mode" in
all)
  check_format
  rust_checks
  frontend_checks
  artifact_checks
  check_e2e
  ;;
format)
  check_format
  ;;
rust)
  rust_checks
  ;;
frontend)
  frontend_checks
  artifact_checks
  ;;
e2e)
  check_e2e
  ;;
build)
  exec "$signalscope_scripts_dir/build.sh" native
  ;;
*)
  echo "Unknown CI mode: $mode" >&2
  show_help >&2
  exit 2
  ;;
esac

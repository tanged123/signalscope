#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

show_help() {
  cat <<'EOF'
Usage: ./scripts/test.sh [quick|core|shell|unit|frontend|e2e|full]

  quick     Core Rust tests plus the shared frontend checks (default).
  core      Test Rust data-plane crates, optionally filtered.
  shell     Test the Tauri shell, optionally filtered.
  unit      Run frontend unit tests, optionally filtered.
  frontend  Run frontend lint, typecheck, codegen check, unit tests, and
            snapshot artifact checks.
  e2e       Run Playwright desktop and mobile-review smoke tests.
  full      Run quick checks, compile/test the Tauri shell, then run e2e.
EOF
}

test_core() {
  cargo test --workspace --exclude signalscope-shell -- "$@"
}

test_shell() {
  cargo test -p signalscope-shell -- "$@"
}

test_unit() {
  pnpm --filter @signalscope/frontend test -- "$@"
}

test_frontend() {
  frontend_checks
  artifact_checks
}

mode="${1:-quick}"
case "$mode" in
quick)
  test_core
  test_frontend
  ;;
core)
  shift || true
  test_core "$@"
  ;;
shell)
  shift || true
  test_shell "$@"
  ;;
unit)
  shift || true
  test_unit "$@"
  ;;
frontend)
  test_frontend
  ;;
e2e)
  bake_roundtrip_artifact
  pnpm e2e
  ;;
full)
  test_core
  test_frontend
  cargo test -p signalscope-shell
  bake_roundtrip_artifact
  pnpm e2e
  ;;
-h | --help | help)
  show_help
  ;;
*)
  echo "Unknown test mode: $mode" >&2
  show_help >&2
  exit 2
  ;;
esac

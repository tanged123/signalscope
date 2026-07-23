#!/usr/bin/env bash
set -euo pipefail

if [ -z "${IN_NIX_SHELL:-}" ]; then
  exec "$(dirname "$0")/dev.sh" "$0" "$@"
fi

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/test.sh [quick|core|frontend|e2e|full]

  quick     Core Rust tests plus frontend lint, types, tests, and snapshot
            artifact checks (default).
  core      Test Rust data-plane crates without compiling the Tauri shell.
  frontend  Run frontend lint, typecheck, unit tests, and artifact checks.
  e2e       Run Playwright desktop and mobile-review smoke tests.
  full      Run quick checks, compile/test the Tauri shell, then run e2e.
EOF
}

test_core() {
  cargo test --workspace --exclude signalscope-shell
}

test_frontend() {
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  pnpm check:artifacts
}

mode="${1:-quick}"
case "$mode" in
  quick)
    test_core
    test_frontend
    ;;
  core)
    test_core
    ;;
  frontend)
    test_frontend
    ;;
  e2e)
    pnpm e2e
    ;;
  full)
    test_core
    test_frontend
    cargo test -p signalscope-shell
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

#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="${1:-all}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/ci.sh [all|flake|format|quality|rust|frontend|e2e|bench|build]

Each named mode matches the GitHub Actions job with the same name:

  flake     nix flake check; includes the treefmt formatting gate.
  format    read-only formatting check in an isolated copy (fast local shortcut
            for the flake gate). Run ./scripts/format.sh with no arguments to fix.
  quality   Deterministic dependency, shell, workflow, spelling, and unused-code
            checks. RustSec advisory checks need network access on a cold cache.
  rust      cargo clippy plus the full cargo test suite.
  frontend  pnpm lint, typecheck, codegen check, unit tests, web build, and
            snapshot artifact checks.
  e2e       Playwright desktop smoke tests.
  bench     Full benchmark suite; writes build/bench/report.json.
  build     Official Electron package for the current operating system.

`all` runs format, quality, rust, frontend, and e2e sequentially with Cargo
capped at two jobs by default — the complete local quality gate.
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
esac

ensure_dev_shell "$@"

check_format_read_only() {
  "$signalscope_scripts_dir/format.sh" --check
}

check_e2e() {
  bake_roundtrip_artifact
  bake_bench_smoke_artifact
  build_e2e_server
  pnpm e2e
  "$signalscope_scripts_dir/server-smoke.sh"
}

case "$mode" in
all)
  check_format_read_only
  quality_checks
  rust_checks
  frontend_checks
  artifact_checks
  check_e2e
  ;;
format)
  check_format_read_only
  ;;
quality)
  quality_checks
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
bench)
  "$signalscope_scripts_dir/test.sh" bench all
  ;;
build)
  exec "$signalscope_scripts_dir/build.sh" app
  ;;
*)
  echo "Unknown CI mode: $mode" >&2
  show_help >&2
  exit 2
  ;;
esac

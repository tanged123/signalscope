#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

coverage_dir="$signalscope_root/build/coverage"

show_help() {
  cat <<'EOF'
Usage: ./scripts/coverage.sh [all|rust|frontend]

  all       Generate Rust and frontend LCOV reports (default).
  rust      Generate build/coverage/rust.lcov.
  frontend  Generate build/coverage/frontend/lcov.info.
EOF
}

coverage_rust() {
  echo "Generating Rust coverage..."
  export LLVM_COV="${LLVM_COV:-$(command -v llvm-cov)}"
  export LLVM_PROFDATA="${LLVM_PROFDATA:-$(command -v llvm-profdata)}"
  cargo llvm-cov \
    --workspace \
    --exclude signalscope-shell \
    --lcov \
    --output-path "$coverage_dir/rust.lcov"
}

coverage_frontend() {
  echo "Generating frontend coverage..."
  pnpm --filter @signalscope/frontend test:coverage
  SIGNALSCOPE_COVERAGE=1 pnpm e2e
  (
    cd "$signalscope_root/frontend"
    node scripts/merge-coverage.mjs
  )
}

mkdir -p "$coverage_dir"

mode="${1:-all}"
case "$mode" in
all)
  coverage_rust
  coverage_frontend
  ;;
rust)
  coverage_rust
  ;;
frontend)
  coverage_frontend
  ;;
-h | --help | help)
  show_help
  exit 0
  ;;
*)
  echo "Unknown coverage mode: $mode" >&2
  show_help >&2
  exit 2
  ;;
esac

echo "Coverage reports are available under build/coverage."

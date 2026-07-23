#!/usr/bin/env bash
set -euo pipefail

if [ -z "${IN_NIX_SHELL:-}" ]; then
  exec "$(dirname "$0")/dev.sh" "$0" "$@"
fi

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
coverage_dir="$project_root/build/coverage"

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
}

mkdir -p "$coverage_dir"
cd "$project_root"

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

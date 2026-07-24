#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
mode="${1:-all}"

if [ "$mode" = "flake" ]; then
  exec nix flake check
fi

if [ "$mode" = "appimage" ]; then
  exec "$project_root/scripts/build.sh" appimage
fi

if [ -z "${IN_NIX_SHELL:-}" ]; then
  exec "$(dirname "$0")/dev.sh" "$0" "$@"
fi

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/ci.sh [all|flake|format|lint|typecheck|clippy|unit|e2e|build|appimage|artifacts]

Each mode matches the GitHub Actions job with the same name. `all` runs every
local quality gate sequentially, with Cargo capped at two jobs by default.
The Ubuntu-only `appimage` mode runs outside the Nix development shell.
EOF
}

check_format() {
  treefmt --fail-on-change
}

check_lint() {
  cargo fmt --all --check
  pnpm lint
}

check_typecheck() {
  pnpm typecheck
  pnpm codegen:check
}

check_clippy() {
  cargo clippy --workspace --all-targets -- -D warnings
}

check_unit() {
  cargo test --workspace
  pnpm test
}

check_e2e() {
  pnpm e2e
}

check_build() {
  "$project_root/scripts/build.sh" native
}

check_artifacts() {
  "$project_root/scripts/build.sh" web
  pnpm check:artifacts
}

cd "$project_root"

case "$mode" in
  all)
    check_format
    check_lint
    check_typecheck
    check_clippy
    check_unit
    check_e2e
    check_artifacts
    ;;
  format)
    check_format
    ;;
  lint)
    check_lint
    ;;
  typecheck)
    check_typecheck
    ;;
  clippy)
    check_clippy
    ;;
  unit)
    check_unit
    ;;
  e2e)
    check_e2e
    ;;
  build)
    check_build
    ;;
  artifacts)
    check_artifacts
    ;;
  -h | --help | help)
    show_help
    ;;
  *)
    echo "Unknown CI mode: $mode" >&2
    show_help >&2
    exit 2
    ;;
esac

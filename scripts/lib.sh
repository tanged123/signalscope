#!/usr/bin/env bash
# Shared helpers for the ./scripts entry points. Source this file; do not run it.

signalscope_scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
signalscope_root="$(cd "$signalscope_scripts_dir/.." && pwd)"

# Re-exec the calling script inside the Nix dev shell when invoked outside it,
# then apply the defaults every wrapper relies on.
ensure_dev_shell() {
  if [ -z "${IN_NIX_SHELL:-}" ]; then
    exec "$signalscope_scripts_dir/dev.sh" "$0" "$@"
  fi
  # Keep local machines responsive; let CI runners use every core.
  if [ -z "${CI:-}" ]; then
    export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
  fi
  cd "$signalscope_root" || exit 1
}

# Check groups shared by ci.sh and test.sh so local test runs and CI gates
# cannot drift apart.
frontend_checks() {
  pnpm lint
  pnpm typecheck
  pnpm codegen:check
  pnpm test
}

artifact_checks() {
  "$signalscope_scripts_dir/build.sh" web
  pnpm check:artifacts
}

rust_checks() {
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace
}

quality_checks() {
  shellcheck scripts/*.sh .github/hooks/pre-commit
  actionlint
  typos
  cargo deny check
  cargo machete
  pnpm --filter @signalscope/frontend check:unused
  zizmor .github/workflows/ .github/actions/
}

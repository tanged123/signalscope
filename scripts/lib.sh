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
# Type checking runs once inside artifact_checks' build (tsc --noEmit &&
# vite build); every gate that runs frontend_checks also runs artifact_checks.
frontend_checks() {
  pnpm lint
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
  "$signalscope_scripts_dir/chartgpu-submodule.test.sh"
  "$signalscope_scripts_dir/ci-policy.test.sh"
  node "$signalscope_scripts_dir/generate-monte-carlo-demo.mjs" --check
  actionlint
  typos
  cargo deny check
  cargo machete
  pnpm --filter @signalscope/frontend check:deps
  pnpm --filter @signalscope/frontend check:unused
  zizmor .github/workflows/ .github/actions/
}

bake_roundtrip_artifact() {
  "$signalscope_scripts_dir/export.sh" \
    --data frontend/tests/e2e/fixtures/roundtrip.csv \
    --workspace frontend/tests/e2e/fixtures/roundtrip.signalscope \
    --range all \
    --fidelity preview \
    --out build/export/roundtrip-preview.html
  "$signalscope_scripts_dir/export.sh" \
    --no-build \
    --data frontend/tests/e2e/fixtures/roundtrip.csv \
    --workspace frontend/tests/e2e/fixtures/roundtrip.signalscope \
    --range all \
    --fidelity full \
    --out build/export/roundtrip-full.html
}

bake_bench_smoke_artifact() {
  local -a data_args=()
  local file out="$signalscope_root/build/bench/smoke.html" max_bytes=268435456 bytes
  for file in "$signalscope_root"/examples/monte_carlo/run_*.csv; do
    data_args+=(--data "$file")
  done
  "$signalscope_scripts_dir/export.sh" --no-build "${data_args[@]}" \
    --workspace "$signalscope_root/examples/bench/smoke.workspace.json" \
    --range all --fidelity full --out "$out"
  bytes=$(stat -c %s "$out")
  if [ "$bytes" -gt "$max_bytes" ]; then
    echo "baked smoke snapshot is $bytes bytes (limit $max_bytes)" >&2
    return 1
  fi
}

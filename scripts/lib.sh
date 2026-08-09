#!/usr/bin/env bash
# Shared helpers for the ./scripts entry points. Source this file; do not run it.

signalscope_scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
signalscope_root="$(cd "$signalscope_scripts_dir/.." && pwd)"

# Re-exec the calling script inside the Nix dev shell when invoked outside it,
# then apply the defaults every wrapper relies on.
ensure_dev_shell() {
  if [ "${SIGNALSCOPE_DEV_SHELL_READY:-}" != 1 ]; then
    exec "$signalscope_scripts_dir/dev.sh" "$0" "$@"
  fi
  # Keep local machines responsive; let CI runners use every core.
  if [ -z "${CI:-}" ]; then
    export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
  fi
  cd "$signalscope_root" || exit 1
}

wait_for_port() {
  local port="$1"
  local attempts=100
  while [ "$attempts" -gt 0 ]; do
    if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 0.1
  done
  echo "timed out waiting for 127.0.0.1:$port" >&2
  return 1
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
  "$signalscope_scripts_dir/test.sh" host
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace
}

live_host_deletion_check() {
  local matches
  matches=$(rg -n -i \
    'shell/src-tauri|TauriPlane|__TAURI_INTERNALS__|cargo tauri|@tauri-apps|tauri-build|tauri-plugin|webkit2gtk|WebKitGTK' \
    .github AGENTS.md CLAUDE.md README.md Cargo.toml Cargo.lock flake.nix \
    package.json pnpm-workspace.yaml frontend host core protocol desktop scripts \
    --glob '!target/**' --glob '!node_modules/**' --glob '!**/node_modules/**' \
    --glob '!build/**' --glob '!desktop/release/**' --glob '!scripts/lib.sh' || true)
  if [ -n "$matches" ]; then
    printf '%s\n' "$matches" >&2
    return 1
  fi
}

quality_checks() {
  shellcheck scripts/*.sh .github/hooks/pre-commit
  "$signalscope_scripts_dir/ci-policy.test.sh"
  live_host_deletion_check
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

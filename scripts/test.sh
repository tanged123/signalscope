#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

show_help() {
  cat <<'EOF'
Usage: ./scripts/test.sh [quick|core|shell|unit|frontend|e2e|gpu|bench|full]

  quick     Core Rust tests plus the shared frontend checks (default).
  core      Test Rust data-plane crates, optionally filtered.
  shell     Test the Tauri shell, optionally filtered.
  unit      Run frontend unit tests, optionally filtered.
  frontend  Run frontend lint, typecheck, codegen check, unit tests, and
            snapshot artifact checks.
  e2e       Run Playwright desktop/mobile smoke tests and the GPU proof.
  gpu       Run WebGPU software-adapter fidelity tests.
  bench     Run corpus, core, and Playwright performance benchmarks.
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

bench_e2e_tier() {
  local tier="$1"
  local corpus_dir="$signalscope_root/build/bench/corpus/$tier"
  if [ ! -f "$corpus_dir/manifest.json" ]; then
    cargo test --release -p scope-core -- --ignored --test-threads=1 "bench_corpus_$tier"
  fi
  local -a data_args=()
  local file selected=0
  # Full corpus by default so the browser bench proves 1000 sources; PR smoke
  # jobs pass SIGNALSCOPE_BENCH_FILES=2 to stay bounded.
  local browser_files="${SIGNALSCOPE_BENCH_FILES:-1000}"
  if [ "$tier" = dense10k ]; then
    browser_files="${SIGNALSCOPE_BENCH_DENSE10K_FILES:-10000}"
  fi
  for file in "$corpus_dir"/run_*.csv; do
    if [ "$selected" -eq "$browser_files" ]; then
      break
    fi
    data_args+=(--data "$file")
    selected=$((selected + 1))
  done
  [ "$selected" -eq "$browser_files" ]
  local out="$signalscope_root/build/bench/$tier.html"
  local max_bytes="${SIGNALSCOPE_BENCH_MAX_BYTES:-1073741824}"
  local fidelity=preview started elapsed bytes
  started=$SECONDS
  "$signalscope_scripts_dir/export.sh" "${data_args[@]}" \
    --workspace "$signalscope_root/examples/bench/$tier.workspace.json" \
    --range visible --fidelity "$fidelity" --out "$out"
  elapsed=$((SECONDS - started))
  bytes=$(stat -c %s "$out")
  if [ "$bytes" -gt "$max_bytes" ]; then
    echo "baked snapshot is $bytes bytes (limit $max_bytes)" >&2
    exit 1
  fi
  mkdir -p "$signalscope_root/build/bench/report"
  printf '{ "bench": "bake", "seconds": %d, "bytes": %d, "fidelity": "%s", "input_files": %d }\n' \
    "$elapsed" "$bytes" "$fidelity" "$selected" >"$signalscope_root/build/bench/report/bake.json"
  SIGNALSCOPE_BENCH=1 SIGNALSCOPE_BENCH_TIER="$tier" pnpm --filter @signalscope/frontend bench
}

bench_e2e() {
  local tier="${SIGNALSCOPE_BENCH_TIER:-mc1000}"
  if [ "$tier" = all ]; then
    bench_e2e_tier mc1000
    bench_e2e_tier dense10k
  else
    bench_e2e_tier "$tier"
  fi
}

bench_all_exit() {
  local bench_status=$?
  local collect_status=0
  node "$signalscope_scripts_dir/collect-bench-report.mjs" || collect_status=$?
  trap - EXIT
  if [ "$bench_status" -ne 0 ]; then
    exit "$bench_status"
  fi
  exit "$collect_status"
}

bench_all() {
  trap bench_all_exit EXIT
  local core_status=0
  local e2e_status=0
  # Keep collecting browser evidence when a known core floor fails.
  if cargo test --release -p scope-core -- --ignored --show-output --test-threads=1 bench_; then
    :
  else
    core_status=$?
  fi
  if bench_e2e; then
    :
  else
    e2e_status=$?
  fi
  if [ "$core_status" -ne 0 ]; then
    return "$core_status"
  fi
  return "$e2e_status"
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
  bake_bench_smoke_artifact
  pnpm e2e
  bake_bench_smoke_artifact
  pnpm --filter @signalscope/frontend exec playwright test --project=gpu
  ;;
gpu)
  shift || true
  bake_bench_smoke_artifact
  pnpm --filter @signalscope/frontend exec playwright test --project=gpu "$@"
  ;;
bench)
  bench_mode="${2:-all}"
  case "$bench_mode" in
  corpus)
    cargo test --release -p scope-core -- corpus
    cargo test --release -p scope-core -- --ignored --show-output --test-threads=1 bench_corpus_
    ;;
  core)
    cargo test --release -p scope-core -- --ignored --show-output --test-threads=1 bench_
    ;;
  e2e)
    bench_e2e
    ;;
  all)
    bench_all
    ;;
  *)
    echo "unknown bench mode: $bench_mode" >&2
    exit 2
    ;;
  esac
  ;;
full)
  test_core
  test_frontend
  cargo test -p signalscope-shell
  bake_roundtrip_artifact
  bake_bench_smoke_artifact
  pnpm e2e
  bake_bench_smoke_artifact
  pnpm --filter @signalscope/frontend exec playwright test --project=gpu
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

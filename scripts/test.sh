#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [ "${SIGNALSCOPE_WINDOWS_BUILD:-}" = 1 ] &&
  [ "${1:-}" = desktop ] && [ "${2:-}" = package ]; then
  cd "$signalscope_root" || exit 1
else
  ensure_dev_shell "$@"
fi

show_help() {
  cat <<'EOF'
Usage: ./scripts/test.sh [quick|core|host|desktop|policy|unit|frontend|e2e|native-e2e|gpu|bench|full]

  quick     Core Rust tests plus the shared frontend checks (default).
  core      Test Rust data-plane crates, optionally filtered.
  host      Test the shell-independent Rust host and server, optionally filtered.
  desktop   Test the Electron desktop package, optionally filtered.
  policy    Test CI and release policy invariants.
  unit      Run frontend unit tests, optionally filtered.
  frontend  Run frontend lint, typecheck, codegen check, unit tests, and
            snapshot artifact checks.
  e2e       Run browser Playwright E2E only; use native-e2e for Electron.
  gpu       Run WebGPU software-adapter fidelity tests.
  bench     Run corpus, core, browser, or software-adapter benchmarks.
  full      Run quick, desktop, browser E2E, GPU, and native E2E checks.
EOF
}

test_core() {
  cargo test --workspace -- "$@"
}

test_host() {
  cargo test -p scope-host -p scope-server -- "$@"
}

test_desktop() {
  if [ "${1:-}" = package ]; then
    shift
    if [ "${1:-}" != --no-build ]; then
      "$signalscope_scripts_dir/build.sh" native --dir
    else
      shift
    fi
    local packaged_bin
    local package_platform
    case "$(uname -s)" in
    Linux*) package_platform=linux ;;
    Darwin*) package_platform=darwin ;;
    MINGW* | MSYS* | CYGWIN*) package_platform=win32 ;;
    *) package_platform=unknown ;;
    esac
    packaged_bin=$(node "$signalscope_root/desktop/scripts/package-paths.mjs" \
      "$signalscope_root/desktop/release" executable)
    SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER=none \
      SIGNALSCOPE_PACKAGED_BIN="$packaged_bin" \
      SIGNALSCOPE_PACKAGE_PLATFORM="$package_platform" \
      pnpm --filter @signalscope/frontend exec playwright test \
      --project=electron-packaged "$@"
    return
  fi
  pnpm --filter @signalscope/desktop test -- "$@"
}

test_native_e2e() {
  if [ -z "${SIGNALSCOPE_ELECTRON_BIN:-}" ]; then
    echo "SIGNALSCOPE_ELECTRON_BIN is not configured; enter the Nix dev shell" >&2
    return 1
  fi
  "$signalscope_scripts_dir/build.sh" host
  pnpm --filter @signalscope/frontend build
  pnpm --filter @signalscope/desktop build
  run_gui_command env \
    SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER=managed \
    SIGNALSCOPE_HOST_BIN="$signalscope_root/target/debug/signalscope-host" \
    NODE_ENV=development SIGNALSCOPE_BENCH=1 SIGNALSCOPE_GPU_MODE=software \
    pnpm --filter @signalscope/frontend exec playwright test --project=electron-native "$@"
}

test_unit() {
  pnpm --filter @signalscope/frontend test -- "$@"
}

test_frontend() {
  frontend_checks
  artifact_checks
}

bench_e2e() {
  rm -f "$signalscope_root/build/bench/report/electron-hardware.json"
  "$signalscope_scripts_dir/build.sh" native --dir

  local requested_tier="${SIGNALSCOPE_BENCH_TIER:-all}"
  local -a tiers=(mc1000 dense10k)
  if [ "$requested_tier" != all ]; then tiers=("$requested_tier"); fi
  local tier corpus_dir packaged_bin package_platform
  case "$(uname -s)" in
  Linux*) package_platform=linux ;;
  Darwin*) package_platform=darwin ;;
  MINGW* | MSYS* | CYGWIN*) package_platform=win32 ;;
  *) package_platform=unknown ;;
  esac
  packaged_bin=$(node "$signalscope_root/desktop/scripts/package-paths.mjs" \
    "$signalscope_root/desktop/release" executable)
  export SIGNALSCOPE_BENCH_REQUESTED_TIERS="$requested_tier"
  for tier in "${tiers[@]}"; do
    corpus_dir="$signalscope_root/build/bench/corpus/$tier"
    if [ ! -f "$corpus_dir/manifest.json" ]; then
      cargo test --release -p scope-core -- --ignored --test-threads=1 "bench_corpus_$tier"
    fi
    SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER=none \
      SIGNALSCOPE_PACKAGED_BIN="$packaged_bin" \
      SIGNALSCOPE_PACKAGE_PLATFORM="$package_platform" \
      SIGNALSCOPE_BENCH_TIER="$tier" \
      SIGNALSCOPE_BENCH_CORPUS_DIR="$corpus_dir" \
      pnpm --filter @signalscope/frontend exec playwright test \
      --project=electron-hardware
  done
}

bench_software() {
  rm -f "$signalscope_root/build/bench/report/electron-hardware.json"
  rm -f "$signalscope_root"/build/bench/report/e2e_*.json
  bake_bench_smoke_artifact
  SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER=managed SIGNALSCOPE_BENCH=1 \
    pnpm --filter @signalscope/frontend exec playwright test \
    --project=bench-software
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

bench_e2e_exit() {
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
  rm -f "$signalscope_root/build/bench/report/electron-hardware.json"
  local core_status=0
  local software_status=0
  # Scheduled CI has no hardware authority; keep its software proof bounded.
  if cargo test --release -p scope-core -- --ignored --show-output --test-threads=1 bench_; then
    :
  else
    core_status=$?
  fi
  if bench_software; then
    :
  else
    software_status=$?
  fi
  if [ "$core_status" -ne 0 ]; then
    return "$core_status"
  fi
  return "$software_status"
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
host)
  shift || true
  test_host "$@"
  ;;
desktop)
  shift || true
  test_desktop "$@"
  ;;
policy)
  "$signalscope_scripts_dir/ci-policy.test.sh"
  ;;
native-e2e)
  shift || true
  test_native_e2e "$@"
  ;;
unit)
  shift || true
  test_unit "$@"
  ;;
frontend)
  test_frontend
  ;;
e2e)
  shift || true
  bake_roundtrip_artifact
  bake_bench_smoke_artifact
  SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER=managed pnpm e2e -- "$@"
  ;;
gpu)
  shift || true
  bake_bench_smoke_artifact
  SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER=managed \
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
    trap bench_e2e_exit EXIT
    bench_e2e
    ;;
  software)
    bench_software
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
  test_desktop
  bake_roundtrip_artifact
  bake_bench_smoke_artifact
  SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER=managed pnpm e2e
  bake_bench_smoke_artifact
  SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER=managed \
    pnpm --filter @signalscope/frontend exec playwright test --project=gpu
  test_native_e2e
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

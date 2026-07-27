#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failures=0

expect_status() {
  local expected="$1"
  shift
  local actual=0

  "$@" >/dev/null 2>&1 || actual=$?
  if [ "$actual" -ne "$expected" ]; then
    printf 'expected exit %s, got %s: %s\n' "$expected" "$actual" "$*" >&2
    failures=$((failures + 1))
  fi
}

check_ci_results() {
  env NEEDS_JSON="$1" "$script_dir/check-ci-results.sh"
}

expect_status 0 check_ci_results '{"version":{"result":"success"},"flake":{"result":"success"}}'
expect_status 0 check_ci_results '{"version":{"result":"success"},"flake":{"result":"skipped"}}'
expect_status 1 check_ci_results '{"version":{"result":"success"},"flake":{"result":"failure"}}'
expect_status 1 check_ci_results '{"version":{"result":"cancelled"},"flake":{"result":"success"}}'
expect_status 1 check_ci_results ''

asset_dir="$(mktemp -d)"
trap 'rmdir "$asset_dir"' EXIT
expect_status 2 env GH_TOKEN=test \
  "$script_dir/release.sh" publish v1.2.3-trailing "$asset_dir"

if [ "$failures" -ne 0 ]; then
  exit 1
fi

echo "CI policy tests passed."

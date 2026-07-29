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
trap 'rm -rf "$asset_dir" ${windows_asset_dir:+"$windows_asset_dir"}' EXIT
expect_status 2 env GH_TOKEN=test \
  "$script_dir/release.sh" publish v1.2.3-trailing "$asset_dir"

windows_asset_dir="$(mktemp -d)"
: >"$windows_asset_dir/SignalScope_0.3.3_x64-setup.exe"
: >"$windows_asset_dir/signalscope-shell.exe"
listed="$("$script_dir/release.sh" assets "$windows_asset_dir" | tr -d '\0')"
if [ "$listed" != "$windows_asset_dir/SignalScope_0.3.3_x64-setup.exe" ]; then
  printf 'release assets must list the NSIS installer and nothing else, got: %s\n' "$listed" >&2
  failures=$((failures + 1))
fi

# The Windows installer script must refuse to run anywhere but Windows.
case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*) ;;
*) expect_status 1 "$script_dir/build-windows.sh" ;;
esac

if [ "$failures" -ne 0 ]; then
  exit 1
fi

echo "CI policy tests passed."

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

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

asset_dir="$test_root/empty-assets"
mkdir -p "$asset_dir"
expect_status 2 env GH_TOKEN=test \
  "$script_dir/release.sh" publish v1.2.3-trailing "$asset_dir"
expect_status 2 "$script_dir/demo.sh" publish

incomplete_demo_dir="$test_root/incomplete-demo"
mkdir -p "$incomplete_demo_dir"
: >"$incomplete_demo_dir/demo.html"
expect_status 1 "$script_dir/demo.sh" publish "$incomplete_demo_dir"

windows_asset_dir="$test_root/windows-assets"
mkdir -p "$windows_asset_dir"
: >"$windows_asset_dir/SignalScope_0.3.3_x64-setup.exe"
: >"$windows_asset_dir/signalscope-shell.exe"
listed="$("$script_dir/release.sh" assets "$windows_asset_dir" | tr -d '\0')"
if [ "$listed" != "$windows_asset_dir/SignalScope_0.3.3_x64-setup.exe" ]; then
  printf 'release assets must list the NSIS installer and nothing else, got: %s\n' "$listed" >&2
  failures=$((failures + 1))
fi

# `publish` forwards whatever assets() discovers to `gh release create`. Stub gh
# so that hand-off is covered without a token or network access.
publish_dir="$test_root/publish-assets"
stub_dir="$test_root/stub-bin"
mkdir -p "$publish_dir" "$stub_dir"
: >"$publish_dir/signalscope_1.2.3_amd64.deb"
: >"$publish_dir/SignalScope_1.2.3_x64-setup.exe"
: >"$publish_dir/signalscope-shell.exe"
: >"$publish_dir/latest.json"

cat >"$stub_dir/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$GH_STUB_ARGS"
STUB
chmod +x "$stub_dir/gh"

PATH="$stub_dir:$PATH" GH_TOKEN=test GH_STUB_ARGS="$test_root/gh-args" \
  "$script_dir/release.sh" publish v1.2.3 "$publish_dir"

published="$(sed -n "s|^$publish_dir/||p" "$test_root/gh-args" | LC_ALL=C sort | tr '\n' ' ')"
if [ "$published" != "SignalScope_1.2.3_x64-setup.exe signalscope_1.2.3_amd64.deb " ]; then
  printf 'publish must forward only publishable assets, got: %s\n' "$published" >&2
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

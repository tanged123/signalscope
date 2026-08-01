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

readme="$script_dir/../README.md"
if ! grep -q '^## Interactive demo$' "$readme"; then
  echo "README must give the hosted demo its own section" >&2
  failures=$((failures + 1))
fi
if ! grep -Eq '!\[SignalScope interactive demo\]\(https://tanged123\.github\.io/signalscope/demo\.gif\?v=[0-9]+\.[0-9]+\.[0-9]+\)' "$readme"; then
  echo "README must embed the release-generated demo GIF" >&2
  failures=$((failures + 1))
fi
if ! grep -Fq '[Open the interactive HTML snapshot](https://tanged123.github.io/signalscope/demo.html)' "$readme"; then
  echo "README must link directly to the interactive HTML snapshot" >&2
  failures=$((failures + 1))
fi

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

version_root="$test_root/version"
mkdir -p \
  "$version_root/core" \
  "$version_root/frontend/src/ui" \
  "$version_root/scripts" \
  "$version_root/shell/src-tauri"
cp "$script_dir/version.mjs" "$version_root/scripts/version.mjs"
cat >"$version_root/Cargo.toml" <<'EOF'
[workspace]
members = ["core"]

[workspace.package]
version = "1.2.3"

[workspace.dependencies]
core = { path = "core", version = "1.2.3" }
EOF
cat >"$version_root/core/Cargo.toml" <<'EOF'
[package]
name = "core"
EOF
cat >"$version_root/Cargo.lock" <<'EOF'
[[package]]
name = "core"
version = "1.2.3"
EOF
printf '{"version":"1.2.3"}\n' >"$version_root/frontend/package.json"
printf '{"version":"1.2.3"}\n' >"$version_root/shell/src-tauri/tauri.conf.json"
printf 'showModeHelp("SignalScope 1.2.3")\n' >"$version_root/frontend/src/ui/app-shell.ts"
cat >"$version_root/README.md" <<'EOF'
[![SignalScope interactive demo](https://tanged123.github.io/signalscope/demo.gif?v=1.2.2)](https://tanged123.github.io/signalscope/demo.html)
EOF
expect_status 1 node "$version_root/scripts/version.mjs" check
expect_status 0 node "$version_root/scripts/version.mjs" set 2.0.0
if ! grep -Fq 'demo.gif?v=2.0.0' "$version_root/README.md"; then
  echo "version set must update the README demo cache key" >&2
  failures=$((failures + 1))
fi

asset_dir="$test_root/empty-assets"
mkdir -p "$asset_dir"
expect_status 2 env GH_TOKEN=test \
  "$script_dir/release.sh" publish v1.2.3-trailing "$asset_dir"
expect_status 2 "$script_dir/demo.sh" publish

incomplete_demo_dir="$test_root/incomplete-demo"
mkdir -p "$incomplete_demo_dir"
: >"$incomplete_demo_dir/demo.html"
expect_status 1 "$script_dir/demo.sh" publish "$incomplete_demo_dir"

complete_demo_dir="$test_root/complete-demo"
stub_dir="$test_root/stub-bin"
mkdir -p "$complete_demo_dir" "$stub_dir"
: >"$complete_demo_dir/demo.html"
: >"$complete_demo_dir/demo.gif"

real_git="$(command -v git)"
cat >"$stub_dir/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "config" ] &&
  [ "${2:-}" = "--get-regexp" ] &&
  [ "${3:-}" = '^http\..*\.extraheader$' ]; then
  printf '%s\n' \
    'http.https://github.com/.extraheader AUTHORIZATION: basic test'
  exit 0
fi

if [ "$1" = "-C" ] && [ "${3:-}" = "push" ]; then
  "$REAL_GIT" -C "$2" config --get-all \
    http.https://github.com/.extraheader >"$DEMO_AUTH_CAPTURE" || true
  exit "${DEMO_PUSH_STATUS:-0}"
fi

exec "$REAL_GIT" "$@"
STUB
chmod +x "$stub_dir/git"

auth_capture="$test_root/demo-auth"
PATH="$stub_dir:$PATH" REAL_GIT="$real_git" DEMO_AUTH_CAPTURE="$auth_capture" \
  "$script_dir/demo.sh" publish "$complete_demo_dir"
if [ "$(cat "$auth_capture")" != "AUTHORIZATION: basic test" ]; then
  echo "demo publish must forward the checkout authentication header" >&2
  failures=$((failures + 1))
fi

failed_push_output="$test_root/demo-failed-push"
actual=0
PATH="$stub_dir:$PATH" REAL_GIT="$real_git" \
  DEMO_AUTH_CAPTURE="$auth_capture" DEMO_PUSH_STATUS=1 \
  "$script_dir/demo.sh" publish "$complete_demo_dir" \
  >"$failed_push_output" 2>&1 || actual=$?
if [ "$actual" -ne 1 ]; then
  echo "demo publish must return a failed push's status" >&2
  failures=$((failures + 1))
fi
if grep -q "unbound variable" "$failed_push_output"; then
  echo "demo publish cleanup must retain its temporary path" >&2
  failures=$((failures + 1))
fi

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

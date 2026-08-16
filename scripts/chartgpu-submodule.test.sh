#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

git_config() {
  git -C "$1" config user.name "SignalScope test"
  git -C "$1" config user.email "signalscope-test@example.invalid"
}

expect_status() {
  local expected="$1"
  shift
  local actual=0
  "$@" >/dev/null 2>&1 || actual=$?
  [ "$actual" -eq "$expected" ] || {
    printf 'expected exit %s, got %s: %s\n' "$expected" "$actual" "$*" >&2
    exit 1
  }
}

upstream="$test_root/upstream"
parent="$test_root/parent"
checkout="$test_root/checkout"

git init --quiet "$upstream"
git_config "$upstream"
mkdir -p "$upstream/src"
printf 'export const revision = 1;\n' >"$upstream/src/index.ts"
git -C "$upstream" add src/index.ts
git -C "$upstream" commit --quiet -m "first"
first_revision="$(git -C "$upstream" rev-parse HEAD)"
printf 'export const revision = 2;\n' >"$upstream/src/index.ts"
git -C "$upstream" commit --quiet -am "second"
second_revision="$(git -C "$upstream" rev-parse HEAD)"

git init --quiet "$parent"
git_config "$parent"
mkdir -p "$parent/scripts"
cp "$script_dir/chartgpu-submodule.sh" "$parent/scripts/"
git -C "$parent" add scripts/chartgpu-submodule.sh
git -C "$parent" commit --quiet -m "add script"
git -C "$parent" -c protocol.file.allow=always submodule add --quiet \
  "$upstream" frontend/vendor/chartgpu
git -C "$parent/frontend/vendor/chartgpu" checkout --quiet --detach "$first_revision"
git -C "$parent" add .gitmodules frontend/vendor/chartgpu
git -C "$parent" commit --quiet -m "pin submodule"

git clone --quiet --no-recurse-submodules "$parent" "$checkout"

expect_status 1 "$checkout/scripts/chartgpu-submodule.sh" check
uninitialized_output="$test_root/uninitialized-output"
"$checkout/scripts/chartgpu-submodule.sh" check >"$uninitialized_output" 2>&1 || true
grep -Fq "run ./scripts/chartgpu-submodule.sh init" "$uninitialized_output"
env GIT_ALLOW_PROTOCOL=file "$checkout/scripts/chartgpu-submodule.sh" init >/dev/null
[ "$(git -C "$checkout/frontend/vendor/chartgpu" rev-parse HEAD)" = "$first_revision" ]
"$checkout/scripts/chartgpu-submodule.sh" check

env GIT_ALLOW_PROTOCOL=file \
  "$checkout/scripts/chartgpu-submodule.sh" update "$second_revision" >/dev/null
[ "$(git -C "$checkout/frontend/vendor/chartgpu" rev-parse HEAD)" = "$second_revision" ]
expect_status 1 "$checkout/scripts/chartgpu-submodule.sh" check
mismatch_output="$test_root/mismatch-output"
"$checkout/scripts/chartgpu-submodule.sh" check >"$mismatch_output" 2>&1 || true
grep -Fq "expected $first_revision" "$mismatch_output"
grep -Fq "run ./scripts/chartgpu-submodule.sh init" "$mismatch_output"
git -C "$checkout" diff --quiet -- frontend/vendor/chartgpu && {
  echo "update must leave a reviewable gitlink change" >&2
  exit 1
}

env GIT_ALLOW_PROTOCOL=file "$checkout/scripts/chartgpu-submodule.sh" init >/dev/null
"$checkout/scripts/chartgpu-submodule.sh" check

echo "ChartGPU submodule tests passed."

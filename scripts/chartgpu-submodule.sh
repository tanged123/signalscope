#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
submodule_path="frontend/vendor/chartgpu"

cd "$project_root"

usage() {
  cat <<'EOF'
Usage: ./scripts/chartgpu-submodule.sh [init|check|update <revision>]

  init               initialize and check out the recorded ChartGPU revision
  check              verify the initialized checkout matches the gitlink
  update <revision>  fetch and check out a new revision for parent-repo review
EOF
}

recorded_revision() {
  git ls-files --stage -- "$submodule_path" |
    awk '$1 == "160000" { print $2; exit }'
}

check_submodule() {
  local expected actual
  expected="$(recorded_revision)"
  [ -n "$expected" ] || {
    echo "$submodule_path is not recorded as a Git submodule" >&2
    return 1
  }
  [ -e "$submodule_path/.git" ] || {
    echo "$submodule_path is not initialized; run ./scripts/chartgpu-submodule.sh init" >&2
    return 1
  }
  actual="$(git -C "$submodule_path" rev-parse HEAD)"
  [ "$actual" = "$expected" ] || {
    printf '%s is at %s; expected %s\n' "$submodule_path" "$actual" "$expected" >&2
    echo "run ./scripts/chartgpu-submodule.sh init to restore the recorded revision" >&2
    return 1
  }
}

mode="${1:-init}"
case "$mode" in
init)
  [ "$#" -eq 1 ] || {
    usage >&2
    exit 2
  }
  git submodule sync -- "$submodule_path"
  git submodule update --init --checkout -- "$submodule_path"
  check_submodule
  ;;
check)
  [ "$#" -eq 1 ] || {
    usage >&2
    exit 2
  }
  check_submodule
  ;;
update)
  [ "$#" -eq 2 ] || {
    usage >&2
    exit 2
  }
  revision="$2"
  git submodule sync -- "$submodule_path"
  git submodule update --init --checkout -- "$submodule_path"
  git -C "$submodule_path" fetch origin
  resolved="$(git -C "$submodule_path" rev-parse --verify "$revision^{commit}")"
  git -C "$submodule_path" checkout --detach "$resolved"
  printf 'ChartGPU updated to %s; review and stage %s\n' "$resolved" "$submodule_path"
  ;;
-h | --help | help)
  usage
  ;;
*)
  echo "unknown ChartGPU submodule command: $mode" >&2
  usage >&2
  exit 2
  ;;
esac

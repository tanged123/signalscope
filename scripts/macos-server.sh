#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ] || [[ $1 != prepare && $1 != check ]] || [ ! -f "$2" ]; then
  echo "usage: ./scripts/macos-server.sh <prepare|check> <scope-server>" >&2
  exit 2
fi

mode="$1"
binary="$2"
libraries="$(otool -L "$binary" | sed -n 's/^[[:space:]]*\(.*\) (compatibility version .*$/\1/p')"
rpaths="$(otool -l "$binary" | awk '
  $1 == "cmd" { rpath = ($2 == "LC_RPATH") }
  rpath && $1 == "path" {
    sub(/^[[:space:]]*path /, "")
    sub(/ \(offset [0-9]+\)$/, "")
    print
  }
')"
if [ -z "$libraries" ]; then
  echo "macOS scope-server has no readable runtime dependencies: $binary" >&2
  exit 1
fi

changes=()
while IFS= read -r library; do
  # The pinned Nix package builds Apple's libiconv, with the system ABI.
  if [ "$mode" = prepare ] &&
    [[ $library == /nix/store/*-libiconv-115.100.1/lib/libiconv.2.dylib ]]; then
    changes+=(-change "$library" /usr/lib/libiconv.2.dylib)
    continue
  fi
  case "$library" in
  /usr/lib/* | /System/Library/*) ;;
  *)
    echo "macOS scope-server has non-system runtime dependency: $library" >&2
    exit 1
    ;;
  esac
done <<<"$libraries"

while IFS= read -r rpath; do
  if [ "$mode" = prepare ] && [[ $rpath == /nix/store/* ]]; then
    changes+=(-delete_rpath "$rpath")
    continue
  fi
  case "$rpath" in
  "" | /usr/lib/* | /System/Library/*) ;;
  *)
    echo "macOS scope-server has non-system runtime search path: $rpath" >&2
    exit 1
    ;;
  esac
done <<<"$rpaths"

if [ "${#changes[@]}" -gt 0 ]; then
  install_name_tool "${changes[@]}" "$binary"
  "$0" check "$binary"
  # Editing Mach-O load commands invalidates the arm64 linker signature.
  codesign --force --sign - "$binary"
  codesign --verify --strict "$binary"
fi

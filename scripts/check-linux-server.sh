#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: ./scripts/check-linux-server.sh <scope-server>" >&2
  exit 2
fi

binary="$1"
failures=0
while IFS= read -r library; do
  case "$library" in
  ld-linux-x86-64.so.2 | libc.so.6 | libdl.so.2 | libgcc_s.so.1 | libm.so.6 | libpthread.so.0 | librt.so.1) ;;
  *)
    echo "Linux scope-server has non-baseline runtime dependency: $library" >&2
    failures=$((failures + 1))
    ;;
  esac
done < <(patchelf --print-needed "$binary")

max_glibc="$({
  objdump -T "$binary" |
    sed -n 's/.*(GLIBC_\([^)]*\)).*/\1/p'
  printf '0\n'
} | sort -Vu | tail -n 1)"
if [ "$(printf '2.35\n%s\n' "$max_glibc" | sort -Vu | tail -n 1)" != 2.35 ]; then
  echo "Linux scope-server requires glibc $max_glibc; Ubuntu 22.04 provides 2.35" >&2
  failures=$((failures + 1))
fi

exit "$failures"

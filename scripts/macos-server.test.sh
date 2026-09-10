#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir "$test_root/tools"
binary="$test_root/scope server"
touch "$binary"
nix_iconv=/nix/store/wl602np9yz9kw3a9ydpn68nqd63g0xda-libiconv-115.100.1/lib/libiconv.2.dylib

cat >"$test_root/tools/otool" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = -L ]; then
  printf '%s:\n' "$2"
  while IFS= read -r library; do
    printf '\t%s (compatibility version 1.0.0, current version 1.0.0)\n' "$library"
  done <"$2.libraries"
else
  while IFS= read -r rpath; do
    printf 'Load command 1\n          cmd LC_RPATH\n      cmdsize 80\n         path %s (offset 12)\n' "$rpath"
  done <"$2.rpaths"
fi
STUB
cat >"$test_root/tools/install_name_tool" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
binary="${!#}"
while [ "$#" -gt 1 ]; do
  case "$1" in
  -change)
    awk -v old="$2" -v new="$3" '{ print ($0 == old ? new : $0) }' "$binary.libraries" >"$binary.tmp"
    mv "$binary.tmp" "$binary.libraries"
    shift 3
    ;;
  -delete_rpath)
    awk -v old="$2" '$0 != old' "$binary.rpaths" >"$binary.tmp"
    mv "$binary.tmp" "$binary.rpaths"
    shift 2
    ;;
  *) exit 1 ;;
  esac
done
printf 'edit\n' >>"$binary.log"
STUB
cat >"$test_root/tools/codesign" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >>"${!#}.log"
STUB
chmod +x "$test_root/tools/"*

check() {
  PATH="$test_root/tools:$PATH" "$script_dir/macos-server.sh" "$@" "$binary"
}

expect_failure() {
  if check "$@" >"$test_root/error" 2>&1; then
    echo "macOS server check unexpectedly accepted $*" >&2
    exit 1
  fi
}

printf '%s\n' /usr/lib/libSystem.B.dylib "$nix_iconv" \
  /System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation >"$binary.libraries"
printf '%s\n' /nix/store/build-toolchain/lib >"$binary.rpaths"
expect_failure check
check prepare
check check
grep -Fxq /usr/lib/libiconv.2.dylib "$binary.libraries"
[ ! -s "$binary.rpaths" ]
[ "$(cat "$binary.log")" = "$(printf 'edit\n--force\n--verify')" ]
check prepare
[ "$(wc -l <"$binary.log")" -eq 3 ]

for library in /nix/store/other/lib/libhdf5.dylib /opt/homebrew/lib/libiconv.2.dylib \
  /nix/store/gnu-libiconv-1.19/lib/libiconv.2.dylib @rpath/libz.dylib \
  @loader_path/libz.dylib 'relative path/libz.dylib'; do
  printf '%s\n' "$library" >"$binary.libraries"
  expect_failure check
  expect_failure prepare
  grep -Fq "$library" "$test_root/error"
done
printf '%s\n' /usr/lib/libSystem.B.dylib >"$binary.libraries"
printf '%s\n' '/opt/local/lib with spaces' >"$binary.rpaths"
expect_failure prepare
expect_failure check
grep -Fq '/opt/local/lib with spaces' "$test_root/error"
: >"$binary.libraries"
expect_failure check
rm "$binary.libraries"
expect_failure check

if [ "$(uname -s)" = Darwin ]; then
  cat >"$test_root/main.c" <<'C'
#include <iconv.h>
int main(void) {
  iconv_t converter = iconv_open("UTF-8", "UTF-8");
  if (converter == (iconv_t)-1) return 1;
  return iconv_close(converter);
}
C
  /usr/bin/xcrun clang "$test_root/main.c" -liconv \
    -Wl,-headerpad_max_install_names -o "$binary"
  /usr/bin/install_name_tool -change /usr/lib/libiconv.2.dylib "$nix_iconv" \
    -add_rpath /nix/store/build-toolchain/lib "$binary"
  if "$script_dir/macos-server.sh" check "$binary" >/dev/null 2>&1; then
    echo "macOS server check accepted an actual Nix-linked Mach-O binary" >&2
    exit 1
  fi
  "$script_dir/macos-server.sh" prepare "$binary"
  "$script_dir/macos-server.sh" check "$binary"
  /usr/bin/codesign --verify --strict "$binary"
  "$binary"
fi

echo "macOS server portability tests passed."

#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

printf 'int main(void) { return 0; }\n' >"$test_root/main.c"
cc "$test_root/main.c" -o "$test_root/server"
"$script_dir/check-linux-server.sh" "$test_root/server"

patchelf --add-needed libwayland-client.so.0 "$test_root/server"
if "$script_dir/check-linux-server.sh" "$test_root/server" >/dev/null 2>&1; then
  echo "Linux server dependency check accepted a Wayland-linked binary" >&2
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(uname -s)" != "Linux" ]; then
  echo "AppImage builds require Linux." >&2
  exit 1
fi

exec "$script_dir/build.sh" native --linux AppImage "$@"

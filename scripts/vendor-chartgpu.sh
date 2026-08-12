#!/usr/bin/env bash
# Vendor ChartGPU source at a pinned revision.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
ensure_dev_shell "$@"

dest="frontend/vendor/chartgpu"
rev="${1:-$(cat "$dest/VENDORED_REV.txt" 2>/dev/null || true)}"
[ -n "$rev" ] || {
  echo "usage: $0 <rev> (no recorded rev found)" >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone --no-checkout https://github.com/ChartGPU/ChartGPU.git "$tmp"
git -C "$tmp" checkout --detach "$rev"

rm -rf "$dest"
mkdir -p "$dest"
cp -r "$tmp/src" "$dest/src"
cp "$tmp/LICENSE" "$tmp/package.json" "$dest/"
find "$dest/src" -name __tests__ -type d -prune -exec rm -rf {} +
printf '%s\n' "$rev" >"$dest/VENDORED_REV.txt"
echo "vendored ChartGPU @ $rev"

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
tool_root="$project_root/build/appimage-tools"

if [ "$(uname -s)" != "Linux" ]; then
  echo "AppImage builds require Linux." >&2
  exit 1
fi

if [ -n "${IN_NIX_SHELL:-}" ]; then
  cat >&2 <<'EOF'
AppImage builds must run outside the Nix shell because linuxdeploy's GTK plugin
requires Ubuntu/FHS library paths. Run:

  ./scripts/setup-appimage.sh
  ./scripts/build.sh appimage
EOF
  exit 1
fi

for command_name in cargo node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

mkdir -p "$tool_root"
npm install \
  --no-package-lock \
  --no-save \
  --prefix "$tool_root" \
  @tauri-apps/cli@2.11.4 \
  pnpm@10.27.0

export PATH="$tool_root/node_modules/.bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

cd "$project_root"
pnpm install --frozen-lockfile

cd "$project_root/shell/src-tauri"
exec tauri build --bundles appimage "$@"

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
tool_root="$project_root/build/windows-tools"

case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*) ;;
*)
  echo "Windows installer builds require Windows with Git Bash." >&2
  exit 1
  ;;
esac

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
exec tauri build --bundles nsis "$@"

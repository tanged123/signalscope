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
  pnpm@10.27.0

export PATH="$tool_root/node_modules/.bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

cd "$project_root"
SIGNALSCOPE_WINDOWS_BUILD=1 ./scripts/setup.sh

if [ -n "${WINDOWS_CERTIFICATE:-}" ] && [ -n "${WINDOWS_CERTIFICATE_PASSWORD:-}" ]; then
  export CSC_LINK="$WINDOWS_CERTIFICATE"
  export CSC_KEY_PASSWORD="$WINDOWS_CERTIFICATE_PASSWORD"
  echo "Signing the installer with the configured certificate"
elif [ -n "${WINDOWS_CERTIFICATE:-}" ] || [ -n "${WINDOWS_CERTIFICATE_PASSWORD:-}" ]; then
  echo "WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD must be set together." >&2
  exit 1
else
  echo "WINDOWS_CERTIFICATE is not set; building an unsigned installer." >&2
fi

SIGNALSCOPE_WINDOWS_BUILD=1 ./scripts/build.sh native --win nsis --x64 "$@"
SIGNALSCOPE_WINDOWS_BUILD=1 ./scripts/test.sh desktop package --no-build

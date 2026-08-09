#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

show_help() {
  cat <<'EOF'
Usage: ./scripts/run.sh [native|web]

  native  Launch the Electron workbench (default).
  web     Launch the shared frontend in a browser at http://127.0.0.1:4173.

Native compilation is capped at two jobs by default. Override with:
  CARGO_BUILD_JOBS=4 ./scripts/run.sh native

Use ./scripts/run.sh native --software-gpu for SwiftShader integration runs.
EOF
}

mode="${1:-native}"
case "$mode" in
native)
  shift || true
  software_gpu=0
  electron_args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
    --software-gpu)
      software_gpu=1
      ;;
    --)
      shift
      electron_args+=("$@")
      break
      ;;
    *)
      electron_args+=("$1")
      ;;
    esac
    shift
  done
  "$signalscope_scripts_dir/build.sh" host
  "$signalscope_scripts_dir/build.sh" web
  native_dev_args=()
  if [ "$software_gpu" -eq 1 ]; then
    native_dev_args+=(--software-gpu)
  fi
  native_dev_args+=(-- "${electron_args[@]}")
  exec node "$signalscope_scripts_dir/native-dev.mjs" "${native_dev_args[@]}"
  ;;
web)
  shift || true
  # Port 4173 is also used by Playwright against the shared frontend host.
  exec pnpm dev "$@"
  ;;
-h | --help | help)
  show_help
  ;;
*)
  echo "Unknown run mode: $mode" >&2
  show_help >&2
  exit 2
  ;;
esac

#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Linux" ] || [ ! -r /etc/os-release ]; then
  echo "AppImage setup requires Ubuntu Linux." >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "AppImage setup requires Ubuntu; detected ${ID:-unknown}." >&2
  exit 1
fi

sudo_command=()
if [ "$(id -u)" -ne 0 ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "AppImage setup requires root or sudo access." >&2
    exit 1
  fi
  sudo_command=(sudo)
fi

"${sudo_command[@]}" apt-get update
"${sudo_command[@]}" apt-get install --yes \
  build-essential \
  curl \
  file \
  libayatana-appindicator3-dev \
  libfuse2 \
  librsvg2-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  patchelf \
  pkg-config \
  wget

echo "SignalScope AppImage system dependencies are ready."

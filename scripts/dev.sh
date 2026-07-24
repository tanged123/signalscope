#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 0 ]; then
  exec nix develop --command "$@"
fi

exec nix develop


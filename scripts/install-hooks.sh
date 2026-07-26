#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"

hooks_dir="$(cd "$project_root" && git rev-parse --path-format=absolute --git-path hooks)"
mkdir -p "$hooks_dir"
cp "$project_root/.github/hooks/pre-commit" "$hooks_dir/pre-commit"
chmod +x "$hooks_dir/pre-commit"
echo "SignalScope pre-commit formatter installed."

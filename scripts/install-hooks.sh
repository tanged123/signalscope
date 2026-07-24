#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"

cp "$project_root/.github/hooks/pre-commit" "$project_root/.git/hooks/pre-commit"
chmod +x "$project_root/.git/hooks/pre-commit"
echo "SignalScope pre-commit formatter installed."


#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="${1:-write}"

show_help() {
  cat <<'EOF'
Usage: ./scripts/format.sh [--check]

Formats the whole repository with treefmt — the same formatter behind `nix fmt`,
the flake gate, and the pre-commit hook.

  (no arguments)  rewrite unformatted files in place
  --check         report unformatted files and exit non-zero; writes nothing

treefmt covers Rust, TypeScript, Nix, shell, TOML, and Markdown. Documentation,
ADRs, specs, and plans are formatted like source. `.prettierignore` lists the
exclusions.

`./scripts/ci.sh format` calls this with --check.
EOF
}

case "$mode" in
-h | --help | help)
  show_help
  exit 0
  ;;
esac

ensure_dev_shell "$@"

case "$mode" in
write)
  exec treefmt
  ;;
--check | check)
  exec treefmt --fail-on-change
  ;;
*)
  echo "Unknown format mode: $mode" >&2
  show_help >&2
  exit 2
  ;;
esac

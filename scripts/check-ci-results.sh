#!/usr/bin/env bash
set -euo pipefail

results=(
  "${VERSION_RESULT:-}"
  "${FLAKE_RESULT:-}"
  "${QUALITY_RESULT:-}"
  "${RUST_RESULT:-}"
  "${FRONTEND_RESULT:-}"
  "${E2E_RESULT:-}"
  "${COVERAGE_RESULT:-}"
)

for result in "${results[@]}"; do
  case "$result" in
  failure | cancelled)
    echo "One or more required CI jobs did not succeed." >&2
    exit 1
    ;;
  esac
done

#!/usr/bin/env bash
set -euo pipefail

# Fails when any needed job failed or was cancelled. NEEDS_JSON is the
# workflow's `toJSON(needs)`, so newly added needed jobs are covered
# automatically and an empty payload fails closed.
if [ -z "${NEEDS_JSON:-}" ]; then
  echo "NEEDS_JSON is empty; refusing to pass the gate." >&2
  exit 1
fi

if grep -Eq '"result":[[:space:]]*"(failure|cancelled)"' <<<"$NEEDS_JSON"; then
  echo "One or more required CI jobs did not succeed." >&2
  exit 1
fi

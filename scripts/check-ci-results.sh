#!/usr/bin/env bash
set -euo pipefail

# Fails unless every needed job has exactly the successful result.
if [ -z "${NEEDS_JSON:-}" ]; then
  echo "NEEDS_JSON is empty; refusing to pass the gate." >&2
  exit 1
fi

NEEDS_JSON="$NEEDS_JSON" node --input-type=module -e '
const needs = JSON.parse(process.env.NEEDS_JSON ?? "");
const jobs = Object.values(needs);
if (jobs.length === 0 || jobs.some((job) => job?.result !== "success")) {
  console.error("One or more required CI jobs did not succeed.");
  process.exit(1);
}
'

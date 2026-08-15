#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
# shellcheck source=scripts/lib.sh
source "$script_dir/lib.sh"
ensure_dev_shell "$@"

if [ ! -f "$repo_root/frontend/dist/index.html" ]; then
  "$script_dir/build.sh" web
fi

data_dir=$(mktemp -d)
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rmdir "$data_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Build before starting the health window: a stale binary must not spend the
# poll budget compiling (and --quiet would hide that it ever was).
cargo build --release -p scope-server

cargo run --quiet --release -p scope-server -- \
  --no-auth --no-open --port 43117 --data-dir "$data_dir" &
server_pid=$!

ready=0
for _ in $(seq 1 60); do
  if curl -fs http://127.0.0.1:43117/api/health >/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "server-smoke: scope-server not healthy on port 43117 within 30s" >&2
  exit 1
fi

protocol=$(node -e '
const fs = require("node:fs");
const schema = JSON.parse(fs.readFileSync("protocol/schema/scope-protocol.json", "utf8"));
process.stdout.write(String(schema.protocol_version));
')

curl -fsS -X POST http://127.0.0.1:43117/api/list_formats |
  node -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const envelope = JSON.parse(body);
      if (typeof envelope.protocol_version !== "number" || !Array.isArray(envelope.payload) || envelope.payload.length === 0) process.exit(1);
    });
  '

request=$(node -e '
const protocol = process.argv[1];
process.stdout.write(JSON.stringify({
  protocol_version: Number(protocol),
  payload: {
    request_id: "server-smoke",
    signal_ids: [],
    window: { t0: 0, t1: 1 },
    pixel_width: 100,
    max_total_bins: 1000,
  },
}));
' "$protocol")
magic=$(curl -fsS -X POST -H 'content-type: application/json' \
  -d "$request" http://127.0.0.1:43117/api/query_tiles_bin |
  od -An -tx1 -N4 | tr -d ' \n')
if [ "$magic" != "53535442" ]; then
  echo "server-smoke: query_tiles_bin magic mismatch: got '$magic'" >&2
  exit 1
fi

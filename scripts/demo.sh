#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

show_help() {
  cat <<'EOF'
Usage: ./scripts/demo.sh [all|bake|publish <dir>]

  all             Bake, check, and stage the HTML demo.
  bake            Bake build/demo/demo.html through the export path.
  publish <dir>   Force-push the HTML demo to the orphan gh-pages branch.
EOF
}

bake() {
  "$signalscope_scripts_dir/export.sh" \
    --data examples/demo_flight.csv \
    --range all \
    --fidelity full \
    --out build/demo/demo.html
}

stage_pages() {
  local pages_dir="$signalscope_root/build/demo/pages"
  rm -rf "$pages_dir"
  mkdir -p "$pages_dir"
  cp build/demo/demo.html "$pages_dir/"
  cp build/demo/demo.html "$pages_dir/index.html"
}

check_demo() {
  pnpm --filter @signalscope/frontend check:demo
}

demo_publish_work=""

cleanup_publish_work() {
  local work="${demo_publish_work:-}"
  demo_publish_work=""
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

publish() {
  local asset_dir="${1:-}"
  if [ -z "$asset_dir" ]; then
    echo "publish requires a staged asset directory" >&2
    exit 2
  fi
  if [ ! -d "$asset_dir" ]; then
    echo "asset directory does not exist: $asset_dir" >&2
    exit 1
  fi
  if [ ! -f "$asset_dir/demo.html" ]; then
    echo "demo.html is required in $asset_dir" >&2
    exit 1
  fi

  local origin_url
  origin_url="$(git remote get-url origin)"
  demo_publish_work="$(mktemp -d)"
  trap cleanup_publish_work EXIT

  cp "$asset_dir/demo.html" "$demo_publish_work/"
  cp "$asset_dir/demo.html" "$demo_publish_work/index.html"
  git init --quiet "$demo_publish_work"
  git -C "$demo_publish_work" checkout --quiet --orphan gh-pages-publish
  git -C "$demo_publish_work" remote add origin "$origin_url"
  while read -r key value; do
    git -C "$demo_publish_work" config --local --add "$key" "$value"
  done < <(git config --get-regexp '^http\..*\.extraheader$' || true)
  git -C "$demo_publish_work" add -- demo.html index.html
  git -C "$demo_publish_work" \
    -c user.name="${GIT_AUTHOR_NAME:-github-actions[bot]}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}" \
    commit --quiet --message "docs: publish SignalScope demo"
  git -C "$demo_publish_work" push --force origin HEAD:gh-pages >/dev/null

  cleanup_publish_work
  trap - EXIT
}

mode="${1:-all}"
case "$mode" in
all)
  rm -rf build/demo
  bake
  check_demo
  stage_pages
  ;;
bake)
  bake
  ;;
publish)
  shift
  publish "$@"
  ;;
-h | --help | help)
  show_help
  ;;
*)
  echo "Unknown demo mode: $mode" >&2
  show_help >&2
  exit 2
  ;;
esac

#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

show_help() {
  cat <<'EOF'
Usage: ./scripts/demo.sh [all|bake|record|encode|publish <dir>]

  all             Bake, record, encode, and check the demo artifacts.
  bake            Bake build/demo/demo.html through the export path.
  record          Record the baked artifact with Playwright.
  encode          Encode the single recording as build/demo/demo.gif.
  publish <dir>   Force-push the artifacts to the orphan gh-pages branch.
EOF
}

bake() {
  "$signalscope_scripts_dir/export.sh" \
    --data examples/demo_flight.csv \
    --range all \
    --fidelity full \
    --out build/demo/demo.html
}

prepare_playwright_ffmpeg() {
  local executable_name playwright_ffmpeg_dir
  case "$(uname -s)" in
  Linux*) executable_name="ffmpeg-linux" ;;
  Darwin*) executable_name="ffmpeg-mac" ;;
  *)
    echo "demo recording is unsupported on $(uname -s)" >&2
    exit 1
    ;;
  esac

  # Playwright 1.57 expects build 1011 at this path. The pinned dev-shell
  # ffmpeg implements the same recording command without a second download.
  playwright_ffmpeg_dir="$signalscope_root/build/demo/playwright/ffmpeg-1011"
  mkdir -p "$playwright_ffmpeg_dir"
  ln -sf "$(command -v ffmpeg)" "$playwright_ffmpeg_dir/$executable_name"
  export PLAYWRIGHT_BROWSERS_PATH="$signalscope_root/build/demo/playwright"
}

record() {
  local recording_dir="$signalscope_root/build/demo/recording"
  rm -rf "$recording_dir"
  trap 'rm -rf "$signalscope_root/build/demo/playwright"' EXIT
  prepare_playwright_ffmpeg
  SIGNALSCOPE_DEMO=1 pnpm --filter @signalscope/frontend demo
  single_recording >/dev/null
  rm -rf "$signalscope_root/build/demo/playwright"
  trap - EXIT
}

single_recording() {
  local recording_dir="$signalscope_root/build/demo/recording"
  local -a recordings=()
  mapfile -d '' recordings < <(
    find "$recording_dir" -type f -name '*.webm' -print0 | sort -z
  )
  if [ "${#recordings[@]}" -ne 1 ]; then
    echo "expected exactly one demo recording, found ${#recordings[@]}" >&2
    exit 1
  fi
  printf '%s\n' "${recordings[0]}"
}

encode() {
  local webm
  webm="$(single_recording)"
  mkdir -p build/demo
  ffmpeg -y -loglevel error -i "$webm" \
    -vf "fps=12,scale=800:-1:flags=lanczos,palettegen=stats_mode=diff" \
    -f image2 build/demo/palette.png
  ffmpeg -y -loglevel error -i "$webm" -i build/demo/palette.png \
    -lavfi "fps=12,scale=800:-1:flags=lanczos,paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
    build/demo/demo.gif
  rm -f build/demo/palette.png
}

stage_pages() {
  local pages_dir="$signalscope_root/build/demo/pages"
  rm -rf "$pages_dir"
  mkdir -p "$pages_dir"
  cp build/demo/demo.html build/demo/demo.gif "$pages_dir/"
  cp build/demo/demo.html "$pages_dir/index.html"
}

check_demo() {
  pnpm --filter @signalscope/frontend check:demo
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
  if [ ! -f "$asset_dir/demo.html" ] || [ ! -f "$asset_dir/demo.gif" ]; then
    echo "demo.html and demo.gif are required in $asset_dir" >&2
    exit 1
  fi

  local origin_url work
  origin_url="$(git remote get-url origin)"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT

  cp "$asset_dir/demo.html" "$asset_dir/demo.gif" "$work/"
  cp "$asset_dir/demo.html" "$work/index.html"
  git init --quiet "$work"
  git -C "$work" checkout --quiet --orphan gh-pages-publish
  git -C "$work" remote add origin "$origin_url"
  while read -r key value; do
    git -C "$work" config --local --add "$key" "$value"
  done < <(git config --local --get-regexp '^http\..*\.extraheader$' || true)
  git -C "$work" add -- demo.html demo.gif index.html
  git -C "$work" \
    -c user.name="${GIT_AUTHOR_NAME:-github-actions[bot]}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}" \
    commit --quiet --message "docs: publish SignalScope demo"
  git -C "$work" push --force origin HEAD:gh-pages >/dev/null

  rm -rf "$work"
  trap - EXIT
}

mode="${1:-all}"
case "$mode" in
all)
  bake
  record
  encode
  check_demo
  stage_pages
  ;;
bake)
  bake
  ;;
record)
  record
  ;;
encode)
  encode
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

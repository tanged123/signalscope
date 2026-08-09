#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

show_help() {
  cat <<'EOF'
Usage: ./scripts/release.sh [version|tag|tag-output|publish|assets]

  version                 Validate and print the synchronized app version.
  tag                     Create and push the annotated v<version> tag.
  publish <tag> <dir>     Create a GitHub Release from staged assets.
  assets <dir>            List publishable release assets in a staged directory.

'tag' is strict: it refuses an existing tag and never overwrites release
history. 'publish' expects .deb, .rpm, .AppImage, .dmg, or *-setup.exe files in
the staged asset directory and uses GH_TOKEN for GitHub authentication.
EOF
}

version() {
  "$script_dir/version.sh" check
}

tag() {
  local version tag author_name author_email
  version >/dev/null
  version="$("$script_dir/version.sh" get)"
  tag="v$version"

  if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    echo "release tag already exists locally: $tag" >&2
    exit 1
  fi
  if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
    echo "release tag already exists on origin: $tag" >&2
    exit 1
  fi

  author_name="${GIT_AUTHOR_NAME:-github-actions[bot]}"
  author_email="${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
  git -c user.name="$author_name" -c user.email="$author_email" \
    tag --annotate "$tag" --message "SignalScope $tag"
  git push origin "$tag" >/dev/null
  printf '%s\n' "$tag"
}

tag_output() {
  local output_file="${1:-}"
  if [ -z "$output_file" ]; then
    echo "tag-output requires a GitHub output file" >&2
    exit 2
  fi
  local tag_value
  tag_value="$(tag)"
  printf 'tag=%s\n' "$tag_value" >>"$output_file"
}

assets() {
  local asset_dir="${1:-}"
  if [ -z "$asset_dir" ]; then
    echo "assets requires a staged asset directory" >&2
    exit 2
  fi
  if [ ! -d "$asset_dir" ]; then
    echo "asset directory does not exist: $asset_dir" >&2
    exit 1
  fi

  find "$asset_dir" -type f -size +0c \
    \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.dmg' \
    -o -name '*-setup.exe' \) -print0 | sort -z
}

publish() {
  local tag="${1:-}"
  local asset_dir="${2:-}"
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "GH_TOKEN is required to publish a GitHub Release" >&2
    exit 1
  fi
  if [ -z "$tag" ] || [ -z "$asset_dir" ]; then
    echo "publish requires a tag and staged asset directory" >&2
    exit 2
  fi
  if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "invalid release tag: $tag" >&2
    exit 2
  fi
  if [ ! -d "$asset_dir" ]; then
    echo "asset directory does not exist: $asset_dir" >&2
    exit 1
  fi

  mapfile -d '' release_assets < <(assets "$asset_dir")
  if [ "${#release_assets[@]}" -eq 0 ]; then
    echo "no release assets found in $asset_dir" >&2
    exit 1
  fi

  gh release create "$tag" "${release_assets[@]}" \
    --verify-tag \
    --title "SignalScope $tag" \
    --generate-notes
}

mode="${1:-version}"
case "$mode" in
version)
  version
  ;;
tag)
  tag
  ;;
tag-output)
  shift
  tag_output "$@"
  ;;
publish)
  shift
  publish "$@"
  ;;
assets)
  shift
  assets "$@"
  ;;
-h | --help | help)
  show_help
  ;;
*)
  echo "Unknown release mode: $mode" >&2
  show_help >&2
  exit 2
  ;;
esac

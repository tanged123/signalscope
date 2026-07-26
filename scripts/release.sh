#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

show_help() {
  cat <<'EOF'
Usage: ./scripts/release.sh [version|tag|publish]

  version                 Validate and print the synchronized app version.
  tag                     Create and push the annotated v<version> tag.
  publish <tag> <dir>     Create a GitHub Release from staged assets.

'tag' is strict: it refuses an existing tag and never overwrites release
history. 'publish' expects .deb, .rpm, .AppImage, or .dmg files in the staged
asset directory and uses GH_TOKEN for GitHub authentication.
EOF
}

version() {
  "$script_dir/version.sh" check
}

tag() {
  local version tag
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

  git tag --annotate "$tag" --message "SignalScope $tag"
  git push origin "$tag" >/dev/null
  printf '%s\n' "$tag"
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

  mapfile -d '' assets < <(
    find "$asset_dir" -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.dmg' \) -print0
  )
  if [ "${#assets[@]}" -eq 0 ]; then
    echo "no release assets found in $asset_dir" >&2
    exit 1
  fi

  gh release create "$tag" "${assets[@]}" \
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
publish)
  shift
  publish "$@"
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

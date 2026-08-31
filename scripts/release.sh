#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

show_help() {
  cat <<'EOF'
Usage: ./scripts/release.sh [version|tag|verify|checksums|publish|assets]

  version                 Validate and print the synchronized app version.
  tag                     Create and push the annotated v<version> tag.
  verify <tag> <dir>      Validate the complete current-version package matrix.
  checksums <tag> <dir>   Verify packages and write SHA256SUMS.txt.
  publish <tag> <dir>     Create a GitHub Release from staged assets.
  assets <dir>            List publishable release assets in a staged directory.

'tag' is strict: it refuses an existing tag and never overwrites release
history. 'publish' accepts only a verified required package set and uses
GH_TOKEN for GitHub authentication.
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

  find "$asset_dir" -type f \
    \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.dmg' \
    -o -name '*.tar.gz' -o -name '*-setup.exe' -o -name 'SHA256SUMS.txt' \) \
    -print0 | sort -z
}

verify() {
  local tag="${1:-}"
  local asset_dir="${2:-}"
  if [[ ! $tag =~ ^v?([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    echo "invalid release tag or version: $tag" >&2
    return 2
  fi
  local version="${BASH_REMATCH[1]}"
  if [ ! -d "$asset_dir" ]; then
    echo "asset directory does not exist: $asset_dir" >&2
    return 1
  fi
  if find "$asset_dir" -type l -print -quit | grep -q .; then
    echo "release assets must not contain symlinks" >&2
    return 1
  fi

  local -a required=(
    "SignalScope-$version-linux-x64.AppImage"
    "SignalScope-$version-windows-x64-setup.exe"
    "SignalScope-$version-mac-arm64.dmg"
  )
  local name count
  for name in "${required[@]}"; do
    count="$(find "$asset_dir" -type f -name "$name" | wc -l)"
    if [ "$count" -ne 1 ]; then
      echo "release requires exactly one $name" >&2
      return 1
    fi
  done

  local -a release_assets=()
  mapfile -d '' release_assets < <(assets "$asset_dir")
  local path base
  for path in "${release_assets[@]}"; do
    if [ "$(dirname "$path")" != "$asset_dir" ]; then
      echo "release assets must be staged directly in $asset_dir: $path" >&2
      return 1
    fi
    base="$(basename "$path")"
    case "$base" in
    SHA256SUMS.txt) ;;
    SignalScope-"$version"-* | signalscope_"$version"_* | signalscope-"$version"-*) ;;
    *)
      echo "release asset does not match version $version: $base" >&2
      return 1
      ;;
    esac
  done
}

checksums() {
  local tag="${1:-}"
  local asset_dir="${2:-}"
  verify "$tag" "$asset_dir"
  local output="$asset_dir/SHA256SUMS.txt"
  local temporary
  temporary="$(mktemp "$asset_dir/.SHA256SUMS.XXXXXX")"
  local -a release_assets=()
  mapfile -d '' release_assets < <(assets "$asset_dir")
  local path
  for path in "${release_assets[@]}"; do
    if [ "$(basename "$path")" != SHA256SUMS.txt ]; then
      (cd "$asset_dir" && sha256sum "$(basename "$path")") >>"$temporary"
    fi
  done
  LC_ALL=C sort -o "$temporary" "$temporary"
  mv "$temporary" "$output"
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

  verify "$tag" "$asset_dir"
  if [ ! -f "$asset_dir/SHA256SUMS.txt" ]; then
    echo "release checksum manifest is missing" >&2
    exit 1
  fi
  (cd "$asset_dir" && sha256sum --check SHA256SUMS.txt)

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
verify)
  shift
  verify "$@"
  ;;
checksums)
  shift
  checksums "$@"
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

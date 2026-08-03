#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
tool_root="$project_root/build/windows-tools"

case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*) ;;
*)
  echo "Windows installer builds require Windows with Git Bash." >&2
  exit 1
  ;;
esac

for command_name in cargo node npm cmake; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

mkdir -p "$tool_root"
npm install \
  --no-package-lock \
  --no-save \
  --prefix "$tool_root" \
  @tauri-apps/cli@2.11.4 \
  pnpm@10.27.0

export PATH="$tool_root/node_modules/.bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

cd "$project_root"
pnpm install --frozen-lockfile

# Authenticode signing is opt-in. Without the certificate secrets the build
# still succeeds and produces an unsigned installer, so forks and pre-certificate
# CI runs are not blocked.
pfx_path="$tool_root/signing-certificate.pfx"
imported_thumbprint=""

# The decoded PFX and the imported store entry are private key material. Drop
# both however the script exits, including a failed import or a failed build.
cleanup_signing() {
  rm -f "$pfx_path"
  if [ -n "$imported_thumbprint" ]; then
    powershell -NoProfile -NonInteractive -Command \
      "Remove-Item -Path 'Cert:\\CurrentUser\\My\\$imported_thumbprint' -Force" ||
      echo "failed to remove certificate $imported_thumbprint from the store" >&2
  fi
}
trap cleanup_signing EXIT

signing_config=()
if [ -n "${WINDOWS_CERTIFICATE:-}" ] && [ -n "${WINDOWS_CERTIFICATE_PASSWORD:-}" ]; then
  printf '%s' "$WINDOWS_CERTIFICATE" | base64 --decode >"$pfx_path"

  thumbprint="$(
    powershell -NoProfile -NonInteractive -Command "
      \$password = ConvertTo-SecureString -String \$env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
      (Import-PfxCertificate -FilePath '$(cygpath -w "$pfx_path")' -CertStoreLocation Cert:\\CurrentUser\\My -Password \$password).Thumbprint
    " | tr -d '\r\n'
  )"
  rm -f "$pfx_path"

  if [ -z "$thumbprint" ]; then
    echo "failed to import the Windows signing certificate" >&2
    exit 1
  fi
  imported_thumbprint="$thumbprint"
  echo "Signing the installer with certificate $thumbprint"
  signing_config=(--config "{\"bundle\":{\"windows\":{\"certificateThumbprint\":\"$thumbprint\"}}}")
elif [ -n "${WINDOWS_CERTIFICATE:-}" ] || [ -n "${WINDOWS_CERTIFICATE_PASSWORD:-}" ]; then
  # Half-configured signing means a release silently ships unsigned. Fail loudly
  # instead; only the fully absent case falls back to an unsigned installer.
  echo "WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD must be set together." >&2
  exit 1
else
  echo "WINDOWS_CERTIFICATE is not set; building an unsigned installer." >&2
fi

# Not exec: the signing cleanup trap must still run after the build.
cd "$project_root/shell/src-tauri"
tauri build --bundles nsis ${signing_config[@]:+"${signing_config[@]}"} "$@"

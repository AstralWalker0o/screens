#!/usr/bin/env bash
# Build a release-signed Screens Launcher APK.
#
# The signing key is kept in the private R2 bucket (screens-store/signing/), never in git. Android only accepts an
# update when it is signed with the same key, so every future build must reuse it. The first run creates it.
# Needs CLOUDFLARE_API_TOKEN/ACCOUNT_ID, a JDK and the Android SDK (ANDROID_HOME or android/local.properties).
#   tools/build-launcher.sh             # → android/dist/screens-launcher.apk
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
KS_KEY=screens-store/signing/screens-launcher.p12
ENV_KEY=screens-store/signing/screens-launcher.env

cd "$ROOT/central"
r2get() { npx wrangler r2 object get "$1" --file "$2" --remote >/dev/null 2>&1; }
r2put() { npx wrangler r2 object put "$1" --file "$2" --remote >"$TMP/r2put.log" 2>&1 || { grep -v -i -E "password|PASS" "$TMP/r2put.log" | tail -5 >&2; return 1; }; }

if r2get "$KS_KEY" "$TMP/ks.p12" && r2get "$ENV_KEY" "$TMP/ks.env"; then
  echo "==> using the existing signing key from R2"
else
  echo "==> creating a new launcher signing key (first build) and storing it in R2"
  rm -f "$TMP/ks.p12" "$TMP/ks.env"   # a failed download can leave empty files behind
  PASS="$(openssl rand -hex 24)"
  keytool -genkeypair -keystore "$TMP/ks.p12" -storetype PKCS12 -alias screens-launcher \
    -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Screens Launcher, O=Screens" \
    -storepass "$PASS" -keypass "$PASS" >/dev/null 2>&1 || { echo "keytool failed" >&2; exit 1; }
  echo "    key generated" 
  printf 'SCREENS_KEYSTORE_PASSWORD=%s\nSCREENS_KEY_ALIAS=screens-launcher\nSCREENS_KEY_PASSWORD=%s\n' "$PASS" "$PASS" > "$TMP/ks.env"
  r2put "$KS_KEY" "$TMP/ks.p12" && r2put "$ENV_KEY" "$TMP/ks.env" || { echo "could not store the key in R2" >&2; exit 1; }
  echo "    key stored in R2"
fi

set -a; . "$TMP/ks.env"; set +a
export SCREENS_KEYSTORE="$TMP/ks.p12"

echo "==> building"
cd "$ROOT/android"
./gradlew --no-daemon -q assembleRelease \
  -Dorg.gradle.internal.repository.max.retries=10 -Dorg.gradle.internal.repository.initial.backoff=3000
mkdir -p dist
cp app/build/outputs/apk/release/app-release.apk dist/screens-launcher.apk

SDK="${ANDROID_HOME:-$(sed -n 's/^sdk.dir=//p' local.properties 2>/dev/null)}"
APKSIGNER="$(ls -1 "$SDK"/build-tools/*/apksigner 2>/dev/null | tail -1)"
"$APKSIGNER" verify --print-certs dist/screens-launcher.apk | grep -E "Signer #1 certificate (DN|SHA-256)"
sha256sum dist/screens-launcher.apk

#!/usr/bin/env bash
# Publish the Screens Launcher APK (android/dist/screens-launcher.apk) into the central APK library,
# where the "Install Screens Launcher" action picks the newest version.
#   tools/release-launcher.sh            # remote (production)
#   tools/release-launcher.sh --local    # local wrangler dev state
set -euo pipefail
MODE="${1:---remote}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="$ROOT/android/dist/screens-launcher.apk"
[ -f "$APK" ] || { echo "Build it first: cd android && ./gradlew assembleRelease" >&2; exit 1; }
AAPT2="$(ls -1 "${ANDROID_HOME:-/opt/android-sdk}"/build-tools/*/aapt2 2>/dev/null | tail -1)"
[ -x "$AAPT2" ] || { echo "aapt2 not found (set ANDROID_HOME)" >&2; exit 1; }
BADGING="$("$AAPT2" dump badging "$APK")"
PKG="$(echo "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
VCODE="$(echo "$BADGING" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")"
VNAME="$(echo "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
[ "$PKG" = "au.supercluster.screens.launcher" ] || { echo "unexpected package $PKG" >&2; exit 1; }
SHA="$(sha256sum "$APK" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$APK")"
KEY="apks/$SHA.apk"
cd "$ROOT/central"
CFG=wrangler.jsonc; EXTRA=(--remote)
if [ "$MODE" = "--local" ]; then CFG=wrangler.e2e.jsonc; EXTRA=(--local --persist-to .wrangler/e2e); fi
npx wrangler r2 object put "screens-store/$KEY" --file "$APK" --content-type application/vnd.android.package-archive -c "$CFG" "${EXTRA[@]}" >/dev/null
NOW="$(date +%s)000"
npx wrangler d1 execute screens -c "$CFG" "${EXTRA[@]}" --command "INSERT INTO apks (id, package, label, version_name, version_code, r2_key, sha256, size, notes, uploaded_at) VALUES ('apk_launcher_$VCODE', '$PKG', 'Screens Launcher', '$VNAME', $VCODE, '$KEY', '$SHA', $SIZE, 'Built-in: kiosk launcher + welcome screen', $NOW) ON CONFLICT(id) DO UPDATE SET r2_key = excluded.r2_key, sha256 = excluded.sha256, size = excluded.size, version_name = excluded.version_name, uploaded_at = excluded.uploaded_at;" >/dev/null
echo "published Screens Launcher $VNAME ($VCODE) sha256=$SHA"

#!/usr/bin/env bash
# Rebuilds the tiny, real (but code-free) APKs used by test/updates.test.ts, plus expected.json.
# Needs the Android SDK build-tools (aapt2, zipalign, apksigner) and a JDK (keytool, java).
#   central/test/fixtures/updates/build.sh
# The signing keys are throwaway: generated in a temp dir and deleted afterwards.
set -euo pipefail
export JAVA_TOOL_OPTIONS= _JAVA_OPTIONS=
HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-/opt/android-sdk}"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
JAR="$(ls "$SDK"/platforms/android-*/android.jar | sort -V | tail -1)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PKG=au.supercluster.screens.fixture

key() {
  keytool -genkeypair -keystore "$T/$1.jks" -storepass fixture -keypass fixture -alias "$1" -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=Screens test fixture $1" >/dev/null 2>&1
  keytool -exportcert -keystore "$T/$1.jks" -storepass fixture -alias "$1" -file "$T/$1.der" >/dev/null 2>&1
}
key k1; key k2

# unsigned APK: $1 versionCode, $2 versionName, $3 native ABIs (space separated), $4 versionCodeMajor (optional), $5 targetSdk
unsigned() {
  cat > "$T/AndroidManifest.xml" <<XML
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="$PKG">
  <application android:label="Screens Fixture" android:hasCode="false"/>
</manifest>
XML
  local major=(); [ -n "${4:-}" ] && major=(--version-code-major "$4")
  "$BT/aapt2" link -o "$T/u.apk" -I "$JAR" --manifest "$T/AndroidManifest.xml" --min-sdk-version 21 --target-sdk-version "${5:-34}" \
    --version-code "$1" --version-name "$2" "${major[@]}"
  for abi in $3; do
    mkdir -p "$T/lib/$abi"; printf 'not a real library' > "$T/lib/$abi/libfixture.so"
    (cd "$T" && zip -q -0 u.apk "lib/$abi/libfixture.so")
  done
  rm -rf "$T/lib"
  "$BT/zipalign" -f -p 4 "$T/u.apk" "$T/a.apk"
}
signer() { echo --ks "$T/$1.jks" --ks-pass pass:fixture --ks-key-alias "$1" --key-pass pass:fixture; }
sign() { local out="$1"; shift; "$BT/apksigner" sign "$@" --out "$HERE/$out" "$T/a.apk"; }

unsigned 1 1.0 "";                                  sign v1-k1.apk $(signer k1)
unsigned 2 1.1 "arm64-v8a";                         sign v2-k1-arm64.apk $(signer k1)
unsigned 2 1.1 "armeabi-v7a";                       sign v2-k1-armv7.apk $(signer k1)
unsigned 2 1.1 "arm64-v8a armeabi-v7a x86 x86_64";  sign v2-k1-universal.apk $(signer k1)
unsigned 2 1.1 "";                                  sign v2-k2.apk $(signer k2)
# Key rotation k1 → k2 (APK Signature Scheme v3 proof-of-rotation): a box signed with k1 accepts this update.
"$BT/apksigner" rotate --out "$T/lineage" --old-signer $(signer k1) --new-signer $(signer k2)
# Default rotation targets Android 13+ (v3.1 block, k2) and keeps k1 in the v3 block for older platforms.
unsigned 3 1.2 "";                                  sign v3-rotated.apk $(signer k1) --next-signer $(signer k2) --lineage "$T/lineage"
# Rotation for Android 9+ in the plain v3 block (k2 + lineage), v2/v1 keep k1.
unsigned 3 1.2 "";                                  sign v3-rotated-p.apk $(signer k1) --next-signer $(signer k2) --lineage "$T/lineage" --rotation-min-sdk-version 28
# JAR (v1) signature only: the certificate comes from META-INF/*.RSA (PKCS#7).
unsigned 4 1.3 "" "" 29;                            sign v4-k1-jaronly.apk $(signer k1) --v2-signing-enabled false --v3-signing-enabled false
# versionCodeMajor = 1 → long version code 4294967301.
unsigned 5 2.0 "" 1;                                sign v5-major.apk $(signer k1)
rm -f "$HERE"/*.idsig

# Ground truth: SHA-256 and Java Arrays.hashCode (what `dumpsys package` prints) of each certificate.
cat > "$T/Hash.java" <<'JAVA'
public class Hash { public static void main(String[] a) throws Exception {
  System.out.print(Integer.toHexString(java.util.Arrays.hashCode(java.nio.file.Files.readAllBytes(java.nio.file.Path.of(a[0]))))); } }
JAVA
jh() { java "$T/Hash.java" "$T/$1.der"; }
sh256() { sha256sum "$T/$1.der" | cut -d' ' -f1; }
cat > "$HERE/expected.json" <<JSON
{
  "package": "$PKG",
  "k1": { "sha256": "$(sh256 k1)", "java_hash": "$(jh k1)" },
  "k2": { "sha256": "$(sh256 k2)", "java_hash": "$(jh k2)" }
}
JSON
"$BT/apksigner" verify -v --print-certs "$HERE/v3-rotated.apk" | grep -E 'Verified using|Signer' || true
ls -l "$HERE"/*.apk
cat "$HERE/expected.json"

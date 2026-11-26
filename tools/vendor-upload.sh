#!/usr/bin/env bash
# Publish third-party runtime files that the cloud pushes to devices:
#   scrcpy-server v5.0.1 (Apache-2.0), used for live screen mirroring. Verified against upstream's pinned sha256.
#   tools/vendor-upload.sh            # remote (production R2)
#   tools/vendor-upload.sh --local    # local wrangler dev state
set -euo pipefail
MODE="${1:---remote}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER=5.0.1
SHA=764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/scrcpy-server" "https://github.com/Genymobile/scrcpy/releases/download/v$VER/scrcpy-server-v$VER"
echo "$SHA  $TMP/scrcpy-server" | sha256sum --check --quiet
cd "$ROOT/central"
CFG=wrangler.jsonc; EXTRA=(--remote)
if [ "$MODE" = "--local" ]; then CFG=wrangler.e2e.jsonc; EXTRA=(--local --persist-to .wrangler/e2e); fi
npx wrangler r2 object put "screens-store/vendor/scrcpy-server-v$VER" --file "$TMP/scrcpy-server" --content-type application/java-archive -c "$CFG" "${EXTRA[@]}" >/dev/null
echo "published scrcpy-server v$VER ($SHA)"

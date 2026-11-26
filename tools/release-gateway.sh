#!/usr/bin/env bash
# Build the gateway agent and publish it to the central app's R2 bucket + D1 release table.
# Sites then update from the dashboard (Gateway tab → Update), and new installs fetch it.
#
#   tools/release-gateway.sh 0.1.0            # remote (production)
#   tools/release-gateway.sh 0.1.0 --local    # local wrangler dev state (e2e tests)
set -euo pipefail
VERSION="${1:?usage: release-gateway.sh <version> [--local]}"
MODE="${2:---remote}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/gateway"
VERSION="$VERSION" ./build.sh >/dev/null
cd "$ROOT/central"

CFG=wrangler.jsonc
EXTRA=()
if [ "$MODE" = "--local" ]; then CFG=wrangler.e2e.jsonc; EXTRA=(--local --persist-to .wrangler/e2e); else EXTRA=(--remote); fi

declare -A SHA
for ARCH in amd64 arm64; do
  F="$ROOT/gateway/dist/screens-gateway-linux-$ARCH"
  [ -f "$F" ] || { echo "missing $F" >&2; exit 1; }
  SHA[$ARCH]="$(sha256sum "$F" | cut -d' ' -f1)"
  KEY="agent/$VERSION/screens-gateway-linux-$ARCH"
  npx wrangler r2 object put "screens-store/$KEY" --file "$F" --content-type application/octet-stream -c "$CFG" "${EXTRA[@]}" >/dev/null
  echo "uploaded $KEY (${SHA[$ARCH]})"
done

NOW="$(date +%s)000"
SQL="INSERT INTO agent_releases (version, amd64_key, amd64_sha256, arm64_key, arm64_sha256, created_at) VALUES ('$VERSION', 'agent/$VERSION/screens-gateway-linux-amd64', '${SHA[amd64]}', 'agent/$VERSION/screens-gateway-linux-arm64', '${SHA[arm64]}', $NOW) ON CONFLICT(version) DO UPDATE SET amd64_sha256 = excluded.amd64_sha256, arm64_sha256 = excluded.arm64_sha256, created_at = excluded.created_at;"
npx wrangler d1 execute screens -c "$CFG" "${EXTRA[@]}" --command "$SQL" >/dev/null
echo "release $VERSION recorded"

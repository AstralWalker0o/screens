#!/usr/bin/env bash
# Deploy the Screens central app to Cloudflare.
# Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.
#   tools/deploy.sh            # test, migrate, build, deploy
#   tools/deploy.sh --skip-tests
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/central"

[ -d node_modules ] || npm ci
if [ "${1:-}" != "--skip-tests" ]; then
  npx tsc -p tsconfig.worker.json
  npx tsc -p tsconfig.app.json
  npx vitest run
fi

echo "==> D1 migrations"
npx wrangler d1 migrations apply screens --remote

echo "==> build"
npx vite build

echo "==> deploy"
npx wrangler deploy

# One-time secrets: generated here, never stored anywhere else. Rotating SECRETS_KEY would make stored
# device tokens unreadable (devices would just need re-pairing), so it is only ever created once.
EXISTING="$(npx wrangler secret list --format json 2>/dev/null || echo '[]')"
NEED=()
for S in SIGNING_SECRET SECRETS_KEY; do
  echo "$EXISTING" | grep -q "\"$S\"" || NEED+=("$S")
done
if [ ${#NEED[@]} -gt 0 ]; then
  echo "==> creating secrets: ${NEED[*]}"
  TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
  python3 - "$TMP" "${NEED[@]}" <<'PY'
import base64, json, os, secrets, sys
out = {}
for name in sys.argv[2:]:
    out[name] = base64.b64encode(os.urandom(32)).decode() if name == 'SECRETS_KEY' else secrets.token_hex(32)
open(sys.argv[1], 'w').write(json.dumps(out))
PY
  npx wrangler secret bulk "$TMP"
fi
echo "==> done: $(grep -o '"PUBLIC_URL": "[^"]*"' wrangler.jsonc | cut -d'"' -f4)"

/** Files written to /opt/screens on the site's Linux host by the one-line installer. */

export const ENTRYPOINT_SH = `#!/bin/sh
# Screens gateway entrypoint (runs inside alpine). Installs adb if missing, then starts the agent.
set -u
if ! command -v adb >/dev/null 2>&1; then
  apk add --no-cache android-tools ca-certificates tzdata >/dev/null 2>&1 || echo "screens: could not install adb (offline?) - ADB features disabled until next start" >&2
fi
BIN=/data/bin/screens-gateway
if [ -f /data/bin/screens-gateway.new ]; then mv -f /data/bin/screens-gateway.new "$BIN"; fi
chmod 755 "$BIN" 2>/dev/null || true
exec "$BIN"
`;

export function composeYml(): string {
  return `# Screens site gateway - managed from the Screens dashboard. Do not edit by hand.
services:
  gateway:
    image: alpine:3.22
    container_name: screens-gateway
    network_mode: host
    restart: unless-stopped
    cap_add: [NET_ADMIN, NET_RAW, NET_BIND_SERVICE]
    volumes:
      - ./data:/data
    entrypoint: ["/bin/sh", "/data/entrypoint.sh"]
    env_file: .env
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
`;
}

export function installScript(origin: string, token: string): string {
  return `#!/usr/bin/env bash
# Screens site gateway installer
#   curl -fsSL ${origin}/install/${token} | sudo bash
set -euo pipefail

CENTRAL="${origin}"
TOKEN="${token}"
DIR="/opt/screens"

say()  { printf '\\033[1;36m==>\\033[0m %s\\n' "$*"; }
fail() { printf '\\033[1;31mError:\\033[0m %s\\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Please run as root, e.g. curl -fsSL $CENTRAL/install/$TOKEN | sudo bash"
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install it with:  curl -fsSL https://get.docker.com | sh   then run this command again."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is missing (docker compose). Install docker-compose-plugin and try again."
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required (coreutils)"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "Unsupported CPU architecture: $(uname -m)" ;;
esac

say "Installing the Screens gateway into $DIR ($ARCH)"
mkdir -p "$DIR/data/bin"
TMP="$(mktemp)"
curl -fsSL "$CENTRAL/agent/v1/dist/latest/$ARCH" -o "$TMP" || fail "Could not download the gateway binary"
WANT="$(curl -fsSL "$CENTRAL/agent/v1/dist/latest/$ARCH.sha256" | tr -d '[:space:]')"
GOT="$(sha256sum "$TMP" | cut -d' ' -f1)"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { rm -f "$TMP"; fail "Checksum mismatch for the gateway binary"; }
install -m 0755 "$TMP" "$DIR/data/bin/screens-gateway"
rm -f "$TMP"

cat > "$DIR/data/entrypoint.sh" <<'ENTRY'
${ENTRYPOINT_SH.trimEnd()}
ENTRY
chmod 755 "$DIR/data/entrypoint.sh"

cat > "$DIR/docker-compose.yml" <<'COMPOSE'
${composeYml().trimEnd()}
COMPOSE

if [ -f "$DIR/data/identity.json" ]; then
  say "Existing gateway identity found; keeping it (the token is only used for new gateways)"
fi
umask 077
cat > "$DIR/.env" <<ENVFILE
SCREENS_CENTRAL_URL=$CENTRAL
SCREENS_ENROLL_TOKEN=$TOKEN
SCREENS_DATA=/data
ENVFILE
chmod 600 "$DIR/.env"

# Port 53 must be free on this host's LAN addresses (systemd-resolved's 127.0.0.53 stub is fine).
if command -v ss >/dev/null 2>&1; then
  BUSY="$(ss -lunpH 'sport = :53' 2>/dev/null | awk '{print $4}' | grep -v -E '^(127\\.|\\[::1\\]|::1)' || true)"
  if [ -n "$BUSY" ]; then
    printf '\\033[1;33mWarning:\\033[0m something else is already listening on DNS port 53 on: %s\\n' "$BUSY"
    printf '         The Screens DNS filter will skip those addresses. Stop that service if the TVs should use Screens for DNS.\\n'
  fi
fi

say "Starting the gateway container"
cd "$DIR"
docker compose pull --quiet
docker compose up -d --force-recreate

say "Done. The gateway should show as online in the Screens dashboard within a minute."
echo "    Logs:      docker logs -f screens-gateway"
echo "    Uninstall: cd $DIR && docker compose down && rm -rf $DIR"
`;
}

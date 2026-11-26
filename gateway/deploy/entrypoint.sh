#!/bin/sh
# Screens gateway container entrypoint (stock alpine:3.22, host network).
#
# Installs adb (android-tools) if it is missing, then execs the agent from
# the data volume. Idempotent; never fails because apk is offline: without
# adb the agent still runs and adb.* ops return not_supported.
set -u

DATA="${SCREENS_DATA:-/data}"
BIN="$DATA/bin/screens-gateway"
export SCREENS_DATA="$DATA"

log() { echo "entrypoint: $*" >&2; }

if ! command -v adb >/dev/null 2>&1; then
  log "adb not found; installing android-tools"
  if ! apk add --no-cache android-tools >/dev/null 2>&1; then
    log "could not install android-tools (offline?); continuing without adb"
  fi
fi

# TLS roots for the central URL and DoH upstreams (present in the base
# image; reinstall only if they went missing).
if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then
  apk add --no-cache ca-certificates >/dev/null 2>&1 || log "could not install ca-certificates"
fi

# sys.update stages a verified binary as .new before renaming it into
# place; finish that swap if the agent stopped in between. An interrupted
# download (.new.part) is discarded.
rm -f "$BIN.new.part" 2>/dev/null || true
if [ -f "$BIN.new" ]; then
  chmod 755 "$BIN.new" 2>/dev/null || true
  mv -f "$BIN.new" "$BIN" || log "could not install staged update"
fi

if [ ! -x "$BIN" ]; then
  if [ -f "$BIN" ]; then
    chmod 755 "$BIN" 2>/dev/null || true
  fi
fi
if [ ! -x "$BIN" ]; then
  log "$BIN is missing; re-run the install script"
  # Avoid a tight restart loop.
  sleep 30
  exit 1
fi

exec "$BIN" "$@"

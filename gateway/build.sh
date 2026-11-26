#!/usr/bin/env bash
# Cross-compiles the static gateway binaries into dist/ and prints sha256s.
#
#   ./build.sh            # version from $VERSION, else git describe, else 0.1.0-dev
#   VERSION=0.2.0 ./build.sh
#   ./build.sh 0.2.0
set -euo pipefail

cd "$(dirname "$0")"

GO="${GO:-}"
if [ -z "$GO" ]; then
  if command -v go >/dev/null 2>&1; then GO=go; else GO=/usr/local/go/bin/go; fi
fi

VERSION="${1:-${VERSION:-}}"
if [ -z "$VERSION" ]; then
  VERSION="$(git describe --tags --always --dirty 2>/dev/null || true)"
  VERSION="${VERSION#v}"
  [ -n "$VERSION" ] || VERSION="0.1.0-dev"
fi

mkdir -p dist
export CGO_ENABLED=0 GOOS=linux GOTOOLCHAIN="${GOTOOLCHAIN:-local}"
for arch in amd64 arm64; do
  out="dist/screens-gateway-linux-${arch}"
  GOARCH="$arch" "$GO" build -trimpath -buildvcs=false \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o "$out" ./cmd/screens-gateway
done

echo "version ${VERSION}"
( cd dist && sha256sum screens-gateway-linux-amd64 screens-gateway-linux-arm64 | tee SHA256SUMS )

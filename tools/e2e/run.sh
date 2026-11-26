#!/usr/bin/env bash
# End-to-end test runner: builds a simulated LAN (network namespace + veth), starts the device simulators
# inside it, runs the central Worker locally, and drives the real gateway binary through tools/e2e/e2e.py.
#   sudo tools/e2e/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=simlan
[ "$(id -u)" -eq 0 ] || { echo "run as root (network namespaces, DNS port 53)"; exit 1; }
command -v ip >/dev/null || { echo "needs iproute2"; exit 1; }

if ! ip netns list | grep -q "^$NS"; then
  ip netns add "$NS"
  ip link add lan0 type veth peer name simeth0
  ip link set simeth0 netns "$NS"
  ip addr add 10.99.0.1/24 dev lan0; ip link set lan0 up multicast on
  ip netns exec "$NS" ip link set lo up
  ip netns exec "$NS" ip link set simeth0 up
  for i in 10 11 20 30 31; do ip netns exec "$NS" ip addr add 10.99.0.$i/24 dev simeth0; done
  ip netns exec "$NS" ip route add default via 10.99.0.1
fi

# Second namespace = the "main VLAN" with phones, for real-multicast mDNS reflector tests.
if ! ip netns list | grep -q "^simmain"; then
  ip netns add simmain
  ip link add lan1 type veth peer name simeth1
  ip link set simeth1 netns simmain
  ip addr add 10.88.0.1/24 dev lan1; ip link set lan1 up multicast on
  ip netns exec simmain ip link set lo up
  ip netns exec simmain ip link set simeth1 up multicast on
  ip netns exec simmain ip addr add 10.88.0.50/24 dev simeth1
  ip netns exec simmain ip route add default via 10.88.0.1
fi

pkill -f tools/sim/sim.py 2>/dev/null || true
: > "$ROOT/tools/sim/sim.log"
ip netns exec "$NS" python3 "$ROOT/tools/sim/sim.py" --samsung 10.99.0.20 --sonos 10.99.0.30,10.99.0.31 --android 10.99.0.10,10.99.0.11 &
SIM=$!

cd "$ROOT/central"
[ -d node_modules ] || npm ci
[ -f .dev.vars ] || printf 'DEV_AUTH=1\nSIGNING_SECRET=dev-signing-secret\nSECRETS_KEY=%s\n' "$(head -c 32 /dev/urandom | base64)" > .dev.vars
npx wrangler d1 migrations apply screens --local -c wrangler.e2e.jsonc --persist-to .wrangler/e2e >/dev/null
if ! curl -sf --noproxy '*' http://127.0.0.1:8787/healthz >/dev/null; then
  npx wrangler dev -c wrangler.e2e.jsonc --persist-to .wrangler/e2e --port 8787 --ip 127.0.0.1 --test-scheduled > /tmp/screens-e2e-wrangler.log 2>&1 &
  WR=$!
  for _ in $(seq 1 60); do curl -sf --noproxy '*' http://127.0.0.1:8787/healthz >/dev/null && break; sleep 1; done
  curl -s --noproxy '*' "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*" >/dev/null   # seed + build blocklists
fi
(cd "$ROOT/gateway" && ./build.sh >/dev/null)
trap 'kill $SIM ${WR:-} 2>/dev/null || true' EXIT
python3 "$ROOT/tools/e2e/e2e.py"

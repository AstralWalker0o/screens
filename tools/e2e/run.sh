#!/usr/bin/env bash
# End-to-end test runner: builds a simulated LAN (network namespace + veth), starts the device simulators
# inside it, runs the central Worker locally, and drives the real gateway binary through tools/e2e/e2e.py.
#   sudo tools/e2e/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=simlan
[ "$(id -u)" -eq 0 ] || { echo "run as root (network namespaces, DNS port 53)"; exit 1; }
command -v ip >/dev/null || { echo "needs iproute2"; exit 1; }

# Namespaces can survive a container restart as stale entries: rebuild unless they actually work.
ns_ok() { ip netns exec "$1" true 2>/dev/null && ip link show "$2" >/dev/null 2>&1; }
if ! ns_ok "$NS" lan0; then
  ip netns del "$NS" 2>/dev/null || true; ip link del lan0 2>/dev/null || true
  ip netns add "$NS"
  ip link add lan0 type veth peer name simeth0
  ip link set simeth0 netns "$NS"
  ip addr add 10.99.0.1/24 dev lan0; ip link set lan0 up multicast on
  ip netns exec "$NS" ip link set lo up
  ip netns exec "$NS" ip link set simeth0 up
  ip netns exec "$NS" ip route add default via 10.99.0.1
fi

# Simulated device addresses (idempotent, so new simulators get their IPs on existing namespaces too).
for i in 10 11 20 21 22 30 31; do ip netns exec "$NS" ip addr add 10.99.0.$i/24 dev simeth0 2>/dev/null || true; done

# Second namespace = the "main VLAN" with phones, for real-multicast mDNS reflector tests.
if ! ns_ok simmain lan1; then
  ip netns del simmain 2>/dev/null || true; ip link del lan1 2>/dev/null || true
  ip netns add simmain
  ip link add lan1 type veth peer name simeth1
  ip link set simeth1 netns simmain
  ip addr add 10.88.0.1/24 dev lan1; ip link set lan1 up multicast on
  ip netns exec simmain ip link set lo up
  ip netns exec simmain ip link set simeth1 up multicast on
  ip netns exec simmain ip addr add 10.88.0.50/24 dev simeth1
  ip netns exec simmain ip route add default via 10.88.0.1
fi

# Third namespace = a VLAN reached through a spare, unconfigured port (lan2) with its own DHCP server,
# for the dashboard-managed network legs test.
if ! ns_ok simvlan lan2; then
  ip netns del simvlan 2>/dev/null || true; ip link del lan2 2>/dev/null || true
  ip netns add simvlan
  ip link add lan2 type veth peer name simeth2
  ip link set simeth2 netns simvlan
  ip link set lan2 up multicast on          # deliberately no address: the gateway configures it
  ip netns exec simvlan ip link set lo up
  ip netns exec simvlan ip link set simeth2 up multicast on
  ip netns exec simvlan ip addr add 10.98.0.1/24 dev simeth2
fi
ip -4 addr flush dev lan2 2>/dev/null || true
if command -v dnsmasq >/dev/null; then
  pkill -f 'dnsmasq.*simeth2' 2>/dev/null || true
  ip netns exec simvlan dnsmasq --no-daemon --port=0 --interface=simeth2 --bind-interfaces \
    --dhcp-range=10.98.0.100,10.98.0.150,255.255.255.0,10m --dhcp-option=3 --dhcp-leasefile=/tmp/screens-e2e-dhcp.leases >/tmp/screens-e2e-dnsmasq.log 2>&1 &
else
  echo "dnsmasq not installed: the network-legs DHCP test will fail (apt-get install dnsmasq-base)"
fi

pkill -f tools/sim/sim.py 2>/dev/null || true
: > "$ROOT/tools/sim/sim.log"
ip netns exec "$NS" python3 "$ROOT/tools/sim/sim.py" --samsung 10.99.0.20 --samsung9 10.99.0.21 --samsung-deny 10.99.0.22 --sonos 10.99.0.30,10.99.0.31 --android 10.99.0.10,10.99.0.11 &
SIM=$!

cd "$ROOT/central"
[ -d node_modules ] || npm ci
[ -f .dev.vars ] || printf 'DEV_AUTH=1\nSIGNING_SECRET=dev-signing-secret\nSECRETS_KEY=%s\n' "$(head -c 32 /dev/urandom | base64)" > .dev.vars
# Every run starts from a clean local database/bucket and a freshly started Worker (current code, no leftovers
# such as older launcher APKs in the library deciding which build "Install launcher" picks).
pkill -f "wrangler dev -c wrangler.e2e.jsonc" 2>/dev/null || true; sleep 1
rm -rf .wrangler/e2e
npx wrangler d1 migrations apply screens --local -c wrangler.e2e.jsonc --persist-to .wrangler/e2e >/dev/null
if ! curl -sf --noproxy '*' http://127.0.0.1:8787/healthz >/dev/null; then
  npx wrangler dev -c wrangler.e2e.jsonc --persist-to .wrangler/e2e --port 8787 --ip 127.0.0.1 --test-scheduled > /tmp/screens-e2e-wrangler.log 2>&1 &
  WR=$!
  for _ in $(seq 1 60); do curl -sf --noproxy '*' http://127.0.0.1:8787/healthz >/dev/null && break; sleep 1; done
  curl -s --noproxy '*' "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*" >/dev/null   # seed + build blocklists
fi
(cd "$ROOT/gateway" && ./build.sh >/dev/null)
"$ROOT/tools/vendor-upload.sh" --local >/dev/null      # scrcpy server for mirroring
(cd "$ROOT/central" && npx vite build >/dev/null)       # dashboard for the UI mirror test
trap 'kill $SIM ${WR:-} 2>/dev/null || true; pkill -f "dnsmasq.*simeth2" 2>/dev/null || true' EXIT
python3 "$ROOT/tools/e2e/e2e.py"
python3 "$ROOT/tools/e2e/ui_mirror.py"   # real dashboard player against the real chain

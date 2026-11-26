# Screens gateway ↔ hub protocol (v1)

This is the contract between the **site gateway agent** (Go, runs in Docker on a
Linux host at each site) and the **SiteHub** Durable Object in the central
Cloudflare app. One SiteHub exists per site.

Design rule: **the gateway is a thin, dumb executor.** It exposes primitives
(relay an HTTP request to a LAN device, run an adb command, answer DNS using a
compiled policy, reflect mDNS packets using a rule set). Every decision (what to
block, which device is which, what an automation does, how a Samsung TV is
driven) is made in the cloud.

All times are Unix epoch **milliseconds** unless noted. All JSON keys are
`snake_case`.

---

## 1. Enrollment

1. The admin creates a site in the dashboard and clicks **Add gateway**. The
   cloud returns a one-time enrollment token (`enr_...`, 24 h expiry) and an
   install command.
2. On the Linux host the install script writes `/opt/screens/` and starts the
   container with `SCREENS_CENTRAL_URL` and `SCREENS_ENROLL_TOKEN`.
3. On first start (no identity file at `$DATA/identity.json`) the agent:
   - generates an **Ed25519** keypair,
   - `POST {central}/agent/v1/enroll` with JSON:

     ```json
     {
       "token": "enr_...",
       "public_key": "<base64url raw 32-byte ed25519 public key>",
       "hostname": "media-gw-01",
       "version": "0.1.0",
       "os": "linux",
       "arch": "amd64"
     }
     ```
   - response `200`:

     ```json
     { "site_id": "site_abc", "site_name": "Beach House", "gateway_id": "gw_xyz" }
     ```
   - writes `identity.json` = `{site_id, gateway_id, private_key (base64url 64-byte seed+pub), central_url}` with mode `0600`.
   - Error responses are `4xx` with `{"error": "...", "message": "..."}`. A
     used/expired token returns `410`. The agent then logs and retries every
     60 s (the admin can issue a new token and restart the container).

## 2. Connecting

`GET {central}/agent/v1/connect` with a WebSocket upgrade (`wss://`). Headers:

| Header | Value |
|---|---|
| `X-Screens-Gateway` | `gw_xyz` |
| `X-Screens-Ts` | current time, epoch ms |
| `X-Screens-Nonce` | 16 random bytes, base64url |
| `X-Screens-Sig` | base64url(Ed25519.sign(private_key, `"screens-agent-v1\n" + gateway_id + "\n" + ts + "\n" + nonce`)) |

The Worker verifies the signature against the stored public key, rejects if
`|now - ts| > 300000`, and rejects a reused nonce. `401` means bad signature,
`403` means the gateway is revoked (agent should back off 10 min), and `101`
means connected.

Reconnect with exponential backoff: 1 s doubling to a 60 s cap, with ±20%
jitter. Reset the backoff after the link has been up for 60 s.

## 3. Framing

Every WebSocket message is a **UTF-8 JSON text frame** holding one object with a
`t` (type) field. Binary data inside JSON is base64 (standard, padded) in fields
ending `_b64`. A frame must not exceed **512 KiB**. Anything bigger (screenshots,
APKs, blocklists, binaries) moves over plain HTTPS using signed URLs (§7).

| `t` | Direction | Meaning |
|---|---|---|
| `hello` | agent → hub | first frame after connect |
| `welcome` | hub → agent | reply to hello, carries initial config |
| `req` | hub → agent | run an operation |
| `res` | agent → hub | result of a `req` |
| `evt` | agent → hub | unsolicited event / telemetry |
| `stream` | both | data on an open relay stream |
| `ping` / `pong` | both | keepalive, `{ "t":"ping", "ts": 123 }` → `{ "t":"pong", "ts": 123 }` |

The agent sends `ping` every 25 s. If no frame has arrived for 90 s, it drops
and reconnects.

### hello

```json
{
  "t": "hello",
  "version": "0.1.0",
  "hostname": "media-gw-01",
  "os": "linux", "arch": "amd64",
  "started_at": 1764120000000,
  "interfaces": [
    { "name": "ens18.20", "mac": "bc:24:11:aa:bb:cc", "addrs": ["10.0.20.5/24", "fe80::1/64"], "up": true, "multicast": true }
  ],
  "caps": ["adb", "dns", "dot", "mdns", "ssdp", "discovery", "wol", "http", "ws", "tcp", "update"],
  "dns": { "listening": ["10.0.20.5:53"], "dot_listening": [], "policy_versions": { "p_balanced": "sha256..." } },
  "adb_version": "1.0.41"
}
```

### welcome

```json
{
  "t": "welcome",
  "site_id": "site_abc",
  "server_time": 1764120000123,
  "config": {
    "dns": { "...": "see dns.configure args" },
    "mdns": { "...": "see mdns.configure args" },
    "net": { "...": "see net.configure args (only sent when the agent has cap netcfg)" },
    "telemetry": { "dns_batch_ms": 5000, "metrics_ms": 60000, "neighbors_ms": 300000 }
  }
}
```

The agent applies `config.net` (first), `config.dns` and `config.mdns` exactly as
if it had received `net.configure` / `dns.configure` / `mdns.configure`. It persists the last applied config to
`$DATA/config.json`, so DNS and mDNS keep working with no link (the site must
stay usable if the internet or Cloudflare is down).

### req / res

```json
{ "t": "req", "id": "r_01", "op": "adb.shell", "args": { "serial": "10.0.20.31:5555", "cmd": "getprop ro.product.model" }, "timeout_ms": 30000 }
{ "t": "res", "id": "r_01", "ok": true, "data": { "stdout": "SHIELD Android TV\n", "exit_code": 0 } }
{ "t": "res", "id": "r_01", "ok": false, "error": { "code": "timeout", "message": "command exceeded 30000ms" } }
```

- Requests run **concurrently**. Results may arrive in any order.
- `timeout_ms` defaults to 30000 and is capped at 600000.
- Unknown op → `error.code = "unknown_op"`.
- Error codes: `bad_args`, `unknown_op`, `timeout`, `forbidden` (target
  not allowed), `unreachable`, `adb_unauthorized`, `adb_offline`, `failed`,
  `not_supported`.

### evt

```json
{ "t": "evt", "type": "dns.queries", "data": { ... } }
```

## 4. Target safety (agent-enforced)

Relay primitives (`http.request`, `ws.open`, `tcp.open`, `net.*`, `adb.connect`)
only ever touch **private / local addresses**: `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`.
Hostnames are resolved first and every resolved address must pass. Loopback is
**never** allowed, so the agent can't be used to reach the host's own services.
Anything else returns `forbidden`. The agent itself only connects out to the
central URL (and to DoH upstreams for DNS).

## 5. Operations (hub → agent `req.op`)

### System

| op | args | data |
|---|---|---|
| `sys.info` | – | `{hostname, version, uptime_s, load: [1,5,15], mem: {total, available}, disk: {total, free}, interfaces: [...], go_version}` |
| `sys.update` | `{version, url, sha256}` | `{}` — download, verify sha256, atomically swap `$DATA/bin/screens-gateway`, reply, then exit(0) so Docker restarts on the new binary |
| `sys.restart` | – | `{}` then exit(0) |
| `sys.logs` | `{lines?: 200}` | `{lines: ["..."]}` from an in-memory ring buffer |

### Network / discovery

| op | args | data |
|---|---|---|
| `net.neighbors` | – | `{entries: [{ip, mac, iface}]}` (from `/proc/net/arp` + `ip -6 neigh` if available) |
| `net.scan` | `{cidrs?: ["10.0.20.0/24"], ports: [5555, 8001, 8002, 3000, 3001, 1400, 8008, 8009], timeout_ms?: 400, concurrency?: 128}` | `{hosts: [{ip, mac?, open_ports: [..]}]}` — if `cidrs` is omitted, every IPv4 interface subnet /22 or smaller. TCP connect probe. |
| `net.probe` | `{targets: [{id, ip, port, kind: "tcp"\|"http", path?, timeout_ms?}]}` | `{results: [{id, ok, ms, status?, body?}]}` — `http` does GET `http://ip:port{path}`, body truncated to 8 KiB |
| `net.mdns_browse` | `{services: ["_googlecast._tcp", ...], duration_ms?: 3000}` | `{entries: [{instance, service, host, addrs: [..], port, txt: {k: v}, iface}]}` (services `[]` = `_services._dns-sd._udp` enumeration first) |
| `net.ssdp_search` | `{st?: "ssdp:all", duration_ms?: 3000}` | `{entries: [{ip, location, server, st, usn, iface}]}` |
| `net.wol` | `{mac, broadcast?: "10.0.20.255", port?: 9}` | `{sent: n}` — sends the magic packet on every multicast-capable interface (or to the given broadcast) |

### HTTP / WebSocket / TCP relay

| op | args | data |
|---|---|---|
| `http.request` | `{url, method?: "GET", headers?: {}, body?: "text", body_b64?: "...", timeout_ms?, insecure_tls?: true, max_body?: 2097152}` | `{status, headers: {k: v}, body?: "text", body_b64?: "...", truncated: bool}` — `body` if the response is valid UTF-8, else `body_b64` |
| `ws.open` | `{stream: "s_1", url: "wss://10.0.20.40:8002/api/v2/...", headers?: {}, insecure_tls?: true, subprotocols?: []}` | `{}` once connected. Then `stream` frames flow. |
| `tcp.open` | `{stream: "s_2", host: "10.0.20.31", port: 5555}` | `{}` once connected |
| `stream.close` | `{stream}` | `{}` |

Stream frames (both directions):

```json
{ "t": "stream", "stream": "s_1", "kind": "text", "data": "{...}" }
{ "t": "stream", "stream": "s_1", "kind": "binary", "data_b64": "AAEC" }
{ "t": "stream", "stream": "s_1", "kind": "close", "code": 1000, "reason": "" }
```

For `tcp.open`, all data is `binary`. The agent closes a stream idle for 10 min
and sends `close` when the remote side closes. A stream frame for an unknown
stream id is answered with a `close` frame.

### ADB

The agent runs the stock `adb` server (`adb start-server`, keys in
`$DATA/adb/`). `serial` is always `ip:port`.

| op | args | data |
|---|---|---|
| `adb.connect` | `{serial}` | `{state: "device"\|"unauthorized"\|"offline"\|"unreachable", output}` |
| `adb.disconnect` | `{serial}` | `{}` |
| `adb.devices` | – | `{devices: [{serial, state, model?}]}` |
| `adb.pair` | `{host, port, code}` | `{ok, output}` (Android 11+ wireless debugging) |
| `adb.shell` | `{serial, cmd, timeout_ms?}` | `{stdout, stderr, exit_code}` — auto-connects if not connected. stdout capped at 1 MiB (`truncated: true`) |
| `adb.install` | `{serial, url, sha256, flags?: ["-r", "-g"]}` | `{output}` — downloads to a temp file, verifies sha256, `adb -s serial install flags file` |
| `adb.uninstall` | `{serial, package, keep_data?: false, user?: 0}` | `{output}` |
| `adb.screencap` | `{serial, upload_url, max_width?: 1280, quality?: 70}` | `{bytes, width, height, content_type: "image/jpeg"}` — `exec-out screencap -p`, decode PNG, downscale, JPEG-encode, `PUT` to `upload_url` |
| `adb.push` | `{serial, url, sha256, remote_path}` | `{output}` |

### DNS

`dns.configure` args (also `welcome.config.dns`):

```json
{
  "enabled": true,
  "listen": ["0.0.0.0:53"],
  "dot": { "enabled": false, "listen": ["0.0.0.0:853"], "hostname": "q4mzt7xk2pa6wd3n.dns.screens.supercluster.au" },
  "upstreams": ["https://1.1.1.1/dns-query", "https://1.0.0.1/dns-query"],
  "block_response": "null",
  "cache": { "enabled": true, "max_entries": 20000, "min_ttl_s": 0, "max_ttl_s": 86400 },
  "default": { "policy": "monitor", "mode": "monitor" },
  "clients": {
    "10.0.20.31": { "device_id": "dev_1", "policy": "p_balanced", "mode": "enforce", "allow": ["example.com"], "block": [] }
  },
  "policies": {
    "p_balanced": { "version": "<sha256 of gz file>", "url": "https://.../agent/v1/files/...", "sha256": "<same>" }
  },
  "log": { "enabled": true }
}
```

- `listen`: `0.0.0.0:<port>` is **expanded by the agent** into one listener per
  non-loopback IPv4 address on physical/VLAN interfaces (skip `docker*`,
  `br-*`, `veth*`, `cni*`, `flannel*`, `tailscale*`, `lo`). This avoids clashing
  with systemd-resolved's `127.0.0.53:53` stub. `[::]:<port>` expands the same
  way over global/ULA IPv6 addresses. Explicit `ip:port` entries are used
  as-is. If one address fails to bind, log it and keep the others running.
- `mode`: `enforce` (block matches), `monitor` (never block, but log
  `would_block`), `off` (no filtering, still logged), `bypass` (no filtering,
  not logged).
- `policy` names a key in `policies`. A missing or not-yet-downloaded policy
  means nothing is blocked; log `action: "allow"` with `rule: "policy_missing"`.
- `block_response`: `null` answers `A 0.0.0.0` / `AAAA ::` with TTL 60 (for
  `A`/`AAAA`; other types get an empty NOERROR). `nxdomain` answers NXDOMAIN.
- Policy files are gzip'd UTF-8, one rule per line, `#` comments:

  ```
  # screens-policy v1 id=p_balanced
  b samsungacr.com acr
  b samsungads.com ads
  a samsungotn.net update
  ```
  `b` = block, `a` = allow. The second field is a domain that matches itself
  **and all subdomains**. The optional third field is a category tag reported
  back as `cat`. Lookup walks from the full qname to the TLD and takes the
  **most specific** match. When `a` and `b` both match at the same level, `a`
  wins. Per-client inline `allow`/`block` are checked before the policy file,
  in the same way.
- The agent downloads a policy only when its `version` differs from the one it
  holds. It verifies `sha256` and caches it at `$DATA/dns/<policy>.gz`.
- Upstream is DoH (RFC 8484, POST `application/dns-message`). Try upstreams in
  order, with a 2 s timeout each. If every DoH upstream fails, fall back to plain
  UDP `1.1.1.1:53`.
- DoT: when `dot.enabled` is set and `$DATA/tls/dot.crt` + `dot.key` exist,
  serve DNS over TLS on `dot.listen`. Clients are identified by source IP just
  like port 53.

`tls.csr` args `{hostname}` → data `{csr_pem}`. Generates (or reuses)
`$DATA/tls/dot.key` (ECDSA P-256) and returns a PEM CSR with CN and SAN =
hostname. The private key never leaves the gateway.
`tls.install` args `{cert_pem}` (full chain) → `{not_after}`. Writes
`$DATA/tls/dot.crt` and (re)starts the DoT listener.

`dns.stats` → `{since, queries, blocked, would_block, cache_hits, upstream_errors, qps_1m}`.
`dns.flush_cache` → `{}`.

Event **`dns.queries`**, batched every `telemetry.dns_batch_ms` or 500 entries,
whichever comes first. Drop the oldest beyond 20k buffered while the link is
down:

```json
{ "entries": [
  { "ts": 1764120000000, "client": "10.0.20.31", "device_id": "dev_1", "qname": "log-config.samsungacr.com", "qtype": "A",
    "action": "block", "cat": "acr", "rule": "samsungacr.com", "rcode": "NOERROR", "answers": ["0.0.0.0"], "ms": 0, "cached": false, "proto": "udp" }
]}
```

`action` ∈ `allow`, `block`, `would_block`. `rule` is the matching domain (or
`client_allow`/`client_block`). `answers` holds at most 8 A/AAAA/CNAME values.

### mDNS / SSDP reflector

`mdns.configure` args (also `welcome.config.mdns`):

```json
{
  "enabled": true,
  "interfaces": ["ens18", "ens18.20"],
  "rules": [
    { "from": "ens18.20", "to": ["ens18"], "allow": ["_sonos._tcp", "_spotify-connect._tcp", "_googlecast._tcp", "_airplay._tcp", "_raop._tcp"], "deny": [] },
    { "from": "ens18", "to": ["ens18.20"], "allow": ["*"], "deny": ["_hap._tcp"] }
  ],
  "ssdp": { "enabled": true, "rules": [ { "from": "ens18", "to": ["ens18.20"] }, { "from": "ens18.20", "to": ["ens18"] } ] },
  "rate_limit_pps": 200,
  "track_services": true
}
```

- Reflect a packet received on interface `from` (whose source isn't one of the
  gateway's own addresses) to `224.0.0.251:5353` / `[ff02::fb]:5353` on each
  `to` interface. Only reflect if the packet **matches** the rule: at least one
  name in the question/answer/authority/additional sections ends with an
  `allow` service type (`*` = anything) and no name ends with a `deny` type.
  Packets with no service-type names (plain A/AAAA for `host.local`) are
  reflected when the rule allows `*`, or when the hostname was seen in an
  allowed SRV record in the last 10 min.
- When reflecting a query, clear the QU (unicast-response) bit so responders
  answer by multicast.
- Loop prevention: never reflect packets whose source address belongs to the
  gateway, and drop a packet whose content hash was reflected in the last 1 s.
- SSDP: reflect `M-SEARCH` from `from` to `239.255.255.250:1900` on each `to`
  interface using an ephemeral socket bound to that interface, collect unicast
  responses for `MX`+1 s (max 5 s), and relay them unicast back to the original
  requester from the gateway's address on `from`. Reflect multicast `NOTIFY`
  packets according to the same rules.
- Rate limit per interface in packets/s, dropping above the limit.

`mdns.status` → `{enabled, interfaces: [{name, rx, tx, dropped}], services: [{service, instance, host, addrs, port, iface, last_seen}], counters: {reflected, filtered, rate_limited, ssdp_relayed}}`.

Event **`mdns.services`** every 60 s **when the list changed**: `{services: [ ...same as above... ]}`.

### Network legs (cap `netcfg`, gateway ≥ 0.3.0)

The dashboard can give the gateway an address on more VLANs without touching
the router or the host's own network config. A *leg* is either a VLAN
sub-interface on a trunked port (`kind: "vlan"`, created as `scr<vlan>`) or a
port the host left unconfigured (`kind: "existing"`, e.g. a second Proxmox
NIC). Addressing is DHCP (address and prefix only: no routes, no DNS servers,
no hostname changes) or a static private CIDR.

`net.configure` args (also `welcome.config.net`; persisted to `config.json`):

```json
{ "interfaces": [
  { "kind": "vlan", "parent": "eth0", "vlan": 50, "mode": "dhcp" },
  { "kind": "existing", "name": "ens19", "mode": "static", "address": "10.10.60.5/24" }
] }
```

The agent reconciles to exactly this list. It creates and raises missing
legs, removes legs that are no longer listed (and stray `scr*` links), and
refuses an `existing` port that already has addresses from the host. DHCP
legs renew at half the lease time; each address is installed with a lifetime
of lease + 30 s, so a dead gateway never squats on an address. Validation:
VLAN 1–4094, interface names `[A-Za-z0-9._-]{1,15}`, never lo, docker, br-,
veth, cni, flannel, tailscale, wg, tun, tap, virbr or zt; at most 32 legs.

Result (also `net.status`): `{interfaces: [{name, kind, parent?, vlan?, mode, state: "up"|"acquiring"|"error", addrs, error?, lease_at?, expires?}], errors: [string], host: [hello-style interface list]}`.

Whenever a leg's addresses change, the agent re-binds DNS/DoT/mDNS listeners
(so `0.0.0.0:53` expands to the new address) and sends event **`net.status`**
with the same shape. The hub stores it, refreshes the gateway's interface list
and re-reads the DNS listener state.

### Telemetry events

| `evt.type` | interval | data |
|---|---|---|
| `metrics` | `telemetry.metrics_ms` | `{uptime_s, load, mem, dns: {...dns.stats}, mdns: {...counters}, goroutines}` |
| `neighbors` | `telemetry.neighbors_ms` | `{entries: [{ip, mac, iface}]}` |
| `log` | as they happen (warn+) | `{level, msg, ts}` |
| `dns.queries` | see DNS | |
| `mdns.services` | see mDNS | |
| `net.status` | when leg addresses change | see Network legs |

## 6. Hub-side responsibilities (for reference)

The hub sends `welcome`, keeps a pending-request map keyed by `id`, times out
unanswered requests, stores DNS query logs in its SQLite, rolls up into D1, and
pushes config changes as `dns.configure` / `mdns.configure` whenever a device,
policy or rule changes.

## 7. Signed URLs

`/agent/v1/files/<key>?exp=<ms>&sig=<hex>` (GET) and
`/agent/v1/upload/<key>?exp=<ms>&sig=<hex>` (PUT) carry
`sig = hex(HMAC-SHA256(SIGNING_SECRET, method + "\n" + key + "\n" + exp))`.
The agent treats them as opaque URLs. These paths need no other auth.

---

## 8. Implementation notes (v0.1.0 gateway)

The gateway resolves these details beyond the sections above. They are part of the contract.

- **Base64url** values (keys, signatures, nonces) are unpadded. Padded input is accepted.
- **Frame cap.** Results are shrunk to fit the 512 KiB frame and marked `truncated: true`. In practice this caps `http.request` bodies and `adb.shell` stdout at about 400 KiB. Use signed URLs for anything bigger.
- **Signed URLs** (`url`, `upload_url`) must be on the central origin (same scheme, host and port as `SCREENS_CENTRAL_URL`). Anything else gets `forbidden`.
- **`http.request`**:
  - Redirects are returned as-is unless `follow_redirects: true` is passed.
  - Response header names are lower-cased, and repeated headers are joined with `", "`.
  - `insecure_tls` defaults to true and also allows legacy TLS 1.0 ciphers, for old TV firmware.
- **`ws.open`** may return `{subprotocol}`. Streams and pending requests are cancelled when the link drops, so the hub must reopen them after reconnecting. Close codes are 1001 for idle timeout, 1011 for an unknown stream, and 1009 when a frame is too big.
- **`dns.configure`**:
  - Each call replaces the whole config. Missing `enabled` means **false**, so DNS never binds port 53 by accident.
  - Invalid entries are skipped and reported, not fatal.
  - The result is `{enabled, listening, dot_listening, policy_versions, errors?}`. The hub stores it as the gateway's DNS status.
- **`mdns.configure`** returns `{enabled, interfaces, errors?}`. The top-level `enabled` also gates SSDP.
- **DNS server behaviour**:
  - Only clients from private ranges or the host's own subnets are answered (open-resolver protection).
  - Stale cache entries are served (TTL 30 s, up to 24 h old) when every upstream fails.
  - DoH hostnames are bootstrapped via 1.1.1.1.
  - Listen addresses are re-expanded every 30 s, picking up DHCP changes and VLANs that come up late.
- **`sys.update`** downloads to `.new.part` and verifies the sha256 and that it's an ELF binary for this CPU. It then renames to `.new`, swaps it in and exits 0, so a `.new` file is always a verified binary.
- **Clock skew** of more than 30 s is compensated using the hub's `Date` header (on a 401) and `welcome.server_time`.

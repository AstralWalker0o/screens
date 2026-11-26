# Screens architecture

Screens is a remote-management (RMM) and privacy platform for media devices:
smart TVs (Samsung Tizen, LG webOS), Android TV boxes (NVIDIA Shield and other
Android TV / Google TV devices) and Sonos speakers, across many sites.

```
                   ┌──────────────────────── Cloudflare ────────────────────────┐
  You (browser) ──▶│ Cloudflare Access ─▶ Worker "screens"                       │
                   │                        ├─ Dashboard (React SPA, static)     │
                   │                        ├─ REST API  /api/*                  │
                   │                        ├─ Gateway API /agent/v1/* (signed)  │
                   │                        ├─ Cron (blocklists, automations)    │
                   │                        │                                    │
                   │   D1  (fleet database) │   R2 (policies, APKs, screenshots, │
                   │                        │       gateway releases)            │
                   │   Durable Object "SiteHub" × one per site                   │
                   │     • holds the live link to that site's gateway            │
                   │     • device drivers (Android, Samsung, LG, Sonos)          │
                   │     • DNS query log (SQLite), schedules, alarms             │
                   └───────────────▲─────────────────────────────────────────────┘
                                   │ one outbound WebSocket (TLS, Ed25519-signed)
               ┌───────────────────┴────────── Site (Linux VM + Docker) ─────────┐
               │ screens-gateway (Go, host network)                              │
               │   • relay: HTTP / WebSocket / TCP to LAN devices (private IPs   │
               │     only), adb, Wake-on-LAN, port/mDNS/SSDP discovery           │
               │   • DNS filter for the TVs (UDP/TCP 53 + DNS-over-TLS 853)      │
               │     – compiled policies pushed from the cloud, DoH upstream     │
               │   • mDNS + SSDP reflector between VLANs (rules from the cloud)  │
               └──────┬───────────────┬──────────────┬───────────────────────────┘
                 Samsung/LG TVs   Shields (adb)   Sonos (UPnP)
```

## Principles

- **All the decisions are made in the cloud.** The gateway runs primitives:
  "send this HTTP request to 10.0.20.40", "run this adb shell command",
  "answer DNS with this compiled policy", "reflect these mDNS service types
  between these interfaces". Device protocols (Samsung's WebSocket remote, LG
  SSAP, Sonos SOAP, Android shell parsing), privacy scoring, automations and
  dashboards all live in the Worker / Durable Objects.
- **The site keeps working offline.** DNS filtering and the mDNS reflector run
  on the last configuration the gateway saved, so a dropped internet link
  never breaks DNS for the TVs.
- **Outbound only.** The gateway dials out to Cloudflare. Sites never open an
  inbound port or need port-forwarding.
- **Nothing on your router changes.** Devices are pointed at the Screens DNS
  individually: Android through Private DNS (set remotely over adb), and
  Samsung/LG by entering the DNS address once in the TV's own network
  settings. Your Palo Alto / UniFi config isn't touched.

## Security model

| Layer | Control |
|---|---|
| Dashboard login | Cloudflare Access (only your identity is allowed). The Worker re-verifies the Access JWT on every API call. |
| Gateway identity | One-time enrollment token (24 h, single use) → the gateway generates an Ed25519 key pair locally. Every connection is signed (timestamp + nonce, replay-protected). |
| Gateway revocation | "Revoke" in the dashboard immediately disconnects the gateway and rejects its key. |
| File transfer | Short-lived HMAC-signed URLs for policies, APKs, screenshots and updates. Gateway binaries are verified by SHA-256 before install. |
| Relay safety | The gateway refuses to relay to anything except private LAN addresses (never loopback or the internet), so it can't be turned into a proxy. |
| Device secrets | Samsung tokens and LG client keys are encrypted at rest (AES-GCM) in D1. The ADB key stays on the gateway. DoT private keys never leave the gateway (the cloud only sees the CSR). |
| Audit | Every non-trivial action (install, uninstall, guest reset, rule change, enrollment…) goes into the audit log with the actor. |

## Data

- **D1** holds clients, sites, gateways, devices, app inventory, APK library,
  app policies, DNS rules and list sources, policy builds, domain
  intelligence, hourly and daily DNS rollups, automations, jobs, alerts, audit
  and settings.
- **SiteHub SQLite** (one per site) holds the raw DNS query log (7 days by
  default), pending aggregates, gateway logs, mDNS services seen and probe
  state.
- **R2** holds compiled DNS policies (`policies/<name>/<sha>.gz`), raw
  community lists, APKs, the latest screenshot per device, and gateway
  releases.

## DNS filtering pipeline

1. A daily cron fetches community lists (Perflyst Smart TV, HaGeZi native
   Samsung / LG / Amazon, HaGeZi Light / Pro mini) into R2.
2. These are compiled together with the **curated catalog**
   (`central/src/worker/dns/catalog.ts`) and your own rules into **Balanced**
   and **Strict** policy files. The catalog covers ACR endpoints, ads and
   telemetry, plus allow-rules for firmware updates, clocks and streaming CDNs.
3. Gateways download a policy only when its hash changes. Each device gets a
   mode:
   - `monitor`: log what would be blocked. This is the default for new devices,
     for N days.
   - `enforce`: block.
   - `off`: no filtering, still logged.
   - `bypass`: not filtered or logged.
4. Every query is reported back. The site hub stores it and the dashboards,
   the privacy score and "new domain" detection read it.

## Live screen mirroring

The cloud pushes the scrcpy server (checksum-verified) to an Android box and starts it. The gateway's
`adb.stream` relays the box's local scrcpy socket as raw bytes. SiteHub turns the video into aligned H.264 units
and fans them out to each viewer's browser, which decodes them with WebCodecs. Viewer input goes back as
allow-listed scrcpy control messages. See [MIRROR.md](MIRROR.md).

## mDNS / SSDP reflector

You configure it per site: pick interfaces and add rules
(`from → to`, allowed service types, denied types), plus SSDP relay rules. The
gateway reflects only matching packets, clears the "unicast response" bit so
answers come back by multicast, stops loops and rate-limits. It also
reports every service it sees, which makes the reflector double as an
inventory of what's on each VLAN.

## Repo layout

```
central/            Cloudflare Worker + dashboard (TypeScript)
  src/worker/       API, SiteHub Durable Object, device drivers, DNS, privacy, automations, ACME
  src/ui/           React dashboard
  src/shared/       types shared by both
  migrations/       D1 schema
gateway/            Go site agent (Docker)
tools/sim/          device simulators for end-to-end tests (Samsung, Sonos, fake adbd)
tools/release-gateway.sh   publish a gateway build to the central app
docs/               PROTOCOL.md (gateway ↔ hub), API.md, SETUP.md, this file
```

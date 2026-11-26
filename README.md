# Screens

**Remote management and privacy protection for smart TVs, Android TV boxes and Sonos, across every site you look after.**

Screens is the successor to ShieldControl, rebuilt from scratch:

- **Central app on Cloudflare.** Workers, D1, Durable Objects and R2, behind
  Cloudflare Access. All the logic, dashboards and history live there.
- **A tiny gateway at each site.** One Docker container on a Linux VM that dials
  out to Cloudflare and acts as a gateway into the local network. It needs no
  open ports and no router changes.

## What it does

| | |
|---|---|
| **Fleet RMM** | Clients → sites → devices, with live status, power, current app and alerts. |
| **Remote control** | A remote (D-pad, volume, power, text) for Samsung, LG and Android TV, plus screenshots with click-to-tap on Android. For Sonos: now playing, transport, volume, grouping and LED. |
| **Android TV / Shield** | ADB from the browser: app inventory, launch, stop, clear, disable/enable, uninstall, install from your APK library, a shell console, reboot and Private DNS. |
| **Privacy** | A DNS filter just for the media devices. It shows every lookup, flags ACR ("what you watch" tracking), ads and telemetry, and blocks them using maintained community lists plus a curated TV catalog. Each device gets a privacy score, a vendor checklist of settings to turn off, and a "which apps can use the microphone" list. It also alerts you when a device is bypassing the filter. |
| **mDNS / SSDP reflector** | Lets the Sonos app (and AirPlay, Chromecast, Spotify Connect) work across VLANs, with per-service allow/deny rules managed from the dashboard. |
| **Automations** | Schedules (e.g. TVs off at midnight) and event triggers (device offline, new app, ACR detected) running commands, guest resets, app policy enforcement, DNS mode changes or alerts. |
| **Rentals** | One-click guest reset (signs out of Netflix, YouTube, Stan…), app policies and kiosk allow-lists. |

## Docs

- [docs/SETUP.md](docs/SETUP.md): bringing a site online, step by step
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together, and the security model
- [docs/PROTOCOL.md](docs/PROTOCOL.md): gateway ↔ cloud protocol
- [docs/API.md](docs/API.md): dashboard API

## Development

```bash
# central app (Worker + dashboard)
cd central && npm install
npx wrangler d1 migrations apply screens --local
npm run dev            # http://127.0.0.1:5173  (local dev skips Access)
npm test

# gateway
cd gateway && go test ./... && ./build.sh

# end-to-end: simulated LAN (netns) with a Samsung TV, 2 Sonos and 2 Shields (real adb wire protocol),
# local central Worker, and the real gateway binary — ~60 checks across every feature
sudo tools/e2e/run.sh
```

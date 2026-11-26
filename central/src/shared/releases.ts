// Release history shown in the dashboard's "What's new" panel.
// Newest first. Bump APP_VERSION by adding an entry here before each deploy.

export type ReleaseNoteKind = 'new' | 'improved' | 'fixed' | 'security';

export interface ReleaseNote { kind: ReleaseNoteKind; text: string }

export interface Release {
  version: string;          // semver of the central app (dashboard + Worker)
  date: string;             // YYYY-MM-DD
  title: string;
  summary?: string;
  notes: ReleaseNote[];
  /** Component versions that shipped with (or alongside) this release. */
  components?: { gateway?: string; launcher?: string };
}

export const RELEASES: Release[] = [
  {
    version: '0.2.0',
    date: '2026-11-26',
    title: 'Rental launcher, privacy controls and Sonos extras',
    summary: 'Kiosk launcher and welcome screen for rentals, per-app microphone blocking, and much richer Sonos control.',
    components: { gateway: '0.1.1', launcher: '1.0.0' },
    notes: [
      { kind: 'new', text: 'Screens Launcher for Android TV: a kiosk home screen showing only the apps you allow, plus a welcome screen with Wi-Fi QR code and house info. Shown on boot and after every guest reset.' },
      { kind: 'new', text: 'Welcome screen and kiosk editor on the Guest tab, with a live TV preview and an exit PIN (stored only as a hash).' },
      { kind: 'new', text: 'Block an app\'s microphone, camera, location or contacts access from the Apps tab.' },
      { kind: 'new', text: 'One-click "Debloat" disables known bloat and tracker apps (reversible; never uninstalls).' },
      { kind: 'new', text: 'Sonos: favourites (play radio and playlists), EQ (bass, treble, loudness), Night Sound and Speech Enhancement on soundbars, sleep timer, LED state and track progress.' },
      { kind: 'new', text: 'Samsung: switch input (TV, HDMI 1–4).' },
      { kind: 'new', text: 'Wireless-debugging pairing for newer Google TV / Android 11+ boxes, with the debug port picked up automatically from discovery.' },
      { kind: 'new', text: 'Bulk actions across devices in one request, including changing DNS mode for many devices at once.' },
      { kind: 'new', text: '"ACR attempts by vendor" on the Privacy page.' },
      { kind: 'improved', text: 'mDNS reflector strips only denied services from an announcement instead of dropping it, so denying HomeKit no longer hides AirPlay from the same Apple TV.' },
      { kind: 'improved', text: 'A new site builds the DNS blocklists itself if the daily job hasn\'t run yet, so the first gateway is protected immediately.' },
      { kind: 'improved', text: 'Samsung setup guidance now covers "IP Remote" (needed on 2022+ models).' },
      { kind: 'fixed', text: 'Device MAC addresses now come from the gateway\'s ARP table, so Wake-on-LAN and DHCP tracking work for wired Samsung TVs and Shields on Wi-Fi.' },
      { kind: 'fixed', text: 'Samsung and LG replies are parsed as JSON, so pairing no longer depends on how the TV formats its messages.' },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-11-26',
    title: 'First release',
    summary: 'The rebuilt platform: a central app on Cloudflare with a thin gateway at each site.',
    components: { gateway: '0.1.0' },
    notes: [
      { kind: 'new', text: 'Central app on Cloudflare (Workers, D1, Durable Objects, R2) behind Cloudflare Access.' },
      { kind: 'new', text: 'Site gateway: one Docker container that dials out to Cloudflare. No open ports and no router changes. One-line install and self-updating.' },
      { kind: 'new', text: 'Discovery and adoption of Samsung and LG TVs, Android TV boxes (NVIDIA Shield) and Sonos speakers.' },
      { kind: 'new', text: 'Remote control, app management over ADB from the browser, screenshots with click-to-tap, and an ADB shell console.' },
      { kind: 'new', text: 'TV-only DNS filter: monitor-then-enforce, Balanced and Strict policies built from community lists plus a curated TV catalogue, a live query log, and per-device allow/block.' },
      { kind: 'new', text: 'Privacy score, vendor privacy checklists and DNS-bypass detection for every device.' },
      { kind: 'new', text: 'mDNS / SSDP reflector between VLANs with per-service rules, so the Sonos app works across VLANs.' },
      { kind: 'new', text: 'Automations (schedules and events), guest reset for rentals, app policies, APK library and audit log.' },
      { kind: 'security', text: 'Gateways use one-time enrollment, Ed25519-signed connections, and replay protection. They only relay to private LAN addresses.' },
    ],
  },
];

export const APP_VERSION = RELEASES[0].version;

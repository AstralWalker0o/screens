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
    version: '0.5.1',
    date: '2026-11-26',
    title: 'Live view that tells you what went wrong',
    summary: 'A live view that connects but gets no picture now says so, and Screens keeps a diagnostic trail for troubleshooting.',
    components: { gateway: '0.3.0', launcher: '1.0.0' },
    notes: [
      { kind: 'fixed', text: 'If a box connects but sends no picture, the live view asks it for a fresh picture, then explains what to try after 20 seconds instead of showing "Starting…" forever.' },
      { kind: 'improved', text: 'Screens now records slow or failed gateway calls, gateway warnings and each step of a live view (kept for 7 days), so problems at a site can be traced without asking you to repeat them.' },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-11-26',
    title: 'Sonos, properly',
    summary: 'Play that actually starts the music, album art, queue, grouping, playlists and a Sonos tab for each site.',
    components: { gateway: '0.3.0', launcher: '1.0.0' },
    notes: [
      { kind: 'fixed', text: 'Pressing Play on a Sonos speaker now really starts the music. If the app that was playing (like YouTube Music or Spotify) has finished, Screens starts the Sonos queue instead and tells you so.' },
      { kind: 'improved', text: 'When something can\'t be played, Screens says why in plain words instead of an error number, and the speaker page shows the last problem until it\'s fixed.' },
      { kind: 'new', text: 'Album covers for what\'s playing, the queue and favourites.' },
      { kind: 'new', text: 'The speaker page updates by itself while it\'s open: song, time and who\'s grouped.' },
      { kind: 'new', text: 'Shuffle, repeat and crossfade buttons, and a bar you can drag to jump within a song.' },
      { kind: 'new', text: 'See the queue, jump to any song in it, remove songs or clear it.' },
      { kind: 'new', text: 'Play your Sonos playlists, and switch to the TV or a plugged-in line-in where the speaker has one.' },
      { kind: 'new', text: 'Group any rooms together or "Group all rooms", with volume for the whole group or each room. Subs and surround speakers show as part of their room.' },
      { kind: 'new', text: 'Speaker settings: lock the buttons, home-theatre levels (Sub, surrounds, lip-sync) and Sonos alarms on or off. The sleep timer shows the minutes left.' },
      { kind: 'new', text: 'A Sonos tab on each site with Sonos: every room at once, with play/pause, volumes, moving rooms between groups and "Pause all".' },
      { kind: 'fixed', text: 'Playing a favourite after regrouping now uses the right speaker, turning Night Sound or Speech Enhancement off is reported correctly, and titles with "&" display properly.' },
    ],
  },
  {
    version: '0.4.1',
    date: '2026-11-26',
    title: 'Private DNS hostnames that don\'t reveal your sites',
    summary: 'Each site\'s encrypted-DNS hostname is now a random name, and failed certificate requests retry by themselves.',
    components: { gateway: '0.3.0', launcher: '1.0.0' },
    notes: [
      { kind: 'security', text: 'Private DNS hostnames are now random (e.g. q4mzt7xk2pa6wd3n.dns.screens.supercluster.au) instead of the site name. Hostnames end up in public DNS and in public certificate logs, so site and client names are no longer exposed.' },
      { kind: 'improved', text: 'A Private DNS certificate that couldn\'t be issued is retried automatically: straight away once the Cloudflare token is added, otherwise every 30 minutes. Site → Settings also has a Retry now button.' },
      { kind: 'improved', text: 'When you add a VLAN to the gateway, the site\'s Private DNS hostname moves to the gateway address on the network where most Android boxes are.' },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-11-26',
    title: 'Add VLANs to the gateway from the dashboard',
    summary: 'Give a site\'s gateway a leg on another VLAN in a couple of clicks, so it can reach, pair with and filter devices there.',
    components: { gateway: '0.3.0', launcher: '1.0.0' },
    notes: [
      { kind: 'new', text: 'Gateway → Network interfaces → Add network: put the gateway on another VLAN, either as a tagged VLAN on its port or on a spare network port (such as a second network device on a Proxmox VM). DHCP or a fixed address.' },
      { kind: 'new', text: 'The DNS filter, discovery and the mDNS reflector pick up new networks automatically. Remove one and the gateway gives its address back.' },
      { kind: 'improved', text: 'Your router and the gateway machine\'s own network settings are left alone: Screens only takes an address on each VLAN, with no routes or DNS changes.' },
      { kind: 'fixed', text: 'Samsung pairing explains the real problem when the TV is on a different VLAN from the gateway. Samsung only shows its "Allow" prompt to devices on its own network, so the fix is to add that VLAN to the gateway.' },
      { kind: 'security', text: 'The Cloudflare DNS token now lives only as an encrypted Cloudflare Worker secret (CF_DNS_TOKEN) instead of in the app. The Settings page shows whether it\'s set and how to add it.' },
      { kind: 'fixed', text: 'Settings → About shows the real version.' },
    ],
  },
  {
    version: '0.3.2',
    date: '2026-11-26',
    title: 'Samsung 2024–2025 (Tizen 9) pairing',
    summary: 'Pairing works with newer Samsung TVs, and the instructions point to the right menus.',
    components: { gateway: '0.2.0', launcher: '1.0.0' },
    notes: [
      { kind: 'fixed', text: 'Pairing with 2024–2025 Samsung TVs (Tizen 9), which wait for the app to introduce itself before showing the "Allow" prompt.' },
      { kind: 'fixed', text: 'Samsung instructions now use the current menus: Settings → All Settings → Connection → External Device Manager → Device Connection Manager.' },
      { kind: 'improved', text: 'When a Samsung refuses or the prompt times out, Screens records exactly which happened and shows the matching fix.' },
      { kind: 'fixed', text: 'Samsung TV names with quotes (e.g. 75" QLED) no longer show HTML codes.' },
      { kind: 'fixed', text: 'Removed the incorrect "IP Remote" step; it isn\'t needed for Screens.' },
    ],
  },
  {
    version: '0.3.1',
    date: '2026-11-26',
    title: 'Discovery fixes from the first real site',
    summary: 'Fixes found while bringing the first house online.',
    components: { gateway: '0.2.0', launcher: '1.0.0' },
    notes: [
      { kind: 'fixed', text: 'Devices that only open port 3000 (e.g. Grafana or other web apps) are no longer mistaken for LG TVs. LG needs ports 3000 and 3001, or a webOS announcement.' },
      { kind: 'improved', text: 'Discovery always scans the gateway\'s own subnet as well as any extra subnets you add in site settings.' },
      { kind: 'improved', text: 'The Discover list shows the latest scan only, so stale entries from earlier scans disappear.' },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-11-26',
    title: 'Live screen mirroring',
    summary: 'Watch and control an Android TV box\'s screen live from the dashboard.',
    components: { gateway: '0.2.0', launcher: '1.0.0' },
    notes: [
      { kind: 'new', text: 'Live screen mirroring for Android TV boxes (NVIDIA Shield and others), powered by the open-source scrcpy server. H.264 is decoded in your browser at up to 1080p/60 fps.' },
      { kind: 'new', text: 'Control the live picture directly: click or tap to touch, scroll, type, and use Back / Home / Recent apps / volume / power buttons. "Screen off on TV" keeps mirroring with the TV panel dark.' },
      { kind: 'new', text: 'Several people can watch the same box at once. New viewers get a fresh keyframe immediately.' },
      { kind: 'improved', text: 'Site gateways relay binary data natively instead of base64, a third less bandwidth for streams.' },
      { kind: 'security', text: 'The gateway only opens scrcpy\'s own local socket on a device, the cloud forwards only known input message types, and the scrcpy server is checksum-verified against the upstream release before it is pushed to a device.' },
    ],
  },
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

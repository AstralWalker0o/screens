// Mock fixtures: the owner's real test fleet — 2 clients, 3 sites (one rental),
// 3 Samsung TVs, 3 NVIDIA Shields, 2 Sonos speakers and 1 LG TV still pairing.

import type {
  Alert, Apk, AppPolicy, AppSettings, AuditEntry, Automation, ChecklistItem, Client, Device, DeviceApp, DeviceCapability,
  Discovered, DnsList, DnsPolicyBuild, DnsRule, Gateway, GuestSettings, Job, MdnsConfig, MdnsService, MicUsage, PrivacyFactor, SiteDetail,
  SiteSettings,
} from '../../shared/types';
import { hex } from './rand';

export const NOW = Date.now();
export const S = 1000;
export const M = 60 * S;
export const H = 60 * M;
export const D = 24 * H;
/** Most recent midnight in Sydney (AEDT, UTC+11). */
export const LAST_MIDNIGHT = Math.floor((NOW + 11 * H) / D) * D - 11 * H;

export const clients: Client[] = [
  { id: 'cl_home', name: 'Home', contact: null, notes: 'My own place — the test fleet.', created_at: NOW - 140 * D },
  { id: 'cl_coastal', name: 'Coastal Rentals', contact: 'bookings@coastalrentals.example', notes: 'Holiday rentals on the NSW north coast. Cleaners turn over Fri–Sun.', created_at: NOW - 61 * D },
];

const baseSettings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  monitor_days: 7,
  default_policy: 'balanced',
  unknown_clients: 'monitor',
  scan_cidrs: [],
  dot_enabled: false,
  guest: defaultGuest(),
  ...over,
});

export function defaultGuest(over: Partial<GuestSettings> = {}): GuestSettings {
  return {
    clear_packages: [], go_home: true, reboot: false, show_welcome_after_reset: false,
    welcome: { enabled: false, show_on_boot: true, title: 'Welcome', message: '', wifi: null, sections: [], contact: '', accent: '#4F8EF7' },
    kiosk: { enabled: false, allowed: [], pinned: [], force_home: false, pin_set: false },
    ...over,
  };
}

const iface = (name: string, mac: string, addrs: string[], multicast = true, up = true) => ({ name, mac, addrs, up, multicast });

export const gateways: Gateway[] = [
  {
    id: 'gw_home', site_id: 's_home', hostname: 'screens-gw', version: '0.4.2', os: 'linux', arch: 'amd64', status: 'online',
    last_seen: NOW - 6 * S, connected_at: NOW - 6 * D - 3 * H, created_at: NOW - 120 * D,
    interfaces: [
      iface('eth0', 'bc:24:11:4e:20:01', ['192.168.1.5/24', 'fe80::be24:11ff:fe4e:2001/64']),
      iface('eth0.20', 'bc:24:11:4e:20:01', ['10.0.20.5/24']),
      iface('eth0.30', 'bc:24:11:4e:20:01', ['10.0.30.5/24']),
      iface('docker0', '02:42:9c:3a:11:0e', ['172.17.0.1/16'], false),
    ],
    caps: ['adb', 'dns', 'dot', 'mdns', 'ssdp', 'discovery', 'wol', 'http', 'ws', 'tcp', 'update'],
    metrics: {
      uptime_s: 6 * 86400 + 3 * 3600 + 1260, load: [0.08, 0.11, 0.09], mem: { total: 2_048_000_000, available: 1_311_000_000 },
      dns: { queries: 0, blocked: 0, would_block: 0, cache_hits: 0, upstream_errors: 3, qps_1m: 4.2 },
      mdns: { reflected: 18_204, filtered: 2_311, rate_limited: 4, ssdp_relayed: 1_022 },
    },
    dns_listening: ['192.168.1.5:53', '10.0.20.5:53', '10.0.30.5:53'],
    dot_listening: ['10.0.20.5:853'],
    latest_version: '0.4.2',
  },
  {
    id: 'gw_beach', site_id: 's_beach', hostname: 'beachhouse-gw', version: '0.4.1', os: 'linux', arch: 'arm64', status: 'online',
    last_seen: NOW - 11 * S, connected_at: NOW - 2 * D - 7 * H, created_at: NOW - 58 * D,
    interfaces: [
      iface('end0', 'dc:a6:32:01:7f:10', ['10.1.10.4/24']),
      iface('end0.20', 'dc:a6:32:01:7f:10', ['10.1.20.4/24']),
    ],
    caps: ['adb', 'dns', 'mdns', 'ssdp', 'discovery', 'wol', 'http', 'ws', 'tcp', 'update'],
    metrics: {
      uptime_s: 2 * 86400 + 7 * 3600, load: [0.21, 0.18, 0.15], mem: { total: 4_096_000_000, available: 3_020_000_000 },
      dns: { queries: 0, blocked: 0, would_block: 0, cache_hits: 0, upstream_errors: 0, qps_1m: 1.6 },
      mdns: { reflected: 4_120, filtered: 380, rate_limited: 0, ssdp_relayed: 0 },
    },
    dns_listening: ['10.1.10.4:53', '10.1.20.4:53'],
    dot_listening: [],
    latest_version: '0.4.2',
  },
];

export const sites: Omit<SiteDetail, 'devices' | 'gateway' | 'gateway_status' | 'gateway_last_seen' | 'devices_total' | 'devices_online' | 'dns_queries_24h' | 'dns_blocked_24h' | 'alerts_open' | 'client_name'>[] = [
  {
    id: 's_home', client_id: 'cl_home', name: 'Home', slug: 'home', kind: 'residential', timezone: 'Australia/Sydney', address: 'Bondi NSW',
    created_at: NOW - 120 * D, notes: null,
    settings: baseSettings({ dot_enabled: true, scan_cidrs: ['10.0.20.0/24'] }),
    dot_hostname: 'home.dns.screens.supercluster.au', dot_status: 'Certificate active · 1 device using Private DNS',
  },
  {
    id: 's_beach', client_id: 'cl_coastal', name: 'Beach House', slug: 'beach-house', kind: 'rental', timezone: 'Australia/Sydney', address: '14 Marine Pde, Byron Bay NSW',
    created_at: NOW - 58 * D, notes: 'Lockbox code in 1Password. Router is in the laundry cupboard.',
    settings: baseSettings({
      monitor_days: 3, unknown_clients: 'enforce',
      guest: defaultGuest({
        clear_packages: ['com.netflix.ninja', 'au.com.stan.and', 'com.google.android.youtube.tv', 'com.disney.disneyplus', 'com.amazon.amazonvideo.livingroom', 'com.spotify.tv.android'],
        go_home: true, reboot: true, show_welcome_after_reset: true,
        welcome: {
          enabled: true, show_on_boot: true, title: 'Welcome to Beach House', message: 'We hope you have a wonderful stay. Everything you need is below.',
          wifi: { ssid: 'BeachHouse-Guest', password: 'sunny-days-2026', security: 'WPA' },
          sections: [
            { title: 'Checkout', body: 'Please check out by 11 am. Leave keys in the lockbox.' },
            { title: 'TV tips', body: 'Press Home to come back here. Your sign-ins are cleared after you leave.' },
          ],
          contact: 'Questions? Text the Coastal Rentals team on 0400 000 000', accent: '#4F8EF7',
        },
        kiosk: {
          enabled: true, allowed: ['com.netflix.ninja', 'com.google.android.youtube.tv', 'au.com.stan.and', 'com.disney.disneyplus', 'com.amazon.amazonvideo.livingroom', 'com.spotify.tv.android', 'au.net.abc.iview'],
          pinned: ['com.netflix.ninja', 'com.google.android.youtube.tv', 'au.com.stan.and'], force_home: false, pin_set: true,
        },
      }),
    }),
    dot_hostname: 'beach-house.dns.screens.supercluster.au', dot_status: 'Off',
  },
  {
    id: 's_office', client_id: 'cl_coastal', name: 'Coastal Rentals Office', slug: 'office', kind: 'business', timezone: 'Australia/Sydney', address: 'Ballina NSW',
    created_at: NOW - 9 * D, notes: null, settings: baseSettings(), dot_hostname: null, dot_status: null,
  },
];

const ANDROID_CAPS: DeviceCapability[] = ['remote', 'text', 'apps', 'launch', 'install', 'uninstall', 'disable', 'clear', 'screenshot', 'tap', 'shell', 'reboot', 'power', 'volume', 'private_dns', 'media', 'toast', 'guest_reset', 'launcher'];
const SAMSUNG_CAPS: DeviceCapability[] = ['remote', 'text', 'apps', 'launch', 'power', 'volume', 'guest_reset'];
const LG_CAPS: DeviceCapability[] = ['remote', 'text', 'apps', 'launch', 'power', 'volume', 'toast'];
const SONOS_CAPS: DeviceCapability[] = ['volume', 'media', 'group'];

type DevSeed = Omit<Device, 'dns_allow' | 'dns_block' | 'tags' | 'facts' | 'created_at' | 'updated_at' | 'capabilities'> &
  Partial<Pick<Device, 'dns_allow' | 'dns_block' | 'tags' | 'facts' | 'capabilities' | 'created_at' | 'updated_at'>>;

function dev(d: DevSeed): Device {
  const caps = d.capabilities ?? (d.kind === 'android' ? ANDROID_CAPS : d.kind === 'samsung' ? SAMSUNG_CAPS : d.kind === 'lg' ? LG_CAPS : d.kind === 'sonos' ? SONOS_CAPS : []);
  return { dns_allow: [], dns_block: [], tags: [], facts: {}, created_at: NOW - 40 * D, updated_at: NOW - 2 * H, ...d, capabilities: caps };
}

export const devices: Device[] = [
  dev({
    id: 'dev_lr_tv', site_id: 's_home', kind: 'samsung', name: 'Living Room TV', room: 'Living room', ip: '10.0.20.40', mac: '70:2a:d5:1c:88:e4', port: 8002,
    manufacturer: 'Samsung', model: 'QA65QN90DAWXXY', os_version: 'Tizen 8.0', firmware: '1621.4', serial: '0B8R3CNX400112',
    status: 'online', power: 'on', current_app: 'Netflix', last_seen: NOW - 20 * S, tags: ['tv', 'main'],
    dns_mode: 'enforce', dns_policy: 'balanced', privacy_score: 62,
    facts: { year: 2024, series: 'Neo QLED QN90D', wol: true, resolution: '3840×2160', art_mode: false },
  }),
  dev({
    id: 'dev_bed_tv', site_id: 's_home', kind: 'samsung', name: 'Bedroom TV', room: 'Main bedroom', ip: '10.0.20.41', mac: '70:2a:d5:3e:01:9a', port: 8002,
    manufacturer: 'Samsung', model: 'QA55LS03DAWXXY', os_version: 'Tizen 8.0', firmware: '1620.2',
    status: 'standby', power: 'standby', current_app: null, last_seen: NOW - 50 * S, tags: ['tv'],
    dns_mode: 'monitor', dns_policy: 'balanced', monitor_until: NOW + 4 * D + 5 * H, privacy_score: 54,
    created_at: NOW - 3 * D,
    facts: { year: 2024, series: 'The Frame', wol: true, art_mode: true },
  }),
  dev({
    id: 'dev_lr_shield', site_id: 's_home', kind: 'android', name: 'Living Room Shield', room: 'Living room', ip: '10.0.20.31', mac: '00:04:4b:e5:91:02', port: 5555,
    manufacturer: 'NVIDIA', model: 'SHIELD Android TV Pro', os_version: 'Android 11 (Shield 9.2.0)', serial: '1323219012345',
    status: 'online', power: 'on', current_app: 'Plex', last_seen: NOW - 15 * S, tags: ['streamer', 'main'],
    dns_mode: 'enforce', dns_policy: 'balanced', private_dns: 'home.dns.screens.supercluster.au', privacy_score: 86,
    facts: { sdk: 30, build: '9.2.0', screen: '3840×2160', package: 'com.plexapp.android', launcher: { installed: false, checked_at: NOW - 1 * D } },
  }),
  dev({
    id: 'dev_sonos_lr', site_id: 's_home', kind: 'sonos', name: 'Living Room', room: 'Living room', ip: '10.0.20.60', mac: '48:a6:b8:72:10:3c', port: 1400,
    manufacturer: 'Sonos', model: 'Sonos Arc', os_version: 'S2 · 17.2', status: 'online', power: 'on', current_app: 'Spotify', last_seen: NOW - 9 * S, tags: ['audio'],
    dns_mode: 'enforce', dns_policy: 'balanced', privacy_score: 88,
    facts: {
      uuid: 'RINCON_48A6B872103C01400', room: 'Living Room', model_number: 'S19', display_version: '17.2', led: true,
      now_playing: { state: 'PLAYING', title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We’re Dreaming', volume: 28, muted: false, source: 'Spotify', duration_s: 243, position_s: 87 },
      group: { coordinator: 'RINCON_48A6B872103C01400', is_coordinator: true, members: [{ uuid: 'RINCON_48A6B872103C01400', name: 'Living Room', ip: '10.0.20.60' }, { uuid: 'RINCON_48A6B89C44D101400', name: 'Kitchen', ip: '10.0.20.61' }] },
    },
  }),
  dev({
    id: 'dev_sonos_kitchen', site_id: 's_home', kind: 'sonos', name: 'Kitchen', room: 'Kitchen', ip: '10.0.20.61', mac: '48:a6:b8:9c:44:d1', port: 1400,
    manufacturer: 'Sonos', model: 'Sonos Era 100', os_version: 'S2 · 17.2', status: 'online', power: 'on', current_app: 'Spotify', last_seen: NOW - 9 * S, tags: ['audio'],
    dns_mode: 'enforce', dns_policy: 'balanced', privacy_score: 92,
    facts: {
      uuid: 'RINCON_48A6B89C44D101400', room: 'Kitchen', model_number: 'S39', display_version: '17.2', led: false,
      now_playing: { state: 'PLAYING', title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We’re Dreaming', volume: 22, muted: false, source: 'Spotify', duration_s: 243, position_s: 87 },
      group: { coordinator: 'RINCON_48A6B872103C01400', is_coordinator: false, members: [{ uuid: 'RINCON_48A6B872103C01400', name: 'Living Room', ip: '10.0.20.60' }, { uuid: 'RINCON_48A6B89C44D101400', name: 'Kitchen', ip: '10.0.20.61' }] },
    },
  }),
  dev({
    id: 'dev_study_lg', site_id: 's_home', kind: 'lg', name: 'Study TV', room: 'Study', ip: '10.0.20.45', mac: 'a8:23:fe:0d:52:77', port: 3001,
    manufacturer: 'LG', model: 'OLED48C3PSA', os_version: 'webOS 23', status: 'pairing', power: 'on', current_app: null, last_seen: NOW - 70 * S,
    dns_mode: 'monitor', dns_policy: 'balanced', monitor_until: NOW + 6 * D + 22 * H, privacy_score: null, created_at: NOW - 2 * H,
    facts: { pairing_started: NOW - 95 * S, webos: '23' },
  }),
  dev({
    id: 'dev_beach_tv', site_id: 's_beach', kind: 'samsung', name: 'Lounge TV', room: 'Lounge', ip: '10.1.20.40', mac: '8c:ea:48:61:aa:05', port: 8002,
    manufacturer: 'Samsung', model: 'QA75Q80CAWXXY', os_version: 'Tizen 7.0', firmware: '1513.6', status: 'online', power: 'on', current_app: 'YouTube',
    last_seen: NOW - 25 * S, tags: ['tv', 'guest'], dns_mode: 'enforce', dns_policy: 'balanced', privacy_score: 71,
    facts: { year: 2023, series: 'QLED Q80C', wol: true },
  }),
  dev({
    id: 'dev_beach_shield', site_id: 's_beach', kind: 'android', name: 'Lounge Shield', room: 'Lounge', ip: '10.1.20.31', mac: '00:04:4b:a1:0c:73', port: 5555,
    manufacturer: 'NVIDIA', model: 'SHIELD Android TV', os_version: 'Android 11 (Shield 9.2.0)', status: 'online', power: 'on', current_app: 'Stan',
    last_seen: NOW - 12 * S, tags: ['streamer', 'guest'], dns_mode: 'enforce', dns_policy: 'strict', privacy_score: 81,
    facts: { sdk: 30, build: '9.2.0', screen: '3840×2160', package: 'au.com.stan.and', launcher: { installed: true, version: '1.0.2', config_sha: 'a91f0c', is_home: true, checked_at: NOW - 9 * H } },
  }),
  dev({
    id: 'dev_beach_bed_shield', site_id: 's_beach', kind: 'android', name: 'Master Bedroom Shield', room: 'Master bedroom', ip: '10.1.20.32', mac: '00:04:4b:a1:0d:19', port: 5555,
    manufacturer: 'NVIDIA', model: 'SHIELD Android TV', os_version: 'Android 11 (Shield 9.1.1)', status: 'offline', power: null, current_app: null,
    last_seen: NOW - 3 * H - 12 * M, tags: ['streamer', 'guest'], dns_mode: 'enforce', dns_policy: 'strict', privacy_score: 58,
    facts: { sdk: 30, build: '9.1.1', launcher: { installed: true, version: '1.0.1', config_sha: '77be12', is_home: true, checked_at: NOW - 3 * H - 20 * M } },
  }),
];

// ---------------------------------------------------------------------------
// Apps

const app = (pkg: string, label: string, o: Partial<DeviceApp> = {}): DeviceApp => ({
  package: pkg, label, version_name: 'version_name' in o ? o.version_name : '1.0', version_code: null, system: false, enabled: true, permissions: [],
  category: null, risk: null, first_seen: NOW - 30 * D, last_seen: NOW - 5 * M, ...o,
});
const MIC = 'android.permission.RECORD_AUDIO';
const CAM = 'android.permission.CAMERA';

function shieldApps(extra: DeviceApp[] = []): DeviceApp[] {
  return [
    app('com.netflix.ninja', 'Netflix', { version_name: '9.6.0 build 2', category: 'streaming', permissions: [] }),
    app('com.google.android.youtube.tv', 'YouTube', { version_name: '4.40.303', category: 'streaming', permissions: [MIC] }),
    app('com.plexapp.android', 'Plex', { version_name: '10.24.0.4142', category: 'streaming' }),
    app('au.com.stan.and', 'Stan', { version_name: '4.32.1', category: 'streaming' }),
    app('com.disney.disneyplus', 'Disney+', { version_name: '24.11.04', category: 'streaming' }),
    app('com.amazon.amazonvideo.livingroom', 'Prime Video', { version_name: '6.17.2', category: 'streaming', risk: 'medium' }),
    app('com.spotify.tv.android', 'Spotify', { version_name: '1.92.0', category: 'music' }),
    app('au.net.abc.iview', 'ABC iview', { version_name: '4.21.0', category: 'streaming' }),
    app('com.google.android.katniss', 'Google app', { system: true, version_name: '4.39.2', category: 'assistant', permissions: [MIC], risk: 'medium' }),
    app('com.google.android.tvlauncher', 'Android TV Home', { system: true, version_name: '6.3.0', category: 'launcher' }),
    app('com.google.android.apps.mediashell', 'Chromecast built-in', { system: true, version_name: '1.72.4', category: 'system' }),
    app('com.android.vending', 'Google Play Store', { system: true, version_name: '42.4.24', category: 'store' }),
    app('com.nvidia.ota', 'NVIDIA System Upgrade', { system: true, version_name: '9.2.0', category: 'system' }),
    app('com.nvidia.tegrazone3', 'NVIDIA Games', { system: true, version_name: '5.33.1', category: 'games', risk: 'low' }),
    app('com.google.android.tvrecommendations', 'Android TV Core Services', { system: true, category: 'system', risk: 'medium' }),
    app('com.nvidia.diagtools', 'NVIDIA Feedback', { system: true, version_name: '2.1', category: 'telemetry', risk: 'medium', enabled: false }),
    ...extra,
  ];
}

export const apps: Record<string, DeviceApp[]> = {
  dev_lr_shield: shieldApps([
    app('com.teamsmart.videomanager.tv', 'SmartTube', { version_name: '28.66', category: 'streaming', first_seen: NOW - 12 * D }),
    app('com.spocky.projengmenu', 'Projectivy Launcher', { version_name: '4.62', category: 'launcher' }),
    app('com.zoom.videomeetings.tv', 'Zoom for TV', { version_name: '6.0.2', category: 'communication', permissions: [MIC, CAM], risk: 'medium' }),
  ]),
  dev_beach_shield: shieldApps([
    app('au.coastal.welcome', 'Beach House Welcome', { version_name: '1.3', category: 'kiosk' }),
    app('com.mxtech.videoplayer.ad', 'MX Player', { version_name: '1.83.4', category: 'video', risk: 'high', permissions: [MIC] }),
  ]),
  dev_beach_bed_shield: shieldApps([
    app('au.coastal.welcome', 'Beach House Welcome', { version_name: '1.3', category: 'kiosk' }),
    app('tv.pluto.android', 'Pluto TV', { version_name: '5.48.0', category: 'streaming', risk: 'high' }),
  ]),
  dev_lr_tv: samsungApps(),
  dev_bed_tv: samsungApps(),
  dev_beach_tv: samsungApps(),
};

function samsungApps(): DeviceApp[] {
  const s = (id: string, label: string, category = 'streaming', risk: string | null = null) =>
    app(`samsung.${id}`, label, { app_id: id, category, risk, version_name: null });
  return [
    s('3201907018807', 'Netflix'), s('111299001912', 'YouTube'), s('3201512006785', 'Prime Video'), s('3201901017640', 'Disney+'),
    s('3201606009682', 'Stan'), s('3201606009684', 'Spotify', 'music'), s('3201807016597', 'Apple TV'), s('3201707014448', 'ABC iview'),
    s('3201710015037', 'Samsung TV Plus', 'streaming', 'high'), s('3201909019175', 'Samsung Gaming Hub', 'games', 'medium'),
    s('3202008021577', 'SmartThings', 'vendor', 'medium'), s('3201611010983', 'Internet', 'browser'),
  ];
}

// ---------------------------------------------------------------------------
// Privacy details per device

const ck = (key: string, label: string, how: string, done = false, auto = false): ChecklistItem => ({ key, label, how, done, auto });

const SAMSUNG_CHECKLIST = (done: string[] = []): ChecklistItem[] => [
  ck('samsung.viewing_info', 'Turn off Viewing Information Services (ACR)', 'On the TV remote press Home → Menu → Settings → All Settings → General & Privacy → Terms & Privacy → Viewing Information Services, then switch it off.', done.includes('viewing')),
  ck('samsung.ads', 'Turn off interest-based ads', 'Settings → All Settings → General & Privacy → Terms & Privacy → Interest-Based Advertisements → off. Then choose "Reset PSID" on the same screen.', done.includes('ads')),
  ck('samsung.voice', 'Turn off voice recognition', 'Settings → All Settings → General & Privacy → Terms & Privacy → Voice Recognition Services → Disagree.', done.includes('voice')),
  ck('samsung.tvplus', 'Stop Samsung TV Plus starting by itself', 'Settings → All Settings → General & Privacy → Start Screen Option → Autorun Samsung TV Plus → off.', done.includes('tvplus')),
  ck('samsung.power_on', 'Allow "Power On with Mobile"', 'Settings → All Settings → Connection → Network → Expert Settings → Power On with Mobile → on. This lets Screens wake the TV.', true, true),
];
const LG_CHECKLIST: ChecklistItem[] = [
  ck('lg.live_plus', 'Turn off Live Plus (ACR)', 'Settings → All Settings → General → System → Additional Settings → Live Plus → off.'),
  ck('lg.agreements', 'Withdraw the viewing information agreement', 'Settings → General → System → Additional Settings → User Agreements → untick Viewing Information, Voice Information and Interest-Based Advertising.'),
  ck('lg.ads', 'Limit ad tracking', 'Settings → General → System → Additional Settings → Advertisement → Limit Ad Tracking → on.'),
  ck('lg.tv_on', 'Allow "TV On With Mobile"', 'Settings → General → Devices → External Devices → TV On With Mobile → Turn on via Wi-Fi.'),
];
const SHIELD_CHECKLIST = (done: string[] = []): ChecklistItem[] => [
  ck('android.usage', 'Turn off Usage & diagnostics', 'Settings → Device Preferences → About → Usage & diagnostics → off.', done.includes('usage')),
  ck('android.ad_id', 'Delete the advertising ID', 'Settings → Privacy → Ads → Delete advertising ID.', done.includes('ad_id')),
  ck('android.nvidia', 'Turn off NVIDIA data collection', 'Settings → Device Preferences → About → NVIDIA data collection → off (on older builds: Settings → Device Preferences → System → NVIDIA).', done.includes('nvidia')),
  ck('android.location', 'Turn off location', 'Settings → Device Preferences → Location → off. Streaming apps work fine without it.', done.includes('location')),
  ck('android.private_dns', 'Use Screens Private DNS', 'Screens does this for you — use the Private DNS switch on this page.', done.includes('private_dns'), true),
];
const SONOS_CHECKLIST = (done: string[] = []): ChecklistItem[] => [
  ck('sonos.usage', 'Turn off additional usage data', 'In the Sonos app: Settings → Privacy (or Account → Privacy) → Additional Usage Data → off.', done.includes('usage')),
  ck('sonos.mic', 'Turn off the microphone if you don’t use voice', 'Touch the microphone button on top of the speaker until its light goes out, or in the app: the speaker → Voice → Microphone off.', done.includes('mic')),
];

const f = (key: string, label: string, status: PrivacyFactor['status'], impact: number, detail?: string): PrivacyFactor => ({ key, label, status, impact, detail });

export interface PrivacySeed { factors: PrivacyFactor[]; checklist: ChecklistItem[]; mic: MicUsage[]; bypass: boolean }

export const privacy: Record<string, PrivacySeed> = {
  dev_lr_tv: {
    factors: [
      f('acr_blocked', 'ACR traffic is being blocked', 'good', 0, 'Every attempt to reach Samsung’s content-recognition servers is stopped by the gateway.'),
      f('viewing_info', 'Viewing Information Services is still switched on', 'bad', -18, 'The TV keeps fingerprinting what is on screen and trying to upload it. Turn it off on the TV (see the checklist).'),
      f('ads', 'Interest-based ads are on', 'warn', -10, 'Samsung builds an ad profile from your viewing.'),
      f('voice', 'Voice recognition is on', 'warn', -6, 'Voice commands are processed in Samsung’s cloud.'),
      f('account', 'Signed in to a Samsung account', 'warn', -4, 'Links viewing history to your identity.'),
      f('dns', 'DNS filtering is enforced', 'good', 0, 'Balanced policy.'),
    ],
    checklist: SAMSUNG_CHECKLIST(['tvplus']), mic: [], bypass: false,
  },
  dev_bed_tv: {
    factors: [
      f('monitor', 'Still in monitor mode — nothing blocked yet', 'bad', -25, 'ACR and ad lookups are only being logged. Enforcing starts automatically when monitoring ends.'),
      f('viewing_info', 'Viewing Information Services is still switched on', 'bad', -15, 'Turn it off on the TV (see the checklist).'),
      f('ads', 'Interest-based ads are on', 'warn', -6),
      f('art', 'Art mode keeps the TV online all day', 'good', 0, 'Not a privacy problem on its own, but it means the TV phones home even when “off”.'),
    ],
    checklist: SAMSUNG_CHECKLIST(), mic: [], bypass: false,
  },
  dev_beach_tv: {
    factors: [
      f('acr_blocked', 'ACR traffic is being blocked', 'good', 0),
      f('viewing_info', 'Viewing Information Services is off', 'good', 0, 'Ticked off in the checklist.'),
      f('ads', 'Interest-based ads are on', 'warn', -10),
      f('voice', 'Voice recognition is on', 'warn', -6),
      f('tvplus', 'Samsung TV Plus starts by itself', 'warn', -5, 'Ad-funded channels open when guests turn the TV on.'),
      f('firmware', 'Firmware is over a year old', 'warn', -8, 'Update from Settings → Support → Software Update.'),
    ],
    checklist: SAMSUNG_CHECKLIST(['viewing']), mic: [], bypass: false,
  },
  dev_lr_shield: {
    factors: [
      f('telemetry', 'Google and NVIDIA telemetry is blocked', 'good', 0),
      f('private_dns', 'Private DNS points at Screens', 'good', 0, 'Apps can’t sidestep the filter with their own DNS settings.'),
      f('usage', 'Usage & diagnostics is on', 'warn', -6),
      f('mic', '3 apps can use the microphone', 'warn', -4, 'Google app, YouTube and Zoom for TV.'),
      f('ad_id', 'Advertising ID is still set', 'warn', -4),
    ],
    checklist: SHIELD_CHECKLIST(['location', 'private_dns', 'nvidia']),
    mic: [
      { package: 'com.google.android.katniss', label: 'Google app', last_access: '2 days ago', granted: true },
      { package: 'com.google.android.youtube.tv', label: 'YouTube', last_access: '6 days ago', granted: true },
      { package: 'com.zoom.videomeetings.tv', label: 'Zoom for TV', last_access: null, granted: true },
    ],
    bypass: false,
  },
  dev_beach_shield: {
    factors: [
      f('telemetry', 'Telemetry is blocked (strict policy)', 'good', 0),
      f('usage', 'Usage & diagnostics is on', 'warn', -6),
      f('mic', '3 apps can use the microphone', 'warn', -4, 'Including MX Player, which has no reason to.'),
      f('ad_id', 'Advertising ID is still set', 'warn', -4),
      f('sideload', 'An ad-funded app is installed (MX Player)', 'warn', -5, 'Banned by the “No ad-funded players” policy — it will be removed on the next enforce run.'),
    ],
    checklist: SHIELD_CHECKLIST(['location']),
    mic: [
      { package: 'com.google.android.katniss', label: 'Google app', last_access: 'yesterday', granted: true },
      { package: 'com.google.android.youtube.tv', label: 'YouTube', last_access: '3 days ago', granted: true },
      { package: 'com.mxtech.videoplayer.ad', label: 'MX Player', last_access: '12 days ago', granted: true },
    ],
    bypass: false,
  },
  dev_beach_bed_shield: {
    factors: [
      f('bypass', 'Looks like it is bypassing Screens DNS', 'bad', -20, 'It kept streaming for 2 hours while sending almost no lookups to the gateway — an app is probably using its own encrypted DNS.'),
      f('private_dns', 'Private DNS is not set', 'warn', -8, 'Turn on Private DNS for this site, then switch it on here.'),
      f('usage', 'Usage & diagnostics is on', 'warn', -6),
      f('mic', '2 apps can use the microphone', 'warn', -4),
      f('ad_id', 'Advertising ID is still set', 'warn', -4),
    ],
    checklist: SHIELD_CHECKLIST(),
    mic: [
      { package: 'com.google.android.katniss', label: 'Google app', last_access: '4 days ago', granted: true },
      { package: 'com.google.android.youtube.tv', label: 'YouTube', last_access: null, granted: false },
    ],
    bypass: true,
  },
  dev_sonos_lr: {
    factors: [
      f('telemetry', 'Sonos usage metrics are blocked', 'good', 0),
      f('mic', 'Microphone is on (voice assistant)', 'warn', -8, 'Alexa is enabled on this speaker.'),
      f('usage', 'Additional usage data sharing is on', 'warn', -4),
    ],
    checklist: SONOS_CHECKLIST(), mic: [], bypass: false,
  },
  dev_sonos_kitchen: {
    factors: [
      f('telemetry', 'Sonos usage metrics are blocked', 'good', 0),
      f('mic', 'Microphone is on', 'warn', -8, 'Era 100 has a built-in mic; voice control is not set up.'),
    ],
    checklist: SONOS_CHECKLIST(['usage']), mic: [], bypass: false,
  },
  dev_study_lg: {
    factors: [
      f('pairing', 'Not paired yet', 'warn', 0, 'Screens can’t read this TV’s settings until someone presses Allow on it.'),
      f('monitor', 'In monitor mode — nothing blocked yet', 'bad', -20, 'LG’s Live Plus (ACR) lookups are only being logged.'),
    ],
    checklist: LG_CHECKLIST, mic: [], bypass: false,
  },
};

// ---------------------------------------------------------------------------
// DNS rules, lists, builds

const rule = (domain: string, action: 'block' | 'allow', o: Partial<DnsRule> = {}): DnsRule => ({
  domain, action, category: null, vendor: null, policies: ['balanced', 'strict'], scope_type: 'global', scope_id: '', source: 'curated', notes: null,
  created_at: NOW - 90 * D, ...o,
});

export const rules: DnsRule[] = [
  rule('samsungacr.com', 'block', { category: 'acr', vendor: 'Samsung', notes: 'Samsung ACR ingestion and config' }),
  rule('acr0.samsungcloudsolution.com', 'block', { category: 'acr', vendor: 'Samsung' }),
  rule('samsungcloud.tv', 'block', { category: 'acr', vendor: 'Samsung', policies: ['strict'], notes: 'Also serves TV Plus — strict only' }),
  rule('alphonso.tv', 'block', { category: 'acr', vendor: 'Alphonso (LG)' }),
  rule('samba.tv', 'block', { category: 'acr', vendor: 'Samba TV' }),
  rule('samsungads.com', 'block', { category: 'ads', vendor: 'Samsung' }),
  rule('lgsmartad.com', 'block', { category: 'ads', vendor: 'LG' }),
  rule('app-measurement.com', 'block', { category: 'telemetry', vendor: 'Google' }),
  rule('telemetry.gfe.nvidia.com', 'block', { category: 'telemetry', vendor: 'NVIDIA' }),
  rule('msmetrics.ws.sonos.com', 'block', { category: 'telemetry', vendor: 'Sonos' }),
  rule('connectivitycheck.gstatic.com', 'allow', { category: 'essential', vendor: 'Google', notes: 'Android shows “No internet” without it', policies: ['balanced', 'strict', 'monitor'] }),
  rule('time.samsungcloudsolution.com', 'allow', { category: 'essential', vendor: 'Samsung', notes: 'Clock sync', policies: ['balanced', 'strict', 'monitor'] }),
  rule('api.amazonalexa.com', 'allow', { source: 'user', scope_type: 'site', scope_id: 's_home', category: 'vendor', vendor: 'Amazon', notes: 'Alexa on the Sonos Arc', created_at: NOW - 21 * D }),
  rule('ichnaea.netflix.com', 'block', { source: 'user', category: 'telemetry', vendor: 'Netflix', notes: 'Netflix playback logging — app still works', created_at: NOW - 14 * D }),
  rule('events.gfe.nvidia.com', 'block', { source: 'user', scope_type: 'client', scope_id: 'cl_coastal', category: 'telemetry', vendor: 'NVIDIA', created_at: NOW - 30 * D }),
];

export const lists: DnsList[] = [
  { id: 'l_perflyst_tv', name: 'Perflyst Smart TV', url: 'https://raw.githubusercontent.com/Perflyst/PiHoleBlocklist/master/SmartTV.txt', format: 'domains', category: 'acr', enabled: true, policies: ['balanced', 'strict'], last_fetched: NOW - 3 * H - 4 * M, last_count: 231, last_error: null },
  { id: 'l_hagezi_samsung', name: 'HaGeZi Native Tracker · Samsung', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/native.samsung-onlydomains.txt', format: 'domains', category: 'telemetry', enabled: true, policies: ['balanced', 'strict'], last_fetched: NOW - 3 * H - 4 * M, last_count: 58, last_error: null },
  { id: 'l_hagezi_lg', name: 'HaGeZi Native Tracker · LG webOS', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/native.lgwebos-onlydomains.txt', format: 'domains', category: 'telemetry', enabled: true, policies: ['balanced', 'strict'], last_fetched: NOW - 3 * H - 4 * M, last_count: 44, last_error: null },
  { id: 'l_perflyst_android', name: 'Perflyst Android tracking', url: 'https://raw.githubusercontent.com/Perflyst/PiHoleBlocklist/master/android-tracking.txt', format: 'domains', category: 'tracking', enabled: true, policies: ['balanced', 'strict'], last_fetched: NOW - 3 * H - 4 * M, last_count: 146, last_error: null },
  { id: 'l_hagezi_pro', name: 'HaGeZi Multi PRO', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt', format: 'adblock', category: 'ads', enabled: true, policies: ['balanced', 'strict'], last_fetched: NOW - 3 * H - 3 * M, last_count: 171_884, last_error: null },
  { id: 'l_hagezi_tif', name: 'HaGeZi Threat Intelligence', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.medium.txt', format: 'adblock', category: 'malware', enabled: true, policies: ['balanced', 'strict'], last_fetched: NOW - 3 * H - 3 * M, last_count: 402_517, last_error: null },
  { id: 'l_stevenblack', name: 'StevenBlack unified hosts', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts', format: 'hosts', category: 'ads', enabled: false, policies: ['strict'], last_fetched: NOW - 9 * D, last_count: 82_317, last_error: null },
  { id: 'l_community_acr', name: 'Community ACR list', url: 'https://lists.example.org/acr/domains.txt', format: 'domains', category: 'acr', enabled: true, policies: ['strict'], last_fetched: NOW - 27 * H, last_count: null, last_error: 'HTTP 404 Not Found — the list may have moved' },
];

export const builds: DnsPolicyBuild[] = [
  { policy: 'balanced', sha256: hex(64), rules: 573_211, built_at: NOW - 3 * H - 2 * M },
  { policy: 'strict', sha256: hex(64), rules: 655_601, built_at: NOW - 3 * H - 2 * M },
  { policy: 'monitor', sha256: hex(64), rules: 573_211, built_at: NOW - 3 * H - 2 * M },
];

// ---------------------------------------------------------------------------
// Discovery

export const discovered: Discovered[] = [
  { site_id: 's_home', ip: '10.0.20.52', mac: 'f4:f5:d8:21:6b:0e', kind_guess: 'android', name: 'Chromecast with Google TV', model: 'Chromecast HD', manufacturer: 'Google', hints: { ports: [8008, 8009, 8443], mdns: ['_googlecast._tcp', '_androidtvremote2._tcp'] }, first_seen: NOW - 2 * D, last_seen: NOW - 4 * M },
  { site_id: 's_home', ip: '10.0.20.47', mac: '64:1c:ae:3d:07:90', kind_guess: 'samsung', name: '[TV] Samsung Q60 Series (43)', model: 'QA43Q60CAWXXY', manufacturer: 'Samsung', hints: { ports: [8001, 8002, 9197], ssdp: ['urn:samsung.com:device:RemoteControlReceiver:1'] }, first_seen: NOW - 20 * H, last_seen: NOW - 11 * M },
  { site_id: 's_home', ip: '10.0.20.71', mac: '38:42:0b:aa:19:c2', kind_guess: 'sonos', name: 'Sonos Roam', model: 'Roam', manufacturer: 'Sonos', hints: { ports: [1400, 1443], mdns: ['_sonos._tcp', '_spotify-connect._tcp', '_airplay._tcp'] }, first_seen: NOW - 6 * D, last_seen: NOW - 40 * M },
  { site_id: 's_home', ip: '10.0.20.90', mac: 'a4:cf:12:8e:30:4b', kind_guess: null, name: null, model: null, manufacturer: 'Espressif', hints: { ports: [80], mdns: ['_http._tcp'] }, first_seen: NOW - 15 * D, last_seen: NOW - 2 * M },
  { site_id: 's_home', ip: '10.0.20.12', mac: '3c:52:82:11:9a:00', kind_guess: 'other', name: 'HP LaserJet M234', model: 'M234sdw', manufacturer: 'HP', hints: { ports: [80, 631], mdns: ['_ipp._tcp', '_printer._tcp'] }, first_seen: NOW - 90 * D, last_seen: NOW - 1 * H, ignored: true },
  { site_id: 's_home', ip: '10.0.20.40', mac: '70:2a:d5:1c:88:e4', kind_guess: 'samsung', name: '[TV] Samsung QN90D (65)', model: 'QA65QN90DAWXXY', manufacturer: 'Samsung', hints: { ports: [8001, 8002] }, first_seen: NOW - 41 * D, last_seen: NOW - 1 * M, adopted_device_id: 'dev_lr_tv' },
  { site_id: 's_home', ip: '10.0.20.31', mac: '00:04:4b:e5:91:02', kind_guess: 'android', name: 'SHIELD', model: 'SHIELD Android TV Pro', manufacturer: 'NVIDIA', hints: { ports: [5555, 8008, 8009] }, first_seen: NOW - 41 * D, last_seen: NOW - 1 * M, adopted_device_id: 'dev_lr_shield' },
  { site_id: 's_home', ip: '10.0.20.60', mac: '48:a6:b8:72:10:3c', kind_guess: 'sonos', name: 'Living Room', model: 'Arc', manufacturer: 'Sonos', hints: { ports: [1400] }, first_seen: NOW - 41 * D, last_seen: NOW - 1 * M, adopted_device_id: 'dev_sonos_lr' },
  { site_id: 's_beach', ip: '10.1.20.55', mac: 'cc:6e:a4:02:39:fe', kind_guess: 'other', name: 'Fire TV Stick 4K', model: 'AFTKA', manufacturer: 'Amazon', hints: { ports: [8009], mdns: ['_amzn-wplay._tcp'] }, first_seen: NOW - 1 * D, last_seen: NOW - 30 * M },
];

export const extraOnScan: Discovered = {
  site_id: 's_home', ip: '10.0.20.33', mac: '00:04:4b:7c:12:aa', kind_guess: 'android', name: 'SHIELD', model: 'SHIELD Android TV', manufacturer: 'NVIDIA',
  hints: { ports: [5555, 8008, 8009], mdns: ['_googlecast._tcp', '_nvstream._tcp'] }, first_seen: NOW, last_seen: NOW,
};

// ---------------------------------------------------------------------------
// mDNS

export const mdnsConfig: Record<string, MdnsConfig> = {
  s_home: {
    enabled: true,
    interfaces: ['eth0', 'eth0.20'],
    rules: [
      { from: 'eth0.20', to: ['eth0'], allow: ['_sonos._tcp', '_spotify-connect._tcp', '_googlecast._tcp', '_airplay._tcp', '_raop._tcp'], deny: [] },
      { from: 'eth0', to: ['eth0.20'], allow: ['_sonos._tcp', '_spotify-connect._tcp', '_googlecast._tcp', '_airplay._tcp'], deny: [] },
    ],
    ssdp: { enabled: true, rules: [{ from: 'eth0.20', to: ['eth0'] }] },
    rate_limit_pps: 50,
    track_services: true,
  },
  s_beach: {
    enabled: true,
    interfaces: ['end0', 'end0.20'],
    rules: [{ from: 'end0.20', to: ['end0'], allow: ['_googlecast._tcp', '_spotify-connect._tcp'], deny: ['_adb-tls-connect._tcp'] }],
    ssdp: { enabled: false, rules: [] },
    rate_limit_pps: 30,
    track_services: true,
  },
};

const svc = (service: string, instance: string, host: string, addr: string, port: number, ifaceName: string, ago: number): MdnsService => ({
  service, instance, host, addrs: [addr], port, iface: ifaceName, last_seen: NOW - ago,
});
export const mdnsServices: Record<string, MdnsService[]> = {
  s_home: [
    svc('_sonos._tcp', 'Sonos-48A6B872103C@Living Room', 'Sonos-48A6B872103C.local', '10.0.20.60', 1443, 'eth0.20', 8 * S),
    svc('_sonos._tcp', 'Sonos-48A6B89C44D1@Kitchen', 'Sonos-48A6B89C44D1.local', '10.0.20.61', 1443, 'eth0.20', 8 * S),
    svc('_spotify-connect._tcp', 'Living Room', 'Sonos-48A6B872103C.local', '10.0.20.60', 1400, 'eth0.20', 12 * S),
    svc('_spotify-connect._tcp', 'Kitchen', 'Sonos-48A6B89C44D1.local', '10.0.20.61', 1400, 'eth0.20', 12 * S),
    svc('_airplay._tcp', 'Living Room', 'Sonos-48A6B872103C.local', '10.0.20.60', 7000, 'eth0.20', 14 * S),
    svc('_raop._tcp', '48A6B872103C@Living Room', 'Sonos-48A6B872103C.local', '10.0.20.60', 7000, 'eth0.20', 14 * S),
    svc('_googlecast._tcp', 'SHIELD-Android-TV-6a2f', 'shield-living.local', '10.0.20.31', 8009, 'eth0.20', 20 * S),
    svc('_googlecast._tcp', 'Chromecast-HD-90a1', 'chromecast.local', '10.0.20.52', 8009, 'eth0.20', 25 * S),
    svc('_androidtvremote2._tcp', 'Living Room Shield', 'shield-living.local', '10.0.20.31', 6466, 'eth0.20', 31 * S),
    svc('_airplay._tcp', 'Sam’s iPhone', 'Sams-iPhone.local', '192.168.1.44', 7000, 'eth0', 2 * M),
    svc('_ipp._tcp', 'HP LaserJet M234', 'HP3C5282119A00.local', '10.0.20.12', 631, 'eth0.20', 4 * M),
  ],
  s_beach: [
    svc('_googlecast._tcp', 'SHIELD-Lounge', 'shield-lounge.local', '10.1.20.31', 8009, 'end0.20', 15 * S),
    svc('_spotify-connect._tcp', 'Lounge Shield', 'shield-lounge.local', '10.1.20.31', 4070, 'end0.20', 19 * S),
  ],
};

// ---------------------------------------------------------------------------
// Library

export const apks: Apk[] = [
  { id: 'apk_smarttube', package: 'com.teamsmart.videomanager.tv', label: 'SmartTube', version_name: '28.66', version_code: 2866, sha256: hex(64), size: 34_812_331, notes: 'Ad-free YouTube for Android TV', uploaded_at: NOW - 12 * D },
  { id: 'apk_projectivy', package: 'com.spocky.projengmenu', label: 'Projectivy Launcher', version_name: '4.62', version_code: 462, sha256: hex(64), size: 9_412_004, notes: 'Clean launcher without the Google TV ads row', uploaded_at: NOW - 31 * D },
  { id: 'apk_kodi', package: 'org.xbmc.kodi', label: 'Kodi', version_name: '21.2', version_code: 2120, sha256: hex(64), size: 79_123_456, notes: null, uploaded_at: NOW - 44 * D },
  { id: 'apk_welcome', package: 'au.coastal.welcome', label: 'Beach House Welcome', version_name: '1.3', version_code: 13, sha256: hex(64), size: 4_201_337, notes: 'Guest welcome screen with Wi-Fi details and house rules', uploaded_at: NOW - 20 * D },
];

export const appPolicies: AppPolicy[] = [
  {
    id: 'ap_beach', name: 'Beach House guest setup', scope_type: 'site', scope_id: 's_beach',
    required: [{ package: 'com.netflix.ninja' }, { package: 'au.com.stan.and' }, { package: 'com.google.android.youtube.tv' }, { package: 'au.coastal.welcome', apk_id: 'apk_welcome' }],
    banned: ['tv.pluto.android'], ban_action: 'disable', kiosk_allowed: null, enabled: true, created_at: NOW - 20 * D,
  },
  { id: 'ap_global', name: 'No ad-funded players', scope_type: 'global', scope_id: null, required: [], banned: ['com.mxtech.videoplayer.ad'], ban_action: 'uninstall', kiosk_allowed: null, enabled: true, created_at: NOW - 40 * D },
  {
    id: 'ap_kiosk', name: 'Office lobby screen', scope_type: 'site', scope_id: 's_office', required: [{ package: 'com.google.android.youtube.tv' }],
    banned: [], ban_action: 'disable', kiosk_allowed: ['com.google.android.youtube.tv', 'au.coastal.welcome'], enabled: false, created_at: NOW - 8 * D,
  },
];

// ---------------------------------------------------------------------------
// Automations, jobs, alerts, audit

export const automations: Automation[] = [
  {
    id: 'au_midnight', name: 'Turn all TVs off at midnight', enabled: true, scope_type: 'global', scope_id: null,
    trigger: { type: 'schedule', cron: '0 0 * * *', timezone: 'Australia/Sydney' },
    target: { kinds: ['samsung', 'lg', 'android'] }, actions: [{ type: 'command', command: 'power_off' }],
    last_run: LAST_MIDNIGHT + 4 * S, last_status: 'ok', created_at: NOW - 30 * D,
  },
  {
    id: 'au_checkout', name: 'Guest reset at 11 am checkout', enabled: true, scope_type: 'site', scope_id: 's_beach',
    trigger: { type: 'schedule', cron: '0 11 * * *', timezone: 'Australia/Sydney' },
    target: { site_ids: ['s_beach'] },
    actions: [{ type: 'guest_reset' }, { type: 'delay', seconds: 90 }, { type: 'enforce_apps' }, { type: 'alert', severity: 'info', title: 'Beach House reset for the next guest' }],
    last_run: NOW - 9 * H, last_status: 'error: 1 of 3 devices offline', created_at: NOW - 20 * D,
  },
  {
    id: 'au_offline', name: 'Alert when a device goes offline', enabled: true, scope_type: 'global', scope_id: null,
    trigger: { type: 'event', event: 'device.offline' }, target: {},
    actions: [{ type: 'alert', severity: 'warning', title: 'A device went offline' }],
    last_run: NOW - 3 * H - 7 * M, last_status: 'ok', created_at: NOW - 30 * D,
  },
  {
    id: 'au_acr', name: 'Enforce DNS when ACR shows up', enabled: false, scope_type: 'global', scope_id: null,
    trigger: { type: 'event', event: 'privacy.acr_detected' }, target: { kinds: ['samsung', 'lg'] },
    actions: [{ type: 'dns_mode', mode: 'enforce' }], last_run: null, last_status: null, created_at: NOW - 4 * D,
  },
];

const job = (id: string, kind: string, o: Partial<Job>): Job => ({
  id, kind, params: {}, status: 'ok', actor: 'you', created_at: NOW, finished_at: null, ...o,
});
export const jobs: Job[] = [
  job('j_12', 'command:screenshot', { site_id: 's_home', device_id: 'dev_lr_shield', site_name: 'Home', device_name: 'Living Room Shield', created_at: NOW - 6 * M, finished_at: NOW - 6 * M + 1400, result: { url: '/api/devices/dev_lr_shield/screenshot', width: 1280, height: 720 } }),
  job('j_11', 'command:launch', { site_id: 's_home', device_id: 'dev_lr_tv', site_name: 'Home', device_name: 'Living Room TV', params: { app_id: '3201907018807' }, created_at: NOW - 48 * M, finished_at: NOW - 48 * M + 900, result: { ok: true } }),
  job('j_10', 'dns.rebuild', { created_at: NOW - 3 * H - 3 * M, finished_at: NOW - 3 * H - 2 * M, result: { policies: 3, rules: 573_211, pushed_to: 2 } }),
  job('j_09', 'automation:device.offline', { site_id: 's_beach', device_id: 'dev_beach_bed_shield', site_name: 'Beach House', device_name: 'Master Bedroom Shield', actor: 'automation', automation_id: 'au_offline', created_at: NOW - 3 * H - 7 * M, finished_at: NOW - 3 * H - 7 * M + 200, result: { alert: 'al_offline' } }),
  job('j_08', 'guest_reset', {
    site_id: 's_beach', site_name: 'Beach House', actor: 'automation', automation_id: 'au_checkout', status: 'error', created_at: NOW - 9 * H, finished_at: NOW - 9 * H + 74_000,
    result: { results: [{ device_id: 'dev_beach_shield', ok: true, detail: 'Cleared 6 apps, went home, rebooted' }, { device_id: 'dev_beach_tv', ok: true, detail: 'Returned to Home (Samsung apps can’t be cleared remotely)' }, { device_id: 'dev_beach_bed_shield', ok: false, detail: 'Device offline' }] },
  }),
  job('j_07', 'command:power_off', { actor: 'automation', automation_id: 'au_midnight', created_at: LAST_MIDNIGHT + 1 * S, finished_at: LAST_MIDNIGHT + 6200, result: { devices: 6, ok: 6 } }),
  job('j_06', 'apps.enforce', { site_id: 's_beach', site_name: 'Beach House', actor: 'automation', automation_id: 'au_checkout', created_at: NOW - 9 * H + 90_000, finished_at: NOW - 9 * H + 120_000, result: { installed: [], disabled: ['tv.pluto.android'], uninstalled: [] } }),
  job('j_05', 'adopt', { site_id: 's_home', device_id: 'dev_study_lg', site_name: 'Home', device_name: 'Study TV', status: 'running', created_at: NOW - 2 * H, result: { state: 'waiting for Allow on TV' } }),
  job('j_04', 'command:install', { site_id: 's_home', device_id: 'dev_lr_shield', site_name: 'Home', device_name: 'Living Room Shield', params: { apk_id: 'apk_smarttube' }, created_at: NOW - 12 * D, finished_at: NOW - 12 * D + 31_000, result: { output: 'Performing Streamed Install\nSuccess' } }),
  job('j_03', 'gateway.update', { site_id: 's_home', site_name: 'Home', created_at: NOW - 6 * D - 3 * H, finished_at: NOW - 6 * D - 3 * H + 42_000, params: { version: '0.4.2' }, result: { from: '0.4.1', to: '0.4.2' } }),
];

export const alerts: Alert[] = [
  { id: 'al_offline', at: NOW - 3 * H - 7 * M, severity: 'warning', type: 'device.offline', site_id: 's_beach', device_id: 'dev_beach_bed_shield', title: 'Master Bedroom Shield went offline', details: 'No response for 3 hours. It may have been unplugged by a guest.', site_name: 'Beach House', device_name: 'Master Bedroom Shield' },
  { id: 'al_bypass', at: NOW - 5 * H, severity: 'critical', type: 'dns.bypass_suspected', site_id: 's_beach', device_id: 'dev_beach_bed_shield', title: 'Master Bedroom Shield may be bypassing DNS filtering', details: 'Streaming continued for 2 h with almost no lookups through the gateway.', site_name: 'Beach House', device_name: 'Master Bedroom Shield' },
  { id: 'al_acr', at: NOW - 26 * M, severity: 'warning', type: 'privacy.acr_detected', site_id: 's_home', device_id: 'dev_bed_tv', title: 'Bedroom TV is sending ACR data (monitor mode)', details: 'Lookups to log-ingestion.samsungacr.com are only being logged until monitoring ends.', site_name: 'Home', device_name: 'Bedroom TV' },
  { id: 'al_update', at: NOW - 2 * D, severity: 'info', type: 'gateway.update_available', site_id: 's_beach', title: 'Gateway update available for Beach House (0.4.1 → 0.4.2)', details: 'Includes faster mDNS reflection and a DoT fix.', site_name: 'Beach House' },
  { id: 'al_list', at: NOW - 27 * H, severity: 'warning', type: 'dns.list_error', title: 'Blocklist “Community ACR list” failed to download', details: 'HTTP 404 Not Found', acknowledged_at: NOW - 20 * H },
  { id: 'al_pair', at: NOW - 2 * H, severity: 'info', type: 'device.pairing', site_id: 's_home', device_id: 'dev_study_lg', title: 'Study TV is waiting for you to press Allow', site_name: 'Home', device_name: 'Study TV', acknowledged_at: NOW - 100 * M },
  { id: 'al_gw', at: NOW - 6 * D - 3 * H - 10 * M, severity: 'critical', type: 'gateway.offline', site_id: 's_home', title: 'Home gateway went offline', details: 'Reconnected after 4 minutes (updating to 0.4.2).', site_name: 'Home', acknowledged_at: NOW - 6 * D, resolved_at: NOW - 6 * D - 3 * H - 6 * M },
];

export const audit: AuditEntry[] = [
  { id: 118, at: NOW - 6 * M, actor: 'you', action: 'device.command', target_type: 'device', target_id: 'dev_lr_shield', site_id: 's_home', details: { command: 'screenshot' } },
  { id: 117, at: NOW - 48 * M, actor: 'you', action: 'device.command', target_type: 'device', target_id: 'dev_lr_tv', site_id: 's_home', details: { command: 'launch', app: 'Netflix' } },
  { id: 116, at: NOW - 2 * H, actor: 'you', action: 'device.adopt', target_type: 'device', target_id: 'dev_study_lg', site_id: 's_home', details: { ip: '10.0.20.45', kind: 'lg' } },
  { id: 115, at: NOW - 3 * H - 3 * M, actor: 'you', action: 'dns.rebuild', target_type: 'dns', details: { policies: ['balanced', 'strict', 'monitor'] } },
  { id: 114, at: NOW - 9 * H, actor: 'automation:Guest reset at 11 am checkout', action: 'site.guest_reset', target_type: 'site', target_id: 's_beach', site_id: 's_beach', details: { devices: 3, ok: 2 } },
  { id: 113, at: NOW - 1 * D - 2 * H, actor: 'you', action: 'dns.rule.add', target_type: 'dns_rule', target_id: 'ichnaea.netflix.com', details: { action: 'block', scope: 'global' } },
  { id: 112, at: NOW - 3 * D, actor: 'you', action: 'device.adopt', target_type: 'device', target_id: 'dev_bed_tv', site_id: 's_home', details: { ip: '10.0.20.41', kind: 'samsung' } },
  { id: 111, at: NOW - 6 * D - 3 * H, actor: 'you', action: 'gateway.update', target_type: 'gateway', target_id: 'gw_home', site_id: 's_home', details: { to: '0.4.2' } },
  { id: 110, at: NOW - 9 * D, actor: 'you', action: 'site.create', target_type: 'site', target_id: 's_office', details: { name: 'Coastal Rentals Office' } },
  { id: 109, at: NOW - 12 * D, actor: 'you', action: 'apk.upload', target_type: 'apk', target_id: 'apk_smarttube', details: { label: 'SmartTube', version: '28.66' } },
  { id: 108, at: NOW - 14 * D, actor: 'you', action: 'dns.rule.add', target_type: 'dns_rule', target_id: 'ichnaea.netflix.com', details: { action: 'block' } },
  { id: 107, at: NOW - 21 * D, actor: 'you', action: 'dns.rule.add', target_type: 'dns_rule', target_id: 'api.amazonalexa.com', site_id: 's_home', details: { action: 'allow', scope: 'site' } },
];

export const settings: AppSettings = {
  dot_base_domain: 'dns.screens.supercluster.au',
  default_monitor_days: 7,
  default_policy: 'balanced',
  dns_log_retention_days: 30,
  agent_latest_version: '0.4.2',
  cf_dns_token_set: true,
};

export const gatewayLogs: Record<string, string[]> = {
  s_home: [
    'level=info msg="dns policy applied" policy=p_balanced rules=573211 sha256=4f1c…9e2a',
    'level=info msg="mdns reflector" rule="eth0.20→eth0" reflected=212 filtered=18 window=60s',
    'level=info msg="adb connect" serial=10.0.20.31:5555 state=device',
    'level=warn msg="upstream timeout" upstream=https://1.0.0.1/dns-query ms=2000',
    'level=info msg="dot handshake" client=10.0.20.31 sni=home.dns.screens.supercluster.au',
    'level=info msg="ws relay open" stream=s_88 url=wss://10.0.20.40:8002/api/v2/channels/samsung.remote.control',
    'level=info msg="screencap uploaded" serial=10.0.20.31:5555 bytes=148223 width=1280 height=720',
    'level=info msg="lg pairing prompt shown" ip=10.0.20.45 waiting=true',
    'level=info msg="metrics" qps_1m=4.2 cache_hit=61% mem_avail=1.31GB',
  ],
  s_beach: [
    'level=info msg="dns policy applied" policy=p_strict rules=655601',
    'level=warn msg="adb connect failed" serial=10.1.20.32:5555 error="no route to host"',
    'level=info msg="update available" current=0.4.1 latest=0.4.2',
  ],
};

import {
  Tv, TvMinimalPlay, Speaker, Cpu, type LucideIcon,
} from 'lucide-react';
import type {
  DeviceKind, DeviceStatus, DnsCategory, DnsMode, DnsPolicyName, SiteKind, Severity, AutomationEvent,
} from '../../shared/types';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'serious' | 'crit';

export const KIND: Record<DeviceKind, { label: string; short: string; icon: LucideIcon; vendor: string }> = {
  android: { label: 'Android TV box', short: 'Android TV', icon: TvMinimalPlay, vendor: 'Android' },
  samsung: { label: 'Samsung TV', short: 'Samsung', icon: Tv, vendor: 'Samsung' },
  lg: { label: 'LG TV', short: 'LG', icon: Tv, vendor: 'LG' },
  sonos: { label: 'Sonos speaker', short: 'Sonos', icon: Speaker, vendor: 'Sonos' },
  other: { label: 'Other device', short: 'Other', icon: Cpu, vendor: 'Other' },
};
export const KIND_ORDER: DeviceKind[] = ['samsung', 'lg', 'android', 'sonos', 'other'];

export function kindLabel(kind: DeviceKind, model?: string | null): string {
  if (kind === 'android' && model && /shield/i.test(model)) return 'NVIDIA Shield';
  return KIND[kind]?.label ?? kind;
}

export const DEVICE_STATUS: Record<DeviceStatus, { label: string; tone: Tone; help: string }> = {
  online: { label: 'Online', tone: 'ok', help: 'Connected and responding.' },
  standby: { label: 'Standby', tone: 'neutral', help: 'Screen is off but the device is reachable.' },
  offline: { label: 'Offline', tone: 'crit', help: 'Not responding on the network.' },
  unauthorized: { label: 'Needs approval', tone: 'warn', help: 'The device is refusing Screens. Accept the prompt on the TV or re-pair.' },
  pairing: { label: 'Pairing', tone: 'warn', help: 'Waiting for someone to press "Allow" on the TV with its remote.' },
  unknown: { label: 'Unknown', tone: 'neutral', help: 'Screens has not heard from this device yet.' },
};

export const GATEWAY_STATUS: Record<'online' | 'offline' | 'none' | 'revoked', { label: string; tone: Tone }> = {
  online: { label: 'Gateway online', tone: 'ok' },
  offline: { label: 'Gateway offline', tone: 'crit' },
  none: { label: 'No gateway', tone: 'neutral' },
  revoked: { label: 'Gateway revoked', tone: 'neutral' },
};

export const CATEGORY: Record<DnsCategory, { label: string; help: string; privacy: boolean }> = {
  acr: { label: 'ACR', help: 'Automatic content recognition — the TV fingerprints what is on screen and reports it.', privacy: true },
  ads: { label: 'Ads', help: 'Ad servers and ad measurement.', privacy: true },
  telemetry: { label: 'Telemetry', help: 'Usage and diagnostics data sent back to the manufacturer or app maker.', privacy: true },
  tracking: { label: 'Tracking', help: 'Analytics and cross-app tracking services.', privacy: true },
  malware: { label: 'Malware', help: 'Known malicious or scam domains.', privacy: true },
  update: { label: 'Updates', help: 'Firmware and app update servers.', privacy: false },
  streaming: { label: 'Streaming', help: 'Video and music delivery (Netflix, YouTube, Spotify…).', privacy: false },
  essential: { label: 'Essential', help: 'Needed for the device to work: time, connectivity checks, sign-in.', privacy: false },
  vendor: { label: 'Vendor services', help: 'Manufacturer cloud services such as voice assistants and app stores.', privacy: false },
  unknown: { label: 'Uncategorised', help: 'Not in any list yet.', privacy: false },
};
export const CATEGORY_ORDER: DnsCategory[] = ['acr', 'ads', 'telemetry', 'tracking', 'malware', 'vendor', 'update', 'streaming', 'essential', 'unknown'];
export const PRIVACY_CATEGORIES: DnsCategory[] = ['acr', 'ads', 'telemetry', 'tracking', 'malware'];

export const DNS_MODE: Record<DnsMode, { label: string; tone: Tone; short: string; help: string }> = {
  enforce: {
    label: 'Enforce', tone: 'ok', short: 'Blocking',
    help: 'Blocks spying, ads and trackers using the selected policy.',
  },
  monitor: {
    label: 'Monitor', tone: 'warn', short: 'Watching',
    help: 'Blocks nothing yet. Logs what would have been blocked so you can check nothing breaks, then switches to Enforce automatically.',
  },
  off: {
    label: 'Off', tone: 'neutral', short: 'Not filtered',
    help: 'No filtering, but lookups are still logged so you can see what the device does.',
  },
  bypass: {
    label: 'Bypass', tone: 'neutral', short: 'Ignored',
    help: 'No filtering and no logging. Use for devices you do not want Screens to touch.',
  },
};
export const DNS_MODES: DnsMode[] = ['enforce', 'monitor', 'off', 'bypass'];

export const POLICY: Record<DnsPolicyName, { label: string; help: string }> = {
  balanced: { label: 'Balanced', help: 'Blocks ACR, ads, telemetry and trackers while keeping apps and updates working. Recommended.' },
  strict: { label: 'Strict', help: 'Also blocks manufacturer cloud services. Some features (voice search, app stores) may stop working.' },
  monitor: { label: 'Monitor only', help: 'A list-only policy: nothing is blocked, everything is logged.' },
};
export const POLICIES: DnsPolicyName[] = ['balanced', 'strict', 'monitor'];

export const SITE_KIND: Record<SiteKind, { label: string; help: string }> = {
  residential: { label: 'Residential', help: 'A home.' },
  rental: { label: 'Rental', help: 'Short-stay property. Adds one-click guest reset between stays.' },
  business: { label: 'Business', help: 'Office, venue or shop.' },
};

export const SEVERITY: Record<Severity, { label: string; tone: Tone }> = {
  info: { label: 'Info', tone: 'accent' },
  warning: { label: 'Warning', tone: 'warn' },
  critical: { label: 'Critical', tone: 'crit' },
};

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export function gradeFor(score: number | null | undefined): Grade | null {
  if (score == null) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
export const GRADE: Record<Grade, { tone: Tone; label: string }> = {
  A: { tone: 'ok', label: 'Very private' },
  B: { tone: 'ok', label: 'Mostly private' },
  C: { tone: 'warn', label: 'Some leaks' },
  D: { tone: 'serious', label: 'Leaky' },
  F: { tone: 'crit', label: 'Spying freely' },
};

export const EVENTS: Record<AutomationEvent, { label: string; help: string }> = {
  'device.offline': { label: 'A device goes offline', help: 'Fires when a device stops responding for 5 minutes.' },
  'device.online': { label: 'A device comes back online', help: 'Fires when an offline device responds again.' },
  'app.installed': { label: 'A new app is installed', help: 'Fires when an app shows up that was not there before.' },
  'gateway.offline': { label: 'A gateway goes offline', help: 'Fires when a site gateway loses its connection to Screens.' },
  'gateway.online': { label: 'A gateway reconnects', help: 'Fires when a site gateway connects again.' },
  'privacy.acr_detected': { label: 'ACR traffic is detected', help: 'Fires when a TV tries to reach a content-recognition server.' },
  'dns.bypass_suspected': { label: 'A device may be bypassing DNS', help: 'Fires when a device seems to use its own DNS instead of the gateway.' },
};

/** Friendly names for common mDNS service types. */
export const MDNS_SERVICE_NAMES: Record<string, string> = {
  '_sonos._tcp': 'Sonos',
  '_spotify-connect._tcp': 'Spotify Connect',
  '_googlecast._tcp': 'Chromecast',
  '_airplay._tcp': 'AirPlay',
  '_raop._tcp': 'AirPlay audio',
  '_androidtvremote2._tcp': 'Android TV Remote',
  '_amzn-wplay._tcp': 'Fire TV',
  '_hap._tcp': 'HomeKit',
  '_homekit._tcp': 'HomeKit',
  '_ipp._tcp': 'Printer',
  '_printer._tcp': 'Printer',
  '_smb._tcp': 'File sharing',
  '_http._tcp': 'Web interface',
  '_matter._tcp': 'Matter',
  '_nvstream._tcp': 'NVIDIA GameStream',
  '_adb-tls-connect._tcp': 'Wireless debugging',
};

export const KEY_LABELS: Record<string, string> = {
  UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right', OK: 'OK', BACK: 'Back', HOME: 'Home', MENU: 'Menu',
  PLAY_PAUSE: 'Play/pause', PLAY: 'Play', PAUSE: 'Pause', STOP: 'Stop', NEXT: 'Next', PREV: 'Previous',
  REWIND: 'Rewind', FF: 'Fast-forward', VOL_UP: 'Volume up', VOL_DOWN: 'Volume down', MUTE: 'Mute', POWER: 'Power',
  CH_UP: 'Channel up', CH_DOWN: 'Channel down', SETTINGS: 'Settings', SEARCH: 'Search', INFO: 'Info', INPUT: 'Input',
  GUIDE: 'Guide',
};
export const ALL_KEYS = [...Object.keys(KEY_LABELS), '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Commands an automation (or bulk action) can send, with the kinds that support them. */
export const COMMANDS: { id: string; label: string; kinds: DeviceKind[]; args?: 'key' | 'text' | 'level' | 'package' | 'message' | 'mute' | 'on' | 'media' }[] = [
  { id: 'power_off', label: 'Power off', kinds: ['android', 'samsung', 'lg'] },
  { id: 'power_on', label: 'Power on', kinds: ['android', 'samsung', 'lg'] },
  { id: 'reboot', label: 'Restart', kinds: ['android'] },
  { id: 'key', label: 'Press a remote key', kinds: ['android', 'samsung', 'lg'], args: 'key' },
  { id: 'volume', label: 'Set volume', kinds: ['android', 'samsung', 'lg', 'sonos'], args: 'level' },
  { id: 'mute', label: 'Mute / unmute', kinds: ['android', 'samsung', 'lg', 'sonos'], args: 'mute' },
  { id: 'launch', label: 'Open an app', kinds: ['android', 'samsung', 'lg'], args: 'package' },
  { id: 'media', label: 'Media control', kinds: ['sonos', 'android'], args: 'media' },
  { id: 'toast', label: 'Show a message on screen', kinds: ['android', 'lg'], args: 'message' },
  { id: 'text', label: 'Type text', kinds: ['android', 'samsung', 'lg'], args: 'text' },
  { id: 'led', label: 'Speaker light', kinds: ['sonos'], args: 'on' },
  { id: 'refresh', label: 'Refresh status', kinds: ['android', 'samsung', 'lg', 'sonos', 'other'] },
  { id: 'apps', label: 'Refresh app list', kinds: ['android', 'samsung', 'lg'] },
];
export function commandLabel(id: string): string {
  return COMMANDS.find((c) => c.id === id)?.label ?? id.replace(/_/g, ' ');
}

export const COMMON_TIMEZONES = [
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth',
  'Australia/Hobart', 'Australia/Darwin', 'Pacific/Auckland', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London',
  'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC',
];
export function allTimezones(): string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (all?.length) return Array.from(new Set(['Australia/Sydney', ...all]));
  } catch {
    /* ignore */
  }
  return COMMON_TIMEZONES;
}

export const PERMISSION_LABELS: Record<string, string> = {
  'android.permission.RECORD_AUDIO': 'Microphone',
  'android.permission.CAMERA': 'Camera',
  'android.permission.ACCESS_FINE_LOCATION': 'Location',
  'android.permission.ACCESS_COARSE_LOCATION': 'Location',
  'android.permission.READ_CONTACTS': 'Contacts',
};

const JOB_LABELS: Record<string, string> = {
  guest_reset: 'Guest reset',
  'dns.rebuild': 'Rebuilt DNS policies',
  adopt: 'Adopted a device',
  'apps.enforce': 'Enforced app policy',
  enforce_apps: 'Enforced app policy',
  'gateway.update': 'Updated gateway',
  'gateway.restart': 'Restarted gateway',
  'gateway.revoke': 'Revoked gateway',
  screenshot: 'Screenshot', install: 'Installed an app', uninstall: 'Uninstalled an app', shell: 'Shell command', private_dns: 'Private DNS',
  pair: 'Pairing', clear: 'Cleared app data', stop: 'Stopped an app', disable: 'Disabled an app', enable: 'Enabled an app', play_store: 'Opened Play Store',
  launcher_install: 'Installed Screens Launcher', launcher_config: 'Updated launcher settings', launcher_remove: 'Removed Screens Launcher',
  launcher_status: 'Checked launcher', welcome_show: 'Showed welcome screen', debloat: 'Removed bloatware', revoke_permission: 'Revoked an app permission',
  grant_permission: 'Granted an app permission', apps: 'Refreshed app list',
};
export function jobLabel(kind: string, params?: Record<string, unknown> | null): string {
  if (kind === 'automation') return params?.automation ? `Automation “${String(params.automation)}”` : 'Automation';
  if (JOB_LABELS[kind]) return JOB_LABELS[kind];
  if (kind.startsWith('command:')) return jobLabel(kind.slice(8));
  if (kind.startsWith('automation:')) {
    const rest = kind.slice(11);
    if (rest in EVENTS) return `Automation: ${EVENTS[rest as AutomationEvent].label.toLowerCase()}`;
    return `Automation “${rest}”`;
  }
  const c = COMMANDS.find((x) => x.id === kind);
  if (c) return c.label;
  const t = kind.replace(/[._:]/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "you", "dev@localhost", "automation:Name" → readable. */
export function actorLabel(actor?: string | null): string {
  if (!actor) return '';
  if (actor === 'automation') return 'an automation';
  if (actor.startsWith('automation:')) return `automation “${actor.slice(11)}”`;
  return actor;
}

/** Android permission → the name the revoke/grant_permission commands take. */
export const PRIVACY_PERMISSION: Record<string, { key: 'microphone' | 'camera' | 'location' | 'contacts'; label: string }> = {
  'android.permission.RECORD_AUDIO': { key: 'microphone', label: 'Microphone' },
  'android.permission.CAMERA': { key: 'camera', label: 'Camera' },
  'android.permission.ACCESS_FINE_LOCATION': { key: 'location', label: 'Location' },
  'android.permission.ACCESS_COARSE_LOCATION': { key: 'location', label: 'Location' },
  'android.permission.READ_CONTACTS': { key: 'contacts', label: 'Contacts' },
};

import type {
  Alert, AppSettings, Automation, Device, DeviceCapability, DeviceKind, Discovered, Gateway, Job, MdnsConfig,
  SiteSettings,
} from '../../shared/types';
import type { Env } from '../env';
import { now, parseJson, rid } from './util';

export type Row = Record<string, any>;

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  monitor_days: 3,
  default_policy: 'balanced',
  unknown_clients: 'monitor',
  scan_cidrs: [],
  dot_enabled: false,
  guest: {
    clear_packages: [
      'com.netflix.ninja',
      'com.google.android.youtube.tv',
      'com.amazon.amazonvideo.livingroom',
      'com.disney.disneyplus',
      'com.wbd.stream',
      'com.apple.atve.androidtv.appletv',
      'com.cbs.ott',
      'au.com.stan.and',
      'au.com.streamotion.ares',
      'au.com.kayosports.tv',
      'com.spotify.tv.android',
      'com.plexapp.android',
    ],
    go_home: true,
    reboot: false,
    show_welcome_after_reset: true,
    welcome: {
      enabled: false,
      show_on_boot: true,
      title: 'Welcome',
      message: 'We hope you enjoy your stay.',
      wifi: null,
      sections: [
        { title: 'Your privacy', body: 'Your streaming logins are cleared automatically after you check out.' },
      ],
      contact: '',
      accent: '#4F8EF7',
    },
    kiosk: { enabled: false, allowed: [], pinned: [], force_home: false },
  },
};

export const DEFAULT_MDNS: MdnsConfig = {
  enabled: false,
  interfaces: [],
  rules: [],
  ssdp: { enabled: false, rules: [] },
  rate_limit_pps: 200,
  track_services: true,
};

export function siteSettings(row: Row): SiteSettings {
  const s = parseJson<Partial<SiteSettings>>(row.settings, {});
  const g: any = s.guest ?? {};
  const d = DEFAULT_SITE_SETTINGS.guest;
  const kiosk = { ...d.kiosk, ...(g.kiosk ?? {}) };
  const pin_set = !!kiosk.pin_sha256;
  delete kiosk.pin_sha256; delete kiosk.pin;
  return { ...DEFAULT_SITE_SETTINGS, ...s, guest: { ...d, ...g, welcome: { ...d.welcome, ...(g.welcome ?? {}) }, kiosk: { ...kiosk, pin_set } } };
}

/** Raw stored kiosk PIN hash (never sent to the dashboard). */
export function kioskPinHash(row: Row): string | null {
  return parseJson<any>(row.settings, {}).guest?.kiosk?.pin_sha256 ?? null;
}

export function siteMdns(row: Row): MdnsConfig {
  return { ...DEFAULT_MDNS, ...parseJson<Partial<MdnsConfig>>(row.mdns, {}) };
}

export function capabilitiesFor(kind: DeviceKind): DeviceCapability[] {
  switch (kind) {
    case 'android':
      return ['remote', 'text', 'apps', 'launch', 'install', 'uninstall', 'disable', 'clear', 'screenshot', 'tap', 'shell', 'reboot', 'power', 'volume', 'private_dns', 'media', 'toast', 'guest_reset', 'launcher'];
    case 'samsung':
      return ['remote', 'text', 'apps', 'launch', 'power', 'volume', 'guest_reset'];
    case 'lg':
      return ['remote', 'text', 'apps', 'launch', 'power', 'volume', 'media', 'toast'];
    case 'sonos':
      return ['media', 'volume', 'group'];
    default:
      return [];
  }
}

export function toDevice(r: Row): Device {
  return {
    id: r.id, site_id: r.site_id, site_name: r.site_name ?? undefined, kind: r.kind, name: r.name, room: r.room,
    ip: r.ip, mac: r.mac, port: r.port, manufacturer: r.manufacturer, model: r.model, os_version: r.os_version,
    serial: r.serial, firmware: r.firmware, status: r.status, power: r.power, current_app: r.current_app,
    last_seen: r.last_seen, tags: parseJson(r.tags, []), dns_mode: r.dns_mode, dns_policy: r.dns_policy,
    monitor_until: r.monitor_until, dns_allow: parseJson(r.dns_allow, []), dns_block: parseJson(r.dns_block, []),
    private_dns: r.private_dns, privacy_score: r.privacy_score, facts: parseJson(r.facts, {}),
    capabilities: capabilitiesFor(r.kind), created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function toGateway(r: Row, latest?: string | null): Gateway {
  const info = parseJson<any>(r.info, {});
  return {
    id: r.id, site_id: r.site_id, hostname: r.hostname, version: r.version, os: r.os, arch: r.arch,
    status: r.status, last_seen: r.last_seen, connected_at: r.connected_at, created_at: r.created_at,
    interfaces: info.interfaces ?? [], caps: info.caps ?? [], metrics: info.metrics ?? undefined,
    dns_listening: info.dns?.listening ?? [], dot_listening: info.dns?.dot_listening ?? [],
    latest_version: latest ?? null,
  };
}

export function toDiscovered(r: Row): Discovered {
  return {
    site_id: r.site_id, ip: r.ip, mac: r.mac, kind_guess: r.kind_guess, name: r.name, model: r.model,
    manufacturer: r.manufacturer, hints: parseJson(r.hints, {}), first_seen: r.first_seen, last_seen: r.last_seen,
    adopted_device_id: r.adopted_device_id ?? null, ignored: !!r.ignored,
  };
}

export function toJob(r: Row): Job {
  return {
    id: r.id, site_id: r.site_id, device_id: r.device_id, kind: r.kind, params: parseJson(r.params, {}),
    status: r.status, result: parseJson(r.result, null), actor: r.actor, automation_id: r.automation_id,
    created_at: r.created_at, finished_at: r.finished_at, site_name: r.site_name, device_name: r.device_name,
  };
}

export function toAlert(r: Row): Alert {
  return {
    id: r.id, at: r.at, severity: r.severity, type: r.type, site_id: r.site_id, device_id: r.device_id,
    title: r.title, details: r.details, acknowledged_at: r.acknowledged_at, resolved_at: r.resolved_at,
    site_name: r.site_name, device_name: r.device_name,
  };
}

export function toAutomation(r: Row): Automation {
  return {
    id: r.id, name: r.name, enabled: !!r.enabled, scope_type: r.scope_type, scope_id: r.scope_id,
    trigger: parseJson(r.trigger, { type: 'schedule', cron: '0 0 * * *' }), target: parseJson(r.target, {}),
    actions: parseJson(r.actions, []), last_run: r.last_run, last_status: r.last_status, created_at: r.created_at,
  };
}

export async function audit(env: Env, actor: string, action: string, opts: { target_type?: string; target_id?: string; site_id?: string | null; details?: unknown } = {}) {
  await env.DB.prepare('INSERT INTO audit_log (at, actor, action, target_type, target_id, site_id, details) VALUES (?,?,?,?,?,?,?)')
    .bind(now(), actor, action, opts.target_type ?? null, opts.target_id ?? null, opts.site_id ?? null, opts.details === undefined ? null : JSON.stringify(opts.details))
    .run();
}

/** Raise (or refresh) an alert. dedupe_key keeps one open alert per condition. */
export async function raiseAlert(env: Env, a: { severity: Alert['severity']; type: string; title: string; details?: string; site_id?: string | null; device_id?: string | null; dedupe_key?: string }) {
  const id = rid('al');
  const key = a.dedupe_key ?? null;
  if (key) {
    const existing = await env.DB.prepare('SELECT id FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL').bind(key).first<Row>();
    if (existing) return existing.id as string;
    // An old resolved alert may hold the key; free it.
    await env.DB.prepare('UPDATE alerts SET dedupe_key = NULL WHERE dedupe_key = ?').bind(key).run();
  }
  await env.DB.prepare('INSERT INTO alerts (id, at, severity, type, site_id, device_id, title, details, dedupe_key) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, now(), a.severity, a.type, a.site_id ?? null, a.device_id ?? null, a.title, a.details ?? null, key)
    .run();
  return id;
}

export async function resolveAlert(env: Env, dedupe_key: string) {
  await env.DB.prepare('UPDATE alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL').bind(now(), dedupe_key).run();
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  dot_base_domain: null,
  default_monitor_days: 3,
  default_policy: 'balanced',
  dns_log_retention_days: 7,
  agent_latest_version: null,
};

export async function getAppSettings(env: Env): Promise<AppSettings> {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all<Row>();
  const out: any = { ...DEFAULT_APP_SETTINGS, dot_base_domain: env.DOT_BASE_DOMAIN || null };
  for (const r of rows.results) {
    if (r.key === 'cf_dns_token') { out.cf_dns_token_set = true; continue; }
    if (r.key.startsWith('policy_content_') || r.key === 'acme_account' || r.key === 'seeded_v1') continue;
    out[r.key] = parseJson(r.value, r.value);
  }
  out.cf_dns_token_set = !!out.cf_dns_token_set || !!env.CF_API_TOKEN;
  return out as AppSettings;
}

export async function setAppSetting(env: Env, key: string, value: unknown) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value)).run();
}

export async function createJob(env: Env, j: { site_id?: string | null; device_id?: string | null; kind: string; params?: unknown; actor?: string; automation_id?: string | null; status?: Job['status'] }): Promise<string> {
  const id = rid('job');
  await env.DB.prepare('INSERT INTO jobs (id, site_id, device_id, kind, params, status, actor, automation_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, j.site_id ?? null, j.device_id ?? null, j.kind, JSON.stringify(j.params ?? {}), j.status ?? 'running', j.actor ?? null, j.automation_id ?? null, now())
    .run();
  return id;
}

export async function finishJob(env: Env, id: string, status: 'ok' | 'error', result: unknown) {
  let r = JSON.stringify(result ?? null);
  if (r.length > 64_000) r = JSON.stringify({ truncated: true, preview: r.slice(0, 60_000) });
  await env.DB.prepare('UPDATE jobs SET status = ?, result = ?, finished_at = ? WHERE id = ?').bind(status, r, now(), id).run();
}

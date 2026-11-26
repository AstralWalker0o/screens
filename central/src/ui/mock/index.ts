// In-memory mock of the Screens API (docs/API.md). Loaded only in mock mode.

import { ApiError } from '../api';
import type { NetConfig, NetworkState } from '../../shared/types';
import type {
  Alert, Apk, AppPolicy, AppSettings, Automation, Client, CommandResult, Device, DeviceKind, DevicePrivacy, DnsLogEntry,
  DnsRule, Gateway, Job, LiveEvent, MdnsConfig, MdnsStatus, Overview, PrivacyOverview, SiteDetail, SiteSummary, AuditEntry,
  DnsList, EnrollResult, Discovered, VersionInfo,
} from '../../shared/types';
import { APP_VERSION } from '../../shared/releases';
import * as F from './data';
import { D, H, M, NOW, S } from './data';
import { allDomainStats, buildTraffic, makeEntry, resetLiveRng, seedLog, summarize, type SiteCtx } from './dns';
import { applyKey, applyTap, renderScreen, type ScreenState } from './screens';
import { startMockMirror } from './mirror';
import type { MirrorConnection, MirrorHandlers, MirrorParams } from '../api';
import { between, hex } from './rand';
import { sonosMock, sonosOverview } from './sonos';
import { launcherMock } from './launcher';
import { registerUpdates } from './updates';

const clone = <T,>(v: T): T => (v === undefined ? v : structuredClone(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// State

const db = {
  clients: clone(F.clients),
  sites: clone(F.sites),
  gateways: clone(F.gateways),
  devices: clone(F.devices),
  apps: clone(F.apps),
  privacy: clone(F.privacy),
  rules: clone(F.rules),
  lists: clone(F.lists),
  builds: clone(F.builds),
  discovered: clone(F.discovered),
  mdns: clone(F.mdnsConfig),
  network: {} as Record<string, NetConfig>,
  apks: clone(F.apks),
  appPolicies: clone(F.appPolicies),
  automations: clone(F.automations),
  jobs: clone(F.jobs),
  alerts: clone(F.alerts),
  audit: clone(F.audit),
  settings: clone(F.settings),
};

const traffic = buildTraffic(db.devices);
const screens = new Map<string, ScreenState>();
const logs = new Map<string, DnsLogEntry[]>();
let jobSeq = 100;
let auditSeq = 200;

function siteCtx(siteId: string): SiteCtx {
  const site = db.sites.find((s) => s.id === siteId);
  const gw = db.gateways.find((g) => g.site_id === siteId);
  const guestIface = gw?.interfaces?.find((i) => i.name.endsWith('.30'))?.addrs[0] ?? gw?.interfaces?.[0]?.addrs[0] ?? '10.9.9.1/24';
  return {
    siteId,
    devices: db.devices.filter((d) => d.site_id === siteId),
    unknownMode: site?.settings.unknown_clients ?? 'monitor',
    rules: db.rules,
    guestSubnet: guestIface.split('/')[0].split('.').slice(0, 3).join('.'),
  };
}

function siteLog(siteId: string): DnsLogEntry[] {
  let l = logs.get(siteId);
  if (!l) {
    const hasGw = db.gateways.some((g) => g.site_id === siteId && g.status !== 'revoked');
    l = hasGw ? seedLog(siteCtx(siteId)) : [];
    logs.set(siteId, l);
  }
  return l;
}

function screenFor(id: string): ScreenState {
  let s = screens.get(id);
  if (!s) {
    const d = db.devices.find((x) => x.id === id);
    s = { focus: 2, row: 0, app: d?.current_app && d.current_app !== 'Plex' ? d.current_app : null, tab: 0 };
    screens.set(id, s);
  }
  return s;
}

const err = (status: number, code: string, message: string) => new ApiError(status, code, message);
const notFound = (what: string) => err(404, 'not_found', `${what} not found`);

function logAudit(action: string, target_type: string, target_id?: string, site_id?: string | null, details?: unknown) {
  const e: AuditEntry = { id: auditSeq++, at: Date.now(), actor: 'you', action, target_type, target_id, site_id: site_id ?? null, details };
  db.audit.unshift(e);
}

function addJob(kind: string, o: Partial<Job>): Job {
  const site = db.sites.find((s) => s.id === o.site_id);
  const device = db.devices.find((d) => d.id === o.device_id);
  const j: Job = {
    id: `j_${jobSeq++}`, kind, params: {}, status: 'ok', actor: 'you', created_at: Date.now(), finished_at: Date.now() + 600,
    site_name: site?.name ?? null, device_name: device?.name ?? null, ...o,
  };
  db.jobs.unshift(j);
  return j;
}

// ---------------------------------------------------------------------------
// Derived views

const isUp = (d: Device) => d.status === 'online' || d.status === 'standby';

function openAlerts(): Alert[] {
  return db.alerts.filter((a) => !a.acknowledged_at && !a.resolved_at);
}

function siteSummary(s: (typeof db.sites)[number]): SiteSummary {
  const gw = db.gateways.find((g) => g.site_id === s.id);
  const devs = db.devices.filter((d) => d.site_id === s.id);
  const sum = summarize(traffic, devs, db.rules, s.settings.unknown_clients);
  return {
    id: s.id, client_id: s.client_id, client_name: db.clients.find((c) => c.id === s.client_id)?.name, name: s.name, slug: s.slug,
    kind: s.kind, timezone: s.timezone, address: s.address,
    gateway_status: gw ? gw.status : 'none', gateway_last_seen: gw?.last_seen ?? null,
    devices_total: devs.length, devices_online: devs.filter(isUp).length,
    dns_queries_24h: sum.queries, dns_blocked_24h: sum.blocked,
    alerts_open: openAlerts().filter((a) => a.site_id === s.id).length,
    created_at: s.created_at,
  };
}

function withSite(d: Device): Device {
  return { ...d, site_name: db.sites.find((s) => s.id === d.site_id)?.name };
}

function siteDetail(id: string): SiteDetail {
  const s = db.sites.find((x) => x.id === id);
  if (!s) throw notFound('Site');
  const gw = db.gateways.find((g) => g.site_id === id) ?? null;
  return {
    ...siteSummary(s), notes: s.notes, settings: s.settings, gateway: gw ? gatewayView(gw) : null,
    devices: db.devices.filter((d) => d.site_id === id).map(withSite),
    dot_hostname: s.dot_hostname ?? null,
    dot_status: s.settings.dot_enabled ? s.dot_status ?? 'Certificate pending' : 'Off',
  };
}

function gatewayView(g: Gateway): Gateway {
  const sum = summarize(traffic, db.devices.filter((d) => d.site_id === g.site_id), db.rules);
  const elapsed = (Date.now() - NOW) / 1000;
  return {
    ...g,
    last_seen: g.status === 'online' ? Date.now() - Math.round(between(2, 12)) * S : g.last_seen,
    metrics: g.metrics && {
      ...g.metrics,
      uptime_s: (g.metrics.uptime_s ?? 0) + elapsed,
      dns: g.metrics.dns && { ...g.metrics.dns, queries: sum.queries, blocked: sum.blocked, would_block: sum.would_block, cache_hits: Math.round(sum.queries * 0.58) },
    },
  };
}

function scoreOf(d: Device): number | null {
  return d.privacy_score ?? null;
}

function devicePrivacy(d: Device): DevicePrivacy {
  const p = db.privacy[d.id] ?? { factors: [], checklist: [], mic: [], bypass: false };
  const score = scoreOf(d) ?? 0;
  const g = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  return { device_id: d.id, score, grade: g, factors: p.factors, checklist: p.checklist, mic: p.mic, dns: summarize(traffic, [d], db.rules), bypass_suspected: p.bypass };
}

function privacyRows(): PrivacyOverview['devices'] {
  return db.devices
    .filter((d) => scoreOf(d) != null)
    .map((d) => {
      const pr = devicePrivacy(d);
      return {
        device_id: d.id, name: d.name, site_id: d.site_id, site_name: db.sites.find((s) => s.id === d.site_id)?.name ?? '', kind: d.kind,
        score: pr.score, grade: pr.grade, bypass_suspected: pr.bypass_suspected, acr_24h: pr.dns.by_category.acr ?? 0,
      };
    })
    .sort((a, b) => a.score - b.score);
}

function acrByVendor(): PrivacyOverview['acr_by_vendor'] {
  const label = (domain: string) => (/alphonso|lge\.com/.test(domain) ? 'LG / Alphonso' : /samba\.tv/.test(domain) ? 'Samba TV' : /samsung/.test(domain) ? 'Samsung' : /inscape|vizio/.test(domain) ? 'Inscape (Vizio)' : 'Other');
  const m = new Map<string, { vendor: string; attempts: number; blocked: number; devices: Set<string> }>();
  for (const d of db.devices) {
    for (const st of allDomainStats(traffic, [d], db.rules)) {
      if (st.category !== 'acr') continue;
      const v = label(st.domain);
      const e = m.get(v) ?? { vendor: v, attempts: 0, blocked: 0, devices: new Set<string>() };
      e.attempts += st.queries;
      e.blocked += st.blocked;
      e.devices.add(d.id);
      m.set(v, e);
    }
  }
  return [...m.values()].map((e) => ({ vendor: e.vendor, attempts: e.attempts, blocked: e.blocked, devices: e.devices.size })).sort((a, b2) => b2.attempts - a.attempts);
}

function overview(): Overview {
  const byKind: Partial<Record<DeviceKind, number>> = {};
  for (const d of db.devices) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  return {
    counts: {
      clients: db.clients.length, sites: db.sites.length,
      gateways_online: db.gateways.filter((g) => g.status === 'online').length, gateways_total: db.gateways.filter((g) => g.status !== 'revoked').length,
      devices_total: db.devices.length, devices_online: db.devices.filter(isUp).length, devices_by_kind: byKind,
      alerts_open: openAlerts().length,
    },
    dns: summarize(traffic, db.devices, db.rules),
    sites: db.sites.map(siteSummary),
    privacy_worst: privacyRows().slice(0, 5),
    alerts: openAlerts().sort((a, b) => b.at - a.at).slice(0, 6),
    recent_jobs: [...db.jobs].sort((a, b) => b.created_at - a.created_at).slice(0, 8),
  };
}

function mdnsState(siteId: string): { config: MdnsConfig; status: MdnsStatus | null; interfaces: NonNullable<Gateway['interfaces']> } {
  const gw = db.gateways.find((g) => g.site_id === siteId && g.status !== 'revoked');
  const config = db.mdns[siteId] ?? { enabled: false, interfaces: [], rules: [], ssdp: { enabled: false, rules: [] }, rate_limit_pps: 50, track_services: true };
  if (!gw) return { config, status: null, interfaces: [] };
  const elapsed = (Date.now() - NOW) / 1000;
  const base = gw.metrics?.mdns ?? { reflected: 0, filtered: 0, rate_limited: 0, ssdp_relayed: 0 };
  const on = config.enabled;
  const status: MdnsStatus = {
    enabled: on,
    interfaces: (gw.interfaces ?? []).filter((i) => config.interfaces.includes(i.name)).map((i, k) => ({
      name: i.name, rx: Math.round(9_000 + k * 4_200 + elapsed * (3 + k)), tx: Math.round(6_100 + k * 2_900 + elapsed * (2 + k)), dropped: k === 0 ? 3 : 0,
    })),
    services: (F.mdnsServices[siteId] ?? []).map((s) => ({ ...s, last_seen: Date.now() - (NOW - s.last_seen) })),
    counters: on
      ? { reflected: Math.round(base.reflected + elapsed * 3.1), filtered: Math.round(base.filtered + elapsed * 0.4), rate_limited: base.rate_limited, ssdp_relayed: Math.round(base.ssdp_relayed + (config.ssdp.enabled ? elapsed * 0.2 : 0)) }
      : { reflected: base.reflected, filtered: base.filtered, rate_limited: base.rate_limited, ssdp_relayed: base.ssdp_relayed },
  };
  return { config, status, interfaces: gw.interfaces ?? [] };
}

// ---------------------------------------------------------------------------
// Device commands

const NEEDS: Record<string, Device['capabilities'][number] | undefined> = {
  key: 'remote', text: 'text', tap: 'tap', reboot: 'reboot', volume: 'volume', mute: 'volume', apps: 'apps', launch: 'launch',
  stop: 'clear', clear: 'clear', disable: 'disable', enable: 'disable', uninstall: 'uninstall', install: 'install', play_store: 'install',
  screenshot: 'screenshot', shell: 'shell', private_dns: 'private_dns', media: 'media', group: 'group', ungroup: 'group', toast: 'toast',
  guest_reset: 'guest_reset', power_on: 'power', power_off: 'power',
  launcher_install: 'launcher', launcher_config: 'launcher', launcher_status: 'launcher', launcher_remove: 'launcher', welcome_show: 'launcher',
  adb_pair: 'shell', revoke_permission: 'disable', grant_permission: 'disable', debloat: 'disable', input: 'remote', favorites: 'favorites', play_favorite: 'favorites', eq: 'eq', sleep_timer: 'media', led: 'led',
};
const SONOS_ONLY = ['favorites', 'play_favorite', 'eq', 'sleep_timer', 'status', 'seek', 'play_mode', 'crossfade', 'queue', 'play_queue', 'remove_from_queue', 'clear_queue',
  'playlists', 'inputs', 'play_input', 'join', 'party', 'pause_all', 'group_volume', 'group_mute', 'button_lock', 'settings', 'alarms', 'alarm_enable'];
const KIND_ONLY: Record<string, DeviceKind> = { input: 'samsung', adb_pair: 'android', ...Object.fromEntries(SONOS_ONLY.map((c) => [c, 'sonos' as DeviceKind])) };
const revoked = new Map<string, boolean>();

const WHY_NOT: Partial<Record<DeviceKind, string>> = {
  samsung: 'Samsung TVs only accept remote keys, text and app launching over the network.',
  lg: 'LG TVs only accept remote keys, text, toasts and app launching over the network.',
  sonos: 'Sonos speakers only support playback, volume and grouping.',
};

function shellOut(cmd: string, d: Device): { stdout: string; exit_code: number } {
  const c = cmd.trim();
  if (/^getprop ro.product.model/.test(c)) return { stdout: `${d.model}\n`, exit_code: 0 };
  if (/^getprop ro.build.version.release/.test(c)) return { stdout: '11\n', exit_code: 0 };
  if (/^settings get global private_dns_mode/.test(c)) return { stdout: d.private_dns ? 'hostname\n' : 'off\n', exit_code: 0 };
  if (/^settings get global private_dns_specifier/.test(c)) return { stdout: `${d.private_dns ?? 'null'}\n`, exit_code: 0 };
  if (/^pm list packages -3/.test(c)) return { stdout: (db.apps[d.id] ?? []).filter((a) => !a.system).map((a) => `package:${a.package}`).join('\n') + '\n', exit_code: 0 };
  if (/^pm list packages/.test(c)) return { stdout: (db.apps[d.id] ?? []).map((a) => `package:${a.package}`).join('\n') + '\n', exit_code: 0 };
  if (/^uptime/.test(c)) return { stdout: ' 21:14:07 up 6 days,  3:02,  0 users,  load average: 1.12, 0.98, 0.91\n', exit_code: 0 };
  if (/^df/.test(c)) return { stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/block/dm-5  11G  6.1G  4.9G  56% /data\n', exit_code: 0 };
  if (/^ip (a|addr)/.test(c)) return { stdout: `2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    link/ether ${d.mac}\n    inet ${d.ip}/24 brd ${d.ip?.replace(/\.\d+$/, '.255')} scope global eth0\n`, exit_code: 0 };
  if (/^dumpsys window \| grep mCurrentFocus|^dumpsys activity activities/.test(c)) return { stdout: `  mCurrentFocus=Window{4f1 u0 ${String(d.facts.package ?? 'com.google.android.tvlauncher')}/.MainActivity}\n`, exit_code: 0 };
  if (/^whoami/.test(c)) return { stdout: 'shell\n', exit_code: 0 };
  if (/^echo /.test(c)) return { stdout: `${c.slice(5)}\n`, exit_code: 0 };
  return { stdout: `/system/bin/sh: ${c.split(' ')[0]}: inaccessible or not found\n`, exit_code: 127 };
}

async function command(d: Device, cmd: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
  const need = NEEDS[cmd];
  if (KIND_ONLY[cmd] && d.kind !== KIND_ONLY[cmd]) throw err(400, 'not_supported', `${d.name} can’t do that. ${WHY_NOT[d.kind] ?? ''}`.trim());
  if (need && !d.capabilities.includes(need)) {
    throw err(400, 'not_supported', `${d.name} can’t do that. ${WHY_NOT[d.kind] ?? ''}`.trim());
  }
  if (d.status === 'offline' && cmd !== 'power_on') {
    throw err(409, 'device_offline', `${d.name} is offline. Check it has power and is connected to the network.`);
  }
  if (d.status === 'pairing' && !['pair', 'refresh', 'adb_pair'].includes(cmd)) {
    throw err(409, 'not_paired', `${d.name} is waiting for someone to press “Allow” on the TV. Accept the prompt with the TV remote, then try again.`);
  }
  if (d.kind === 'sonos' && !['refresh', 'pair', 'power_off', 'power_on'].includes(cmd)) {
    const r = await sonosMock(d, cmd, args, db.devices);
    if (r) {
      if ((d.facts.last_error as { command?: string } | undefined)?.command === cmd) d.facts.last_error = null;
      return r;
    }
  }
  const job = (data?: unknown): CommandResult => ({ ok: true, data, job_id: addJob(`command:${cmd}`, { site_id: d.site_id, device_id: d.id, params: args, result: data }).id });
  const st = screenFor(d.id);
  switch (cmd) {
    case 'refresh':
      d.last_seen = Date.now();
      return job({ status: d.status });
    case 'pair':
      d.status = 'pairing';
      if (d.kind === 'android') setTimeout(() => { d.status = 'online'; }, 8000);
      return job({ state: 'prompt_shown' });
    case 'key': {
      const key = String(args.key ?? '');
      screens.set(d.id, applyKey(st, key));
      if (key === 'POWER') {
        d.power = d.power === 'on' ? 'standby' : 'on';
        d.status = d.power === 'on' ? 'online' : 'standby';
      }
      if (key === 'HOME') d.current_app = null;
      if (key === 'OK' && d.kind === 'android') d.current_app = applyKey(st, 'OK').app;
      return { ok: true };
    }
    case 'text':
      return { ok: true };
    case 'tap': {
      const n = applyTap(st, Number(args.x), Number(args.y));
      screens.set(d.id, n);
      if (n.app) d.current_app = n.app;
      return { ok: true };
    }
    case 'power_on':
      if (d.status === 'offline') throw err(409, 'device_offline', `${d.name} didn’t wake up. Wake-on-LAN only works if the device still has power.`);
      d.power = 'on';
      d.status = 'online';
      return job();
    case 'power_off':
      d.power = 'standby';
      d.status = d.kind === 'android' ? 'standby' : 'standby';
      d.current_app = null;
      return job();
    case 'reboot':
      d.status = 'offline';
      d.last_seen = Date.now();
      setTimeout(() => { d.status = 'online'; d.last_seen = Date.now(); }, 9000);
      return job();
    case 'volume': {
      const np = (d.facts.now_playing ?? {}) as Record<string, unknown>;
      const cur = Number(np.volume ?? d.facts.volume ?? 20);
      const level = Math.max(0, Math.min(100, Math.round(args.level != null ? Number(args.level) : cur + Number(args.delta ?? 0))));
      if (d.kind === 'sonos') d.facts.now_playing = { ...np, volume: level };
      else d.facts.volume = level;
      return { ok: true, data: { volume: level } };
    }
    case 'mute': {
      if (d.kind === 'sonos') d.facts.now_playing = { ...(d.facts.now_playing as object), muted: !!args.mute };
      else d.facts.muted = !!args.mute;
      return { ok: true, data: { muted: !!args.mute } };
    }
    case 'apps':
      return job(db.apps[d.id] ?? []);
    case 'launch': {
      const a = (db.apps[d.id] ?? []).find((x) => x.package === args.package || x.app_id === args.app_id);
      d.current_app = a?.label ?? String(args.package ?? args.app_id);
      if (d.kind === 'android') screens.set(d.id, { ...st, app: d.current_app });
      return job({ launched: d.current_app });
    }
    case 'stop':
      if (d.current_app && (db.apps[d.id] ?? []).find((x) => x.package === args.package)?.label === d.current_app) {
        d.current_app = null;
        screens.set(d.id, { ...st, app: null });
      }
      return job();
    case 'clear':
      return job({ output: 'Success' });
    case 'disable':
    case 'enable': {
      const a = (db.apps[d.id] ?? []).find((x) => x.package === args.package);
      if (a) a.enabled = cmd === 'enable';
      return job({ output: `Package ${String(args.package)} new state: ${cmd === 'enable' ? 'enabled' : 'disabled-user'}` });
    }
    case 'uninstall': {
      const list = db.apps[d.id] ?? [];
      const a = list.find((x) => x.package === args.package);
      if (a?.system) throw err(400, 'failed', `${a.label} is a system app and can’t be uninstalled. You can disable it instead.`);
      db.apps[d.id] = list.filter((x) => x.package !== args.package);
      return job({ output: 'Success' });
    }
    case 'install': {
      const apk = db.apks.find((x) => x.id === args.apk_id);
      if (!apk) throw notFound('APK');
      await sleep(1800);
      const list = db.apps[d.id] ?? (db.apps[d.id] = []);
      if (!list.some((x) => x.package === apk.package)) {
        list.push({ package: apk.package ?? apk.id, label: apk.label, version_name: apk.version_name, version_code: apk.version_code, system: false, enabled: true, permissions: [], category: null, risk: null, first_seen: Date.now(), last_seen: Date.now() });
      }
      return job({ output: 'Performing Streamed Install\nSuccess' });
    }
    case 'play_store':
      screens.set(d.id, { ...st, app: 'Google Play' });
      return job();
    case 'screenshot':
      await sleep(400);
      return job({ url: renderScreen(screenFor(d.id)) });
    case 'shell':
      return { ok: true, data: shellOut(String(args.cmd ?? ''), d) };
    case 'private_dns': {
      const site = db.sites.find((s) => s.id === d.site_id);
      if (args.enabled && !site?.settings.dot_enabled) throw err(409, 'dot_disabled', 'Turn on Private DNS (DoT) for this site first: Site → Settings → Private DNS.');
      await sleep(900);
      d.private_dns = args.enabled ? siteDetail(d.site_id).dot_hostname ?? null : null;
      return job({ verified: true, hostname: d.private_dns });
    }
    case 'media': {
      const a = String(args.action);
      const coordUuid = (d.facts.group as { coordinator?: string } | undefined)?.coordinator;
      const groupDevs = db.devices.filter((o) => o.kind === 'sonos' && (o.facts.group as { coordinator?: string } | undefined)?.coordinator === coordUuid);
      const np = { ...((d.facts.now_playing ?? {}) as Record<string, unknown>) };
      if (a === 'play') np.state = 'PLAYING';
      if (a === 'pause') np.state = 'PAUSED_PLAYBACK';
      if (a === 'stop') np.state = 'STOPPED';
      if (a === 'next' || a === 'prev') {
        const tracks = [
          { title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We’re Dreaming' },
          { title: 'Breathe Deeper', artist: 'Tame Impala', album: 'The Slow Rush' },
          { title: 'Innerbloom', artist: 'RÜFÜS DU SOL', album: 'Bloom' },
          { title: 'Lost in Yesterday', artist: 'Tame Impala', album: 'The Slow Rush' },
        ];
        const i = Math.max(0, tracks.findIndex((t) => t.title === np.title));
        Object.assign(np, tracks[(i + (a === 'next' ? 1 : tracks.length - 1)) % tracks.length], { state: 'PLAYING' });
      }
      for (const o of groupDevs.length ? groupDevs : [d]) {
        const own = (o.facts.now_playing ?? {}) as Record<string, unknown>;
        o.facts.now_playing = { ...np, volume: own.volume, muted: own.muted };
        if (a === 'next' || a === 'prev') o.facts.position = { elapsed_s: 0, duration_s: 214 };
      }
      return { ok: true };
    }
    case 'toast':
      return job();
    case 'guest_reset':
      return job({ detail: d.kind === 'android' ? 'Cleared apps and went home' : 'Returned to Home' });
    case 'adb_pair': {
      const code = String(args.code ?? '');
      const port = Number(args.port);
      if (!/^\d{6}$/.test(code) || !(port > 0 && port < 65536)) throw err(400, 'bad_args', 'Enter the 6-digit pairing code and the pairing port shown on the TV');
      await sleep(1500);
      if (code === '000000') return { ok: false, error: 'Pairing failed: Failed: Wrong password or connection was dropped.', data: { ok: false, detail: 'Pairing failed' } };
      d.status = 'online';
      return job({ ok: true, detail: 'Paired. Screens will now connect using the wireless debugging port.' });
    }
    case 'revoke_permission':
    case 'grant_permission': {
      const perm = { microphone: 'android.permission.RECORD_AUDIO', camera: 'android.permission.CAMERA', location: 'android.permission.ACCESS_FINE_LOCATION', contacts: 'android.permission.READ_CONTACTS' }[String(args.permission)];
      if (!perm) throw err(400, 'bad_args', 'permission must be one of microphone, camera, location, contacts');
      const a = (db.apps[d.id] ?? []).find((x) => x.package === args.package);
      if (!a) throw notFound('App');
      await sleep(500);
      const revoke = cmd === 'revoke_permission';
      revoked.set(`${d.id}|${a.package}|${perm}`, revoke);
      return job({ ok: true, permission: args.permission, mode: revoke ? 'ignore' : 'allow' });
    }
    case 'debloat': {
      await sleep(1600);
      const catalogue = ['com.google.android.tvrecommendations', 'com.nvidia.tegrazone3', 'com.nvidia.diagtools', 'tv.pluto.android', 'com.google.android.youtube.tvmusic', 'com.amazon.amazonvideo.livingroom.ads', 'com.nvidia.shieldtech.accessoryserver'];
      const list = db.apps[d.id] ?? [];
      const disabled: string[] = [];
      const failed: string[] = [];
      const skipped: string[] = [];
      for (const p of catalogue) {
        const a = list.find((x) => x.package === p);
        if (!a || !a.enabled) skipped.push(p);
        else if (p === 'com.nvidia.tegrazone3') failed.push(p);
        else {
          a.enabled = false;
          disabled.push(p);
        }
      }
      const res = { ok: failed.length === 0, disabled, failed, skipped };
      addJob('debloat', { site_id: d.site_id, device_id: d.id, status: res.ok ? 'ok' : 'error', result: res });
      return { ok: res.ok, data: res, error: undefined };
    }
    case 'input': {
      const src = String(args.source ?? '').toUpperCase();
      if (!['TV', 'HDMI1', 'HDMI2', 'HDMI3', 'HDMI4', 'SOURCE'].includes(src)) throw err(400, 'bad_args', 'source must be TV, HDMI1–HDMI4 or SOURCE');
      if (src !== 'SOURCE') d.current_app = src === 'TV' ? 'Live TV' : src.replace('HDMI', 'HDMI ');
      return { ok: true };
    }
    case 'launcher_install': {
      await sleep(2200);
      return job({ status: await launcher.command(d, cmd) });
    }
    case 'launcher_config':
      if (!(d.facts.launcher as { installed?: boolean } | undefined)?.installed) throw err(409, 'launcher_missing', `The Screens Launcher isn’t installed on ${d.name}. Install it first.`);
      await sleep(600);
      return job({ status: await launcher.command(d, cmd) });
    case 'launcher_home':
      await sleep(500);
      return job({ status: await launcher.command(d, cmd) });
    case 'launcher_status':
      return job({ status: d.facts.launcher ?? { installed: false, checked_at: Date.now() } });
    case 'launcher_remove':
      await sleep(1200);
      d.facts.launcher = { installed: false, checked_at: Date.now() };
      return job({ status: d.facts.launcher });
    case 'welcome_show':
      if (!(d.facts.launcher as { installed?: boolean } | undefined)?.installed) throw err(409, 'launcher_missing', `The Screens Launcher isn’t installed on ${d.name}.`);
      return job();
    default:
      throw err(400, 'unknown_command', `Unknown command “${cmd}”.`);
  }
}

// ---------------------------------------------------------------------------
// Router

type Ctx = { params: string[]; q: URLSearchParams; body: unknown };
type Handler = (c: Ctx) => unknown | Promise<unknown>;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) => {
  const re = new RegExp(`^${pattern.replace(/:[a-z_]+/g, '([^/]+)')}$`);
  routes.push([method, re, h]);
};
const b = <T,>(c: Ctx) => (c.body ?? {}) as T;
const findDevice = (id: string) => {
  const d = db.devices.find((x) => x.id === id);
  if (!d) throw notFound('Device');
  return d;
};
const findSite = (id: string) => {
  const s = db.sites.find((x) => x.id === id);
  if (!s) throw notFound('Site');
  return s;
};

on('GET', '/api/me', () => ({ email: 'owner@supercluster.au', name: 'Owner', dev: true }));
on('GET', '/api/version', (): VersionInfo => {
  const latest = db.settings.agent_latest_version ?? null;
  const sites = db.gateways.filter((g) => g.status !== 'revoked').map((g) => ({
    site_id: g.site_id, site_name: db.sites.find((s) => s.id === g.site_id)?.name ?? g.site_id, version: g.version ?? null, status: g.status,
    up_to_date: !!latest && g.version === latest,
  }));
  const launchers = db.devices.map((d) => d.facts.launcher as { installed?: boolean; version?: string } | undefined).filter((l) => l?.installed);
  const launcherLatest = '1.0.2';
  return {
    version: APP_VERSION, build_sha: 'mock123', built_at: new Date(NOW - 2 * H).toISOString(),
    gateway: { latest, up_to_date: sites.filter((s) => s.up_to_date).length, total: sites.length, sites },
    launcher: { latest: launcherLatest, installed: launchers.length, up_to_date: launchers.filter((l) => l?.version === launcherLatest).length },
  };
});
on('GET', '/api/overview', () => overview());

on('GET', '/api/clients', () => db.clients.map((c) => ({
  ...c, site_count: db.sites.filter((s) => s.client_id === c.id).length,
  device_count: db.devices.filter((d) => db.sites.find((s) => s.id === d.site_id)?.client_id === c.id).length,
})));
on('POST', '/api/clients', (c) => {
  const body = b<Partial<Client>>(c);
  if (!body.name?.trim()) throw err(400, 'bad_request', 'Give the client a name.');
  const cl: Client = { id: `cl_${hex(6)}`, name: body.name.trim(), contact: body.contact ?? null, notes: body.notes ?? null, created_at: Date.now() };
  db.clients.push(cl);
  logAudit('client.create', 'client', cl.id, null, { name: cl.name });
  return cl;
});
on('PATCH', '/api/clients/:id', (c) => {
  const cl = db.clients.find((x) => x.id === c.params[0]);
  if (!cl) throw notFound('Client');
  Object.assign(cl, b<Partial<Client>>(c));
  return cl;
});
on('DELETE', '/api/clients/:id', (c) => {
  if (db.sites.some((s) => s.client_id === c.params[0])) throw err(409, 'has_sites', 'This client still has sites. Delete or move them first.');
  db.clients = db.clients.filter((x) => x.id !== c.params[0]);
  logAudit('client.delete', 'client', c.params[0]);
  return { ok: true };
});

on('GET', '/api/sites', (c) => {
  const cid = c.q.get('client_id');
  return db.sites.filter((s) => !cid || s.client_id === cid).map(siteSummary);
});
on('POST', '/api/sites', (c) => {
  const body = b<{ client_id: string; name: string; kind: SiteDetail['kind']; timezone: string; address?: string }>(c);
  if (!body.name?.trim()) throw err(400, 'bad_request', 'Give the site a name.');
  if (!db.clients.some((x) => x.id === body.client_id)) throw err(400, 'bad_request', 'Pick which client this site belongs to.');
  const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (db.sites.some((s) => s.slug === slug)) throw err(409, 'conflict', `A site called “${body.name}” already exists.`);
  const s = {
    id: `s_${hex(6)}`, client_id: body.client_id, name: body.name.trim(), slug, kind: body.kind, timezone: body.timezone || 'Australia/Sydney', address: body.address ?? null,
    created_at: Date.now(), notes: null,
    settings: { monitor_days: db.settings.default_monitor_days, default_policy: db.settings.default_policy, unknown_clients: 'monitor' as const, scan_cidrs: [], dot_enabled: false, guest: F.defaultGuest() },
    dot_hostname: null, dot_status: null,
  };
  db.sites.push(s);
  logAudit('site.create', 'site', s.id, s.id, { name: s.name });
  return siteDetail(s.id);
});
on('GET', '/api/sites/:id', (c) => siteDetail(c.params[0]));
on('PATCH', '/api/sites/:id', (c) => {
  const s = findSite(c.params[0]);
  const body = b<Partial<SiteDetail>>(c);
  const { settings, ...rest } = body;
  for (const k of ['name', 'kind', 'timezone', 'address', 'notes'] as const) if (k in rest) (s as Record<string, unknown>)[k] = rest[k];
  if (settings) {
    const g = settings.guest;
    let kiosk = s.settings.guest.kiosk;
    if (g?.kiosk) {
      const { pin, ...k } = g.kiosk;
      kiosk = { ...kiosk, ...k, pin_set: pin === undefined ? kiosk.pin_set : pin !== '' };
    }
    s.settings = { ...s.settings, ...settings, guest: { ...s.settings.guest, ...(g ?? {}), kiosk } };
  }
  logAudit('site.update', 'site', s.id, s.id, body);
  return siteDetail(s.id);
});
on('DELETE', '/api/sites/:id', (c) => {
  const id = c.params[0];
  findSite(id);
  db.sites = db.sites.filter((s) => s.id !== id);
  db.devices = db.devices.filter((d) => d.site_id !== id);
  db.gateways = db.gateways.filter((g) => g.site_id !== id);
  logAudit('site.delete', 'site', id);
  return { ok: true };
});
on('POST', '/api/sites/:id/enroll', (c) => {
  const s = findSite(c.params[0]);
  const token = `enr_${hex(32)}`;
  const origin = location.origin.includes('localhost') || location.origin.includes('127.0.0.1') ? 'https://screens.supercluster.au' : location.origin;
  const r: EnrollResult = {
    token, expires_at: Date.now() + 24 * H,
    command: `curl -fsSL ${origin}/install/gateway.sh | sudo sh -s -- --token ${token}`,
    install_url: `${origin}/install/gateway.sh`,
  };
  logAudit('gateway.enroll', 'site', s.id, s.id);
  return r;
});
on('GET', '/api/sites/:id/gateway', (c) => {
  const gw = db.gateways.find((g) => g.site_id === c.params[0]);
  if (!gw) throw err(404, 'no_gateway', 'This site has no gateway yet.');
  return { ...gatewayView(gw), logs: [...(F.gatewayLogs[c.params[0]] ?? [])].map((l, i, a) => `${new Date(Date.now() - (a.length - i) * 47 * S).toISOString()} ${l}`) };
});
on('POST', '/api/sites/:id/gateway/:action', async (c) => {
  const [sid, action] = c.params;
  const gw = db.gateways.find((g) => g.site_id === sid);
  if (!gw) throw err(404, 'no_gateway', 'This site has no gateway.');
  if (gw.status === 'offline' && action !== 'revoke') throw err(409, 'gateway_offline', 'The gateway is offline, so it can’t receive commands.');
  await sleep(700);
  if (action === 'update') {
    gw.version = gw.latest_version ?? gw.version;
    db.alerts = db.alerts.map((a) => (a.type === 'gateway.update_available' && a.site_id === sid ? { ...a, resolved_at: Date.now() } : a));
  }
  if (action === 'restart' && gw.metrics) gw.metrics.uptime_s = -(Date.now() - NOW) / 1000;
  if (action === 'revoke') gw.status = 'revoked';
  addJob(`gateway.${action}`, { site_id: sid });
  logAudit(`gateway.${action}`, 'gateway', gw.id, sid);
  return { ok: true };
});
on('GET', '/api/sites/:id/apps', (c) => {
  const sid = c.params[0];
  findSite(sid);
  const m = new Map<string, { package: string; label: string | null; system: boolean; category: string | null; risk: string | null; devices: number; kinds: DeviceKind[] }>();
  for (const d of db.devices.filter((x) => x.site_id === sid)) {
    for (const a of db.apps[d.id] ?? []) {
      const e = m.get(a.package) ?? { package: a.package, label: a.label ?? null, system: a.system, category: a.category ?? null, risk: a.risk ?? null, devices: 0, kinds: [] };
      e.devices++;
      if (!e.kinds.includes(d.kind)) e.kinds.push(d.kind);
      m.set(a.package, e);
    }
  }
  return [...m.values()].sort((a, b2) => Number(a.system) - Number(b2.system) || (a.label ?? a.package).localeCompare(b2.label ?? b2.package));
});
on('POST', '/api/sites/:id/discover', async (c) => {
  const sid = c.params[0];
  const gw = db.gateways.find((g) => g.site_id === sid && g.status === 'online');
  if (!gw) throw err(409, 'gateway_offline', 'Scanning needs an online gateway at this site.');
  await sleep(2600);
  if (sid === 's_home' && !db.discovered.some((x) => x.ip === F.extraOnScan.ip)) db.discovered.unshift({ ...F.extraOnScan, first_seen: Date.now(), last_seen: Date.now() });
  db.discovered.filter((x) => x.site_id === sid).forEach((x) => (x.last_seen = Date.now() - Math.round(between(0, 30)) * S));
  return db.discovered.filter((x) => x.site_id === sid);
});
on('GET', '/api/sites/:id/discovered', (c) => db.discovered.filter((x) => x.site_id === c.params[0]));
on('POST', '/api/sites/:id/adopt', (c) => {
  const sid = c.params[0];
  const body = b<{ ip: string; kind: DeviceKind; name: string; room?: string; port?: number }>(c);
  if (!body.name?.trim()) throw err(400, 'bad_request', 'Give the device a name.');
  const disc = db.discovered.find((x) => x.site_id === sid && x.ip === body.ip);
  const site = findSite(sid);
  const caps = { android: F.devices[2].capabilities, samsung: F.devices[0].capabilities, lg: F.devices[5].capabilities, sonos: F.devices[3].capabilities, other: [] }[body.kind];
  const dv: Device = {
    id: `dev_${hex(6)}`, site_id: sid, kind: body.kind, name: body.name.trim(), room: body.room || null, ip: body.ip, mac: disc?.mac ?? null,
    port: body.port ?? null, manufacturer: disc?.manufacturer ?? null, model: disc?.model ?? null, os_version: null, status: body.kind === 'sonos' ? 'online' : 'pairing',
    power: 'on', current_app: null, last_seen: Date.now(), tags: [], dns_mode: 'monitor', dns_policy: site.settings.default_policy,
    monitor_until: Date.now() + site.settings.monitor_days * D, dns_allow: [], dns_block: [], private_dns: null, privacy_score: null, facts: {},
    capabilities: caps, created_at: Date.now(), updated_at: Date.now(),
  };
  db.devices.push(dv);
  if (disc) disc.adopted_device_id = dv.id;
  addJob('adopt', { site_id: sid, device_id: dv.id, status: dv.status === 'pairing' ? 'running' : 'ok', result: { state: dv.status === 'pairing' ? 'waiting for Allow on the TV' : 'adopted' } });
  logAudit('device.adopt', 'device', dv.id, sid, { ip: dv.ip, kind: dv.kind });
  if (dv.kind === 'android') setTimeout(() => { dv.status = 'online'; }, 15000);
  return withSite(dv);
});
on('POST', '/api/sites/:id/discovered/:ip/ignore', (c) => {
  const disc = db.discovered.find((x) => x.site_id === c.params[0] && x.ip === decodeURIComponent(c.params[1]));
  if (disc) disc.ignored = true;
  return { ok: true };
});
on('POST', '/api/sites/:id/guest-reset', async (c) => {
  const sid = c.params[0];
  const site = findSite(sid);
  const ids = b<{ device_ids?: string[] }>(c).device_ids;
  await sleep(2400);
  const targets = db.devices.filter((d) => d.site_id === sid && d.capabilities.includes('guest_reset') && (!ids || ids.includes(d.id)));
  const g = site.settings.guest;
  const results = targets.map((d) => {
    if (d.status === 'offline') return { device_id: d.id, ok: false, detail: 'Device is offline — check it has power.' };
    if (d.kind === 'android') {
      const n = g.clear_packages.filter((p) => (db.apps[d.id] ?? []).some((a) => a.package === p)).length;
      d.current_app = null;
      return { device_id: d.id, ok: true, detail: [`Cleared ${n} app${n === 1 ? '' : 's'}`, g.go_home && 'went to Home', g.reboot && 'restarting'].filter(Boolean).join(', ') };
    }
    d.current_app = null;
    return { device_id: d.id, ok: true, detail: 'Returned to Home. Samsung apps can’t be cleared remotely — guests stay signed in until someone signs out on the TV.' };
  });
  addJob('guest_reset', { site_id: sid, status: results.every((r) => r.ok) ? 'ok' : 'error', result: { results } });
  logAudit('site.guest_reset', 'site', sid, sid, { devices: results.length, ok: results.filter((r) => r.ok).length });
  return { results };
});
on('GET', '/api/sites/:id/mdns', (c) => mdnsState(c.params[0]));
function networkState(siteId: string): NetworkState {
  const gw = db.gateways.find((g) => g.site_id === siteId && g.status !== 'revoked');
  const config = db.network[siteId] ?? { interfaces: [] };
  const host = [...(gw?.interfaces ?? [])];
  const status = config.interfaces.map((l, i) => {
    const name = l.kind === 'vlan' ? `scr${l.vlan}` : l.name!;
    const addr = l.mode === 'static' ? l.address! : `10.${50 + i}.${l.vlan ?? 0}.23/24`;
    if (!host.some((h) => h.name === name)) host.push({ name, mac: gw?.interfaces?.[0]?.mac ?? '', addrs: [addr], up: true, multicast: true });
    return { name, kind: l.kind, parent: l.parent, vlan: l.vlan, mode: l.mode, state: 'up' as const, addrs: [addr], ...(l.mode === 'dhcp' ? { lease_at: Date.now(), expires: Date.now() + 86_400_000 } : {}) };
  });
  return { supported: !!gw, gateway_online: gw?.status === 'online', config, status, errors: [], host, updated_at: Date.now() };
}
on('GET', '/api/sites/:id/network', (c) => networkState(c.params[0]));
on('POST', '/api/sites/:id/dot/retry', async () => { await sleep(600); return { ok: true }; });
on('PUT', '/api/sites/:id/network', async (c) => {
  await sleep(900);
  db.network[c.params[0]] = b<NetConfig>(c);
  logAudit('network.update', 'site', c.params[0], c.params[0]);
  return networkState(c.params[0]);
});
on('PUT', '/api/sites/:id/mdns', (c) => {
  db.mdns[c.params[0]] = b<MdnsConfig>(c);
  logAudit('mdns.update', 'site', c.params[0], c.params[0]);
  return { ok: true };
});
on('GET', '/api/sites/:id/dns/log', (c) => {
  const sid = c.params[0];
  findSite(sid);
  const dev = c.q.get('device_id');
  const q = (c.q.get('q') ?? '').toLowerCase();
  const action = c.q.get('action');
  const before = Number(c.q.get('before') || 0);
  const limit = Number(c.q.get('limit') || 200);
  return siteLog(sid)
    .filter((e) => (!dev || e.device_id === dev) && (!action || e.action === action) && (!before || e.ts < before) &&
      (!q || e.qname.includes(q) || e.client.includes(q) || (e.device_name ?? '').toLowerCase().includes(q)))
    .slice(0, limit);
});
on('GET', '/api/sites/:id/dns/summary', (c) => {
  const s = findSite(c.params[0]);
  return summarize(traffic, db.devices.filter((d) => d.site_id === s.id), db.rules, s.settings.unknown_clients);
});

on('GET', '/api/devices', (c) => {
  const sid = c.q.get('site_id');
  const kind = c.q.get('kind');
  return db.devices.filter((d) => (!sid || d.site_id === sid) && (!kind || d.kind === kind)).map(withSite);
});
on('GET', '/api/devices/:id', (c) => withSite(findDevice(c.params[0])));
on('PATCH', '/api/devices/:id', (c) => {
  const d = findDevice(c.params[0]);
  const body = b<Partial<Device>>(c);
  for (const k of ['name', 'room', 'tags', 'ip', 'port', 'dns_mode', 'dns_policy', 'dns_allow', 'dns_block'] as const) {
    if (k in body) (d as unknown as Record<string, unknown>)[k] = body[k];
  }
  if (body.dns_mode && body.dns_mode !== 'monitor') d.monitor_until = null;
  if (body.dns_mode === 'monitor') d.monitor_until = Date.now() + (findSite(d.site_id).settings.monitor_days * D);
  d.updated_at = Date.now();
  logAudit('device.update', 'device', d.id, d.site_id, body);
  return withSite(d);
});
on('DELETE', '/api/devices/:id', (c) => {
  const d = findDevice(c.params[0]);
  db.devices = db.devices.filter((x) => x.id !== d.id);
  db.discovered.forEach((x) => { if (x.adopted_device_id === d.id) x.adopted_device_id = null; });
  logAudit('device.delete', 'device', d.id, d.site_id);
  return { ok: true };
});
on('GET', '/api/sites/:id/sonos', (c) => sonosOverview(findSite(c.params[0]).id, db.devices));
on('POST', '/api/devices/:id/command', async (c) => {
  const d = findDevice(c.params[0]);
  const { command: cmd, args } = b<{ command: string; args?: Record<string, unknown> }>(c);
  return command(d, cmd, args);
});
on('POST', '/api/devices/bulk', async (c) => {
  const { device_ids, command: cmd, args } = b<{ device_ids: string[]; command: string; args?: Record<string, unknown> }>(c);
  if (cmd === 'shell') throw err(400, 'bad_request', 'Shell commands can’t be sent in bulk.');
  await sleep(500);
  const results = [];
  for (const id of device_ids ?? []) {
    const d = db.devices.find((x) => x.id === id);
    if (!d) {
      results.push({ device_id: id, ok: false, error: 'Device not found' });
      continue;
    }
    try {
      if (cmd === 'dns_mode') {
        const mode = String(args?.mode ?? '');
        if (!['enforce', 'monitor', 'off', 'bypass'].includes(mode)) throw err(400, 'bad_args', 'mode must be enforce, monitor, off or bypass');
        d.dns_mode = mode as Device['dns_mode'];
        d.monitor_until = mode === 'monitor' ? Date.now() + findSite(d.site_id).settings.monitor_days * D : null;
        results.push({ device_id: id, name: d.name, ok: true });
        continue;
      }
      const r = await command(d, cmd, args);
      results.push({ device_id: id, name: d.name, ok: r.ok, data: r.data });
    } catch (e) {
      results.push({ device_id: id, name: d.name, ok: false, error: (e as Error).message });
    }
  }
  return { results };
});
on('GET', '/api/devices/:id/apps', (c) => db.apps[findDevice(c.params[0]).id] ?? []);
on('GET', '/api/devices/:id/privacy', (c) => devicePrivacy(findDevice(c.params[0])));
on('PUT', '/api/devices/:id/privacy/checklist', (c) => {
  const d = findDevice(c.params[0]);
  const { key, done } = b<{ key: string; done: boolean }>(c);
  const item = db.privacy[d.id]?.checklist.find((x) => x.key === key);
  if (item && item.done !== done) {
    item.done = done;
    if (d.privacy_score != null) d.privacy_score = Math.max(0, Math.min(100, d.privacy_score + (done ? 4 : -4)));
  }
  return { ok: true };
});

on('GET', '/api/privacy', () => {
  const all = allDomainStats(traffic, db.devices, db.rules);
  const r: PrivacyOverview = {
    devices: privacyRows(),
    fleet: summarize(traffic, db.devices, db.rules),
    new_domains: all.filter((x) => (x.first_seen ?? 0) > Date.now() - 7 * D).sort((a, b2) => (b2.first_seen ?? 0) - (a.first_seen ?? 0)),
    acr_by_vendor: acrByVendor(),
  };
  return r;
});

on('GET', '/api/dns/domains', (c) => {
  const q = (c.q.get('q') ?? '').toLowerCase();
  const cat = c.q.get('category');
  const sid = c.q.get('site_id');
  const limit = Number(c.q.get('limit') || 200);
  const days = Number(c.q.get('days') || 7);
  const devs = db.devices.filter((d) => !sid || d.site_id === sid);
  return allDomainStats(traffic, devs, db.rules)
    .map((x) => ({ ...x, queries: Math.round((x.queries * days) / 7), blocked: Math.round((x.blocked * days) / 7), would_block: Math.round((x.would_block * days) / 7) }))
    .filter((x) => (!q || x.domain.includes(q) || (x.vendor ?? '').toLowerCase().includes(q)) && (!cat || x.category === cat))
    .slice(0, limit);
});
on('GET', '/api/dns/rules', () => db.rules);
on('POST', '/api/dns/rules', (c) => {
  const body = b<Omit<DnsRule, 'created_at' | 'source'>>(c);
  const domain = body.domain?.trim().toLowerCase();
  if (!domain || !/^([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(domain)) throw err(400, 'bad_domain', 'That doesn’t look like a domain name.');
  db.rules = db.rules.filter((r) => !(r.domain === domain && r.scope_type === body.scope_type && r.scope_id === (body.scope_id ?? '')));
  const r: DnsRule = { ...body, domain, scope_id: body.scope_id ?? '', source: 'user', created_at: Date.now() };
  db.rules.unshift(r);
  logAudit('dns.rule.add', 'dns_rule', domain, body.scope_type === 'site' ? body.scope_id : null, { action: r.action, scope: r.scope_type });
  return r;
});
on('DELETE', '/api/dns/rules', (c) => {
  const domain = c.q.get('domain');
  const st = c.q.get('scope_type');
  const sid = c.q.get('scope_id') ?? '';
  db.rules = db.rules.filter((r) => !(r.domain === domain && r.scope_type === st && (r.scope_id ?? '') === sid));
  logAudit('dns.rule.delete', 'dns_rule', domain ?? undefined);
  return { ok: true };
});
on('GET', '/api/dns/lists', () => ({ lists: db.lists, builds: db.builds }));
on('PATCH', '/api/dns/lists/:id', (c) => {
  const l = db.lists.find((x) => x.id === c.params[0]);
  if (!l) throw notFound('List');
  Object.assign(l, b<Partial<DnsList>>(c));
  return l;
});
on('POST', '/api/dns/rebuild', async () => {
  await sleep(1600);
  for (const l of db.lists) if (l.enabled && !l.last_error) l.last_fetched = Date.now();
  db.builds = db.builds.map((bd) => ({
    ...bd, sha256: hex(64), built_at: Date.now(),
    rules: db.lists.filter((l) => l.enabled && l.policies.includes(bd.policy === 'monitor' ? 'balanced' : bd.policy)).reduce((a, l) => a + (l.last_count ?? 0), 0) + db.rules.length,
  }));
  addJob('dns.rebuild', { result: { policies: db.builds.length, pushed_to: db.gateways.filter((g) => g.status === 'online').length } });
  logAudit('dns.rebuild', 'dns');
  return { builds: db.builds };
});

on('GET', '/api/apks', () => db.apks);
on('POST', '/api/apks', async (c) => {
  const fd = c.body as FormData;
  const file = fd.get('file') as File | null;
  if (!file) throw err(400, 'bad_request', 'Choose an APK file to upload.');
  if (!/\.apk$/i.test(file.name)) throw err(400, 'bad_file', 'That file isn’t an APK. Android apps end in .apk.');
  await sleep(1200);
  const base = file.name.replace(/\.apk$/i, '');
  const apk: Apk = {
    id: `apk_${hex(6)}`, package: (fd.get('package') as string) || (base.includes('.') ? base.split(/[-_ ]/)[0] : null), label: (fd.get('label') as string) || base.replace(/[-_]/g, ' '),
    version_name: base.match(/(\d+(\.\d+)+)/)?.[1] ?? null, version_code: null, sha256: hex(64), size: file.size, notes: (fd.get('notes') as string) || null, uploaded_at: Date.now(),
  };
  db.apks.unshift(apk);
  logAudit('apk.upload', 'apk', apk.id, null, { label: apk.label });
  return apk;
});
on('DELETE', '/api/apks/:id', (c) => {
  db.apks = db.apks.filter((x) => x.id !== c.params[0]);
  return { ok: true };
});

on('GET', '/api/app-policies', () => db.appPolicies);
on('POST', '/api/app-policies', (c) => {
  const p: AppPolicy = { ...b<AppPolicy>(c), id: `ap_${hex(6)}`, created_at: Date.now() };
  if (!p.name?.trim()) throw err(400, 'bad_request', 'Give the policy a name.');
  db.appPolicies.push(p);
  return p;
});
on('PATCH', '/api/app-policies/:id', (c) => {
  const p = db.appPolicies.find((x) => x.id === c.params[0]);
  if (!p) throw notFound('Policy');
  Object.assign(p, b<Partial<AppPolicy>>(c));
  return p;
});
on('DELETE', '/api/app-policies/:id', (c) => {
  db.appPolicies = db.appPolicies.filter((x) => x.id !== c.params[0]);
  return { ok: true };
});

on('GET', '/api/automations', () => db.automations);
on('POST', '/api/automations', (c) => {
  const a: Automation = { ...b<Automation>(c), id: `au_${hex(6)}`, created_at: Date.now(), last_run: null, last_status: null };
  if (!a.name?.trim()) throw err(400, 'bad_request', 'Give the automation a name.');
  if (!a.actions?.length) throw err(400, 'bad_request', 'Add at least one action.');
  db.automations.push(a);
  logAudit('automation.create', 'automation', a.id, null, { name: a.name });
  return a;
});
on('PATCH', '/api/automations/:id', (c) => {
  const a = db.automations.find((x) => x.id === c.params[0]);
  if (!a) throw notFound('Automation');
  Object.assign(a, b<Partial<Automation>>(c));
  return a;
});
on('DELETE', '/api/automations/:id', (c) => {
  db.automations = db.automations.filter((x) => x.id !== c.params[0]);
  return { ok: true };
});
on('POST', '/api/automations/:id/run', async (c) => {
  const a = db.automations.find((x) => x.id === c.params[0]);
  if (!a) throw notFound('Automation');
  await sleep(900);
  const t = a.target;
  const targets = db.devices.filter((d) =>
    (!t.site_ids?.length || t.site_ids.includes(d.site_id)) && (!t.kinds?.length || t.kinds.includes(d.kind)) &&
    (!t.device_ids?.length || t.device_ids.includes(d.id)) && (!t.tags?.length || t.tags.some((tg) => d.tags.includes(tg))));
  const offline = targets.filter((d) => d.status === 'offline').length;
  a.last_run = Date.now();
  a.last_status = offline ? `error: ${offline} of ${targets.length} devices offline` : 'ok';
  const jobs = [addJob(`automation:${a.name}`, { actor: 'you', automation_id: a.id, status: offline ? 'error' : 'ok', result: { devices: targets.length, ok: targets.length - offline } })];
  return { ok: true, jobs };
});

on('GET', '/api/jobs', (c) => {
  const sid = c.q.get('site_id');
  const did = c.q.get('device_id');
  const limit = Number(c.q.get('limit') || 100);
  return db.jobs.filter((j) => (!sid || j.site_id === sid) && (!did || j.device_id === did)).sort((a, b2) => b2.created_at - a.created_at).slice(0, limit);
});
on('GET', '/api/alerts', (c) => (c.q.get('open') === '1' ? openAlerts() : db.alerts).sort((a, b2) => b2.at - a.at));
on('POST', '/api/alerts/:id/ack', (c) => {
  const a = db.alerts.find((x) => x.id === c.params[0]);
  if (a) a.acknowledged_at = Date.now();
  return { ok: true };
});
on('GET', '/api/audit', (c) => {
  const sid = c.q.get('site_id');
  return db.audit.filter((e) => !sid || e.site_id === sid).slice(0, Number(c.q.get('limit') || 100));
});
on('GET', '/api/settings', () => db.settings);
on('PUT', '/api/settings', async (c) => {
  const { cf_dns_token, ...rest } = b<AppSettings>(c);
  if (cf_dns_token !== undefined) throw err(400, 'secret_only', 'The Cloudflare DNS token is a Worker secret (CF_DNS_TOKEN) and can’t be set from the dashboard.');
  db.settings = { ...db.settings, ...rest };
  logAudit('settings.update', 'settings');
  return db.settings;
});

// Screens Launcher v2: home-screen layouts, pictures and rollout (./launcher).
const launcher = launcherMock(on, db);
registerUpdates(on, db);

export async function handle(method: string, path: string, body?: unknown): Promise<unknown> {
  const u = new URL(path, 'http://mock');
  const slow = method !== 'GET' ? between(180, 420) : between(90, 260);
  await sleep(slow);
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = u.pathname.match(re);
    if (!match) continue;
    const res = await h({ params: match.slice(1).map(decodeURIComponent), q: u.searchParams, body });
    return clone(res);
  }
  throw err(404, 'not_found', `Mock API has no route for ${method} ${u.pathname}`);
}

// ---------------------------------------------------------------------------
// Screenshots & live feed

export function screenshotFor(id: string): string | null {
  const d = db.devices.find((x) => x.id === id);
  if (!d || d.kind !== 'android' || d.status === 'offline') return null;
  return renderScreen(screenFor(id));
}

export function live(siteId: string, onEvent: (e: LiveEvent) => void): () => void {
  resetLiveRng();
  const hasGw = db.gateways.some((g) => g.site_id === siteId && g.status === 'online');
  if (!hasGw) return () => {};
  let stopped = false;
  let t: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (stopped) return;
    const ctx = siteCtx(siteId);
    const n = 1 + Math.floor(between(0, 3));
    const now = Date.now();
    const entries = Array.from({ length: n }, (_, i) => makeEntry(ctx, now - i * 140)).sort((a, b2) => b2.ts - a.ts);
    const log = siteLog(siteId);
    log.unshift(...entries);
    if (log.length > 3000) log.length = 3000;
    onEvent({ type: 'dns', entries });
    t = setTimeout(tick, between(700, 1300));
  };
  t = setTimeout(tick, 400);
  return () => {
    stopped = true;
    clearTimeout(t);
  };
}



export function mirror(id: string, params: MirrorParams, handlers: MirrorHandlers): MirrorConnection {
  const d = db.devices.find((x) => x.id === id);
  const fail = (message: string): MirrorConnection => {
    let closed = false;
    setTimeout(() => !closed && handlers.onText({ type: 'status', state: 'starting' }), 50);
    setTimeout(() => !closed && handlers.onText({ type: 'status', state: 'error', message }), 900);
    return { send: () => undefined, close: () => { closed = true; } };
  };
  if (!d || d.kind !== 'android') return fail('Live view is only available for Android TV devices.');
  if (d.status === 'offline') return fail(`${d.name} is offline, so the live view can’t start.`);
  return startMockMirror({
    deviceName: d.model ?? d.name,
    params,
    handlers,
    getScreen: () => screenFor(id),
    setScreen: (st) => {
      screens.set(id, st);
      d.current_app = st.app;
    },
  });
}

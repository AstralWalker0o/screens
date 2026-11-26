import { Hono } from 'hono';
import type { EnrollResult, MdnsConfig, Overview, SiteDetail, SiteSettings } from '../../shared/types';
import { randomToken, sha256Hex } from '../lib/crypto';
import {
  audit, DEFAULT_SITE_SETTINGS, getAppSettings, kioskPinHash, type Row, siteMdns, siteSettings, toAlert, toDevice, toDiscovered, toGateway, toJob,
} from '../lib/db';
import { hub, hubStub, originOf } from '../lib/hub';
import { sanitizeNetConfig } from '../lib/netcfg';
import { HttpError, isPrivateIPv4, now, parseJson, rid, slugify } from '../lib/util';
import { actorOf, type AppEnv, body, fleetDnsSummary, siteSummaries } from './shared';

export const siteRoutes = new Hono<AppEnv>();

siteRoutes.get('/me', (c) => c.json(c.get('actor')));

siteRoutes.get('/overview', async (c) => {
  const env = c.env;
  const [clients, gws, devs, alerts, jobs, worst] = await Promise.all([
    env.DB.prepare('SELECT count(*) n FROM clients').first<Row>(),
    env.DB.prepare("SELECT status, count(*) n FROM gateways WHERE status != 'revoked' GROUP BY status").all<Row>(),
    env.DB.prepare('SELECT kind, status, count(*) n FROM devices GROUP BY kind, status').all<Row>(),
    env.DB.prepare('SELECT a.*, s.name site_name, d.name device_name FROM alerts a LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN devices d ON d.id = a.device_id WHERE a.resolved_at IS NULL AND a.acknowledged_at IS NULL ORDER BY a.at DESC LIMIT 20').all<Row>(),
    env.DB.prepare('SELECT j.*, s.name site_name, d.name device_name FROM jobs j LEFT JOIN sites s ON s.id = j.site_id LEFT JOIN devices d ON d.id = j.device_id ORDER BY j.created_at DESC LIMIT 10').all<Row>(),
    env.DB.prepare(`SELECT d.id, d.name, d.site_id, s.name site_name, d.kind, d.privacy_score FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.privacy_score IS NOT NULL ORDER BY d.privacy_score ASC LIMIT 8`).all<Row>(),
  ]);
  const sites = await siteSummaries(env);
  const worstIds = worst.results.map((r) => r.id as string);
  const [acrRows, bypassRows] = worstIds.length ? await Promise.all([
    env.DB.prepare(`SELECT device_id, cats FROM dns_hourly WHERE hour >= ? AND device_id IN (${worstIds.map(() => '?').join(',')})`).bind(Date.now() - 86_400_000, ...worstIds).all<Row>(),
    env.DB.prepare("SELECT device_id FROM alerts WHERE type = 'dns.bypass' AND resolved_at IS NULL").all<Row>(),
  ]) : [{ results: [] as Row[] }, { results: [] as Row[] }];
  const acrBy = new Map<string, number>();
  for (const r of acrRows.results) acrBy.set(r.device_id, (acrBy.get(r.device_id) ?? 0) + (parseJson<any>(r.cats, {}).acr ?? 0));
  const bypassIds = new Set(bypassRows.results.map((r) => r.device_id as string));
  const byKind: Record<string, number> = {};
  let total = 0, online = 0;
  for (const r of devs.results) { byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n; total += r.n; if (r.status === 'online' || r.status === 'standby') online += r.n; }
  const gwTotal = gws.results.reduce((a, r) => a + r.n, 0);
  const grade = (s: number) => (s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : s >= 40 ? 'D' : 'F');
  const out: Overview = {
    counts: {
      clients: clients?.n ?? 0, sites: sites.length, gateways_online: gws.results.find((r) => r.status === 'online')?.n ?? 0, gateways_total: gwTotal,
      devices_total: total, devices_online: online, devices_by_kind: byKind, alerts_open: alerts.results.length,
    },
    dns: await fleetDnsSummary(env, { hours: 24 }),
    sites,
    privacy_worst: worst.results.map((r) => ({ device_id: r.id, name: r.name, site_id: r.site_id, site_name: r.site_name, kind: r.kind, score: r.privacy_score, grade: grade(r.privacy_score), bypass_suspected: bypassIds.has(r.id), acr_24h: acrBy.get(r.id) ?? 0 })),
    alerts: alerts.results.map(toAlert),
    recent_jobs: jobs.results.map(toJob),
  };
  return c.json(out);
});

// ---------------------------------------------------------------- clients
siteRoutes.get('/clients', async (c) => {
  const r = await c.env.DB.prepare(`SELECT c.*, (SELECT count(*) FROM sites s WHERE s.client_id = c.id) site_count,
    (SELECT count(*) FROM devices d JOIN sites s ON s.id = d.site_id WHERE s.client_id = c.id) device_count FROM clients c ORDER BY c.name`).all<Row>();
  return c.json(r.results);
});

siteRoutes.post('/clients', async (c) => {
  const b = await body(c);
  if (!b.name?.trim()) throw new HttpError(400, 'bad_request', 'Name is required');
  const id = rid('cl');
  await c.env.DB.prepare('INSERT INTO clients (id, name, contact, notes, created_at) VALUES (?,?,?,?,?)').bind(id, b.name.trim(), b.contact ?? null, b.notes ?? null, now()).run();
  await audit(c.env, actorOf(c), 'client.create', { target_type: 'client', target_id: id, details: { name: b.name } });
  return c.json(await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first(), 201);
});

siteRoutes.patch('/clients/:id', async (c) => {
  const b = await body(c);
  const cur = await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(c.req.param('id')).first<Row>();
  if (!cur) throw new HttpError(404, 'not_found', 'Client not found');
  await c.env.DB.prepare('UPDATE clients SET name = ?, contact = ?, notes = ? WHERE id = ?').bind(b.name ?? cur.name, b.contact ?? cur.contact, b.notes ?? cur.notes, cur.id).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(cur.id).first());
});

siteRoutes.delete('/clients/:id', async (c) => {
  const id = c.req.param('id');
  const n = await c.env.DB.prepare('SELECT count(*) n FROM sites WHERE client_id = ?').bind(id).first<Row>();
  if (n?.n) throw new HttpError(409, 'not_empty', 'Delete or move this client\'s sites first');
  await c.env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(id).run();
  await audit(c.env, actorOf(c), 'client.delete', { target_type: 'client', target_id: id });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- sites
siteRoutes.get('/sites', async (c) => {
  const cid = c.req.query('client_id');
  return c.json(cid ? await siteSummaries(c.env, 'WHERE s.client_id = ?', [cid]) : await siteSummaries(c.env));
});

async function siteDetail(c: { env: import('../env').Env }, id: string): Promise<SiteDetail> {
  const env = c.env;
  const [summary] = await siteSummaries(env, 'WHERE s.id = ?', [id]);
  if (!summary) throw new HttpError(404, 'not_found', 'Site not found');
  const site = await env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<Row>();
  const [gw, devices, dot, app, rel] = await Promise.all([
    env.DB.prepare("SELECT * FROM gateways WHERE site_id = ? AND status != 'revoked' ORDER BY created_at DESC LIMIT 1").bind(id).first<Row>(),
    env.DB.prepare('SELECT d.*, s.name site_name FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.site_id = ? ORDER BY d.kind, d.name').bind(id).all<Row>(),
    env.DB.prepare('SELECT * FROM dot_certs WHERE site_id = ?').bind(id).first<Row>(),
    getAppSettings(env),
    env.DB.prepare('SELECT version FROM agent_releases ORDER BY created_at DESC LIMIT 1').first<Row>(),
  ]);
  const base = app.dot_base_domain || env.DOT_BASE_DOMAIN;
  return {
    ...summary, notes: site!.notes, settings: siteSettings(site!), gateway: gw ? toGateway(gw, rel?.version) : null,
    devices: devices.results.map(toDevice),
    dot_hostname: dot?.hostname ?? null, // random per site, assigned when encrypted DNS is first turned on
    dot_status: dot ? (dot.status === 'error' ? `error: ${dot.last_error}` : dot.status) : null,
  };
}

siteRoutes.post('/sites', async (c) => {
  const b = await body(c);
  if (!b.name?.trim() || !b.client_id) throw new HttpError(400, 'bad_request', 'client_id and name are required');
  const client = await c.env.DB.prepare('SELECT id FROM clients WHERE id = ?').bind(b.client_id).first();
  if (!client) throw new HttpError(400, 'bad_request', 'Unknown client');
  const app = await getAppSettings(c.env);
  let slug = slugify(b.name);
  for (let i = 2; await c.env.DB.prepare('SELECT 1 FROM sites WHERE slug = ?').bind(slug).first(); i++) slug = `${slugify(b.name)}-${i}`;
  const id = rid('site');
  const settings: SiteSettings = { ...DEFAULT_SITE_SETTINGS, monitor_days: app.default_monitor_days, default_policy: app.default_policy };
  const kind = ['residential', 'rental', 'business'].includes(b.kind) ? b.kind : 'residential';
  await c.env.DB.prepare('INSERT INTO sites (id, client_id, name, slug, kind, timezone, address, notes, settings, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, b.client_id, b.name.trim(), slug, kind, b.timezone || 'Australia/Sydney', b.address ?? null, b.notes ?? null, JSON.stringify(settings), now()).run();
  await audit(c.env, actorOf(c), 'site.create', { target_type: 'site', target_id: id, site_id: id, details: { name: b.name } });
  return c.json(await siteDetail(c, id), 201);
});

siteRoutes.get('/sites/:id', async (c) => c.json(await siteDetail(c, c.req.param('id'))));

siteRoutes.patch('/sites/:id', async (c) => {
  const id = c.req.param('id');
  const b = await body(c);
  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<Row>();
  if (!site) throw new HttpError(404, 'not_found', 'Site not found');
  const prev = siteSettings(site);
  const settings: SiteSettings = b.settings ? mergeSettings(prev, b.settings) : prev;
  // The kiosk PIN is stored only as a SHA-256 hash and never returned.
  let pinHash = kioskPinHash(site);
  const newPin = b.settings?.guest?.kiosk?.pin;
  if (typeof newPin === 'string') {
    if (newPin === '') pinHash = null;
    else if (/^\d{4,8}$/.test(newPin)) pinHash = await sha256Hex(newPin);
    else throw new HttpError(400, 'bad_request', 'Kiosk PIN must be 4–8 digits');
  }
  const stored = { ...settings, guest: { ...settings.guest, kiosk: { ...settings.guest.kiosk, pin_set: undefined, pin: undefined, pin_sha256: pinHash } } };
  await c.env.DB.prepare('UPDATE sites SET name = ?, kind = ?, timezone = ?, address = ?, notes = ?, client_id = ?, settings = ? WHERE id = ?')
    .bind(b.name ?? site.name, b.kind ?? site.kind, b.timezone ?? site.timezone, b.address ?? site.address, b.notes ?? site.notes, b.client_id ?? site.client_id, JSON.stringify(stored), id).run();
  const origin = originOf(c.req.raw, c.env);
  if (b.settings?.guest?.welcome || b.settings?.guest?.kiosk) {
    c.executionCtx.waitUntil(hub(c.env, id, origin, 'pushLauncherConfig').catch(() => undefined));
  }
  if (settings.dot_enabled && !prev.dot_enabled) await hub(c.env, id, origin, 'requestDot');
  if (settings.unknown_clients !== prev.unknown_clients || settings.default_policy !== prev.default_policy || settings.dot_enabled !== prev.dot_enabled) {
    c.executionCtx.waitUntil(hub(c.env, id, origin, 'pushDnsConfig').catch(() => undefined));
  }
  const auditBody = b.settings?.guest?.kiosk?.pin !== undefined ? { ...b, settings: { ...b.settings, guest: { ...b.settings.guest, kiosk: { ...b.settings.guest.kiosk, pin: '[redacted]' } } } } : b;
  await audit(c.env, actorOf(c), 'site.update', { target_type: 'site', target_id: id, site_id: id, details: auditBody });
  return c.json(await siteDetail(c, id));
});

const PKG = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
const str = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);
const pkgs = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((p): p is string => typeof p === 'string' && PKG.test(p)))].slice(0, 100) : []);

/** Validate and merge a partial settings update (nested guest/welcome/kiosk objects merge too). */
function mergeSettings(prev: SiteSettings, patch: any): SiteSettings {
  const out: SiteSettings = { ...prev };
  if (patch.monitor_days !== undefined) out.monitor_days = Math.min(60, Math.max(0, Number(patch.monitor_days) || 0));
  if (patch.default_policy !== undefined) out.default_policy = patch.default_policy === 'strict' ? 'strict' : 'balanced';
  if (patch.unknown_clients !== undefined) out.unknown_clients = ['enforce', 'monitor', 'off', 'bypass'].includes(patch.unknown_clients) ? patch.unknown_clients : prev.unknown_clients;
  if (patch.scan_cidrs !== undefined) out.scan_cidrs = (Array.isArray(patch.scan_cidrs) ? patch.scan_cidrs : []).filter((c: unknown) => typeof c === 'string' && /^\d+\.\d+\.\d+\.\d+\/(2[2-9]|3[0-2])$/.test(c)).slice(0, 16);
  if (patch.dot_enabled !== undefined) out.dot_enabled = !!patch.dot_enabled;
  const g = patch.guest;
  if (g) {
    const guest = { ...prev.guest };
    if (g.clear_packages !== undefined) guest.clear_packages = pkgs(g.clear_packages);
    if (g.go_home !== undefined) guest.go_home = !!g.go_home;
    if (g.reboot !== undefined) guest.reboot = !!g.reboot;
    if (g.show_welcome_after_reset !== undefined) guest.show_welcome_after_reset = !!g.show_welcome_after_reset;
    if (g.welcome) {
      const w = { ...prev.guest.welcome, ...g.welcome };
      const wifi = w.wifi && typeof w.wifi === 'object' && str(w.wifi.ssid, 32)
        ? { ssid: str(w.wifi.ssid, 32), password: str(w.wifi.password, 63), security: (['WPA', 'WEP', 'nopass'].includes(w.wifi.security) ? w.wifi.security : 'WPA') as 'WPA' | 'WEP' | 'nopass' }
        : null;
      guest.welcome = {
        enabled: !!w.enabled, show_on_boot: !!w.show_on_boot, title: str(w.title, 80, 'Welcome'), message: str(w.message, 600),
        wifi, sections: (Array.isArray(w.sections) ? w.sections : []).slice(0, 8).map((x: any) => ({ title: str(x?.title, 60), body: str(x?.body, 600) })).filter((x: any) => x.title || x.body),
        contact: str(w.contact, 160), accent: /^#[0-9a-fA-F]{6}$/.test(w.accent) ? w.accent : '#4F8EF7',
      };
    }
    if (g.kiosk) {
      const k = { ...prev.guest.kiosk, ...g.kiosk };
      guest.kiosk = { enabled: !!k.enabled, allowed: pkgs(k.allowed), pinned: pkgs(k.pinned), force_home: !!k.force_home };
    }
    out.guest = guest;
  }
  return out;
}

siteRoutes.delete('/sites/:id', async (c) => {
  const id = c.req.param('id');
  const origin = originOf(c.req.raw, c.env);
  await hub(c.env, id, origin, 'disconnectAgent', 'site deleted').catch(() => undefined);
  const devIds = (await c.env.DB.prepare('SELECT id FROM devices WHERE site_id = ?').bind(id).all<Row>()).results.map((r) => r.id);
  await c.env.DB.batch([
    ...devIds.map((d) => c.env.DB.prepare('DELETE FROM device_apps WHERE device_id = ?').bind(d)),
    c.env.DB.prepare('DELETE FROM devices WHERE site_id = ?').bind(id),
    c.env.DB.prepare("UPDATE gateways SET status = 'revoked', revoked_at = ? WHERE site_id = ?").bind(now(), id),
    c.env.DB.prepare('DELETE FROM discovered WHERE site_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM enrollment_tokens WHERE site_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM dns_hourly WHERE site_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM dns_daily WHERE site_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM dot_certs WHERE site_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id),
  ]);
  await audit(c.env, actorOf(c), 'site.delete', { target_type: 'site', target_id: id });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- gateway
siteRoutes.post('/sites/:id/enroll', async (c) => {
  const id = c.req.param('id');
  if (!(await c.env.DB.prepare('SELECT 1 FROM sites WHERE id = ?').bind(id).first())) throw new HttpError(404, 'not_found', 'Site not found');
  const token = randomToken('enr', 24);
  const expires = now() + 24 * 3_600_000;
  await c.env.DB.prepare('INSERT INTO enrollment_tokens (token_hash, site_id, expires_at, created_at) VALUES (?,?,?,?)').bind(await sha256Hex(token), id, expires, now()).run();
  const origin = originOf(c.req.raw, c.env);
  const install_url = `${origin}/install/${token}`;
  await audit(c.env, actorOf(c), 'gateway.enroll_token', { site_id: id });
  const r: EnrollResult = { token, expires_at: expires, install_url, command: `curl -fsSL ${install_url} | sudo bash` };
  return c.json(r);
});

siteRoutes.get('/sites/:id/gateway', async (c) => {
  const id = c.req.param('id');
  const gw = await c.env.DB.prepare("SELECT * FROM gateways WHERE site_id = ? AND status != 'revoked' ORDER BY created_at DESC LIMIT 1").bind(id).first<Row>();
  if (!gw) throw new HttpError(404, 'not_found', 'No gateway enrolled for this site');
  const rel = await c.env.DB.prepare('SELECT version FROM agent_releases ORDER BY created_at DESC LIMIT 1').first<Row>();
  const logs = await hub<string[]>(c.env, id, originOf(c.req.raw, c.env), 'gatewayLogs', 200).catch(() => []);
  return c.json({ ...toGateway(gw, rel?.version), logs });
});

siteRoutes.post('/sites/:id/gateway/:action', async (c) => {
  const id = c.req.param('id');
  const action = c.req.param('action');
  const origin = originOf(c.req.raw, c.env);
  if (action === 'revoke') {
    await c.env.DB.prepare("UPDATE gateways SET status = 'revoked', revoked_at = ? WHERE site_id = ? AND status != 'revoked'").bind(now(), id).run();
    await hub(c.env, id, origin, 'disconnectAgent', 'revoked');
    await audit(c.env, actorOf(c), 'gateway.revoke', { site_id: id });
    return c.json({ ok: true });
  }
  if (action !== 'restart' && action !== 'update') throw new HttpError(400, 'bad_request', 'Unknown action');
  await hub(c.env, id, origin, 'gatewayAction', action, actorOf(c));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- discovery & adoption
siteRoutes.post('/sites/:id/discover', async (c) => c.json(await hub(c.env, c.req.param('id'), originOf(c.req.raw, c.env), 'discover')));

siteRoutes.get('/sites/:id/discovered', async (c) => {
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare(`SELECT x.*, (SELECT d.id FROM devices d WHERE d.site_id = x.site_id AND (d.ip = x.ip OR (d.mac IS NOT NULL AND d.mac = x.mac)) LIMIT 1) adopted_device_id
    FROM discovered x WHERE x.site_id = ? ORDER BY x.last_seen DESC`).bind(id).all<Row>();
  return c.json(rows.results.map(toDiscovered));
});

siteRoutes.post('/sites/:id/discovered/:ip/ignore', async (c) => {
  await c.env.DB.prepare('UPDATE discovered SET ignored = 1 WHERE site_id = ? AND ip = ?').bind(c.req.param('id'), c.req.param('ip')).run();
  return c.json({ ok: true });
});

siteRoutes.post('/sites/:id/adopt', async (c) => {
  const b = await body(c);
  if (!b.ip || !isPrivateIPv4(b.ip) || !['android', 'samsung', 'lg', 'sonos', 'other'].includes(b.kind) || !b.name?.trim()) throw new HttpError(400, 'bad_request', 'A private LAN ip, kind and name are required');
  if (b.port !== undefined && b.port !== null && b.port !== '' && !(Number(b.port) >= 1 && Number(b.port) <= 65535)) throw new HttpError(400, 'bad_request', 'Invalid port');
  const id = c.req.param('id');
  const dup = await c.env.DB.prepare('SELECT id FROM devices WHERE site_id = ? AND ip = ?').bind(id, b.ip).first<Row>();
  if (dup) throw new HttpError(409, 'exists', 'A device with this IP is already adopted');
  return c.json(await hub(c.env, id, originOf(c.req.raw, c.env), 'adopt', { ip: b.ip, kind: b.kind, name: b.name.trim(), room: b.room, port: b.port ? Number(b.port) : undefined }, actorOf(c)), 201);
});

siteRoutes.post('/sites/:id/guest-reset', async (c) => {
  const b = await body(c);
  return c.json(await hub(c.env, c.req.param('id'), originOf(c.req.raw, c.env), 'guestReset', b.device_ids, actorOf(c)));
});

/** Every app seen on the site's Android/Samsung/LG devices (for kiosk/guest pickers). */
siteRoutes.get('/sites/:id/apps', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT a.package, max(coalesce(a.label, k.label)) label, min(a.system) system, max(k.category) category, max(k.risk) risk,
      count(DISTINCT a.device_id) devices, group_concat(DISTINCT d.kind) kinds
    FROM device_apps a JOIN devices d ON d.id = a.device_id LEFT JOIN app_catalog k ON k.package = a.package
    WHERE d.site_id = ? GROUP BY a.package ORDER BY min(a.system), label`).bind(c.req.param('id')).all<Row>();
  return c.json(rows.results.map((r) => ({ package: r.package, label: r.label, system: !!r.system, category: r.category, risk: r.risk, devices: r.devices, kinds: String(r.kinds ?? '').split(',') })));
});

siteRoutes.post('/sites/:id/dot/retry', async (c) => {
  const id = c.req.param('id');
  const site = await c.env.DB.prepare('SELECT settings FROM sites WHERE id = ?').bind(id).first<Row>();
  if (!site) throw new HttpError(404, 'not_found', 'Site not found');
  if (!siteSettings(site).dot_enabled) throw new HttpError(409, 'not_enabled', 'Turn on encrypted DNS for this site first');
  await hub(c.env, id, originOf(c.req.raw, c.env), 'retryDotNow');
  await audit(c.env, actorOf(c), 'dot.retry', { site_id: id });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- gateway network legs
siteRoutes.get('/sites/:id/network', async (c) => {
  const id = c.req.param('id');
  const site = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ?').bind(id).first<Row>();
  if (!site) throw new HttpError(404, 'not_found', 'Site not found');
  return c.json(await hub(c.env, id, originOf(c.req.raw, c.env), 'networkState', true));
});

siteRoutes.put('/sites/:id/network', async (c) => {
  const id = c.req.param('id');
  const site = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ?').bind(id).first<Row>();
  if (!site) throw new HttpError(404, 'not_found', 'Site not found');
  const cfg = sanitizeNetConfig(await body(c));
  await c.env.DB.prepare('UPDATE sites SET network = ? WHERE id = ?').bind(JSON.stringify(cfg), id).run();
  await audit(c.env, actorOf(c), 'network.update', { site_id: id, details: cfg });
  const state = await hub(c.env, id, originOf(c.req.raw, c.env), 'pushNetConfig').catch((e) => { throw new HttpError(502, 'push_failed', `Saved, but the gateway could not apply it: ${e.message}`); });
  return c.json(state);
});

/** Live view of every Sonos room and group at the site (docs/API.md). */
siteRoutes.get('/sites/:id/sonos', async (c) => c.json(await hub(c.env, c.req.param('id'), originOf(c.req.raw, c.env), 'sonosOverview')));

// ---------------------------------------------------------------- mDNS reflector
siteRoutes.get('/sites/:id/mdns', async (c) => {
  const id = c.req.param('id');
  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<Row>();
  if (!site) throw new HttpError(404, 'not_found', 'Site not found');
  const gw = await c.env.DB.prepare("SELECT * FROM gateways WHERE site_id = ? AND status != 'revoked' ORDER BY created_at DESC LIMIT 1").bind(id).first<Row>();
  const status = await hub(c.env, id, originOf(c.req.raw, c.env), 'mdnsStatus').catch(() => null);
  return c.json({ config: siteMdns(site), status, interfaces: gw ? toGateway(gw).interfaces : [] });
});

siteRoutes.put('/sites/:id/mdns', async (c) => {
  const id = c.req.param('id');
  const b = await body<MdnsConfig>(c);
  const cfg = sanitizeMdns(b);
  await c.env.DB.prepare('UPDATE sites SET mdns = ? WHERE id = ?').bind(JSON.stringify(cfg), id).run();
  const pushed = await hub(c.env, id, originOf(c.req.raw, c.env), 'pushMdnsConfig', cfg).catch((e) => { throw new HttpError(502, 'push_failed', `Saved, but the gateway rejected it: ${e.message}`); });
  await audit(c.env, actorOf(c), 'mdns.update', { site_id: id, details: cfg });
  return c.json({ ok: true, pushed });
});

const SVC_RE = /^(\*|_[a-z0-9-]{1,63}\._(tcp|udp))$/i;
const IFACE_RE = /^[a-zA-Z0-9._@-]{1,32}$/;
function sanitizeMdns(b: MdnsConfig): MdnsConfig {
  const ifs = (b.interfaces ?? []).filter((i) => IFACE_RE.test(i));
  return {
    enabled: !!b.enabled, interfaces: ifs,
    rules: (b.rules ?? []).filter((r) => IFACE_RE.test(r.from)).map((r) => ({
      from: r.from, to: (r.to ?? []).filter((t) => IFACE_RE.test(t) && t !== r.from),
      allow: (r.allow ?? []).filter((s) => SVC_RE.test(s)), deny: (r.deny ?? []).filter((s) => SVC_RE.test(s)),
    })).filter((r) => r.to.length),
    ssdp: { enabled: !!b.ssdp?.enabled, rules: (b.ssdp?.rules ?? []).filter((r) => IFACE_RE.test(r.from)).map((r) => ({ from: r.from, to: (r.to ?? []).filter((t) => IFACE_RE.test(t) && t !== r.from) })).filter((r) => r.to.length) },
    rate_limit_pps: Math.min(5000, Math.max(10, Number(b.rate_limit_pps) || 200)),
    track_services: b.track_services !== false,
  };
}

// ---------------------------------------------------------------- DNS (site)
siteRoutes.get('/sites/:id/dns/log', async (c) => {
  const q = c.req.query();
  return c.json(await hub(c.env, c.req.param('id'), originOf(c.req.raw, c.env), 'dnsLog', {
    device_id: q.device_id || undefined, q: q.q || undefined, action: q.action || undefined, limit: Number(q.limit) || 200, before: Number(q.before) || undefined,
  }));
});

siteRoutes.get('/sites/:id/dns/summary', async (c) => {
  const hours = Math.min(Number(c.req.query('hours')) || 24, 24 * 7);
  return c.json(await hub(c.env, c.req.param('id'), originOf(c.req.raw, c.env), 'dnsSummary', hours));
});

siteRoutes.get('/sites/:id/live', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') throw new HttpError(426, 'upgrade_required', 'WebSocket upgrade required');
  const id = c.req.param('id');
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-site-id', id);
  headers.set('x-origin', originOf(c.req.raw, c.env));
  return hubStub(c.env, id).fetch(new Request('https://hub/live', { headers }));
});

import { Hono } from 'hono';
import type { DeviceApp } from '../../shared/types';
import { audit, type Row, toDevice } from '../lib/db';
import { hub, originOf } from '../lib/hub';
import { domainValid, HttpError, isPrivateIPv4, now, parseJson } from '../lib/util';
import { actorOf, type AppEnv, body } from './shared';

export const deviceRoutes = new Hono<AppEnv>();

async function deviceRow(c: any, id: string): Promise<Row> {
  const r = await c.env.DB.prepare('SELECT d.*, s.name site_name FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?').bind(id).first();
  if (!r) throw new HttpError(404, 'not_found', 'Device not found');
  return r;
}

deviceRoutes.get('/devices', async (c) => {
  const where: string[] = []; const args: unknown[] = [];
  if (c.req.query('site_id')) { where.push('d.site_id = ?'); args.push(c.req.query('site_id')); }
  if (c.req.query('kind')) { where.push('d.kind = ?'); args.push(c.req.query('kind')); }
  const r = await c.env.DB.prepare(`SELECT d.*, s.name site_name FROM devices d JOIN sites s ON s.id = d.site_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.name, d.name`).bind(...args).all<Row>();
  return c.json(r.results.map(toDevice));
});

deviceRoutes.get('/devices/:id', async (c) => c.json(toDevice(await deviceRow(c, c.req.param('id')))));

deviceRoutes.patch('/devices/:id', async (c) => {
  const d = await deviceRow(c, c.req.param('id'));
  const b = await body(c);
  const sets: string[] = []; const vals: unknown[] = [];
  const set = (k: string, v: unknown) => { sets.push(`${k} = ?`); vals.push(v); };
  let dnsChanged = false;
  if (typeof b.name === 'string' && b.name.trim()) set('name', b.name.trim().slice(0, 80));
  if ('room' in b) set('room', b.room ? String(b.room).slice(0, 80) : null);
  if (Array.isArray(b.tags)) set('tags', JSON.stringify(b.tags.map(String).map((t: string) => t.slice(0, 32)).slice(0, 20)));
  if (b.ip !== undefined) {
    if (!isPrivateIPv4(b.ip)) throw new HttpError(400, 'bad_request', 'IP must be a private LAN address');
    set('ip', b.ip); dnsChanged = true;
  }
  if (b.port !== undefined) set('port', b.port ? Number(b.port) : null);
  if (b.dns_mode !== undefined) {
    if (!['enforce', 'monitor', 'off', 'bypass'].includes(b.dns_mode)) throw new HttpError(400, 'bad_request', 'Invalid dns_mode');
    set('dns_mode', b.dns_mode); dnsChanged = true;
    if (b.dns_mode !== 'monitor') set('monitor_until', null);
  }
  if (b.dns_policy !== undefined) {
    if (!['balanced', 'strict'].includes(b.dns_policy)) throw new HttpError(400, 'bad_request', 'Invalid dns_policy');
    set('dns_policy', b.dns_policy); dnsChanged = true;
  }
  for (const k of ['dns_allow', 'dns_block'] as const) {
    if (b[k] !== undefined) {
      const list = (b[k] as string[]).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      const bad = list.find((x) => !domainValid(x));
      if (bad) throw new HttpError(400, 'bad_request', `"${bad}" is not a valid domain`);
      set(k, JSON.stringify([...new Set(list)].slice(0, 500))); dnsChanged = true;
    }
  }
  if (!sets.length) return c.json(toDevice(d));
  set('updated_at', now());
  await c.env.DB.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, d.id).run();
  if (dnsChanged) c.executionCtx.waitUntil(hub(c.env, d.site_id, originOf(c.req.raw, c.env), 'pushDnsConfig').catch(() => undefined));
  await audit(c.env, actorOf(c), 'device.update', { target_type: 'device', target_id: d.id, site_id: d.site_id, details: b });
  return c.json(toDevice(await deviceRow(c, d.id)));
});

deviceRoutes.delete('/devices/:id', async (c) => {
  const d = await deviceRow(c, c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM device_apps WHERE device_id = ?').bind(d.id),
    c.env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(d.id),
  ]);
  const facts = parseJson<any>(d.facts, {});
  if (facts.last_screenshot) c.executionCtx.waitUntil(c.env.FILES.delete(facts.last_screenshot));
  c.executionCtx.waitUntil(hub(c.env, d.site_id, originOf(c.req.raw, c.env), 'pushDnsConfig').catch(() => undefined));
  await audit(c.env, actorOf(c), 'device.delete', { target_type: 'device', target_id: d.id, site_id: d.site_id, details: { name: d.name } });
  return c.json({ ok: true });
});

deviceRoutes.post('/devices/:id/command', async (c) => {
  const d = await deviceRow(c, c.req.param('id'));
  const b = await body(c);
  if (typeof b.command !== 'string' || !/^[a-z_]{2,32}$/.test(b.command)) throw new HttpError(400, 'bad_request', 'command required');
  const data = await hub(c.env, d.site_id, originOf(c.req.raw, c.env), 'command', d.id, b.command, b.args ?? {}, actorOf(c));
  return c.json({ ok: (data as any)?.ok !== false, data, error: (data as any)?.ok === false ? (data as any).detail ?? (data as any).output : undefined });
});

deviceRoutes.get('/devices/:id/apps', async (c) => {
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare('SELECT a.*, k.category, k.risk, k.label catalog_label FROM device_apps a LEFT JOIN app_catalog k ON k.package = a.package WHERE a.device_id = ? ORDER BY a.system, coalesce(a.label, k.label, a.package)').bind(id).all<Row>();
  const apps: DeviceApp[] = rows.results.map((r) => ({
    package: r.package, label: r.label ?? r.catalog_label ?? null, version_name: r.version_name, version_code: r.version_code, system: !!r.system,
    enabled: !!r.enabled, permissions: parseJson(r.permissions, []), category: r.category, risk: r.risk, first_seen: r.first_seen, last_seen: r.last_seen,
    icon: r.icon, app_id: r.app_id,
  }));
  return c.json(apps);
});

deviceRoutes.get('/devices/:id/privacy', async (c) => {
  const d = await deviceRow(c, c.req.param('id'));
  return c.json(await hub(c.env, d.site_id, originOf(c.req.raw, c.env), 'privacy', d.id));
});

deviceRoutes.put('/devices/:id/privacy/checklist', async (c) => {
  const d = await deviceRow(c, c.req.param('id'));
  const b = await body(c);
  if (typeof b.key !== 'string' || !/^[a-z_]{2,40}$/.test(b.key)) throw new HttpError(400, 'bad_request', 'key required');
  const p = parseJson<any>(d.privacy, {});
  p.checklist = { ...(p.checklist ?? {}), [b.key]: !!b.done };
  await c.env.DB.prepare('UPDATE devices SET privacy = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(p), now(), d.id).run();
  await audit(c.env, actorOf(c), 'privacy.checklist', { target_type: 'device', target_id: d.id, site_id: d.site_id, details: b });
  return c.json({ ok: true });
});

deviceRoutes.get('/devices/:id/screenshot', async (c) => {
  const d = await deviceRow(c, c.req.param('id'));
  const key = parseJson<any>(d.facts, {}).last_screenshot;
  if (!key) throw new HttpError(404, 'not_found', 'No screenshot yet');
  const obj = await c.env.FILES.get(key);
  if (!obj) throw new HttpError(404, 'not_found', 'No screenshot yet');
  return new Response(obj.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=60' } });
});

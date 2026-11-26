import { Hono } from 'hono';
import type { AppPolicy, AppSettings, Automation, VersionInfo } from '../../shared/types';
import { APP_VERSION } from '../../shared/releases';
import { BUILD_SHA, BUILD_TIME } from '../../shared/build';
import { parseCron } from '../automations/cron';
import { parseApk } from '../lib/apk';
import { sha256Hex } from '../lib/crypto';
import { audit, getAppSettings, type Row, setAppSetting, toAlert, toAutomation, toJob } from '../lib/db';
import { hub, originOf } from '../lib/hub';
import { assertPackage, HttpError, now, parseJson, rid } from '../lib/util';
import { actorOf, type AppEnv, body } from './shared';

export const opsRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------- APK library
opsRoutes.get('/apks', async (c) => c.json((await c.env.DB.prepare('SELECT id, package, label, version_name, version_code, sha256, size, notes, uploaded_at FROM apks ORDER BY uploaded_at DESC').all()).results));

opsRoutes.post('/apks', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'bad_request', 'Attach an .apk file');
  const f = file as unknown as File;
  if (f.size > 200 * 1024 * 1024) throw new HttpError(413, 'too_large', 'APK larger than 200 MB');
  const buf = new Uint8Array(await f.arrayBuffer());
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new HttpError(400, 'bad_request', 'That file is not an APK (zip)');
  const sha = await sha256Hex(buf);
  const meta = parseApk(buf);
  const pkg = (form.get('package') as string) || meta?.package || null;
  if (pkg) assertPackage(pkg);
  const id = rid('apk');
  const key = `apks/${sha}.apk`;
  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: 'application/vnd.android.package-archive' } });
  await c.env.DB.prepare('INSERT INTO apks (id, package, label, version_name, version_code, r2_key, sha256, size, notes, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, pkg, (form.get('label') as string) || meta?.label || f.name.replace(/\.apk$/i, ''), meta?.version_name ?? null, meta?.version_code ?? null, key, sha, buf.length, (form.get('notes') as string) || null, now()).run();
  await audit(c.env, actorOf(c), 'apk.upload', { target_type: 'apk', target_id: id, details: { package: pkg, size: buf.length } });
  return c.json(await c.env.DB.prepare('SELECT id, package, label, version_name, version_code, sha256, size, notes, uploaded_at FROM apks WHERE id = ?').bind(id).first(), 201);
});

opsRoutes.delete('/apks/:id', async (c) => {
  const a = await c.env.DB.prepare('SELECT * FROM apks WHERE id = ?').bind(c.req.param('id')).first<Row>();
  if (!a) throw new HttpError(404, 'not_found', 'APK not found');
  await c.env.DB.prepare('DELETE FROM apks WHERE id = ?').bind(a.id).run();
  const others = await c.env.DB.prepare('SELECT 1 FROM apks WHERE r2_key = ?').bind(a.r2_key).first();
  if (!others) await c.env.FILES.delete(a.r2_key);
  await audit(c.env, actorOf(c), 'apk.delete', { target_type: 'apk', target_id: a.id });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- app policies
const toPolicy = (r: Row): AppPolicy => ({
  id: r.id, name: r.name, scope_type: r.scope_type, scope_id: r.scope_id, required: parseJson(r.required, []), banned: parseJson(r.banned, []),
  ban_action: r.ban_action, kiosk_allowed: parseJson(r.kiosk_allowed, null), enabled: !!r.enabled, created_at: r.created_at,
});

function cleanPolicy(b: any) {
  const pk = (p: unknown) => assertPackage(p);
  return {
    name: String(b.name ?? '').trim().slice(0, 80) || 'Untitled policy',
    scope_type: ['global', 'client', 'site', 'device'].includes(b.scope_type) ? b.scope_type : 'global',
    scope_id: b.scope_type === 'global' ? null : b.scope_id ?? null,
    required: JSON.stringify((b.required ?? []).map((r: any) => ({ package: pk(r.package), apk_id: r.apk_id ?? null }))),
    banned: JSON.stringify((b.banned ?? []).map(pk)),
    ban_action: b.ban_action === 'uninstall' ? 'uninstall' : 'disable',
    kiosk_allowed: b.kiosk_allowed?.length ? JSON.stringify(b.kiosk_allowed.map(pk)) : null,
    enabled: b.enabled === false ? 0 : 1,
  };
}

opsRoutes.get('/app-policies', async (c) => c.json((await c.env.DB.prepare('SELECT * FROM app_policies ORDER BY name').all<Row>()).results.map(toPolicy)));
opsRoutes.post('/app-policies', async (c) => {
  const p = cleanPolicy(await body(c));
  const id = rid('pol');
  await c.env.DB.prepare('INSERT INTO app_policies (id, name, scope_type, scope_id, required, banned, ban_action, kiosk_allowed, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, p.name, p.scope_type, p.scope_id, p.required, p.banned, p.ban_action, p.kiosk_allowed, p.enabled, now()).run();
  await audit(c.env, actorOf(c), 'app_policy.create', { target_type: 'app_policy', target_id: id, details: p });
  return c.json(toPolicy((await c.env.DB.prepare('SELECT * FROM app_policies WHERE id = ?').bind(id).first<Row>())!), 201);
});
opsRoutes.patch('/app-policies/:id', async (c) => {
  const cur = await c.env.DB.prepare('SELECT * FROM app_policies WHERE id = ?').bind(c.req.param('id')).first<Row>();
  if (!cur) throw new HttpError(404, 'not_found', 'Policy not found');
  const p = cleanPolicy({ ...toPolicy(cur), ...(await body(c)) });
  await c.env.DB.prepare('UPDATE app_policies SET name = ?, scope_type = ?, scope_id = ?, required = ?, banned = ?, ban_action = ?, kiosk_allowed = ?, enabled = ? WHERE id = ?')
    .bind(p.name, p.scope_type, p.scope_id, p.required, p.banned, p.ban_action, p.kiosk_allowed, p.enabled, cur.id).run();
  await audit(c.env, actorOf(c), 'app_policy.update', { target_type: 'app_policy', target_id: cur.id, details: p });
  return c.json(toPolicy((await c.env.DB.prepare('SELECT * FROM app_policies WHERE id = ?').bind(cur.id).first<Row>())!));
});
opsRoutes.delete('/app-policies/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM app_policies WHERE id = ?').bind(c.req.param('id')).run();
  await audit(c.env, actorOf(c), 'app_policy.delete', { target_type: 'app_policy', target_id: c.req.param('id') });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- automations
function cleanAutomation(b: any): Omit<Automation, 'id' | 'created_at' | 'last_run' | 'last_status'> {
  const trig = b.trigger ?? {};
  if (trig.type === 'schedule') {
    try { parseCron(String(trig.cron)); } catch (e: any) { throw new HttpError(400, 'bad_cron', `Schedule: ${e.message}`); }
    if (trig.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: trig.timezone }); } catch { throw new HttpError(400, 'bad_tz', 'Unknown timezone'); } }
  } else if (trig.type !== 'event') throw new HttpError(400, 'bad_request', 'trigger.type must be schedule or event');
  if (!Array.isArray(b.actions) || !b.actions.length) throw new HttpError(400, 'bad_request', 'Add at least one action');
  return {
    name: String(b.name ?? '').trim().slice(0, 80) || 'Untitled automation', enabled: b.enabled !== false,
    scope_type: ['global', 'client', 'site'].includes(b.scope_type) ? b.scope_type : 'global', scope_id: b.scope_type === 'global' ? null : b.scope_id ?? null,
    trigger: trig.type === 'schedule' ? { type: 'schedule', cron: String(trig.cron), timezone: trig.timezone || undefined } : { type: 'event', event: trig.event },
    target: b.target ?? {}, actions: b.actions.slice(0, 20),
  };
}

opsRoutes.get('/automations', async (c) => c.json((await c.env.DB.prepare('SELECT * FROM automations ORDER BY name').all<Row>()).results.map(toAutomation)));
opsRoutes.post('/automations', async (c) => {
  const a = cleanAutomation(await body(c));
  const id = rid('auto');
  await c.env.DB.prepare('INSERT INTO automations (id, name, enabled, scope_type, scope_id, trigger, target, actions, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, a.name, a.enabled ? 1 : 0, a.scope_type, a.scope_id, JSON.stringify(a.trigger), JSON.stringify(a.target), JSON.stringify(a.actions), now()).run();
  await audit(c.env, actorOf(c), 'automation.create', { target_type: 'automation', target_id: id, details: a });
  return c.json(toAutomation((await c.env.DB.prepare('SELECT * FROM automations WHERE id = ?').bind(id).first<Row>())!), 201);
});
opsRoutes.patch('/automations/:id', async (c) => {
  const cur = await c.env.DB.prepare('SELECT * FROM automations WHERE id = ?').bind(c.req.param('id')).first<Row>();
  if (!cur) throw new HttpError(404, 'not_found', 'Automation not found');
  const a = cleanAutomation({ ...toAutomation(cur), ...(await body(c)) });
  await c.env.DB.prepare('UPDATE automations SET name = ?, enabled = ?, scope_type = ?, scope_id = ?, trigger = ?, target = ?, actions = ? WHERE id = ?')
    .bind(a.name, a.enabled ? 1 : 0, a.scope_type, a.scope_id, JSON.stringify(a.trigger), JSON.stringify(a.target), JSON.stringify(a.actions), cur.id).run();
  await audit(c.env, actorOf(c), 'automation.update', { target_type: 'automation', target_id: cur.id, details: a });
  return c.json(toAutomation((await c.env.DB.prepare('SELECT * FROM automations WHERE id = ?').bind(cur.id).first<Row>())!));
});
opsRoutes.delete('/automations/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM automations WHERE id = ?').bind(c.req.param('id')).run();
  await audit(c.env, actorOf(c), 'automation.delete', { target_type: 'automation', target_id: c.req.param('id') });
  return c.json({ ok: true });
});

/** Sites an automation applies to (scope ∩ target.site_ids). */
export async function automationSites(env: any, a: Automation): Promise<Row[]> {
  let sites: Row[];
  if (a.scope_type === 'site') sites = (await env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(a.scope_id).all()).results;
  else if (a.scope_type === 'client') sites = (await env.DB.prepare('SELECT * FROM sites WHERE client_id = ?').bind(a.scope_id).all()).results;
  else sites = (await env.DB.prepare('SELECT * FROM sites').all()).results;
  if (a.target.site_ids?.length) sites = sites.filter((s) => a.target.site_ids!.includes(s.id));
  return sites;
}

opsRoutes.post('/automations/:id/run', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM automations WHERE id = ?').bind(c.req.param('id')).first<Row>();
  if (!row) throw new HttpError(404, 'not_found', 'Automation not found');
  const a = toAutomation(row);
  const origin = originOf(c.req.raw, c.env);
  const sites = await automationSites(c.env, a);
  const runs = await Promise.all(sites.map((s) => hub<{ ok: boolean; job_id: string }>(c.env, s.id, origin, 'runAutomation', a.id).catch((e) => ({ ok: false, job_id: null, error: e.message }))));
  await audit(c.env, actorOf(c), 'automation.run', { target_type: 'automation', target_id: a.id, details: { sites: sites.length } });
  const ids = runs.map((r: any) => r.job_id).filter(Boolean);
  const jobs = ids.length ? (await c.env.DB.prepare(`SELECT * FROM jobs WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<Row>()).results.map(toJob) : [];
  return c.json({ ok: runs.every((r) => r.ok), jobs });
});

// ---------------------------------------------------------------- jobs / alerts / audit
opsRoutes.get('/jobs', async (c) => {
  const where: string[] = []; const args: unknown[] = [];
  if (c.req.query('site_id')) { where.push('j.site_id = ?'); args.push(c.req.query('site_id')); }
  if (c.req.query('device_id')) { where.push('j.device_id = ?'); args.push(c.req.query('device_id')); }
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  const r = await c.env.DB.prepare(`SELECT j.*, s.name site_name, d.name device_name FROM jobs j LEFT JOIN sites s ON s.id = j.site_id LEFT JOIN devices d ON d.id = j.device_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY j.created_at DESC LIMIT ${limit}`).bind(...args).all<Row>();
  return c.json(r.results.map(toJob));
});

opsRoutes.get('/alerts', async (c) => {
  const open = c.req.query('open') === '1';
  const r = await c.env.DB.prepare(`SELECT a.*, s.name site_name, d.name device_name FROM alerts a LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN devices d ON d.id = a.device_id
    ${open ? 'WHERE a.resolved_at IS NULL AND a.acknowledged_at IS NULL' : ''} ORDER BY a.at DESC LIMIT 300`).all<Row>();
  return c.json(r.results.map(toAlert));
});

opsRoutes.post('/alerts/:id/ack', async (c) => {
  await c.env.DB.prepare('UPDATE alerts SET acknowledged_at = ? WHERE id = ?').bind(now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

opsRoutes.get('/audit', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 200, 1000);
  const site = c.req.query('site_id');
  const r = await c.env.DB.prepare(`SELECT * FROM audit_log ${site ? 'WHERE site_id = ?' : ''} ORDER BY at DESC LIMIT ${limit}`).bind(...(site ? [site] : [])).all<Row>();
  return c.json(r.results.map((x) => ({ ...x, details: parseJson(x.details, null) })));
});

// ---------------------------------------------------------------- settings
opsRoutes.get('/settings', async (c) => {
  const s = await getAppSettings(c.env);
  const rel = await c.env.DB.prepare('SELECT version FROM agent_releases ORDER BY created_at DESC LIMIT 1').first<Row>();
  return c.json({ ...s, agent_latest_version: rel?.version ?? null });
});

opsRoutes.put('/settings', async (c) => {
  const b = await body<Partial<AppSettings>>(c);
  if (b.dot_base_domain !== undefined) {
    const d = (b.dot_base_domain ?? '').trim().toLowerCase();
    if (d && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) throw new HttpError(400, 'bad_request', 'Invalid domain');
    await setAppSetting(c.env, 'dot_base_domain', d || null);
  }
  if (b.default_monitor_days !== undefined) await setAppSetting(c.env, 'default_monitor_days', Math.min(60, Math.max(0, Number(b.default_monitor_days) || 0)));
  if (b.default_policy !== undefined) await setAppSetting(c.env, 'default_policy', b.default_policy === 'strict' ? 'strict' : 'balanced');
  if (b.cf_dns_token !== undefined) {
    throw new HttpError(400, 'secret_only', 'The Cloudflare DNS token is kept as a Worker secret (CF_DNS_TOKEN), not in the app. Add it in Cloudflare: Workers & Pages → screens → Settings → Variables and Secrets.');
  }
  if (b.dns_log_retention_days !== undefined) await setAppSetting(c.env, 'dns_log_retention_days', Math.min(30, Math.max(1, Number(b.dns_log_retention_days) || 7)));
  await audit(c.env, actorOf(c), 'settings.update', { details: b });
  return c.json(await getAppSettings(c.env));
});

// ---------------------------------------------------------------- version / release notes
opsRoutes.get('/version', async (c) => {
  const [rel, gws, launcher, devs] = await Promise.all([
    c.env.DB.prepare('SELECT version FROM agent_releases ORDER BY created_at DESC LIMIT 1').first<Row>(),
    c.env.DB.prepare("SELECT g.site_id, s.name site_name, g.version, g.status FROM gateways g JOIN sites s ON s.id = g.site_id WHERE g.status != 'revoked' ORDER BY s.name").all<Row>(),
    c.env.DB.prepare("SELECT version_name FROM apks WHERE package = 'au.supercluster.screens.launcher' ORDER BY coalesce(version_code, 0) DESC, uploaded_at DESC LIMIT 1").first<Row>(),
    c.env.DB.prepare("SELECT json_extract(facts, '$.launcher.version') v FROM devices WHERE kind = 'android' AND json_extract(facts, '$.launcher.installed') = 1").all<Row>(),
  ]);
  const latest = rel?.version ?? null;
  const sites = gws.results.map((g) => ({ site_id: g.site_id, site_name: g.site_name, version: g.version, status: g.status, up_to_date: !latest || g.version === latest }));
  const lv = launcher?.version_name ?? null;
  const out: VersionInfo = {
    version: APP_VERSION, build_sha: BUILD_SHA, built_at: BUILD_TIME,
    gateway: { latest, up_to_date: sites.filter((s) => s.up_to_date).length, total: sites.length, sites },
    launcher: { latest: lv, installed: devs.results.length, up_to_date: devs.results.filter((d) => !lv || d.v === lv).length },
  };
  return c.json(out);
});

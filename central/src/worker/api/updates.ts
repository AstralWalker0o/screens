// /api/updates/*: the app update manager (docs/UPDATES.md).

import { Hono } from 'hono';
import type { UpdateDeviceInfo, UpdateRollout, UpdateRunResult, UpdateSiteSettings, UpdatesOverview } from '../../shared/updates';
import { DEFAULT_WINDOW, inWindow, nextWindowStart, parseHm } from '../../shared/updates';
import { audit, type Row, toJob } from '../lib/db';
import { hub, originOf } from '../lib/hub';
import { assertPackage, HttpError, now, parseJson } from '../lib/util';
import { checkAllSources } from '../updates/github';
import { ensureApkInfo, getState, toRollout, toSource } from '../updates/store';
import { buildPackages, deviceUpdates, loadFleet, summarize } from '../updates/view';
import type { Env } from '../env';
import { actorOf, type AppEnv, body } from './shared';

export const updateRoutes = new Hono<AppEnv>();

const ABIS = ['arm64-v8a', 'armeabi-v7a', 'armeabi', 'x86_64', 'x86', 'riscv64'];
const GLOB_RE = /^[A-Za-z0-9._+\-*?]{1,100}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

async function sitesView(env: Env, t: number): Promise<UpdateSiteSettings[]> {
  const rows = (await env.DB.prepare(`SELECT s.id, s.name, s.timezone, u.window_start, u.window_end, u.canary_device_id,
    (SELECT count(*) FROM gateways g WHERE g.site_id = s.id AND g.status = 'online') gw
    FROM sites s LEFT JOIN update_sites u ON u.site_id = s.id ORDER BY s.name`).all<Row>()).results;
  return rows.map((r) => {
    const start = r.window_start ?? DEFAULT_WINDOW.start, end = r.window_end ?? DEFAULT_WINDOW.end, tz = r.timezone || 'UTC';
    return {
      site_id: r.id, site_name: r.name, timezone: tz, window_start: start, window_end: end, canary_device_id: r.canary_device_id ?? null,
      in_window: inWindow(t, tz, start, end), next_window_at: nextWindowStart(t, tz, start, end), gateway_online: r.gw > 0,
    };
  });
}

async function recentRollouts(env: Env, limit = 30): Promise<UpdateRollout[]> {
  const rows = (await env.DB.prepare(`SELECT r.*, s.name site_name FROM update_rollouts r LEFT JOIN sites s ON s.id = r.site_id
    ORDER BY CASE WHEN r.status IN ('canary','rolling') THEN 0 ELSE 1 END, r.created_at DESC LIMIT ?`).bind(limit).all<Row>()).results;
  return rows.map(toRollout);
}

async function overview(env: Env): Promise<UpdatesOverview> {
  const t = now();
  await ensureApkInfo(env, 2).catch(() => 0); // new uploads: read their ABIs and signer soon after upload
  const [data, sites, rollouts, jobs, gh, failed, lastCheck] = await Promise.all([
    loadFleet(env), sitesView(env, t), recentRollouts(env),
    env.DB.prepare(`SELECT j.*, s.name site_name, d.name device_name FROM jobs j LEFT JOIN sites s ON s.id = j.site_id LEFT JOIN devices d ON d.id = j.device_id
      WHERE j.kind = 'app_update' ORDER BY j.created_at DESC LIMIT 40`).all<Row>(),
    getState<{ backoff_until?: number | null; last_check?: number | null }>(env, 'github', {}),
    env.DB.prepare("SELECT count(*) n FROM jobs WHERE kind = 'app_update' AND status = 'error' AND created_at > ?").bind(t - 7 * 86_400_000).first<Row>(),
    env.DB.prepare('SELECT max(last_checked) t FROM update_sources').first<Row>(),
  ]);
  const packages = buildPackages(data);
  const devices: UpdateDeviceInfo[] = data.devices.map((d) => {
    const i = data.info.get(d.id);
    return {
      device_id: d.id, name: d.name, site_id: d.site_id, site_name: d.site_name, online: d.status === 'online' || d.status === 'standby',
      model: d.model ?? null, sdk: i?.sdk ?? parseJson<any>(d.facts, {}).sdk ?? null, abis: parseJson<string[]>(i?.abis, []), abi_override: i?.abi_override ?? null, probed_at: i?.probed_at ?? null,
    };
  });
  return {
    packages, sites, devices, rollouts, jobs: jobs.results.map(toJob),
    github: { backoff_until: gh.backoff_until && gh.backoff_until > t ? gh.backoff_until : null, last_check: gh.last_check ?? null },
    summary: summarize(packages, { failed_7d: failed?.n ?? 0, running: rollouts.filter((r) => r.status === 'canary' || r.status === 'rolling').length, last_check: lastCheck?.t ?? null }),
  };
}

updateRoutes.get('/updates', async (c) => c.json(await overview(c.env)));
updateRoutes.get('/updates/summary', async (c) => c.json((await overview(c.env)).summary));

updateRoutes.get('/updates/device/:id', async (c) => {
  const id = c.req.param('id');
  return c.json(deviceUpdates(await loadFleet(c.env, { deviceId: id }), id));
});

// ---------------------------------------------------------------- policies
updateRoutes.put('/updates/policies', async (c) => {
  const b = await body<{ package: string; scope_type?: 'fleet' | 'site'; scope_id?: string | null; mode: string | null }>(c);
  const pkg = assertPackage(b.package);
  const scope = b.scope_type === 'site' ? 'site' : 'fleet';
  const scopeId = scope === 'site' ? String(b.scope_id ?? '') : '';
  if (scope === 'site' && !(await c.env.DB.prepare('SELECT 1 FROM sites WHERE id = ?').bind(scopeId).first())) throw new HttpError(400, 'bad_request', 'Unknown site');
  if (b.mode == null) {
    await c.env.DB.prepare('DELETE FROM update_policies WHERE package = ? AND scope_type = ? AND scope_id = ?').bind(pkg, scope, scopeId).run();
  } else {
    if (!['auto', 'notify', 'pin'].includes(b.mode)) throw new HttpError(400, 'bad_request', 'Mode must be auto, notify or pin');
    await c.env.DB.prepare(`INSERT INTO update_policies (package, scope_type, scope_id, mode, updated_at, updated_by) VALUES (?,?,?,?,?,?)
      ON CONFLICT(package, scope_type, scope_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(pkg, scope, scopeId, b.mode, now(), actorOf(c)).run();
  }
  await audit(c.env, actorOf(c), 'updates.policy', { target_type: 'app', target_id: pkg, site_id: scope === 'site' ? scopeId : null, details: { scope, mode: b.mode } });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- GitHub sources
function cleanSource(b: any) {
  const repo = String(b.repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!REPO_RE.test(repo) || /(^|\/)\.\.?$/.test(repo)) throw new HttpError(400, 'bad_request', 'Enter the GitHub repository as owner/name, e.g. jellyfin/jellyfin-androidtv');
  const pattern = String(b.asset_pattern ?? '*.apk').trim() || '*.apk';
  if (!GLOB_RE.test(pattern)) throw new HttpError(400, 'bad_request', 'The file name pattern may only use letters, digits, . - _ + and the wildcards * and ?');
  const abi: Record<string, string> = {};
  for (const [k, v] of Object.entries((b.abi_patterns ?? {}) as Record<string, unknown>)) {
    const p = String(v ?? '').trim();
    if (!p) continue;
    if (!ABIS.includes(k)) throw new HttpError(400, 'bad_request', `Unknown processor type ${k}`);
    if (!GLOB_RE.test(p)) throw new HttpError(400, 'bad_request', `The pattern for ${k} may only use letters, digits, . - _ + and the wildcards * and ?`);
    abi[k] = p;
  }
  return { repo, asset_pattern: pattern, abi_patterns: JSON.stringify(abi), include_prereleases: b.include_prereleases ? 1 : 0, enabled: b.enabled === false ? 0 : 1 };
}

updateRoutes.get('/updates/sources', async (c) => c.json((await c.env.DB.prepare('SELECT * FROM update_sources ORDER BY package').all<Row>()).results.map(toSource)));

updateRoutes.post('/updates/sources', async (c) => {
  const b = await body(c);
  const pkg = assertPackage(b.package);
  const s = cleanSource(b);
  const t = now();
  await c.env.DB.prepare(`INSERT INTO update_sources (package, kind, repo, asset_pattern, abi_patterns, include_prereleases, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(package) DO UPDATE SET repo = excluded.repo, asset_pattern = excluded.asset_pattern, abi_patterns = excluded.abi_patterns,
      include_prereleases = excluded.include_prereleases, enabled = excluded.enabled, etag = NULL, updated_at = excluded.updated_at,
      signer_sha256 = CASE WHEN update_sources.repo = excluded.repo THEN update_sources.signer_sha256 ELSE NULL END`)
    .bind(pkg, 'github', s.repo, s.asset_pattern, s.abi_patterns, s.include_prereleases, s.enabled, t, t).run();
  await audit(c.env, actorOf(c), 'updates.source.save', { target_type: 'app', target_id: pkg, details: s });
  // Check straight away so the owner sees whether it works.
  const [res] = s.enabled ? await checkAllSources(c.env, pkg) : [];
  const row = await c.env.DB.prepare('SELECT * FROM update_sources WHERE package = ?').bind(pkg).first<Row>();
  return c.json({ source: toSource(row!), check: res ?? null }, 201);
});

updateRoutes.patch('/updates/sources/:package', async (c) => {
  const pkg = assertPackage(c.req.param('package'));
  const cur = await c.env.DB.prepare('SELECT * FROM update_sources WHERE package = ?').bind(pkg).first<Row>();
  if (!cur) throw new HttpError(404, 'not_found', 'No update source for that app');
  const b = await body(c);
  const s = cleanSource({ ...toSource(cur), ...b });
  const resetKey = b.reset_signer === true;
  await c.env.DB.prepare(`UPDATE update_sources SET repo = ?, asset_pattern = ?, abi_patterns = ?, include_prereleases = ?, enabled = ?, updated_at = ?,
    etag = CASE WHEN ? THEN NULL ELSE etag END, signer_sha256 = CASE WHEN ? THEN NULL ELSE signer_sha256 END WHERE package = ?`)
    .bind(s.repo, s.asset_pattern, s.abi_patterns, s.include_prereleases, s.enabled, now(), 1, resetKey || s.repo !== cur.repo ? 1 : 0, pkg).run();
  await audit(c.env, actorOf(c), 'updates.source.save', { target_type: 'app', target_id: pkg, details: { ...s, reset_signer: resetKey } });
  return c.json(toSource((await c.env.DB.prepare('SELECT * FROM update_sources WHERE package = ?').bind(pkg).first<Row>())!));
});

updateRoutes.delete('/updates/sources/:package', async (c) => {
  const pkg = assertPackage(c.req.param('package'));
  await c.env.DB.prepare('DELETE FROM update_sources WHERE package = ?').bind(pkg).run();
  await audit(c.env, actorOf(c), 'updates.source.delete', { target_type: 'app', target_id: pkg });
  return c.json({ ok: true });
});

updateRoutes.post('/updates/check', async (c) => {
  const b = await body<{ package?: string }>(c);
  const results = await checkAllSources(c.env, b.package ? assertPackage(b.package) : undefined);
  await audit(c.env, actorOf(c), 'updates.check', { details: { sources: results.length, imported: results.flatMap((r) => r.imported.filter((i) => i.status === 'imported')).length } });
  return c.json({ results });
});

// ---------------------------------------------------------------- schedule / boxes
updateRoutes.put('/updates/sites/:id', async (c) => {
  const id = c.req.param('id');
  if (!(await c.env.DB.prepare('SELECT 1 FROM sites WHERE id = ?').bind(id).first())) throw new HttpError(404, 'not_found', 'Site not found');
  const b = await body<{ window_start?: string; window_end?: string; canary_device_id?: string | null }>(c);
  const start = b.window_start ?? DEFAULT_WINDOW.start, end = b.window_end ?? DEFAULT_WINDOW.end;
  if (parseHm(start) == null || parseHm(end) == null) throw new HttpError(400, 'bad_request', 'Times must look like 03:00');
  if (start === end) throw new HttpError(400, 'bad_request', 'The window must end at a different time than it starts');
  let canary: string | null = b.canary_device_id || null;
  if (canary && !(await c.env.DB.prepare("SELECT 1 FROM devices WHERE id = ? AND site_id = ? AND kind = 'android'").bind(canary, id).first())) throw new HttpError(400, 'bad_request', 'The canary must be an Android box at this site');
  await c.env.DB.prepare(`INSERT INTO update_sites (site_id, window_start, window_end, canary_device_id, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(site_id) DO UPDATE SET window_start = excluded.window_start, window_end = excluded.window_end, canary_device_id = excluded.canary_device_id, updated_at = excluded.updated_at`)
    .bind(id, start, end, canary, now()).run();
  await audit(c.env, actorOf(c), 'updates.window', { target_type: 'site', target_id: id, site_id: id, details: { start, end, canary } });
  return c.json((await sitesView(c.env, now())).find((s) => s.site_id === id));
});

updateRoutes.put('/updates/devices/:id', async (c) => {
  const id = c.req.param('id');
  const dev = await c.env.DB.prepare("SELECT d.site_id, u.abis FROM devices d LEFT JOIN update_devices u ON u.device_id = d.id WHERE d.id = ? AND d.kind = 'android'").bind(id).first<Row>();
  if (!dev) throw new HttpError(404, 'not_found', 'Android box not found');
  const b = await body<{ abi_override?: string | null }>(c);
  const abi = b.abi_override || null;
  if (abi && !parseJson<string[]>(dev.abis, []).includes(abi)) throw new HttpError(400, 'bad_request', 'That box’s processor doesn’t support that build type');
  await c.env.DB.prepare('INSERT INTO update_devices (device_id, abi_override) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET abi_override = excluded.abi_override').bind(id, abi).run();
  await audit(c.env, actorOf(c), 'updates.device_abi', { target_type: 'device', target_id: id, site_id: dev.site_id, details: { abi } });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- running updates
updateRoutes.post('/updates/run', async (c) => {
  const b = await body<{ package: string; site_id?: string; device_id?: string }>(c);
  const pkg = assertPackage(b.package);
  const origin = originOf(c.req.raw, c.env);
  const actor = actorOf(c);
  const out: UpdateRunResult = { rollouts: [], skipped: [] };
  if (b.device_id) {
    const d = await c.env.DB.prepare("SELECT site_id FROM devices WHERE id = ? AND kind = 'android'").bind(b.device_id).first<Row>();
    if (!d) throw new HttpError(404, 'not_found', 'Android box not found');
    out.rollouts.push(await hub(c.env, d.site_id, origin, 'updateNow', { package: pkg, device_ids: [b.device_id], force: true }, actor));
    return c.json(out);
  }
  const sites = b.site_id ? [b.site_id] : (await c.env.DB.prepare(`SELECT DISTINCT d.site_id FROM device_apps a JOIN devices d ON d.id = a.device_id
    WHERE d.kind = 'android' AND a.package = ? AND a.system = 0`).bind(pkg).all<Row>()).results.map((r) => r.site_id as string);
  for (const s of sites) {
    try { out.rollouts.push(await hub(c.env, s, origin, 'updateNow', { package: pkg }, actor)); }
    catch (e: any) {
      if (b.site_id) throw e;
      out.skipped.push({ site_id: s, reason: e.message });
    }
  }
  if (!out.rollouts.length && out.skipped.length) throw new HttpError(409, 'nothing_to_do', out.skipped[0].reason);
  return c.json(out);
});

updateRoutes.post('/updates/rollouts/:id/cancel', async (c) => {
  const r = await c.env.DB.prepare('SELECT site_id FROM update_rollouts WHERE id = ?').bind(c.req.param('id')).first<Row>();
  if (!r) throw new HttpError(404, 'not_found', 'Rollout not found');
  return c.json(await hub(c.env, r.site_id, originOf(c.req.raw, c.env), 'updatesCancel', c.req.param('id'), actorOf(c)));
});

updateRoutes.post('/updates/probe', async (c) => {
  const b = await body<{ site_id?: string; device_id?: string }>(c);
  const origin = originOf(c.req.raw, c.env);
  let sites: string[];
  if (b.device_id) {
    const d = await c.env.DB.prepare("SELECT site_id FROM devices WHERE id = ? AND kind = 'android'").bind(b.device_id).first<Row>();
    if (!d) throw new HttpError(404, 'not_found', 'Android box not found');
    sites = [d.site_id];
  } else sites = b.site_id ? [b.site_id] : (await c.env.DB.prepare("SELECT DISTINCT site_id FROM gateways WHERE status = 'online'").all<Row>()).results.map((r) => r.site_id as string);
  let devices = 0;
  for (const s of sites) devices += (await hub<{ devices: number }>(c.env, s, origin, 'updatesProbe', b.device_id ? [b.device_id] : undefined).catch(() => ({ devices: 0 }))).devices;
  return c.json({ ok: true, devices });
});

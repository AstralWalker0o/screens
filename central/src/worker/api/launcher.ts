// Screens Launcher v2: home-screen layouts, images and rollout (docs/API.md, docs/LAUNCHER-V2.md).

import { Hono } from 'hono';
import {
  ACCENT_RE, assetR2Key, homeAssets, LAUNCHER_LIMITS, LAUNCHER_PACKAGE, layoutName, launcherConfigJson, sniffImage, supportsV2, utf8Length, validateHome,
  type LauncherDeviceRollout, type LauncherHome, type LauncherLayout, type LauncherSiteState,
} from '../../shared/launcher';
import type { LauncherState } from '../../shared/types';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { audit, type Row } from '../lib/db';
import { hub, originOf } from '../lib/hub';
import { configInput, devicesUsingLayout, effectiveLayoutId, expectedFor, getLayout, launcherPayload, layoutConfigJson, toAsset, toLayout } from '../lib/launcher';
import { HttpError, now, parseJson, rid } from '../lib/util';
import { actorOf, type AppEnv, body, type Ctx } from './shared';

export const launcherRoutes = new Hono<AppEnv>();

const ASSET_FILE_RE = /^([0-9a-f]{64})\.(jpg|png|webp)$/;

async function siteRow(env: Env, id: string): Promise<Row> {
  const s = await env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<Row>();
  if (!s) throw new HttpError(404, 'not_found', 'Site not found');
  return s;
}

async function layoutOr404(env: Env, id: string): Promise<LauncherLayout> {
  const l = await getLayout(env, id);
  if (!l) throw new HttpError(404, 'not_found', 'Home screen layout not found');
  return l;
}

/** Add `used_by` (sites using it as default, devices overriding to it). */
async function withUsage(env: Env, layouts: LauncherLayout[]): Promise<LauncherLayout[]> {
  if (!layouts.length) return layouts;
  const ids = layouts.map((l) => l.id);
  const q = ids.map(() => '?').join(',');
  const [sites, devs] = await Promise.all([
    env.DB.prepare(`SELECT id, launcher_layout_id l FROM sites WHERE launcher_layout_id IN (${q})`).bind(...ids).all<Row>(),
    env.DB.prepare(`SELECT id, launcher_layout_id l FROM devices WHERE launcher_layout_id IN (${q})`).bind(...ids).all<Row>(),
  ]);
  return layouts.map((l) => ({
    ...l,
    used_by: { sites: sites.results.filter((r) => r.l === l.id).map((r) => r.id), devices: devs.results.filter((r) => r.l === l.id).map((r) => r.id) },
  }));
}

function cleanHome(input: unknown): LauncherHome {
  const v = validateHome(input);
  if (!v.ok) throw new HttpError(400, 'bad_layout', v.errors.slice(0, 4).join('. ') + (v.errors.length > 4 ? ` (and ${v.errors.length - 4} more)` : ''));
  return v.home;
}

function cleanAccent(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !ACCENT_RE.test(v)) throw new HttpError(400, 'bad_layout', 'Accent colour must look like #4F8EF7');
  return v;
}

/** Every image must already be uploaded, with the right type, and fit the box's 64 MB budget. */
async function checkAssets(env: Env, home: LauncherHome) {
  const refs = homeAssets(home);
  if (!refs.length) return;
  const rows = (await env.DB.prepare(`SELECT sha256, ext, bytes FROM launcher_assets WHERE sha256 IN (${refs.map(() => '?').join(',')})`).bind(...refs.map((a) => a.sha256)).all<Row>()).results;
  const by = new Map(rows.map((r) => [r.sha256 as string, r]));
  let total = 0;
  for (const a of refs) {
    const r = by.get(a.sha256);
    if (!r) throw new HttpError(400, 'bad_layout', `Image ${a.sha256.slice(0, 12)}… hasn't been uploaded. Upload it again.`);
    if (r.ext !== a.ext) throw new HttpError(400, 'bad_layout', `Image ${a.sha256.slice(0, 12)}… is a ${r.ext}, not a ${a.ext}`);
    total += r.bytes as number;
  }
  if (total > LAUNCHER_LIMITS.assets_total) throw new HttpError(400, 'bad_layout', `The pictures in this layout add up to ${Math.ceil(total / 1048576)} MB; a box holds at most ${LAUNCHER_LIMITS.assets_total / 1048576} MB.`);
}

/** The v2 config (layout + each site's welcome/kiosk) must stay under 48 KB for every site that would use it. */
async function checkConfigSize(env: Env, layout: Pick<LauncherLayout, 'id' | 'site_id' | 'home' | 'accent' | 'name'>) {
  const siteIds = layout.site_id ? [layout.site_id] : (await env.DB.prepare(`SELECT DISTINCT s.id FROM sites s LEFT JOIN devices d ON d.site_id = s.id
      WHERE s.launcher_layout_id = ?1 OR d.launcher_layout_id = ?1`).bind(layout.id).all<Row>()).results.map((r) => r.id as string);
  for (const sid of siteIds) {
    const site = await env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(sid).first<Row>();
    if (!site) continue;
    const bytes = utf8Length(launcherConfigJson(configInput(site, layout as LauncherLayout), 2));
    if (bytes > LAUNCHER_LIMITS.config_bytes) throw new HttpError(400, 'bad_layout', `With ${site.name}'s welcome and kiosk settings this layout is ${Math.ceil(bytes / 1024)} KB; a box accepts at most ${LAUNCHER_LIMITS.config_bytes / 1024} KB. Remove some apps or overrides.`);
  }
}

/** Push to every box whose effective layout is one of these (in the background). */
function pushDevices(c: Ctx, devices: { id: string; site_id: string }[], actor = 'system') {
  if (!devices.length) return;
  const origin = originOf(c.req.raw, c.env);
  const bySite = new Map<string, string[]>();
  for (const d of devices) bySite.set(d.site_id, [...(bySite.get(d.site_id) ?? []), d.id]);
  c.executionCtx.waitUntil(Promise.all([...bySite].map(([sid, ids]) => hub(c.env, sid, origin, 'pushLauncherConfig', ids, actor).catch(() => undefined))));
}

// ---------------------------------------------------------------- layouts
launcherRoutes.get('/launcher/layouts', async (c) => {
  const siteId = c.req.query('site_id');
  const templates = c.req.query('templates') === '1';
  const where = templates ? 'WHERE l.site_id IS NULL' : siteId ? 'WHERE l.site_id = ? OR l.site_id IS NULL' : '';
  const stmt = c.env.DB.prepare(`SELECT l.*, s.name site_name FROM launcher_layouts l LEFT JOIN sites s ON s.id = l.site_id ${where} ORDER BY l.site_id IS NULL, s.name, l.name`);
  const rows = (await (siteId && !templates ? stmt.bind(siteId) : stmt).all<Row>()).results;
  return c.json(await withUsage(c.env, rows.map(toLayout)));
});

launcherRoutes.get('/launcher/layouts/:id', async (c) => c.json((await withUsage(c.env, [await layoutOr404(c.env, c.req.param('id'))]))[0]));

launcherRoutes.post('/launcher/layouts', async (c) => {
  const b = await body(c);
  const siteId: string | null = b.site_id ? String(b.site_id) : null;
  if (siteId) await siteRow(c.env, siteId);
  const from = b.from_id ? await layoutOr404(c.env, String(b.from_id)) : null;
  const home = cleanHome(b.home ?? from?.home ?? {});
  const accent = cleanAccent(b.accent !== undefined ? b.accent : from?.accent ?? null);
  await checkAssets(c.env, home);
  const id = rid('lay');
  const layout = { id, site_id: siteId, name: layoutName(b.name, from ? from.name : 'Home screen'), home, accent };
  await checkConfigSize(c.env, layout);
  const t = now();
  await c.env.DB.prepare('INSERT INTO launcher_layouts (id, site_id, name, config, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)')
    .bind(id, siteId, layout.name, layoutConfigJson(layout), t, t, actorOf(c)).run();
  if (siteId && b.make_default) {
    await c.env.DB.prepare('UPDATE sites SET launcher_layout_id = ? WHERE id = ?').bind(id, siteId).run();
    pushDevices(c, await devicesUsingLayout(c.env, id));
  }
  await audit(c.env, actorOf(c), 'launcher_layout.create', { target_type: 'launcher_layout', target_id: id, site_id: siteId, details: { name: layout.name, from: from?.id ?? null } });
  return c.json((await withUsage(c.env, [await layoutOr404(c.env, id)]))[0], 201);
});

launcherRoutes.put('/launcher/layouts/:id', async (c) => {
  const cur = await layoutOr404(c.env, c.req.param('id'));
  const b = await body(c);
  const home = b.home !== undefined ? cleanHome(b.home) : cur.home;
  const accent = b.accent !== undefined ? cleanAccent(b.accent) : cur.accent;
  const name = b.name !== undefined ? layoutName(b.name, cur.name) : cur.name;
  await checkAssets(c.env, home);
  await checkConfigSize(c.env, { ...cur, home, accent, name });
  await c.env.DB.prepare('UPDATE launcher_layouts SET name = ?, config = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .bind(name, layoutConfigJson({ home, accent }), now(), actorOf(c), cur.id).run();
  const changed = JSON.stringify({ home, accent }) !== JSON.stringify({ home: cur.home, accent: cur.accent });
  if (changed) pushDevices(c, await devicesUsingLayout(c.env, cur.id));
  await audit(c.env, actorOf(c), 'launcher_layout.update', { target_type: 'launcher_layout', target_id: cur.id, site_id: cur.site_id, details: { name, rows: home.rows.length, pushed: changed } });
  return c.json((await withUsage(c.env, [await layoutOr404(c.env, cur.id)]))[0]);
});

launcherRoutes.delete('/launcher/layouts/:id', async (c) => {
  const cur = await layoutOr404(c.env, c.req.param('id'));
  const affected = await devicesUsingLayout(c.env, cur.id);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE sites SET launcher_layout_id = NULL WHERE launcher_layout_id = ?').bind(cur.id),
    c.env.DB.prepare('UPDATE devices SET launcher_layout_id = NULL WHERE launcher_layout_id = ?').bind(cur.id),
    c.env.DB.prepare('DELETE FROM launcher_layouts WHERE id = ?').bind(cur.id),
  ]);
  pushDevices(c, affected);
  await audit(c.env, actorOf(c), 'launcher_layout.delete', { target_type: 'launcher_layout', target_id: cur.id, site_id: cur.site_id, details: { name: cur.name } });
  return c.json({ ok: true });
});

/** Copy a layout to another site (`site_id`) or make a fleet template (`site_id: null`). */
launcherRoutes.post('/launcher/layouts/:id/copy', async (c) => {
  const cur = await layoutOr404(c.env, c.req.param('id'));
  const b = await body(c);
  const siteId: string | null = b.site_id ? String(b.site_id) : null;
  const target = siteId ? await siteRow(c.env, siteId) : null;
  const id = rid('lay');
  const same = siteId === cur.site_id;
  const layout = { id, site_id: siteId, name: layoutName(b.name, same ? `${cur.name} (copy)` : cur.name), home: cur.home, accent: cur.accent };
  await checkConfigSize(c.env, layout);
  const t = now();
  await c.env.DB.prepare('INSERT INTO launcher_layouts (id, site_id, name, config, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)')
    .bind(id, siteId, layout.name, layoutConfigJson(layout), t, t, actorOf(c)).run();
  if (target && b.make_default) {
    await c.env.DB.prepare('UPDATE sites SET launcher_layout_id = ? WHERE id = ?').bind(id, target.id).run();
    pushDevices(c, await devicesUsingLayout(c.env, id));
  }
  await audit(c.env, actorOf(c), 'launcher_layout.copy', { target_type: 'launcher_layout', target_id: id, site_id: siteId, details: { from: cur.id, to_site: siteId ?? 'template' } });
  return c.json((await withUsage(c.env, [await layoutOr404(c.env, id)]))[0], 201);
});

// ---------------------------------------------------------------- images
/** Upload a wallpaper or card picture (multipart `file`): JPEG, PNG or WebP, ≤ 8 MB, stored in R2 by SHA-256. */
launcherRoutes.post('/launcher/assets', async (c) => {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > LAUNCHER_LIMITS.asset_bytes + 64 * 1024) throw new HttpError(413, 'too_large', 'Pictures can be at most 8 MB');
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'bad_request', 'Attach a picture (JPEG, PNG or WebP)');
  const f = file as unknown as File;
  if (f.size > LAUNCHER_LIMITS.asset_bytes) throw new HttpError(413, 'too_large', 'Pictures can be at most 8 MB');
  const buf = new Uint8Array(await f.arrayBuffer());
  if (buf.length > LAUNCHER_LIMITS.asset_bytes) throw new HttpError(413, 'too_large', 'Pictures can be at most 8 MB');
  const img = sniffImage(buf);
  if (!img) throw new HttpError(415, 'not_an_image', 'That file isn’t a JPEG, PNG or WebP picture');
  if (!img.width || !img.height) throw new HttpError(415, 'not_an_image', 'That picture looks damaged (its size can’t be read)');
  if (img.width > LAUNCHER_LIMITS.image_px || img.height > LAUNCHER_LIMITS.image_px) {
    throw new HttpError(400, 'too_large', `Pictures can be at most ${LAUNCHER_LIMITS.image_px} × ${LAUNCHER_LIMITS.image_px} pixels (this one is ${img.width} × ${img.height})`);
  }
  const sha = await sha256Hex(buf);
  const key = assetR2Key(sha, img.ext);
  if (!(await c.env.FILES.head(key))) await c.env.FILES.put(key, buf, { httpMetadata: { contentType: img.content_type }, sha256: sha });
  await c.env.DB.prepare('INSERT OR IGNORE INTO launcher_assets (sha256, ext, content_type, bytes, width, height, r2_key, uploaded_at, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(sha, img.ext, img.content_type, buf.length, img.width, img.height, key, now(), actorOf(c)).run();
  const row = await c.env.DB.prepare('SELECT * FROM launcher_assets WHERE sha256 = ?').bind(sha).first<Row>();
  await audit(c.env, actorOf(c), 'launcher_asset.upload', { target_type: 'launcher_asset', target_id: sha, details: { bytes: buf.length, ext: img.ext, width: img.width, height: img.height } });
  return c.json({ ...toAsset(row!), url: `/api/launcher/assets/${sha}.${row!.ext}` }, 201);
});

launcherRoutes.get('/launcher/assets/:file', async (c) => {
  const m = c.req.param('file').match(ASSET_FILE_RE);
  if (!m) throw new HttpError(404, 'not_found', 'Picture not found');
  const obj = await c.env.FILES.get(assetR2Key(m[1], m[2] as 'jpg'));
  if (!obj) throw new HttpError(404, 'not_found', 'Picture not found');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'Content-Length': String(obj.size),
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
});

// ---------------------------------------------------------------- site & device
/** Which layout the site uses, its layouts + templates, and where every box is up to. */
launcherRoutes.get('/sites/:id/launcher', async (c) => {
  const site = await siteRow(c.env, c.req.param('id'));
  const [layoutRows, devRows, apk] = await Promise.all([
    c.env.DB.prepare('SELECT l.*, s.name site_name FROM launcher_layouts l LEFT JOIN sites s ON s.id = l.site_id WHERE l.site_id = ? OR l.site_id IS NULL ORDER BY l.site_id IS NULL, l.name').bind(site.id).all<Row>(),
    c.env.DB.prepare("SELECT * FROM devices WHERE site_id = ? AND kind = 'android' ORDER BY name").bind(site.id).all<Row>(),
    c.env.DB.prepare('SELECT version_name FROM apks WHERE package = ? ORDER BY coalesce(version_code, 0) DESC, uploaded_at DESC LIMIT 1').bind(LAUNCHER_PACKAGE).first<Row>(),
  ]);
  const layouts = await withUsage(c.env, layoutRows.results.map(toLayout));
  const cache = new Map(layouts.map((l) => [l.id, l as LauncherLayout | null]));
  const devices: LauncherDeviceRollout[] = [];
  for (const d of devRows.results) {
    const st = (parseJson<Record<string, unknown>>(d.facts, {}).launcher ?? null) as LauncherState | null;
    const want = expectedFor(await launcherPayload(c.env, site, d, cache), st);
    devices.push({
      device_id: d.id, name: d.name, room: d.room, status: d.status, override_layout_id: d.launcher_layout_id ?? null, layout_id: effectiveLayoutId(site, d),
      launcher: st, supports_v2: supportsV2(st), expected_v: want.v, expected_sha: want.sha, in_sync: !!st?.installed && st.config_sha === want.sha,
    });
  }
  const out: LauncherSiteState = { site_id: site.id, layout_id: site.launcher_layout_id ?? null, layouts, devices, latest_version: apk?.version_name ?? null };
  return c.json(out);
});

async function usableLayout(env: Env, siteId: string, layoutId: unknown): Promise<string | null> {
  if (layoutId === null || layoutId === undefined || layoutId === '') return null;
  const l = await layoutOr404(env, String(layoutId));
  if (l.site_id && l.site_id !== siteId) throw new HttpError(400, 'bad_request', 'That layout belongs to another site. Copy it to this site first.');
  return l.id;
}

/** Set the site's default layout (`layout_id: null` = back to the classic grid). Pushes to boxes without an override. */
launcherRoutes.put('/sites/:id/launcher', async (c) => {
  const site = await siteRow(c.env, c.req.param('id'));
  const b = await body(c);
  const layoutId = await usableLayout(c.env, site.id, b.layout_id);
  await c.env.DB.prepare('UPDATE sites SET launcher_layout_id = ? WHERE id = ?').bind(layoutId, site.id).run();
  if ((site.launcher_layout_id ?? null) !== layoutId) {
    const devs = (await c.env.DB.prepare("SELECT id, site_id FROM devices WHERE site_id = ? AND kind = 'android' AND launcher_layout_id IS NULL").bind(site.id).all<{ id: string; site_id: string }>()).results;
    pushDevices(c, devs);
  }
  await audit(c.env, actorOf(c), 'launcher.site_layout', { target_type: 'site', target_id: site.id, site_id: site.id, details: { layout_id: layoutId } });
  return c.json({ ok: true, layout_id: layoutId });
});

/** Push now: send the current config (and missing images) to these boxes, or every box with the launcher. Waits for the result. */
launcherRoutes.post('/sites/:id/launcher/push', async (c) => {
  const site = await siteRow(c.env, c.req.param('id'));
  const b = await body(c);
  const ids = Array.isArray(b.device_ids) ? b.device_ids.map(String).slice(0, 200) : undefined;
  const results = await hub<{ device_id: string; ok: boolean; detail?: string }[]>(c.env, site.id, originOf(c.req.raw, c.env), 'pushLauncherConfig', ids, actorOf(c));
  return c.json({ results });
});

/** "Use a different layout on this box" (`layout_id: null` = follow the site). */
launcherRoutes.put('/devices/:id/launcher', async (c) => {
  const d = await c.env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(c.req.param('id')).first<Row>();
  if (!d) throw new HttpError(404, 'not_found', 'Device not found');
  if (d.kind !== 'android') throw new HttpError(400, 'not_supported', 'Only Android TV boxes run the Screens Launcher');
  const b = await body(c);
  const layoutId = await usableLayout(c.env, d.site_id, b.layout_id);
  await c.env.DB.prepare('UPDATE devices SET launcher_layout_id = ?, updated_at = ? WHERE id = ?').bind(layoutId, now(), d.id).run();
  if ((d.launcher_layout_id ?? null) !== layoutId) pushDevices(c, [{ id: d.id, site_id: d.site_id }]);
  await audit(c.env, actorOf(c), 'launcher.device_layout', { target_type: 'device', target_id: d.id, site_id: d.site_id, details: { layout_id: layoutId } });
  return c.json({ ok: true, layout_id: layoutId });
});

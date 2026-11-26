// Mock of the Screens Launcher v2 API (layouts, pictures, rollout) for demo mode.

import { ApiError, registerMockAsset } from '../api';
import {
  ACCENT_RE, compareVersions, defaultHome, homeAssets, launcherConfigJson, layoutName, sniffImage, supportsV2, validateHome,
  type AssetExt, type LauncherHome, type LauncherLayout, type LauncherSiteState,
} from '../../shared/launcher';
import type { Device, DeviceApp, LauncherState, SiteSettings } from '../../shared/types';
import { NOW, H, M, D } from './data';

type Ctx = { params: string[]; q: URLSearchParams; body: unknown };
type On = (method: string, pattern: string, h: (c: Ctx) => unknown | Promise<unknown>) => void;
interface Db { sites: { id: string; name: string; settings: SiteSettings }[]; devices: Device[]; apps: Record<string, DeviceApp[]> }

export const MOCK_LAUNCHER_LATEST = '2.0.0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const err = (status: number, code: string, message: string) => new ApiError(status, code, message);

// ---------------------------------------------------------------------------
// Demo wallpaper: a dusk landscape drawn as SVG (stands in for an uploaded 1920 × 1080 JPEG).

const WALLPAPER_SHA = '5ca1ab1e'.repeat(8);
const WALLPAPER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
<defs>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14203d"/><stop offset=".38" stop-color="#3f4a7e"/><stop offset=".62" stop-color="#b9789a"/><stop offset=".76" stop-color="#f2a37c"/><stop offset=".84" stop-color="#fbd08e"/></linearGradient>
<radialGradient id="g" cx=".7" cy=".7" r=".32"><stop offset="0" stop-color="#fff3d1" stop-opacity=".95"/><stop offset=".2" stop-color="#ffd18f" stop-opacity=".55"/><stop offset="1" stop-color="#ffb37a" stop-opacity="0"/></radialGradient>
<linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3a184"/><stop offset=".35" stop-color="#7c6a91"/><stop offset="1" stop-color="#151a2c"/></linearGradient>
<linearGradient id="m1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7d6c99"/><stop offset="1" stop-color="#5a5482"/></linearGradient>
<linearGradient id="m2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a4674"/><stop offset="1" stop-color="#34335e"/></linearGradient>
</defs>
<rect width="1920" height="1080" fill="url(#s)"/>
<g fill="#fff" opacity=".7"><circle cx="210" cy="120" r="1.6"/><circle cx="460" cy="70" r="1.2"/><circle cx="760" cy="150" r="1.4"/><circle cx="980" cy="60" r="1"/><circle cx="1210" cy="110" r="1.3"/><circle cx="1500" cy="50" r="1.1"/><circle cx="1720" cy="140" r="1.5"/><circle cx="330" cy="230" r="1"/><circle cx="620" cy="260" r="1.1"/></g>
<rect width="1920" height="1080" fill="url(#g)"/>
<circle cx="1344" cy="752" r="58" fill="#fff1cf" opacity=".9"/>
<path d="M0 660 L150 560 L260 600 L420 470 L560 560 L700 500 L860 590 L1010 455 L1150 545 L1280 500 L1440 600 L1600 490 L1760 580 L1920 520 L1920 800 L0 800Z" fill="url(#m1)" opacity=".85"/>
<path d="M0 720 L120 650 L280 700 L430 610 L600 700 L760 640 L930 715 L1100 640 L1260 720 L1430 660 L1610 725 L1780 665 L1920 710 L1920 810 L0 810Z" fill="url(#m2)"/>
<path d="M0 790 L160 760 L330 790 L520 750 L700 795 L900 765 L1100 800 L1320 770 L1520 805 L1720 772 L1920 800 L1920 830 L0 830Z" fill="#232447"/>
<rect y="812" width="1920" height="268" fill="url(#w)"/>
<g stroke="#ffe7bd" stroke-linecap="round" opacity=".55"><path d="M1240 842 H1450" stroke-width="4"/><path d="M1270 866 H1420" stroke-width="3"/><path d="M1300 892 H1390" stroke-width="2.5"/><path d="M1318 920 H1372" stroke-width="2"/></g>
<g fill="#121428"><path d="M0 1080 V860 L40 790 L80 860 L95 820 L130 880 L150 800 L190 880 L210 840 L250 900 L250 1080Z"/><path d="M1680 1080 V900 L1720 830 L1750 880 L1790 790 L1830 880 L1850 845 L1890 910 L1920 870 V1080Z"/></g>
</svg>`;
const WALLPAPER_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(WALLPAPER_SVG)}`;

const assets = new Map<string, { ext: AssetExt; bytes: number; width: number; height: number }>([[WALLPAPER_SHA, { ext: 'jpg', bytes: 412_337, width: 1920, height: 1080 }]]);
registerMockAsset(WALLPAPER_SHA, WALLPAPER_URL);

// ---------------------------------------------------------------------------
// Demo layouts

function livingRoom(): LauncherHome {
  return {
    wallpaper: { asset: WALLPAPER_SHA, ext: 'jpg', dim: 0.15 },
    top_bar: { clock: true, clock_24h: false, date: false, network: true, settings: true },
    rows: [
      { id: 'featured', title: 'InterNik', icon: 'bookmark', card: 'banner', size: 'large', apps: ['org.jellyfin.androidtv'] },
      { id: 'media', title: 'Media', icon: 'media', card: 'banner', size: 'medium', apps: ['au.com.kayo.ott', 'com.netflix.ninja', 'com.plexapp.android', 'com.amazon.amazonvideo.livingroom', 'com.google.android.youtube.tv'] },
    ],
    all_apps: { enabled: true, title: 'All apps' },
    hidden: ['com.android.vending', 'com.spocky.projengmenu'],
    tiles: {},
    focus: { scale: 1.12, label: 'focused' },
  };
}

function beachLounge(): LauncherHome {
  return {
    ...defaultHome(),
    rows: [
      { id: 'watch', title: 'Watch', icon: 'tv', card: 'banner', size: 'large', apps: ['com.netflix.ninja', 'au.com.stan.and', 'com.disney.disneyplus', 'com.amazon.amazonvideo.livingroom', 'com.google.android.youtube.tv', 'au.net.abc.iview'] },
      { id: 'music', title: 'Music', icon: 'music', card: 'icon', size: 'medium', apps: ['com.spotify.tv.android'] },
    ],
    all_apps: { enabled: false, title: 'All apps' },
    hidden: ['com.android.vending', 'com.mxtech.videoplayer.ad'],
    top_bar: { clock: true, clock_24h: false, date: true, network: true, settings: true },
  };
}

const layouts: LauncherLayout[] = [
  { id: 'lay_home', site_id: 's_home', name: 'Living room', home: livingRoom(), accent: null, created_at: NOW - 6 * D, updated_at: NOW - 2 * H },
  { id: 'lay_home_kids', site_id: 's_home', name: 'Kids’ room', home: { ...defaultHome(), rows: [{ id: 'kids', title: 'Kids', icon: 'kids', card: 'poster', size: 'medium', apps: ['com.disney.disneyplus', 'au.net.abc.iview', 'com.google.android.youtube.tv'] }], all_apps: { enabled: false, title: 'All apps' } }, accent: '#F2A600', created_at: NOW - 4 * D, updated_at: NOW - 4 * D },
  { id: 'lay_beach', site_id: 's_beach', name: 'Guest lounge', home: beachLounge(), accent: '#00897B', created_at: NOW - 3 * D, updated_at: NOW - 1 * D },
  { id: 'lay_tpl_projectivy', site_id: null, name: 'Projectivy classic', home: { ...livingRoom(), rows: [{ ...livingRoom().rows[0], title: 'Featured' }, livingRoom().rows[1]] }, accent: null, created_at: NOW - 9 * D, updated_at: NOW - 9 * D },
];
const siteDefault = new Map<string, string | null>([['s_home', 'lay_home'], ['s_beach', 'lay_beach']]);
const deviceOverride = new Map<string, string | null>();

function demoApp(pkg: string, label: string, category: string, version: string): DeviceApp {
  return { package: pkg, label, version_name: version, version_code: null, system: false, enabled: true, permissions: [], category, risk: null, first_seen: NOW - 20 * D, last_seen: NOW - 5 * M, icon: null, app_id: null };
}

// ---------------------------------------------------------------------------
// Hashing (WebCrypto when available, so the demo SHAs look and behave like the real ones)

async function sha256(s: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let out = '';
    for (let k = 0; k < 8; k++) {
      let h = 2166136261 ^ k;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
      out += (h >>> 0).toString(16).padStart(8, '0');
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

export function launcherMock(on: On, db: Db) {
  // Demo state: the Home shield runs launcher 2 with the Living room layout; Beach House boxes are still on 1.x.
  const shield = db.devices.find((d) => d.id === 'dev_lr_shield');
  const lrApps = db.apps.dev_lr_shield;
  if (lrApps && !lrApps.some((a) => a.package === 'org.jellyfin.androidtv')) {
    lrApps.push(demoApp('org.jellyfin.androidtv', 'Jellyfin', 'streaming', '0.17.4'), demoApp('au.com.kayo.ott', 'Kayo', 'streaming', '3.12.0'));
  }
  if (shield) {
    shield.facts.launcher = {
      installed: true, version: MOCK_LAUNCHER_LATEST, version_code: 20000, config_v: 2, config_sha: null, is_home: true, assets: [WALLPAPER_SHA], missing_assets: [],
      last_error: null, checked_at: NOW - 4 * M, pushed_at: NOW - 2 * H, pushed_v: 2, push_error: null, layout_id: 'lay_home', assets_pushed: 1,
    } satisfies LauncherState;
  }
  let seeded: Promise<void> | null = null;
  const seed = () => (seeded ??= (async () => { if (shield) await apply(shield, true); })());

  const findSite = (id: string) => {
    const s = db.sites.find((x) => x.id === id);
    if (!s) throw err(404, 'not_found', 'Site not found');
    return s;
  };
  const findLayout = (id: string) => {
    const l = layouts.find((x) => x.id === id);
    if (!l) throw err(404, 'not_found', 'Home screen layout not found');
    return l;
  };
  const withUsage = (l: LauncherLayout): LauncherLayout => ({
    ...l,
    site_name: l.site_id ? db.sites.find((s) => s.id === l.site_id)?.name ?? null : null,
    used_by: { sites: [...siteDefault].filter(([, v]) => v === l.id).map(([k]) => k), devices: [...deviceOverride].filter(([, v]) => v === l.id).map(([k]) => k) },
  });
  const effective = (d: Device) => deviceOverride.get(d.id) ?? siteDefault.get(d.site_id) ?? null;

  async function payload(d: Device) {
    const site = findSite(d.site_id);
    const layout = layouts.find((l) => l.id === effective(d)) ?? null;
    const input = { site_name: site.name, guest: site.settings.guest, pin_sha256: site.settings.guest.kiosk.pin_set ? 'f'.repeat(64) : null, layout };
    const v1 = launcherConfigJson(input, 1);
    const v2 = layout ? launcherConfigJson(input, 2) : null;
    return { layout, sha_v1: await sha256(v1), sha_v2: v2 ? await sha256(v2) : null };
  }

  /** What a successful push does on the box. */
  async function apply(d: Device, quiet = false) {
    const st = { ...((d.facts.launcher ?? { installed: false }) as LauncherState) };
    if (!st.installed) return st;
    const p = await payload(d);
    const v2 = supportsV2(st) && !!p.sha_v2;
    const want = v2 ? homeAssets(p.layout!.home).map((a) => a.sha256) : [];
    const before = new Set(st.assets ?? []);
    const added = want.filter((s) => !before.has(s));
    Object.assign(st, {
      config_sha: v2 ? p.sha_v2 : p.sha_v1, config_v: v2 ? 2 : 1, pushed_sha: v2 ? p.sha_v2 : p.sha_v1, pushed_v: v2 ? 2 : 1, push_error: null,
      layout_id: v2 ? p.layout!.id : null, checked_at: Date.now(),
      ...(quiet ? {} : { pushed_at: Date.now(), assets_pushed: added.length }),
      ...(supportsV2(st) ? { assets: [...new Set([...before, ...want])], missing_assets: [] } : {}),
    } satisfies Partial<LauncherState>);
    d.facts.launcher = st;
    return st;
  }

  /** Saving pushes in the background, like the hub: online boxes update a moment later. */
  function pushSoon(ids: string[]) {
    setTimeout(() => {
      for (const id of ids) {
        const d = db.devices.find((x) => x.id === id);
        if (d && (d.status === 'online' || d.status === 'standby') && (d.facts.launcher as LauncherState | undefined)?.installed) void apply(d);
      }
    }, 1200);
  }
  const usersOf = (layoutId: string) => db.devices.filter((d) => d.kind === 'android' && effective(d) === layoutId).map((d) => d.id);

  const clean = (b: { home?: unknown; accent?: unknown }, fallback?: LauncherLayout) => {
    const v = validateHome(b.home ?? fallback?.home ?? {});
    if (!v.ok) throw err(400, 'bad_layout', v.errors.slice(0, 4).join('. '));
    for (const a of homeAssets(v.home)) if (!assets.has(a.sha256)) throw err(400, 'bad_layout', `Image ${a.sha256.slice(0, 12)}… hasn't been uploaded. Upload it again.`);
    const accent = b.accent === undefined ? fallback?.accent ?? null : b.accent === null || b.accent === '' ? null : String(b.accent);
    if (accent !== null && !ACCENT_RE.test(accent)) throw err(400, 'bad_layout', 'Accent colour must look like #4F8EF7');
    return { home: v.home, accent };
  };

  on('GET', '/api/launcher/layouts', (c) => {
    const sid = c.q.get('site_id');
    const tpl = c.q.get('templates') === '1';
    return layouts.filter((l) => (tpl ? !l.site_id : !sid || !l.site_id || l.site_id === sid)).map(withUsage);
  });
  on('GET', '/api/launcher/layouts/:id', (c) => withUsage(findLayout(c.params[0])));
  on('POST', '/api/launcher/layouts', (c) => {
    const b = (c.body ?? {}) as { site_id?: string | null; name?: string; home?: unknown; accent?: string | null; from_id?: string; make_default?: boolean };
    if (b.site_id) findSite(b.site_id);
    const from = b.from_id ? findLayout(b.from_id) : undefined;
    const { home, accent } = clean(b, from);
    const l: LauncherLayout = { id: `lay_${Math.random().toString(36).slice(2, 10)}`, site_id: b.site_id ?? null, name: layoutName(b.name, from?.name ?? 'Home screen'), home, accent, created_at: Date.now(), updated_at: Date.now() };
    layouts.push(l);
    if (b.site_id && b.make_default) { siteDefault.set(b.site_id, l.id); pushSoon(usersOf(l.id)); }
    return withUsage(l);
  });
  on('PUT', '/api/launcher/layouts/:id', (c) => {
    const l = findLayout(c.params[0]);
    const b = (c.body ?? {}) as { name?: string; home?: unknown; accent?: string | null };
    const { home, accent } = clean(b, l);
    const changed = JSON.stringify({ home, accent }) !== JSON.stringify({ home: l.home, accent: l.accent });
    Object.assign(l, { home, accent, name: b.name !== undefined ? layoutName(b.name, l.name) : l.name, updated_at: Date.now() });
    if (changed) pushSoon(usersOf(l.id));
    return withUsage(l);
  });
  on('DELETE', '/api/launcher/layouts/:id', (c) => {
    const l = findLayout(c.params[0]);
    const affected = usersOf(l.id);
    for (const [k, v] of siteDefault) if (v === l.id) siteDefault.set(k, null);
    for (const [k, v] of deviceOverride) if (v === l.id) deviceOverride.delete(k);
    layouts.splice(layouts.indexOf(l), 1);
    pushSoon(affected);
    return { ok: true };
  });
  on('POST', '/api/launcher/layouts/:id/copy', (c) => {
    const l = findLayout(c.params[0]);
    const b = (c.body ?? {}) as { site_id?: string | null; name?: string; make_default?: boolean };
    if (b.site_id) findSite(b.site_id);
    const same = (b.site_id ?? null) === l.site_id;
    const copy: LauncherLayout = { ...structuredClone(l), id: `lay_${Math.random().toString(36).slice(2, 10)}`, site_id: b.site_id ?? null, name: layoutName(b.name, same ? `${l.name} (copy)` : l.name), created_at: Date.now(), updated_at: Date.now() };
    layouts.push(copy);
    if (b.site_id && b.make_default) { siteDefault.set(b.site_id, copy.id); pushSoon(usersOf(copy.id)); }
    return withUsage(copy);
  });

  on('POST', '/api/launcher/assets', async (c) => {
    const file = c.body instanceof FormData ? c.body.get('file') : null;
    if (!file || typeof file === 'string') throw err(400, 'bad_request', 'Attach a picture (JPEG, PNG or WebP)');
    if (file.size > 8 * 1024 * 1024) throw err(413, 'too_large', 'Pictures can be at most 8 MB');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const img = sniffImage(bytes);
    if (!img || !img.width || !img.height) throw err(415, 'not_an_image', 'That file isn’t a JPEG, PNG or WebP picture');
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const sha = await sha256(bin);
    assets.set(sha, { ext: img.ext, bytes: bytes.length, width: img.width, height: img.height });
    registerMockAsset(sha, URL.createObjectURL(new Blob([bytes], { type: img.content_type })));
    await sleep(300);
    return { sha256: sha, ext: img.ext, content_type: img.content_type, bytes: bytes.length, width: img.width, height: img.height, uploaded_at: Date.now(), url: '' };
  });

  on('GET', '/api/sites/:id/launcher', async (c) => {
    await seed();
    const site = findSite(c.params[0]);
    const devices = [];
    for (const d of db.devices.filter((x) => x.site_id === site.id && x.kind === 'android')) {
      const st = (d.facts.launcher ?? null) as LauncherState | null;
      const p = await payload(d);
      const v2 = supportsV2(st) && !!p.sha_v2;
      const sha = (v2 ? p.sha_v2 : p.sha_v1)!;
      devices.push({
        device_id: d.id, name: d.name, room: d.room, status: d.status, override_layout_id: deviceOverride.get(d.id) ?? null, layout_id: effective(d),
        launcher: st, supports_v2: supportsV2(st), expected_v: (v2 ? 2 : 1) as 1 | 2, expected_sha: sha, in_sync: !!st?.installed && st.config_sha === sha,
      });
    }
    const out: LauncherSiteState = {
      site_id: site.id, layout_id: siteDefault.get(site.id) ?? null,
      layouts: layouts.filter((l) => !l.site_id || l.site_id === site.id).sort((a, b) => Number(!a.site_id) - Number(!b.site_id) || a.name.localeCompare(b.name)).map(withUsage),
      devices, latest_version: MOCK_LAUNCHER_LATEST,
    };
    return out;
  });
  on('PUT', '/api/sites/:id/launcher', (c) => {
    const site = findSite(c.params[0]);
    const id = ((c.body ?? {}) as { layout_id?: string | null }).layout_id ?? null;
    if (id) {
      const l = findLayout(id);
      if (l.site_id && l.site_id !== site.id) throw err(400, 'bad_request', 'That layout belongs to another site. Copy it to this site first.');
    }
    siteDefault.set(site.id, id);
    pushSoon(db.devices.filter((d) => d.site_id === site.id && d.kind === 'android' && !deviceOverride.get(d.id)).map((d) => d.id));
    return { ok: true, layout_id: id };
  });
  on('POST', '/api/sites/:id/launcher/push', async (c) => {
    const site = findSite(c.params[0]);
    const ids = ((c.body ?? {}) as { device_ids?: string[] }).device_ids;
    await sleep(900);
    const results = [];
    for (const d of db.devices.filter((x) => x.site_id === site.id && x.kind === 'android' && (!ids || ids.includes(x.id)))) {
      if (!(d.facts.launcher as LauncherState | undefined)?.installed || !(d.status === 'online' || d.status === 'standby')) continue;
      await apply(d);
      results.push({ device_id: d.id, ok: true });
    }
    return { results };
  });
  on('PUT', '/api/devices/:id/launcher', (c) => {
    const d = db.devices.find((x) => x.id === c.params[0]);
    if (!d) throw err(404, 'not_found', 'Device not found');
    if (d.kind !== 'android') throw err(400, 'not_supported', 'Only Android TV boxes run the Screens Launcher');
    const id = ((c.body ?? {}) as { layout_id?: string | null }).layout_id ?? null;
    if (id) {
      const l = findLayout(id);
      if (l.site_id && l.site_id !== d.site_id) throw err(400, 'bad_request', 'That layout belongs to another site. Copy it to this site first.');
    }
    if (id) deviceOverride.set(d.id, id);
    else deviceOverride.delete(d.id);
    pushSoon([d.id]);
    return { ok: true, layout_id: id };
  });

  return {
    /** launcher_install / launcher_config / launcher_home on a mock box. */
    async command(d: Device, cmd: string): Promise<LauncherState> {
      const cur = (d.facts.launcher ?? { installed: false }) as LauncherState;
      if (cmd === 'launcher_install') {
        const fresh = !cur.installed || compareVersions(cur.version, MOCK_LAUNCHER_LATEST) < 0;
        d.facts.launcher = { ...cur, installed: true, version: MOCK_LAUNCHER_LATEST, version_code: 20000, is_home: true, ...(fresh ? { assets: cur.assets ?? [], missing_assets: [], last_error: null } : {}), checked_at: Date.now() };
        return apply(d);
      }
      if (cmd === 'launcher_home') {
        if (!cur.installed) throw err(409, 'launcher_missing', `The Screens Launcher isn’t installed on ${d.name}. Install it first.`);
        d.facts.launcher = { ...cur, is_home: true, checked_at: Date.now() };
        return d.facts.launcher as LauncherState;
      }
      return apply(d);
    },
  };
}

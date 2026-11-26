import { describe, expect, it } from 'vitest';
import {
  buildLauncherConfig, compareVersions, defaultHome, homeAssets, launcherConfigJson, launcherMajor, newRowId, sniffImage, supportsV2, validateHome,
  type LauncherHome,
} from '../src/shared/launcher';
import type { GuestSettings } from '../src/shared/types';
import { applyLauncherConfig, parseAssetRows, parseBroadcast, statusFields } from '../src/worker/adapters/launcher';
import { expectedFor, type LauncherPayload } from '../src/worker/lib/launcher';
import { b64Encode, sha256Hex } from '../src/worker/lib/crypto';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

/** The operator's Projectivy screen (contract §2 example). */
function projectivy(): LauncherHome {
  return {
    wallpaper: { asset: SHA_A, ext: 'jpg', dim: 0.25 },
    top_bar: { clock: true, clock_24h: false, date: false, network: true, settings: true },
    rows: [
      { id: 'featured', title: 'InterNik', icon: 'bookmark', card: 'banner', size: 'large', apps: ['org.jellyfin.androidtv'] },
      { id: 'media', title: 'Media', icon: 'media', card: 'banner', size: 'medium', apps: ['au.com.kayo.ott', 'com.netflix.ninja', 'com.plexapp.android', 'com.amazon.amazonvideo.livingroom', 'com.google.android.youtube.tv'] },
    ],
    all_apps: { enabled: true, title: 'All apps' },
    hidden: ['com.android.vending'],
    tiles: { 'com.plexapp.android': { label: 'Plex', asset: SHA_B, ext: 'png' } },
    focus: { scale: 1.12, label: 'focused' },
  };
}

const guest: GuestSettings = {
  clear_packages: [], go_home: true, reboot: false, show_welcome_after_reset: true,
  welcome: { enabled: true, show_on_boot: true, title: '', message: 'Enjoy', wifi: { ssid: 'Guest', password: 'pw', security: 'WPA' }, sections: [{ title: 'Checkout', body: '10am' }], contact: 'Nik', accent: '#4F8EF7' },
  kiosk: { enabled: true, allowed: ['com.netflix.ninja'], pinned: ['com.netflix.ninja'], force_home: false },
};

describe('layout validation (contract §2)', () => {
  it('accepts the contract example unchanged', () => {
    const v = validateHome(projectivy());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.home).toEqual(projectivy());
  });

  it('fills missing sections with defaults', () => {
    const v = validateHome({ rows: [{ id: 'a', icon: 'none', card: 'icon', size: 'small' }] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.home.rows[0]).toEqual({ id: 'a', title: '', icon: 'none', card: 'icon', size: 'small', apps: [] });
    expect(v.home.top_bar).toEqual(defaultHome().top_bar);
    expect(v.home.wallpaper).toBeNull();
  });

  const bad = (patch: (h: any) => void) => {
    const h: any = structuredClone(projectivy());
    patch(h);
    const v = validateHome(h);
    expect(v.ok).toBe(false);
    return v.ok ? [] : v.errors;
  };

  it('enforces row limits, ids and enums', () => {
    expect(bad((h) => { h.rows = []; })[0]).toMatch(/at least one row/);
    expect(bad((h) => { h.rows = Array.from({ length: 13 }, (_, i) => ({ ...h.rows[1], id: `r${i}` })); }).join()).toMatch(/At most 12 rows/);
    expect(bad((h) => { h.rows[0].id = 'Has Space'; })[0]).toMatch(/id must be/);
    expect(bad((h) => { h.rows[0].id = 'x'.repeat(33); })[0]).toMatch(/id must be/);
    expect(bad((h) => { h.rows[1].id = 'featured'; })[0]).toMatch(/used twice/);
    expect(bad((h) => { h.rows[0].title = 'x'.repeat(41); })[0]).toMatch(/at most 40 characters/);
    expect(bad((h) => { h.rows[0].icon = 'rocket'; })[0]).toMatch(/unknown icon/);
    expect(bad((h) => { h.rows[0].card = 'tile'; })[0]).toMatch(/banner, icon or poster/);
    expect(bad((h) => { h.rows[0].size = 'xl'; })[0]).toMatch(/small, medium or large/);
  });

  it('checks packages and the 40-apps-per-row cap, dropping duplicates', () => {
    expect(bad((h) => { h.rows[0].apps = ['com.ok.app', 'bad pkg']; })[0]).toMatch(/not an Android package/);
    expect(bad((h) => { h.rows[0].apps = Array.from({ length: 41 }, (_, i) => `com.app.n${i}`); })[0]).toMatch(/at most 40 apps/);
    expect(bad((h) => { h.hidden = ['1bad']; })[0]).toMatch(/Hidden apps/);
    const v = validateHome({ ...projectivy(), rows: [{ ...projectivy().rows[0], apps: ['com.a.b', 'com.a.b', 'com.c.d'] }] });
    expect(v.ok && v.home.rows[0].apps).toEqual(['com.a.b', 'com.c.d']);
  });

  it('checks wallpaper, tiles and focus ranges', () => {
    expect(bad((h) => { h.wallpaper.dim = 0.81; })[0]).toMatch(/darkening/);
    expect(bad((h) => { h.wallpaper.ext = 'gif'; })[0]).toMatch(/jpg, png or webp/);
    expect(bad((h) => { h.wallpaper.asset = 'A'.repeat(64); })[0]).toMatch(/SHA-256/);
    expect(bad((h) => { h.tiles['com.plexapp.android'].ext = undefined; })[0]).toMatch(/jpg, png or webp/);
    expect(bad((h) => { h.tiles['com.plexapp.android'].label = 'x'.repeat(41); })[0]).toMatch(/at most 40/);
    expect(bad((h) => { h.tiles['not a pkg'] = { label: 'x' }; })[0]).toMatch(/not an Android package/);
    expect(bad((h) => { h.focus.scale = 1.3; })[0]).toMatch(/between 1 and 1.25/);
    expect(bad((h) => { h.focus.scale = 0.9; })[0]).toMatch(/between 1 and 1.25/);
    expect(bad((h) => { h.focus.label = 'sometimes'; })[0]).toMatch(/always, focused or never/);
    expect(bad((h) => { h.top_bar.clock = 'yes'; })[0]).toMatch(/on or off/);
    // empty overrides are dropped, not stored
    const v = validateHome({ ...projectivy(), tiles: { 'com.a.b': { label: '' } } });
    expect(v.ok && v.home.tiles).toEqual({});
  });

  it('rejects layouts over 48 KB', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: 'x', icon: 'none', card: 'banner', size: 'small', apps: Array.from({ length: 40 }, (_, k) => `com.${'p'.repeat(100)}.app${k}`) }));
    const errs = bad((h) => { h.rows = rows; });
    expect(errs.join()).toMatch(/too big for the box/);
  });

  it('lists referenced assets once, wallpaper first', () => {
    const h = projectivy();
    h.tiles['com.netflix.ninja'] = { asset: SHA_A, ext: 'jpg' };
    expect(homeAssets(h)).toEqual([{ sha256: SHA_A, ext: 'jpg' }, { sha256: SHA_B, ext: 'png' }]);
    expect(homeAssets(null)).toEqual([]);
  });

  it('makes unique row ids', () => {
    expect(newRowId('Media', [])).toBe('media');
    expect(newRowId('Media', ['media', 'media-2'])).toBe('media-3');
    expect(newRowId('✨', [])).toBe('row');
  });
});

describe('config building', () => {
  const input = { site_name: 'Theatre', guest, pin_sha256: 'f'.repeat(64) };

  it('keeps the v1 shape and key order byte for byte', () => {
    const v1 = launcherConfigJson(input, 1);
    // Same JSON the v1 hub produced, so existing boxes aren't re-pushed after the upgrade.
    const legacy = JSON.stringify({
      v: 1, site_name: 'Theatre', accent: '#4F8EF7',
      kiosk: { enabled: true, allowed: ['com.netflix.ninja'], pin_sha256: 'f'.repeat(64) },
      pinned: ['com.netflix.ninja'],
      welcome: { enabled: true, show_on_boot: true, title: 'Welcome to Theatre', message: 'Enjoy', wifi: { ssid: 'Guest', password: 'pw', security: 'WPA' }, sections: [{ title: 'Checkout', body: '10am' }], contact: 'Nik' },
    });
    expect(v1).toBe(legacy);
    // v2 requested without a layout stays v1 (the 1.0 app rejects "v": 2)
    expect(launcherConfigJson({ ...input, layout: null }, 2)).toBe(legacy);
  });

  it('builds v2 with home in contract order, merged with kiosk/pinned/welcome', () => {
    const cfg = buildLauncherConfig({ ...input, layout: { home: projectivy(), accent: '#FF8800' } }, 2) as any;
    expect(Object.keys(cfg)).toEqual(['v', 'site_name', 'accent', 'home', 'kiosk', 'pinned', 'welcome']);
    expect(cfg.v).toBe(2);
    expect(cfg.accent).toBe('#FF8800');
    expect(Object.keys(cfg.home)).toEqual(['wallpaper', 'top_bar', 'rows', 'all_apps', 'hidden', 'tiles', 'focus']);
    expect(cfg.home.rows[1].apps).toHaveLength(5);
    expect(cfg.home.tiles['com.plexapp.android']).toEqual({ label: 'Plex', asset: SHA_B, ext: 'png' });
    expect(cfg.kiosk.allowed).toEqual(['com.netflix.ninja']);
    // v1 boxes still get the welcome accent and no home
    const v1 = buildLauncherConfig({ ...input, layout: { home: projectivy(), accent: '#FF8800' } }, 1) as any;
    expect(v1.home).toBeUndefined();
    expect(v1.accent).toBe('#4F8EF7');
  });

  it('picks the config version per box', () => {
    const p = { sha_v1: '1'.repeat(64), sha_v2: '2'.repeat(64) } as LauncherPayload;
    expect(expectedFor(p, { installed: true, version: '1.0.0' })).toEqual({ v: 1, sha: p.sha_v1 });
    expect(expectedFor(p, { installed: true, version: '2.0.0', version_code: 20000 })).toEqual({ v: 2, sha: p.sha_v2 });
    expect(expectedFor({ ...p, sha_v2: null }, { installed: true, version: '2.1.0' })).toEqual({ v: 1, sha: p.sha_v1 });
  });

  it('reads versions', () => {
    expect(launcherMajor('2.0.0')).toBe(2);
    expect(launcherMajor(null)).toBe(0);
    expect(supportsV2({ installed: true, version: '1.0.0' })).toBe(false);
    expect(supportsV2({ installed: true, version: '1.9', version_code: 20001 })).toBe(true);
    expect(supportsV2({ installed: false, version: '2.0.0' })).toBe(false);
    expect(compareVersions('2.0.10', '2.0.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('image sniffing', () => {
  it('reads JPEG, PNG and WebP sizes from magic bytes', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(jpeg)).toEqual({ ext: 'jpg', content_type: 'image/jpeg', width: 1920, height: 1080 });
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 128, 0, 0, 1, 104]);
    expect(sniffImage(png)).toEqual({ ext: 'png', content_type: 'image/png', width: 640, height: 360 });
    const webp = new Uint8Array(32);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
    webp.set([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00], 24); // 1920 × 1080 (stored minus one)
    expect(sniffImage(webp)).toEqual({ ext: 'webp', content_type: 'image/webp', width: 1920, height: 1080 });
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull(); // GIF
  });
});

describe('launcher adb parsing', () => {
  it('parses provider rows and v2 STATUS', () => {
    expect(parseAssetRows(`Row: 0 sha256=${SHA_A}, bytes=1234\nRow: 1 sha256=${SHA_B.toUpperCase()}, bytes=9\n`)).toEqual([{ sha256: SHA_A, bytes: 1234 }, { sha256: SHA_B, bytes: 9 }]);
    expect(parseAssetRows('No result found.\n')).toEqual([]);
    const b = parseBroadcast(`Broadcast completed: result=1, data="status:{\\"version\\":\\"2.0.0\\",\\"version_code\\":20000,\\"config_sha\\":\\"abc\\",\\"config_v\\":2,\\"is_home\\":true,\\"assets\\":[\\"${SHA_A}\\"],\\"missing_assets\\":[\\"${SHA_B}\\"],\\"last_error\\":null}"`);
    expect(statusFields(JSON.parse(b.data!.slice(7)))).toEqual({ version: '2.0.0', version_code: 20000, config_sha: 'abc', config_v: 2, is_home: true, assets: [SHA_A], missing_assets: [SHA_B], last_error: null });
    expect(statusFields({ version: '1.0.0', config_sha: null, is_home: false })).toEqual({ version: '1.0.0', config_sha: null, is_home: false });
  });
});

// ---------------------------------------------------------------------------
// Push pipeline against a fake gateway + launcher app

function fakeBox(version: '1.0.0' | '2.0.0', stored: string[] = []) {
  const calls: { op: string; args: any }[] = [];
  const tmp = new Map<string, string>(); // path → sha pushed by the gateway
  const assets = new Set(stored);
  let configSha: string | null = null;
  let lastCfg: any = null;
  const device: any = { id: 'dev_1', ip: '10.0.0.5', port: 5555, facts: JSON.stringify({ launcher: { installed: true, version, pushed_at: 1 } }) };
  const esc = (o: unknown) => JSON.stringify(o).replace(/"/g, '\\"');
  const ctx: any = {
    env: { SIGNING_SECRET: 'test-secret' }, device, origin: 'https://central.example',
    update: async (f: any) => { device.facts = JSON.stringify({ ...JSON.parse(device.facts), ...f.facts }); },
    gw: async (op: string, args: any) => {
      calls.push({ op, args });
      if (op === 'adb.push') { tmp.set(args.remote_path, args.sha256); return { output: '1 file pushed' }; }
      const cmd: string = args.cmd;
      if (cmd.includes('.STATUS')) {
        const st: any = { version, config_sha: configSha, is_home: true };
        if (version === '2.0.0') Object.assign(st, { version_code: 20000, config_v: lastCfg?.v ?? null, assets: [...assets], missing_assets: [], last_error: null });
        return { stdout: `Broadcast completed: result=1, data="status:${esc(st)}"\n`, exit_code: 0 };
      }
      if (cmd.includes('.CONFIG')) {
        const b64 = cmd.match(/--es config_b64 (\S+)/)![1];
        const json = Buffer.from(b64, 'base64');
        lastCfg = JSON.parse(json.toString());
        if (version === '1.0.0' && lastCfg.v !== 1) return { stdout: 'Broadcast completed: result=0, data="error:v: unsupported config version 2"\n', exit_code: 0 };
        configSha = await sha256Hex(new Uint8Array(json));
        return { stdout: `Broadcast completed: result=1, data="ok:${configSha}"\n`, exit_code: 0 };
      }
      // Like the real app: write always exits 0, the SHA check happens after the pipe closes, and the
      // follow-up single-asset query is the only confirmation.
      const w = cmd.match(/^content write --uri content:\/\/au\.supercluster\.screens\.launcher\.assets\/([0-9a-f]{64})\.(\w+) < (\S+) 2>&1; rm -f (\S+); content query --uri content:\/\/au\.supercluster\.screens\.launcher\.assets\/([0-9a-f]{64})\.(\w+) 2>&1$/);
      if (w) {
        const ok = tmp.get(w[3]) === w[1] && w[3] === w[4];
        if (ok) assets.add(w[1]);
        return { stdout: assets.has(w[5]) ? `Row: 0 sha256=${w[5]}, bytes=10\n` : 'No result found.\n', exit_code: 0 };
      }
      if (cmd.startsWith('content query')) return { stdout: [...assets].map((s, i) => `Row: ${i} sha256=${s}, bytes=10`).join('\n') + '\n', exit_code: 0 };
      throw new Error(`unexpected command ${cmd}`);
    },
  };
  return { ctx, calls, assets, get config() { return lastCfg; }, get facts() { return JSON.parse(device.facts).launcher; } };
}

async function payload() {
  const input = { site_name: 'Theatre', guest, pin_sha256: null, layout: { home: projectivy(), accent: null } };
  const v1 = launcherConfigJson(input, 1), v2 = launcherConfigJson(input, 2);
  const enc = new TextEncoder();
  return {
    layout_id: 'lay_1', config_b64: b64Encode(enc.encode(v1)), config_v2_b64: b64Encode(enc.encode(v2)), v2_error: null,
    sha_v1: await sha256Hex(v1), sha_v2: await sha256Hex(v2),
    assets: [{ sha256: SHA_A, ext: 'jpg', r2_key: `launcher/assets/${SHA_A}.jpg`, bytes: 100 }, { sha256: SHA_B, ext: 'png', r2_key: `launcher/assets/${SHA_B}.png`, bytes: 50 }],
  };
}

describe('launcher push pipeline', () => {
  it('v2 box: pushes only missing images, then the v2 config, and records the outcome', async () => {
    const box = fakeBox('2.0.0', [SHA_A]);
    const p = await payload();
    const r = await applyLauncherConfig(box.ctx, p);
    expect(r).toMatchObject({ ok: true, config_v: 2, sha: p.sha_v2, expected_sha: p.sha_v2, assets_pushed: [SHA_B], assets_failed: [] });
    const pushes = box.calls.filter((c) => c.op === 'adb.push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].args).toMatchObject({ serial: '10.0.0.5:5555', sha256: SHA_B, remote_path: `/data/local/tmp/screens-asset-${SHA_B}.png` });
    expect(pushes[0].args.url).toMatch(new RegExp(`^https://central\\.example/agent/v1/files/launcher/assets/${SHA_B}\\.png\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    const write = box.calls.find((c) => c.args.cmd?.startsWith('content write'))!;
    expect(write.args.cmd).toBe(`content write --uri content://au.supercluster.screens.launcher.assets/${SHA_B}.png < /data/local/tmp/screens-asset-${SHA_B}.png 2>&1; rm -f /data/local/tmp/screens-asset-${SHA_B}.png; content query --uri content://au.supercluster.screens.launcher.assets/${SHA_B}.png 2>&1`);
    expect(box.config.v).toBe(2);
    expect(box.config.home.rows[0].title).toBe('InterNik');
    expect(box.assets).toEqual(new Set([SHA_A, SHA_B]));
    expect(box.facts).toMatchObject({ pushed_sha: p.sha_v2, pushed_v: 2, push_error: null, layout_id: 'lay_1', assets_pushed: 1 });
    // second push: nothing missing → no adb.push at all
    const again = fakeBox('2.0.0', [SHA_A, SHA_B]);
    await applyLauncherConfig(again.ctx, p);
    expect(again.calls.some((c) => c.op === 'adb.push')).toBe(false);
  });

  it('v1 box: no images, v1 config', async () => {
    const box = fakeBox('1.0.0');
    const p = await payload();
    const r = await applyLauncherConfig(box.ctx, p);
    expect(r).toMatchObject({ ok: true, config_v: 1, sha: p.sha_v1 });
    expect(box.calls.some((c) => c.op === 'adb.push' || c.args.cmd?.startsWith('content'))).toBe(false);
    expect(box.config.v).toBe(1);
    expect(box.config.home).toBeUndefined();
    expect(box.facts).toMatchObject({ pushed_v: 1, pushed_sha: p.sha_v1, push_error: null });
  });

  it('reports a refused image but still applies the config (the box shows its fallback)', async () => {
    const box = fakeBox('2.0.0');
    const p = await payload();
    const orig = box.ctx.gw;
    box.ctx.gw = async (op: string, args: any) => (op === 'adb.push' && args.sha256 === SHA_B ? (() => { throw new Error('sha256 mismatch'); })() : orig(op, args));
    const r = await applyLauncherConfig(box.ctx, p);
    expect(r.ok).toBe(false);
    expect(r.config_v).toBe(2);
    expect(r.assets_pushed).toEqual([SHA_A]);
    expect(r.assets_failed[0]).toMatchObject({ sha256: SHA_B });
    expect(box.facts.push_error).toMatch(/1 image could not be copied/);
    expect(box.config.v).toBe(2);
  });

  it('refuses to send an oversized v2 config to a 2.x box', async () => {
    const box = fakeBox('2.0.0');
    const p = { ...(await payload()), config_v2_b64: null, v2_error: 'too big' };
    const r = await applyLauncherConfig(box.ctx, p);
    expect(r).toMatchObject({ ok: false, detail: 'too big' });
    expect(box.calls.some((c) => c.args.cmd?.includes('.CONFIG'))).toBe(false);
  });
});

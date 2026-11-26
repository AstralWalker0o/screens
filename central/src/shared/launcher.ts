// Screens Launcher v2: home-screen layouts, validation and config building (docs/LAUNCHER-V2.md).
// Pure code shared by the Worker (API validation, hub push pipeline), the dashboard (editor, TV preview)
// and the mock API, so all three build byte-identical config JSON.

import type { DeviceStatus, GuestSettings, LauncherState } from './types';

export const LAUNCHER_PACKAGE = 'au.supercluster.screens.launcher';
/** ContentProvider that receives assets over `content write` (protected by android.permission.DUMP). */
export const ASSET_AUTHORITY = 'au.supercluster.screens.launcher.assets';

export const ROW_ICONS = ['bookmark', 'media', 'star', 'tv', 'music', 'games', 'kids', 'settings', 'apps', 'none'] as const;
export const CARD_STYLES = ['banner', 'icon', 'poster'] as const;
export const CARD_SIZES = ['small', 'medium', 'large'] as const;
export const LABEL_MODES = ['always', 'focused', 'never'] as const;
export const ASSET_EXTS = ['jpg', 'png', 'webp'] as const;

export type RowIcon = (typeof ROW_ICONS)[number];
export type CardStyle = (typeof CARD_STYLES)[number];
export type CardSize = (typeof CARD_SIZES)[number];
export type LabelMode = (typeof LABEL_MODES)[number];
export type AssetExt = (typeof ASSET_EXTS)[number];

export const LAUNCHER_LIMITS = {
  rows: 12,
  apps_per_row: 40,
  title: 40,
  label: 40,
  name: 60,
  hidden: 300,
  tiles: 200,
  /** Config JSON before base64 (contract §1.2). */
  config_bytes: 48 * 1024,
  /** Per asset and in total on one box (contract §1.1). */
  asset_bytes: 8 * 1024 * 1024,
  assets_total: 64 * 1024 * 1024,
  /** Cloud-side guard (not in the contract): longest image side, so a box never decodes a huge bitmap. */
  image_px: 4096,
  dim_max: 0.8,
  scale_min: 1,
  scale_max: 1.25,
} as const;

export const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
export const ROW_ID_RE = /^[a-z0-9_-]{1,32}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

export interface LauncherWallpaper { asset: string; ext: AssetExt; dim: number }
export interface LauncherTopBar { clock: boolean; clock_24h: boolean; date: boolean; network: boolean; settings: boolean }
export interface LauncherRow { id: string; title: string; icon: RowIcon; card: CardStyle; size: CardSize; apps: string[] }
export interface LauncherTile { label?: string; asset?: string; ext?: AssetExt }
/** The `home` object of config v2. */
export interface LauncherHome {
  wallpaper: LauncherWallpaper | null;
  top_bar: LauncherTopBar;
  rows: LauncherRow[];
  all_apps: { enabled: boolean; title: string };
  hidden: string[];
  tiles: Record<string, LauncherTile>;
  focus: { scale: number; label: LabelMode };
}

/** A stored home-screen layout: one per site (or several), or a fleet template (`site_id: null`). */
export interface LauncherLayout {
  id: string;
  site_id: string | null;
  name: string;
  home: LauncherHome;
  /** Overrides the welcome screen's accent colour on v2 boxes. null = use the welcome accent. */
  accent: string | null;
  created_at: number;
  updated_at: number;
  site_name?: string | null;
  /** Sites using it as their default and devices using it as an override. */
  used_by?: { sites: string[]; devices: string[] };
}

export interface LauncherAsset {
  sha256: string; ext: AssetExt; content_type: string; bytes: number;
  width: number | null; height: number | null; uploaded_at: number;
}

/** Rollout state of one Android box (GET /api/sites/:id/launcher). */
export interface LauncherDeviceRollout {
  device_id: string;
  name: string;
  room?: string | null;
  status: DeviceStatus;
  /** "Use a different layout on this box". */
  override_layout_id: string | null;
  /** Layout the box should show (override, else the site default), null = classic v1 grid. */
  layout_id: string | null;
  launcher: LauncherState | null;
  /** Installed launcher is 2.x and can show a layout. */
  supports_v2: boolean;
  /** Config version and SHA-256 the box should report once it is up to date. */
  expected_v: 1 | 2;
  expected_sha: string;
  in_sync: boolean;
}

export interface LauncherSiteState {
  site_id: string;
  /** The site's default layout. */
  layout_id: string | null;
  /** This site's layouts plus the fleet templates. */
  layouts: LauncherLayout[];
  devices: LauncherDeviceRollout[];
  /** Newest Screens Launcher in the APK library. */
  latest_version: string | null;
}

// ---------------------------------------------------------------------------
// Defaults

export function defaultTopBar(): LauncherTopBar {
  return { clock: true, clock_24h: false, date: false, network: true, settings: true };
}

export function defaultHome(): LauncherHome {
  return {
    wallpaper: null,
    top_bar: defaultTopBar(),
    rows: [{ id: 'favourites', title: 'Favourites', icon: 'star', card: 'banner', size: 'large', apps: [] }],
    all_apps: { enabled: true, title: 'All apps' },
    hidden: [],
    tiles: {},
    focus: { scale: 1.12, label: 'focused' },
  };
}

/** A fresh row id that doesn't clash with the given ones. */
export function newRowId(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'row';
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

// ---------------------------------------------------------------------------
// Validation (contract §2 field rules)

export type HomeResult = { ok: true; home: LauncherHome } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Validate and normalise a `home` object. Missing top-level sections take their defaults;
 * anything present must follow the contract exactly. Duplicate packages in a list are dropped.
 */
export function validateHome(input: unknown): HomeResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['The layout is missing its home screen settings'] };
  const d = defaultHome();
  const L = LAUNCHER_LIMITS;

  // wallpaper
  let wallpaper: LauncherWallpaper | null = null;
  if (input.wallpaper !== undefined && input.wallpaper !== null) {
    const w = input.wallpaper;
    if (!isObj(w)) errors.push('Wallpaper: expected an image or none');
    else {
      if (typeof w.asset !== 'string' || !SHA256_RE.test(w.asset)) errors.push('Wallpaper: the image reference is not a SHA-256');
      if (!oneOf(ASSET_EXTS, w.ext)) errors.push('Wallpaper: the image type must be jpg, png or webp');
      const dim = w.dim === undefined ? 0.25 : w.dim;
      if (typeof dim !== 'number' || !Number.isFinite(dim) || dim < 0 || dim > L.dim_max) errors.push(`Wallpaper: darkening must be between 0 and ${L.dim_max}`);
      if (typeof w.asset === 'string' && oneOf(ASSET_EXTS, w.ext) && typeof dim === 'number') wallpaper = { asset: w.asset, ext: w.ext, dim: round2(dim) };
    }
  }

  // top bar
  const top_bar = { ...d.top_bar };
  if (input.top_bar !== undefined) {
    if (!isObj(input.top_bar)) errors.push('Top bar: expected on/off settings');
    else {
      for (const k of Object.keys(top_bar) as (keyof LauncherTopBar)[]) {
        const v = input.top_bar[k];
        if (v === undefined) continue;
        if (typeof v !== 'boolean') errors.push(`Top bar: "${k}" must be on or off`);
        else top_bar[k] = v;
      }
    }
  }

  // rows
  const rows: LauncherRow[] = [];
  const rawRows = input.rows === undefined ? d.rows : input.rows;
  if (!Array.isArray(rawRows)) errors.push('Rows: expected a list');
  else {
    if (rawRows.length < 1) errors.push('Add at least one row');
    if (rawRows.length > L.rows) errors.push(`At most ${L.rows} rows`);
    const ids = new Set<string>();
    rawRows.slice(0, L.rows).forEach((r, i) => {
      const where = isObj(r) && typeof r.title === 'string' && r.title ? `Row ${i + 1} (“${r.title.slice(0, 40)}”)` : `Row ${i + 1}`;
      if (!isObj(r)) { errors.push(`${where}: expected a row`); return; }
      const id = r.id;
      if (typeof id !== 'string' || !ROW_ID_RE.test(id)) errors.push(`${where}: the id must be 1–32 lowercase letters, digits, - or _`);
      else if (ids.has(id)) errors.push(`${where}: the id “${id}” is used twice`);
      else ids.add(id);
      const title = r.title === undefined ? '' : r.title;
      if (typeof title !== 'string') errors.push(`${where}: the title must be text`);
      else if (title.length > L.title) errors.push(`${where}: the title can be at most ${L.title} characters`);
      if (!oneOf(ROW_ICONS, r.icon)) errors.push(`${where}: unknown icon “${String(r.icon)}”`);
      if (!oneOf(CARD_STYLES, r.card)) errors.push(`${where}: the card style must be banner, icon or poster`);
      if (!oneOf(CARD_SIZES, r.size)) errors.push(`${where}: the size must be small, medium or large`);
      const apps = r.apps === undefined ? [] : r.apps;
      let list: string[] = [];
      if (!Array.isArray(apps)) errors.push(`${where}: apps must be a list`);
      else {
        const bad = apps.find((p) => typeof p !== 'string' || !PACKAGE_RE.test(p));
        if (bad !== undefined) errors.push(`${where}: “${String(bad)}” is not an Android package name`);
        list = [...new Set(apps.filter((p): p is string => typeof p === 'string' && PACKAGE_RE.test(p)))];
        if (list.length > L.apps_per_row) errors.push(`${where}: at most ${L.apps_per_row} apps per row`);
      }
      if (typeof id === 'string' && typeof title === 'string' && oneOf(ROW_ICONS, r.icon) && oneOf(CARD_STYLES, r.card) && oneOf(CARD_SIZES, r.size)) {
        rows.push({ id, title, icon: r.icon, card: r.card, size: r.size, apps: list.slice(0, L.apps_per_row) });
      }
    });
  }

  // all apps
  const all_apps = { ...d.all_apps };
  if (input.all_apps !== undefined) {
    const a = input.all_apps;
    if (!isObj(a)) errors.push('All apps row: expected settings');
    else {
      if (a.enabled !== undefined) { if (typeof a.enabled !== 'boolean') errors.push('All apps row: "enabled" must be on or off'); else all_apps.enabled = a.enabled; }
      if (a.title !== undefined) {
        if (typeof a.title !== 'string') errors.push('All apps row: the title must be text');
        else if (a.title.length > L.title) errors.push(`All apps row: the title can be at most ${L.title} characters`);
        else all_apps.title = a.title;
      }
    }
  }

  // hidden
  let hidden: string[] = [];
  if (input.hidden !== undefined) {
    if (!Array.isArray(input.hidden)) errors.push('Hidden apps: expected a list');
    else {
      const bad = input.hidden.find((p) => typeof p !== 'string' || !PACKAGE_RE.test(p));
      if (bad !== undefined) errors.push(`Hidden apps: “${String(bad)}” is not an Android package name`);
      hidden = [...new Set(input.hidden.filter((p): p is string => typeof p === 'string' && PACKAGE_RE.test(p)))];
      if (hidden.length > L.hidden) errors.push(`Hidden apps: at most ${L.hidden}`);
    }
  }

  // tiles
  const tiles: Record<string, LauncherTile> = {};
  if (input.tiles !== undefined) {
    if (!isObj(input.tiles)) errors.push('App overrides: expected a map of package → override');
    else {
      const entries = Object.entries(input.tiles);
      if (entries.length > L.tiles) errors.push(`App overrides: at most ${L.tiles}`);
      for (const [pkg, t] of entries.slice(0, L.tiles)) {
        if (!PACKAGE_RE.test(pkg)) { errors.push(`App overrides: “${pkg}” is not an Android package name`); continue; }
        if (!isObj(t)) { errors.push(`App override for ${pkg}: expected a label and/or picture`); continue; }
        const tile: LauncherTile = {};
        if (t.label !== undefined && t.label !== null && t.label !== '') {
          if (typeof t.label !== 'string') errors.push(`App override for ${pkg}: the label must be text`);
          else if (t.label.length > L.label) errors.push(`App override for ${pkg}: the label can be at most ${L.label} characters`);
          else tile.label = t.label;
        }
        const hasAsset = t.asset !== undefined && t.asset !== null;
        const hasExt = t.ext !== undefined && t.ext !== null;
        if (hasAsset || hasExt) {
          if (typeof t.asset !== 'string' || !SHA256_RE.test(t.asset)) errors.push(`App override for ${pkg}: the picture reference is not a SHA-256`);
          else if (!oneOf(ASSET_EXTS, t.ext)) errors.push(`App override for ${pkg}: the picture type must be jpg, png or webp`);
          else { tile.asset = t.asset; tile.ext = t.ext; }
        }
        if (tile.label !== undefined || tile.asset !== undefined) tiles[pkg] = tile;
      }
    }
  }

  // focus
  const focus = { ...d.focus };
  if (input.focus !== undefined) {
    const f = input.focus;
    if (!isObj(f)) errors.push('Focus: expected settings');
    else {
      if (f.scale !== undefined) {
        if (typeof f.scale !== 'number' || !Number.isFinite(f.scale) || f.scale < L.scale_min || f.scale > L.scale_max) errors.push(`Focus zoom must be between ${L.scale_min} and ${L.scale_max}`);
        else focus.scale = round2(f.scale);
      }
      if (f.label !== undefined) { if (!oneOf(LABEL_MODES, f.label)) errors.push('Focus: app names show always, focused or never'); else focus.label = f.label; }
    }
  }

  const home: LauncherHome = { wallpaper, top_bar, rows, all_apps, hidden, tiles, focus };
  if (!errors.length) {
    const bytes = utf8Length(JSON.stringify(homeForConfig(home)));
    if (bytes > L.config_bytes) errors.push(`The layout is too big for the box (${Math.ceil(bytes / 1024)} KB, the limit is ${L.config_bytes / 1024} KB). Remove some apps or overrides.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, home };
}

/** Layout name: 1–60 characters. */
export function layoutName(v: unknown, fallback = 'Home screen'): string {
  const s = typeof v === 'string' ? v.trim().slice(0, LAUNCHER_LIMITS.name) : '';
  return s || fallback;
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Every image the layout references (wallpaper first), deduplicated. */
export function homeAssets(home: LauncherHome | null | undefined): { sha256: string; ext: AssetExt }[] {
  if (!home) return [];
  const out = new Map<string, AssetExt>();
  if (home.wallpaper) out.set(home.wallpaper.asset, home.wallpaper.ext);
  for (const t of Object.values(home.tiles)) if (t.asset && t.ext && !out.has(t.asset)) out.set(t.asset, t.ext);
  return [...out].map(([sha256, ext]) => ({ sha256, ext }));
}

// ---------------------------------------------------------------------------
// Config JSON (contract §2). Key order is fixed so the SHA-256 is reproducible.

/** `home` in canonical key order, with empty tile fields left out. */
export function homeForConfig(h: LauncherHome) {
  const tiles: Record<string, LauncherTile> = {};
  for (const [pkg, t] of Object.entries(h.tiles)) {
    const o: LauncherTile = {};
    if (t.label) o.label = t.label;
    if (t.asset && t.ext) { o.asset = t.asset; o.ext = t.ext; }
    if (o.label || o.asset) tiles[pkg] = o;
  }
  return {
    wallpaper: h.wallpaper ? { asset: h.wallpaper.asset, ext: h.wallpaper.ext, dim: h.wallpaper.dim } : null,
    top_bar: { clock: h.top_bar.clock, clock_24h: h.top_bar.clock_24h, date: h.top_bar.date, network: h.top_bar.network, settings: h.top_bar.settings },
    rows: h.rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon, card: r.card, size: r.size, apps: r.apps })),
    all_apps: { enabled: h.all_apps.enabled, title: h.all_apps.title },
    hidden: h.hidden,
    tiles,
    focus: { scale: h.focus.scale, label: h.focus.label },
  };
}

export interface LauncherConfigInput {
  site_name: string;
  guest: GuestSettings;
  /** Raw stored kiosk PIN hash (never sent to the dashboard). */
  pin_sha256: string | null;
  /** The device's effective layout, if any. */
  layout?: Pick<LauncherLayout, 'home' | 'accent'> | null;
}

/**
 * Config for the box. `v: 2` carries `home` and is only for launcher 2.x; v1 boxes (and any box
 * whose site has no layout) get the unchanged v1 shape: the 1.0 app rejects `"v": 2`.
 */
export function buildLauncherConfig(input: LauncherConfigInput, v: 1 | 2): Record<string, unknown> {
  const g = input.guest;
  const two = v === 2 && !!input.layout;
  const accent = two && input.layout!.accent && ACCENT_RE.test(input.layout!.accent) ? input.layout!.accent : g.welcome.accent;
  const tail = {
    kiosk: { enabled: g.kiosk.enabled, allowed: g.kiosk.allowed, pin_sha256: input.pin_sha256 },
    pinned: g.kiosk.pinned,
    welcome: {
      enabled: g.welcome.enabled, show_on_boot: g.welcome.show_on_boot, title: g.welcome.title || `Welcome to ${input.site_name}`,
      message: g.welcome.message, wifi: g.welcome.wifi, sections: g.welcome.sections, contact: g.welcome.contact,
    },
  };
  return two
    ? { v: 2, site_name: input.site_name, accent, home: homeForConfig(input.layout!.home), ...tail }
    : { v: 1, site_name: input.site_name, accent, ...tail };
}

export function launcherConfigJson(input: LauncherConfigInput, v: 1 | 2): string {
  return JSON.stringify(buildLauncherConfig(input, v));
}

// ---------------------------------------------------------------------------
// Versions & status

/** Major version of a launcher version string ("2.0.0" → 2), 0 if unknown. */
export function launcherMajor(version: string | null | undefined): number {
  const m = String(version ?? '').match(/^(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** True when the installed launcher understands config v2 and assets. */
export function supportsV2(st: Pick<LauncherState, 'installed' | 'version' | 'version_code'> | null | undefined): boolean {
  if (!st?.installed) return false;
  return (st.version_code ?? 0) >= 20000 || launcherMajor(st.version) >= 2;
}

/** Compare dotted versions ("2.0.10" > "2.0.9"). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = String(a ?? '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b ?? '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Images (server-side sniffing of uploads)

export interface SniffedImage { ext: AssetExt; content_type: string; width: number | null; height: number | null }

/** Identify JPEG / PNG / WebP by their magic bytes and read the pixel size. Anything else → null. */
export function sniffImage(b: Uint8Array): SniffedImage | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const dims = jpegSize(b);
    return { ext: 'jpg', content_type: 'image/jpeg', width: dims?.[0] ?? null, height: dims?.[1] ?? null };
  }
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    const be = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    return { ext: 'png', content_type: 'image/png', width: be(16), height: be(20) };
  }
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    let w: number | null = null, h: number | null = null;
    if (chunk === 'VP8 ' && b.length >= 30) { w = (b[26] | (b[27] << 8)) & 0x3fff; h = (b[28] | (b[29] << 8)) & 0x3fff; }
    else if (chunk === 'VP8L' && b.length >= 25) { w = 1 + (((b[22] & 0x3f) << 8) | b[21]); h = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)); }
    else if (chunk === 'VP8X' && b.length >= 30) { w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16)); h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16)); }
    return { ext: 'webp', content_type: 'image/webp', width: w, height: h };
  }
  return null;
}

function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
    i += 2 + len;
  }
  return null;
}

export const ASSET_CONTENT_TYPE: Record<AssetExt, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const assetR2Key = (sha256: string, ext: AssetExt) => `launcher/assets/${sha256}.${ext}`;

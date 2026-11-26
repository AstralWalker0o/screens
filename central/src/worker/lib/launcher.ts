// Screens Launcher v2: D1 access for layouts/assets and the per-device payload the hub pushes.

import {
  ACCENT_RE, assetR2Key, defaultHome, homeAssets, LAUNCHER_LIMITS, launcherConfigJson, type AssetExt, type LauncherAsset, type LauncherConfigInput,
  type LauncherLayout, supportsV2, utf8Length, validateHome,
} from '../../shared/launcher';
import type { LauncherState } from '../../shared/types';
import type { Env } from '../env';
import { b64Encode, sha256Hex } from './crypto';
import { kioskPinHash, type Row, siteSettings } from './db';
import { parseJson } from './util';

export function toLayout(r: Row): LauncherLayout {
  const cfg = parseJson<{ home?: unknown; accent?: unknown }>(r.config, {});
  const v = validateHome(cfg.home);
  return {
    id: r.id, site_id: r.site_id ?? null, name: r.name, home: v.ok ? v.home : defaultHome(),
    accent: typeof cfg.accent === 'string' && ACCENT_RE.test(cfg.accent) ? cfg.accent : null,
    created_at: r.created_at, updated_at: r.updated_at, site_name: r.site_name ?? null,
  };
}

export const layoutConfigJson = (l: Pick<LauncherLayout, 'home' | 'accent'>) => JSON.stringify({ home: l.home, accent: l.accent });

export function toAsset(r: Row): LauncherAsset {
  return { sha256: r.sha256, ext: r.ext, content_type: r.content_type, bytes: r.bytes, width: r.width ?? null, height: r.height ?? null, uploaded_at: r.uploaded_at };
}

export async function getLayout(env: Env, id: string | null | undefined): Promise<LauncherLayout | null> {
  if (!id) return null;
  const r = await env.DB.prepare('SELECT l.*, s.name site_name FROM launcher_layouts l LEFT JOIN sites s ON s.id = l.site_id WHERE l.id = ?').bind(id).first<Row>();
  return r ? toLayout(r) : null;
}

/** The layout a device should show: its own override, else the site's default. */
export const effectiveLayoutId = (site: Row, device: Row | null): string | null => (device?.launcher_layout_id as string | null) ?? (site.launcher_layout_id as string | null) ?? null;

/** Stored metadata for the assets a layout references (unknown SHAs are left out). */
export async function assetsFor(env: Env, list: { sha256: string; ext: AssetExt }[]): Promise<(LauncherAsset & { r2_key: string })[]> {
  if (!list.length) return [];
  const rows = (await env.DB.prepare(`SELECT * FROM launcher_assets WHERE sha256 IN (${list.map(() => '?').join(',')})`).bind(...list.map((a) => a.sha256)).all<Row>()).results;
  const by = new Map(rows.map((r) => [r.sha256 as string, r]));
  return list.flatMap((a) => {
    const r = by.get(a.sha256);
    return r && r.ext === a.ext ? [{ ...toAsset(r), r2_key: r.r2_key as string }] : [];
  });
}

export interface LauncherPayload {
  layout_id: string | null;
  /** v1 config (every launcher version accepts it). */
  config_b64: string;
  sha_v1: string;
  /** v2 config with `home`; null when the device has no layout. */
  config_v2_b64: string | null;
  sha_v2: string | null;
  /** Why a layout couldn't become a v2 config (too big). */
  v2_error: string | null;
  assets: { sha256: string; ext: AssetExt; r2_key: string; bytes: number }[];
}

export function configInput(site: Row, layout: LauncherLayout | null): LauncherConfigInput {
  return { site_name: site.name, guest: siteSettings(site).guest, pin_sha256: kioskPinHash(site), layout: layout ? { home: layout.home, accent: layout.accent } : null };
}

/** Everything the adapter needs to bring one box up to date (both config versions + images). */
export async function launcherPayload(env: Env, site: Row, device: Row | null, cache?: Map<string, LauncherLayout | null>): Promise<LauncherPayload> {
  const id = effectiveLayoutId(site, device);
  let layout: LauncherLayout | null = null;
  if (id) {
    if (cache?.has(id)) layout = cache.get(id)!;
    else { layout = await getLayout(env, id); cache?.set(id, layout); }
  }
  const input = configInput(site, layout);
  const v1 = launcherConfigJson(input, 1);
  const enc = new TextEncoder();
  const out: LauncherPayload = {
    layout_id: layout?.id ?? null, config_b64: b64Encode(enc.encode(v1)), sha_v1: await sha256Hex(v1),
    config_v2_b64: null, sha_v2: null, v2_error: null, assets: [],
  };
  if (layout) {
    const v2 = launcherConfigJson(input, 2);
    const bytes = utf8Length(v2);
    if (bytes > LAUNCHER_LIMITS.config_bytes) {
      out.v2_error = `The home screen “${layout.name}” plus this site's welcome and kiosk settings is ${Math.ceil(bytes / 1024)} KB; the box accepts at most ${LAUNCHER_LIMITS.config_bytes / 1024} KB. Remove some apps or welcome sections.`;
    } else {
      out.config_v2_b64 = b64Encode(enc.encode(v2));
      out.sha_v2 = await sha256Hex(v2);
      out.assets = (await assetsFor(env, homeAssets(layout.home))).map((a) => ({ sha256: a.sha256, ext: a.ext, r2_key: a.r2_key, bytes: a.bytes }));
    }
  }
  return out;
}

/** Which config version a box gets and the SHA-256 it should report once applied. */
export function expectedFor(p: LauncherPayload, st: Pick<LauncherState, 'installed' | 'version' | 'version_code'> | null | undefined): { v: 1 | 2; sha: string } {
  return supportsV2(st) && p.sha_v2 ? { v: 2, sha: p.sha_v2 } : { v: 1, sha: p.sha_v1 };
}

/** Android devices whose effective layout is `layoutId` (override, or site default without an override). */
export async function devicesUsingLayout(env: Env, layoutId: string): Promise<{ id: string; site_id: string }[]> {
  return (await env.DB.prepare(`SELECT d.id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id
    WHERE d.kind = 'android' AND (d.launcher_layout_id = ?1 OR (d.launcher_layout_id IS NULL AND s.launcher_layout_id = ?1))`).bind(layoutId).all<{ id: string; site_id: string }>()).results;
}

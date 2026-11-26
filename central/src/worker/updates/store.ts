// D1 / R2 access for the update manager.

import type { ApkSigning, RolloutDevice, UpdateCandidate, UpdateMode, UpdatePolicyRow, UpdateRollout, UpdateSource } from '../../shared/updates';
import { DEFAULT_WINDOW } from '../../shared/updates';
import type { Env } from '../env';
import type { Row } from '../lib/db';
import { now, parseJson } from '../lib/util';
import { ApkError, inspectApk, type RandomAccess } from './apk';

/** Range reads straight from R2, so inspecting a large APK never loads it into memory. */
export function r2Reader(bucket: R2Bucket, key: string, size: number): RandomAccess {
  return {
    size,
    async read(offset, length) {
      if (length <= 0) return new Uint8Array(0);
      const o = await bucket.get(key, { range: { offset, length } });
      if (!o) throw new ApkError('The APK is missing from storage');
      return new Uint8Array(await o.arrayBuffer());
    },
  };
}

export async function getState<T>(env: Env, k: string, fallback: T): Promise<T> {
  const r = await env.DB.prepare('SELECT v FROM update_state WHERE k = ?').bind(k).first<Row>();
  return r ? parseJson<T>(r.v, fallback) : fallback;
}
export async function setState(env: Env, k: string, v: unknown) {
  await env.DB.prepare('INSERT INTO update_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v)).run();
}

/** Read ABIs + signer of library APKs that haven't been inspected yet (uploads go through the Library page). */
export async function ensureApkInfo(env: Env, limit = 3): Promise<number> {
  const rows = (await env.DB.prepare(`SELECT a.id, a.package, a.r2_key, a.size FROM apks a LEFT JOIN update_apk_info i ON i.apk_id = a.id
    WHERE i.apk_id IS NULL AND a.package IS NOT NULL ORDER BY a.uploaded_at DESC LIMIT ?`).bind(limit).all<Row>()).results;
  for (const a of rows) {
    let info: Awaited<ReturnType<typeof inspectApk>> | null = null, error: string | null = null;
    try { info = await inspectApk(r2Reader(env.FILES, a.r2_key, a.size)); } catch (e: any) { error = String(e?.message ?? e).slice(0, 300); }
    if (info && info.package !== a.package) error = `The file is really ${info.package}, not ${a.package}, so it won't be offered as an update.`;
    await env.DB.prepare(`INSERT INTO update_apk_info (apk_id, package, version_code, version_name, abis, min_sdk, signing, source, error, inspected_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(apk_id) DO NOTHING`).bind(a.id, info?.package ?? null, info?.version_code ?? null, info?.version_name ?? null, JSON.stringify(info?.abis ?? []), info?.min_sdk ?? null,
      info ? JSON.stringify(info.signing) : null, 'library', error, now()).run();
  }
  return rows.length;
}

export function toCandidate(r: Row): UpdateCandidate {
  return {
    // The manifest (read by Screens) wins over what was typed at upload time.
    apk_id: r.id, package: r.package, version_code: r.i_version_code ?? r.version_code ?? null, version_name: r.i_version_name ?? r.version_name ?? null,
    abis: parseJson<string[]>(r.abis, []), min_sdk: r.min_sdk ?? null, signing: parseJson<ApkSigning | null>(r.signing, null),
    source: r.source === 'github' ? 'github' : 'library', size: r.size, uploaded_at: r.uploaded_at, tag: r.tag ?? null,
  };
}

/** Every installable build in the library, by package. APKs that failed inspection are left out. */
export async function loadCandidates(env: Env, pkg?: string): Promise<Map<string, UpdateCandidate[]>> {
  const rows = (await env.DB.prepare(`SELECT a.id, a.package, a.version_code, a.version_name, a.size, a.uploaded_at, i.version_code i_version_code, i.version_name i_version_name, i.abis, i.min_sdk, i.signing, i.source, i.tag, i.error
    FROM apks a LEFT JOIN update_apk_info i ON i.apk_id = a.id WHERE a.package IS NOT NULL ${pkg ? 'AND a.package = ?' : ''}`).bind(...(pkg ? [pkg] : [])).all<Row>()).results;
  const out = new Map<string, UpdateCandidate[]>();
  for (const r of rows) {
    if (r.error) continue;
    const list = out.get(r.package) ?? [];
    list.push(toCandidate(r));
    out.set(r.package, list);
  }
  return out;
}

export function toSource(r: Row): UpdateSource {
  return {
    package: r.package, kind: 'github', repo: r.repo, asset_pattern: r.asset_pattern, abi_patterns: parseJson(r.abi_patterns, {}),
    include_prereleases: !!r.include_prereleases, enabled: !!r.enabled, signer_sha256: r.signer_sha256 ?? null,
    last_checked: r.last_checked ?? null, last_status: r.last_status ?? null, last_error: r.last_error ?? null, latest_tag: r.latest_tag ?? null,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export async function loadPolicies(env: Env): Promise<UpdatePolicyRow[]> {
  return (await env.DB.prepare('SELECT package, scope_type, scope_id, mode FROM update_policies').all<Row>()).results
    .filter((r) => ['auto', 'notify', 'pin'].includes(r.mode))
    .map((r) => ({ package: r.package, scope_type: r.scope_type === 'site' ? 'site' : 'fleet', scope_id: r.scope_id ?? '', mode: r.mode as UpdateMode }));
}

export async function siteWindow(env: Env, siteId: string): Promise<{ window_start: string; window_end: string; canary_device_id: string | null }> {
  const r = await env.DB.prepare('SELECT * FROM update_sites WHERE site_id = ?').bind(siteId).first<Row>();
  return { window_start: r?.window_start ?? DEFAULT_WINDOW.start, window_end: r?.window_end ?? DEFAULT_WINDOW.end, canary_device_id: r?.canary_device_id ?? null };
}

export function toRollout(r: Row): UpdateRollout {
  return {
    id: r.id, site_id: r.site_id, site_name: r.site_name ?? null, package: r.package, label: r.label ?? null,
    version_code: r.version_code ?? null, version_name: r.version_name ?? null, trigger: r.trigger === 'auto' ? 'auto' : 'manual',
    status: r.status, devices: parseJson<RolloutDevice[]>(r.devices, []), detail: r.detail ?? null, actor: r.actor ?? null,
    created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at ?? null,
  };
}

export const ACTIVE_ROLLOUT = "status IN ('canary','rolling')";

export async function saveRollout(env: Env, r: UpdateRollout) {
  r.updated_at = now();
  await env.DB.prepare('UPDATE update_rollouts SET status = ?, devices = ?, detail = ?, updated_at = ?, finished_at = ? WHERE id = ?')
    .bind(r.status, JSON.stringify(r.devices), r.detail, r.updated_at, r.finished_at, r.id).run();
}

// GitHub releases as an update source. Unauthenticated by default (a GITHUB_TOKEN Worker secret is used when
// set), conditional requests with ETags (a 304 doesn't count against GitHub's rate limit), and a fleet-wide
// backoff when GitHub says the limit is used up. Downloads are only ever fetched from GitHub's own hosts, every
// redirect hop is checked, sizes and content types are enforced, and the SHA-256 is computed while streaming
// into R2. The APK's package name must match the source, and its signing key must match the key Screens
// learnt from the first release it imported.

import type { UpdateSource } from '../../shared/updates';
import { globMatch, versionText } from '../../shared/updates';
import type { Env } from '../env';
import { audit, raiseAlert, type Row } from '../lib/db';
import { hex } from '../lib/crypto';
import { now, rid } from '../lib/util';
import { allCerts, ApkError, inspectApk, newestSignerCert } from './apk';
import { ensureApkInfo, getState, r2Reader, setState, toSource } from './store';

export const MAX_APK_BYTES = 200 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const CHECK_EVERY_MS = 6 * 3_600_000;
const DEFAULT_API = 'https://api.github.com';
/** Hosts GitHub serves release downloads from (browser_download_url redirects to the last two). */
export const GITHUB_HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'];
const APK_TYPES = ['application/vnd.android.package-archive', 'application/octet-stream', 'binary/octet-stream', 'application/zip', 'application/x-zip-compressed', 'application/java-archive', 'application/x-zip'];
const UA = 'Screens-Update-Manager';

export class SourceError extends Error {
  constructor(message: string, public kind: 'error' | 'rate_limited' | 'signer' = 'error') { super(message); }
}

export interface GhAsset { id: number; name: string; size: number; content_type?: string; state?: string; browser_download_url: string }
export interface GhRelease { id: number; tag_name: string; name?: string | null; draft?: boolean; prerelease?: boolean; published_at?: string | null; assets: GhAsset[] }

export interface GhConfig { api: string; apiHost: string; extraHosts: string[]; allowHttpHost: string | null; token: string | null }

/** GITHUB_API_BASE points the source at a stand-in (e2e tests); production always talks to api.github.com. */
export function ghConfig(env: Pick<Env, 'GITHUB_API_BASE' | 'GITHUB_TOKEN'>): GhConfig {
  const api = (env.GITHUB_API_BASE || DEFAULT_API).replace(/\/+$/, '');
  const u = new URL(api);
  const custom = api !== DEFAULT_API;
  return { api, apiHost: u.host, extraHosts: custom ? [u.host] : [], allowHttpHost: custom && u.protocol === 'http:' ? u.host : null, token: env.GITHUB_TOKEN || null };
}

export function allowedUrl(raw: string, cfg: GhConfig): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'http:') return cfg.allowHttpHost === u.host;
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return cfg.extraHosts.includes(u.host);
  return GITHUB_HOSTS.includes(u.hostname) || cfg.extraHosts.includes(u.host);
}

/** fetch with redirects followed by hand: every hop must be a GitHub host, and the token never leaves the API host. */
export async function ghFetch(cfg: GhConfig, url: string, headers: Record<string, string>, fetcher: typeof fetch = fetch): Promise<Response> {
  let u = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!allowedUrl(u, cfg)) throw new SourceError(`Refused to download from ${safeHost(u)}: it isn’t one of GitHub’s download hosts.`);
    const h: Record<string, string> = { 'user-agent': UA, ...headers };
    if (cfg.token && new URL(u).host === cfg.apiHost) h.authorization = `Bearer ${cfg.token}`;
    const res = await fetcher(u, { headers: h, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new SourceError('GitHub sent a redirect without a location');
      u = new URL(loc, u).toString();
      continue;
    }
    return res;
  }
  throw new SourceError('Too many redirects from GitHub');
}
const safeHost = (u: string) => { try { return new URL(u).host; } catch { return 'an invalid address'; } };

async function readJson<T>(res: Response): Promise<T> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_JSON_BYTES) throw new SourceError('GitHub’s answer was unexpectedly large');
  const text = await res.text();
  if (text.length > MAX_JSON_BYTES) throw new SourceError('GitHub’s answer was unexpectedly large');
  try { return JSON.parse(text) as T; } catch { throw new SourceError('GitHub’s answer wasn’t valid JSON'); }
}

/** Newest published release (drafts never, pre-releases only when allowed). */
export function pickRelease(list: GhRelease[], includePre: boolean): GhRelease | null {
  return list.filter((r) => !r.draft && (includePre || !r.prerelease))
    .sort((a, b) => Date.parse(b.published_at ?? '') - Date.parse(a.published_at ?? '') || b.id - a.id)[0] ?? null;
}

/**
 * Which release assets to import: the first match of each per-ABI pattern, plus one build for the general
 * pattern (used by boxes no ABI pattern covers). Only .apk files within the size limit, at most four.
 */
export function selectAssets(rel: GhRelease, src: Pick<UpdateSource, 'asset_pattern' | 'abi_patterns'>): { asset: GhAsset; abi: string | null }[] {
  const apks = (rel.assets ?? []).filter((a) => /\.apk$/i.test(a.name) && (!a.state || a.state === 'uploaded') && a.size > 0 && a.size <= MAX_APK_BYTES);
  const out: { asset: GhAsset; abi: string | null }[] = [];
  const taken = new Set<number>();
  for (const [abi, pat] of Object.entries(src.abi_patterns ?? {})) {
    const a = apks.find((x) => !taken.has(x.id) && globMatch(pat, x.name));
    if (a) { out.push({ asset: a, abi }); taken.add(a.id); }
  }
  const general = apks.find((x) => !taken.has(x.id) && globMatch(src.asset_pattern || '*.apk', x.name));
  if (general) out.push({ asset: general, abi: null });
  return out.slice(0, 4);
}

/** Stream a download into R2 with a hard size limit, computing its SHA-256 on the way. */
export async function storeStream(env: Env, key: string, body: ReadableStream<Uint8Array>, length: number): Promise<{ sha256: string; size: number }> {
  if (!(length > 0) || length > MAX_APK_BYTES) throw new SourceError('The download has no size or is too large');
  const meta = { httpMetadata: { contentType: 'application/vnd.android.package-archive' } };
  const C = crypto as unknown as { DigestStream?: new (alg: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } };
  const FLS = (globalThis as any).FixedLengthStream as (new (n: number) => TransformStream<Uint8Array, Uint8Array>) | undefined;
  let seen = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) { seen += chunk.byteLength; if (seen > length) ctl.error(new SourceError('The download is bigger than GitHub said')); else ctl.enqueue(chunk); },
  });
  const limited = body.pipeThrough(limit);
  if (C.DigestStream && FLS) {
    // Workers: never hold the whole APK in memory.
    const digest = new C.DigestStream('SHA-256');
    const fixed = new FLS(length);
    const [toR2, toHash] = limited.tee();
    await Promise.all([env.FILES.put(key, fixed.readable, meta), toR2.pipeTo(fixed.writable), toHash.pipeTo(digest)]);
    return { sha256: hex(await digest.digest), size: length };
  }
  const buf = new Uint8Array(await new Response(limited).arrayBuffer());
  if (buf.length !== length) throw new SourceError('The download was cut short');
  await env.FILES.put(key, buf, meta);
  return { sha256: hex(await crypto.subtle.digest('SHA-256', buf)), size: buf.length };
}

export interface ImportResult { asset: string; abi: string | null; status: 'imported' | 'duplicate' | 'known' | 'error'; detail?: string; apk_id?: string; version?: string }

async function importAsset(env: Env, cfg: GhConfig, src: UpdateSource, rel: GhRelease, asset: GhAsset, abi: string | null, fetcher: typeof fetch): Promise<ImportResult> {
  const origin = `${src.repo}#${asset.id}`;
  if (await env.DB.prepare('SELECT 1 FROM update_apk_info WHERE origin = ?').bind(origin).first()) return { asset: asset.name, abi, status: 'known' };
  const res = await ghFetch(cfg, asset.browser_download_url, { accept: 'application/octet-stream' }, fetcher);
  if (res.status !== 200 || !res.body) { await res.body?.cancel().catch(() => undefined); throw new SourceError(`Downloading ${asset.name} failed (HTTP ${res.status})`); }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type && !APK_TYPES.includes(type)) { await res.body.cancel().catch(() => undefined); throw new SourceError(`${asset.name} came back as ${type}, not an APK`); }
  const length = Number(res.headers.get('content-length') ?? asset.size);
  if (asset.size && length !== asset.size) { await res.body.cancel().catch(() => undefined); throw new SourceError(`${asset.name} is ${length} bytes but GitHub lists ${asset.size}`); }
  const key = `apks/github/${src.package}/${asset.id}-${rid('a', 6).slice(2)}.apk`;
  const stored = await storeStream(env, key, res.body, length);
  const drop = async (msg: string, kind: SourceError['kind'] = 'error'): Promise<never> => { await env.FILES.delete(key).catch(() => undefined); throw new SourceError(msg, kind); };

  let info;
  try { info = await inspectApk(r2Reader(env.FILES, key, stored.size)); } catch (e: any) { return drop(`${asset.name}: ${e instanceof ApkError ? e.message : 'not a readable APK'}`); }
  if (info.package !== src.package) return drop(`${asset.name} contains ${info.package}, not ${src.package}, so it was not imported.`);
  if (info.version_code == null) return drop(`${asset.name} has no version code`);
  const certs = allCerts(info.signing).map((c) => c.sha256);
  if (src.signer_sha256 && !certs.includes(src.signer_sha256)) {
    return drop(`${rel.tag_name} (${asset.name}) is signed with a different key than earlier releases. It was not imported. If the developer really changed keys, reset the trusted key on this source.`, 'signer');
  }
  const newest = newestSignerCert(info.signing)?.sha256 ?? null;
  if (newest && newest !== src.signer_sha256) {
    await env.DB.prepare('UPDATE update_sources SET signer_sha256 = ? WHERE package = ?').bind(newest, src.package).run();
    src.signer_sha256 = newest;
  }
  const dup = await env.DB.prepare('SELECT id FROM apks WHERE sha256 = ?').bind(stored.sha256).first<Row>();
  if (dup) {
    await env.FILES.delete(key).catch(() => undefined);
    await env.DB.prepare("UPDATE update_apk_info SET origin = coalesce(origin, ?), tag = coalesce(tag, ?) WHERE apk_id = ?").bind(origin, rel.tag_name, dup.id).run();
    return { asset: asset.name, abi, status: 'duplicate', apk_id: dup.id };
  }
  const label = (await env.DB.prepare('SELECT label FROM apks WHERE package = ? AND label IS NOT NULL ORDER BY uploaded_at DESC LIMIT 1').bind(src.package).first<Row>())?.label
    ?? (await env.DB.prepare('SELECT label FROM app_catalog WHERE package = ?').bind(src.package).first<Row>())?.label ?? info.label ?? src.package;
  const id = rid('apk');
  const t = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO apks (id, package, label, version_name, version_code, r2_key, sha256, size, notes, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(id, info.package, label, info.version_name, info.version_code, key, stored.sha256, stored.size, `From GitHub ${src.repo} ${rel.tag_name}${abi ? ` (${abi})` : ''}`.slice(0, 200), t),
    env.DB.prepare(`INSERT INTO update_apk_info (apk_id, package, version_code, version_name, abis, min_sdk, signing, source, origin, tag, inspected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, info.package, info.version_code, info.version_name, JSON.stringify(info.abis), info.min_sdk, JSON.stringify(info.signing), 'github', origin, rel.tag_name.slice(0, 100), t),
  ]);
  await audit(env, 'system', 'apk.import', { target_type: 'apk', target_id: id, details: { package: info.package, version: info.version_name, repo: src.repo, tag: rel.tag_name, asset: asset.name, sha256: stored.sha256 } });
  return { asset: asset.name, abi, status: 'imported', apk_id: id, version: versionText(info) };
}

export interface CheckResult { package: string; status: NonNullable<UpdateSource['last_status']>; detail: string; imported: ImportResult[]; tag?: string | null }

/** Check one source now. Never throws: the outcome is stored on the source and returned. */
export async function checkSource(env: Env, srcRow: Row, opts: { fetcher?: typeof fetch } = {}): Promise<CheckResult> {
  const src = toSource(srcRow);
  const cfg = ghConfig(env);
  const fetcher = opts.fetcher ?? fetch;
  const t = now();
  const finish = async (status: CheckResult['status'], detail: string, extra: { etag?: string | null; tag?: string | null } = {}, imported: ImportResult[] = []) => {
    const failed = status === 'error';
    await env.DB.prepare(`UPDATE update_sources SET last_checked = ?, last_status = ?, last_error = ?, etag = CASE WHEN ? THEN ? ELSE etag END,
      latest_tag = coalesce(?, latest_tag), fail_count = CASE WHEN ? THEN fail_count + 1 ELSE 0 END WHERE package = ?`)
      .bind(t, status, failed || status === 'rate_limited' ? detail.slice(0, 500) : null, extra.etag !== undefined ? 1 : 0, extra.etag ?? null, extra.tag ?? null, failed ? 1 : 0, src.package).run();
    if (failed && (srcRow.fail_count ?? 0) + 1 >= 3) {
      await raiseAlert(env, { severity: 'warning', type: 'update.source', title: `Can’t check for ${src.package} updates on GitHub`, details: detail, dedupe_key: `upd_src:${src.package}` });
    } else if (!failed && status !== 'rate_limited') {
      await env.DB.prepare('UPDATE alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL').bind(t, `upd_src:${src.package}`).run();
    }
    return { package: src.package, status, detail, imported, tag: extra.tag ?? src.latest_tag ?? null };
  };

  const gh = await getState<{ backoff_until?: number | null }>(env, 'github', {});
  if (gh.backoff_until && gh.backoff_until > t) return { package: src.package, status: 'rate_limited', detail: `GitHub asked Screens to wait until ${new Date(gh.backoff_until).toISOString()}`, imported: [] };
  try {
    const [owner, repo] = src.repo.split('/');
    const url = `${cfg.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases${src.include_prereleases ? '?per_page=10' : '/latest'}`;
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    if (srcRow.etag && (src.last_status === 'ok' || src.last_status === 'not_modified')) headers['if-none-match'] = srcRow.etag;
    const res = await ghFetch(cfg, url, headers, fetcher);
    await setState(env, 'github', { backoff_until: null, last_check: t, remaining: Number(res.headers.get('x-ratelimit-remaining') ?? NaN) || null });
    if (res.status === 304) return finish('not_modified', 'No new release.');
    if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after'))) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const retry = Number(res.headers.get('retry-after')) * 1000;
      const until = Math.min(t + 2 * 3_600_000, Math.max(t + 60_000, reset || t + (retry || 15 * 60_000)));
      await setState(env, 'github', { backoff_until: until, last_check: t });
      return finish('rate_limited', 'GitHub’s hourly limit for unauthenticated checks is used up. Screens will try again later.');
    }
    if (res.status === 404) return finish('error', `GitHub has no published releases for ${src.repo} (or the repository doesn’t exist).`);
    if (!res.ok) return finish('error', `GitHub answered HTTP ${res.status}.`);
    const body = await readJson<GhRelease | GhRelease[]>(res);
    const rel = Array.isArray(body) ? pickRelease(body, src.include_prereleases) : body;
    if (!rel || !rel.tag_name) return finish('error', 'No published release found.', { etag: res.headers.get('etag') });
    const picks = selectAssets(rel, src);
    if (!picks.length) return finish('error', `No APK in release ${rel.tag_name} matches “${src.asset_pattern}”${Object.keys(src.abi_patterns).length ? ' or the processor patterns' : ''}.`, { tag: rel.tag_name });
    const imported: ImportResult[] = [];
    for (const p of picks) {
      try { imported.push(await importAsset(env, cfg, src, rel, p.asset, p.abi, fetcher)); }
      catch (e: any) {
        imported.push({ asset: p.asset.name, abi: p.abi, status: 'error', detail: e.message });
        if (e instanceof SourceError && e.kind === 'signer') {
          await raiseAlert(env, { severity: 'warning', type: 'update.signer', title: `GitHub release of ${src.package} has a different signing key`, details: e.message, dedupe_key: `upd_signer:${src.package}:${rel.tag_name}` });
        }
      }
    }
    const errs = imported.filter((i) => i.status === 'error');
    await announce(env, src.package, imported).catch(() => undefined);
    // Keep the ETag only when everything went in, so a failed import is retried next time.
    return finish(errs.length ? 'error' : 'ok', errs.length ? errs.map((e) => e.detail).join(' ') : imported.some((i) => i.status === 'imported') ? `Imported ${rel.tag_name}.` : `${rel.tag_name} is already in the library.`,
      { etag: errs.length ? null : res.headers.get('etag'), tag: rel.tag_name }, imported);
  } catch (e: any) {
    return finish('error', e instanceof SourceError ? e.message : `Couldn’t reach GitHub: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

/** "Jellyfin 0.17.0 is available for 3 boxes" (one notification per version). */
async function announce(env: Env, pkg: string, imported: ImportResult[]) {
  const ids = imported.filter((i) => i.status === 'imported' && i.apk_id).map((i) => i.apk_id!);
  if (!ids.length) return;
  const top = await env.DB.prepare(`SELECT label, version_name, version_code FROM apks WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY version_code DESC LIMIT 1`).bind(...ids).first<Row>();
  if (!top) return;
  const n = (await env.DB.prepare(`SELECT count(*) n FROM device_apps a JOIN devices d ON d.id = a.device_id WHERE d.kind = 'android' AND a.package = ? AND a.system = 0 AND coalesce(a.version_code, 0) < ?`)
    .bind(pkg, top.version_code).first<Row>())?.n ?? 0;
  if (!n) return;
  await raiseAlert(env, { severity: 'info', type: 'update.available', title: `${top.label ?? pkg} ${top.version_name ?? ''} is available for ${n} box${n === 1 ? '' : 'es'}`.replace(/\s+/g, ' '), details: 'See Updates to install it now, or let the maintenance window do it.', dedupe_key: `upd_new:${pkg}:${top.version_code}` });
}

/** Sources not checked for 6 hours (or never). Called every minute by the cron; at most `limit` per call. */
export async function checkDueSources(env: Env, t: number, limit = 2): Promise<CheckResult[]> {
  const gh = await getState<{ backoff_until?: number | null }>(env, 'github', {});
  if (gh.backoff_until && gh.backoff_until > t) return [];
  const rows = (await env.DB.prepare('SELECT * FROM update_sources WHERE enabled = 1 AND (last_checked IS NULL OR last_checked < ?) ORDER BY coalesce(last_checked, 0) LIMIT ?').bind(t - CHECK_EVERY_MS, limit).all<Row>()).results;
  const out: CheckResult[] = [];
  for (const r of rows) out.push(await checkSource(env, r));
  return out;
}

/** "Check for updates now": every enabled source (or one), regardless of when it was last checked. */
export async function checkAllSources(env: Env, pkg?: string): Promise<CheckResult[]> {
  await ensureApkInfo(env, 10).catch(() => 0);
  const rows = (await env.DB.prepare(`SELECT * FROM update_sources WHERE enabled = 1 ${pkg ? 'AND package = ?' : ''} ORDER BY package LIMIT 50`).bind(...(pkg ? [pkg] : [])).all<Row>()).results;
  const out: CheckResult[] = [];
  for (const r of rows) out.push(await checkSource(env, r));
  return out;
}

/** Cron hook (every minute): read new library uploads, check due sources. */
export async function updatesCron(env: Env, t: number) {
  await ensureApkInfo(env, 3).catch((e) => console.error('apk inspect failed', e));
  await checkDueSources(env, t).catch((e) => console.error('update source check failed', e));
}

// App update manager (Android TV boxes): types shared by the Worker (src/worker/updates) and the dashboard,
// plus the pure decision logic both sides use: version order, maintenance windows, policy resolution,
// which APK fits which box, signer checks and rollout order. No Worker or DOM APIs in here.

import type { Job } from './types';

export type UpdateMode = 'auto' | 'notify' | 'pin';
/** Policy when nothing is set for a package: show the update, wait for a click. */
export const DEFAULT_UPDATE_MODE: UpdateMode = 'notify';
export const DEFAULT_WINDOW = { start: '03:00', end: '05:00' } as const;
export const LAUNCHER_PACKAGE = 'au.supercluster.screens.launcher';

/** App stores that keep their own apps up to date. Screens shows these apps but never installs over them. */
export const STORE_INSTALLERS: Record<string, string> = {
  'com.android.vending': 'Google Play',
  'com.amazon.venezia': 'Amazon Appstore',
};
export const isStoreInstaller = (installer?: string | null) => !!installer && installer in STORE_INSTALLERS;

// ---------------------------------------------------------------------------------------------- versions

/** Split "1.10.2-beta3" into numeric release parts and a pre-release tag. */
function splitVersion(v: string): { nums: number[]; pre: string | null } {
  const s = v.trim().replace(/^v(?=\d)/i, '');
  const m = s.match(/^(\d+(?:\.\d+)*)(.*)$/);
  if (!m) return { nums: [], pre: s || null };
  const rest = m[2].replace(/^[-+._ ]+/, '');
  // Build metadata / build numbers ("+123", " build 2") don't make a pre-release.
  const pre = /^(alpha|beta|rc|pre|preview|dev|snapshot|canary|nightly|a|b)\b/i.test(rest) || /^(alpha|beta|rc|pre|dev)\d/i.test(rest) ? rest.toLowerCase() : null;
  return { nums: m[1].split('.').map((x) => Number(x)), pre };
}

/** Compare two version names ("1.2.10" > "1.2.9", "2.0.0-beta1" < "2.0.0"). Returns -1, 0 or 1. */
export function compareVersionNames(a?: string | null, b?: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const x = splitVersion(a), y = splitVersion(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  if (x.pre && y.pre) return x.pre === y.pre ? 0 : x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0 ? 1 : -1;
  return 0;
}

export interface VersionRef { version_code?: number | null; version_name?: string | null }

/** Order two installs/builds of the same package: versionCode decides when both are known (it's what Android compares). */
export function compareVersions(a: VersionRef, b: VersionRef): number {
  if (a.version_code != null && b.version_code != null) return a.version_code === b.version_code ? 0 : a.version_code > b.version_code ? 1 : -1;
  return compareVersionNames(a.version_name, b.version_name);
}

export const versionText = (v: VersionRef) => v.version_name || (v.version_code != null ? `build ${v.version_code}` : 'unknown version');

// ---------------------------------------------------------------------------------------------- maintenance window

/** "03:00" → 180 (minutes after midnight), null when malformed. */
export function parseHm(s: unknown): number | null {
  const m = typeof s === 'string' ? s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export const fmtHm = (mins: number) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** Minutes after local midnight at `ts` in `tz` (wall clock, so DST is handled by Intl). */
export function localMinutes(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** Is `ts` inside the daily window [start, end) in the site's time zone? Windows may wrap midnight (23:00–02:00). */
export function inWindow(ts: number, tz: string, start: string, end: string): boolean {
  const s = parseHm(start), e = parseHm(end);
  if (s == null || e == null || s === e) return false;
  const t = localMinutes(ts, tz);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** The next time the window opens (epoch ms, minute precision), or `ts` itself when it's open now. */
export function nextWindowStart(ts: number, tz: string, start: string, end: string): number | null {
  const s = parseHm(start);
  if (s == null || parseHm(end) == null || start === end) return null;
  if (inWindow(ts, tz, start, end)) return ts;
  const base = Math.floor(ts / 60_000) * 60_000;
  let t = base + ((s - localMinutes(base, tz) + 1440) % 1440) * 60_000;
  // A DST change between now and then moves the wall clock by up to an hour: nudge onto the local start minute.
  for (const d of [0, -60, 60, -30, 30]) {
    const c = t + d * 60_000;
    if (c > ts && localMinutes(c, tz) === s) { t = c; break; }
  }
  return t;
}

// ---------------------------------------------------------------------------------------------- policies

export interface UpdatePolicyRow { package: string; scope_type: 'fleet' | 'site'; scope_id: string; mode: UpdateMode }

/** Site override, else fleet default for the package, else notify. */
export function resolveMode(pkg: string, siteId: string, policies: UpdatePolicyRow[]): { mode: UpdateMode; from: 'site' | 'fleet' | 'default' } {
  const site = policies.find((p) => p.package === pkg && p.scope_type === 'site' && p.scope_id === siteId);
  if (site) return { mode: site.mode, from: 'site' };
  const fleet = policies.find((p) => p.package === pkg && p.scope_type === 'fleet');
  if (fleet) return { mode: fleet.mode, from: 'fleet' };
  return { mode: DEFAULT_UPDATE_MODE, from: 'default' };
}

// ---------------------------------------------------------------------------------------------- signing

/** A signing certificate: SHA-256 of its DER encoding, plus the Java Arrays.hashCode that `dumpsys package` prints. */
export interface CertRef { sha256: string; java_hash: string; subject?: string | null }
/** One signer from an APK signature block. v3/v3.1 signers apply to a platform range and may carry a rotation lineage. */
export interface ApkSigner { min_sdk: number; max_sdk: number; certs: CertRef[]; lineage: CertRef[] }
export interface ApkSigning {
  /** Blocks present, strongest first. */
  schemes: ('v3.1' | 'v3' | 'v2' | 'v1')[];
  v31: ApkSigner[]; v3: ApkSigner[]; v2: ApkSigner[]; v1: ApkSigner[];
}

/** Android TV boxes we haven't read yet are most likely Android 11 (SDK 30). */
const ASSUMED_SDK = 30;

/**
 * The signer Android uses for this APK on a given platform version, following the platform's own order:
 * v3.1 (Android 13+), v3 (9+), v2 (7+), then the JAR signature.
 */
export function effectiveSigner(s: ApkSigning | null | undefined, sdk?: number | null): { scheme: string; certs: CertRef[]; lineage: CertRef[] } | null {
  if (!s) return null;
  const v = sdk ?? ASSUMED_SDK;
  const pick = (list: ApkSigner[]) => list.find((x) => x.min_sdk <= v && v <= x.max_sdk);
  const take = (scheme: string, x?: ApkSigner) => (x && x.certs.length ? { scheme, certs: x.certs, lineage: x.lineage } : null);
  return (v >= 33 ? take('v3.1', pick(s.v31)) : null)
    ?? (v >= 28 ? take('v3', pick(s.v3)) : null)
    ?? (v >= 24 ? take('v2', s.v2[0]) : null)
    ?? take('v1', s.v1[0])
    ?? take('v2', s.v2[0]);
}

/** What we know about the signer of the copy installed on a box. */
export interface BoxSigner { sha256?: string[] | null; java_hash?: string[] | null }
export type SignerVerdict = 'match' | 'mismatch' | 'unknown';

/**
 * Would Android accept this APK as an update of what the box has? The box's signer must be the APK's signer,
 * or a previous key in its proof-of-rotation lineage. SHA-256 (read from the installed APK) is preferred; the
 * 32-bit hash from dumpsys is a fallback. Android still enforces the real rule at install time.
 */
export function signerVerdict(apk: ApkSigning | null | undefined, box: BoxSigner | null | undefined, sdk?: number | null): SignerVerdict {
  const eff = effectiveSigner(apk, sdk);
  if (!eff || !box) return 'unknown';
  const all = [...eff.certs, ...eff.lineage];
  if (box.sha256?.length) return box.sha256.every((h) => all.some((c) => c.sha256 === h.toLowerCase())) ? 'match' : 'mismatch';
  if (box.java_hash?.length) return box.java_hash.every((h) => all.some((c) => c.java_hash === h.toLowerCase().replace(/^0+(?=.)/, ''))) ? 'match' : 'mismatch';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------- which APK fits a box

export interface UpdateCandidate {
  apk_id: string; package: string; version_code: number | null; version_name: string | null;
  /** Native ABIs the APK ships (lib/<abi>/). Empty = no native code, runs anywhere. */
  abis: string[];
  min_sdk: number | null;
  signing?: ApkSigning | null;
  source: 'library' | 'github';
  size: number; uploaded_at: number;
  /** GitHub release tag it came from. */
  tag?: string | null;
}

export interface BoxProfile {
  /** ro.product.cpu.abilist, primary first. Empty = not read yet. */
  abis: string[];
  /** Operator's choice of build for this box (one of `abis`), e.g. 32-bit builds on a 64-bit box. */
  abi_override?: string | null;
  sdk?: number | null;
}

export function abiCompatible(apkAbis: string[], box: BoxProfile): boolean {
  if (!apkAbis.length) return true;
  const want = box.abi_override ? [box.abi_override] : box.abis;
  return want.some((a) => apkAbis.includes(a));
}

/**
 * The newest APK this box can run. Ties on version prefer a build made for the box's primary ABI
 * (smallest download), then universal builds, then the most recent upload.
 */
export function pickCandidate(cands: UpdateCandidate[], box: BoxProfile): UpdateCandidate | null {
  const primary = box.abi_override ?? box.abis[0] ?? null;
  const ok = cands.filter((c) => (box.abis.length || !c.abis.length) && abiCompatible(c.abis, box) && (c.min_sdk == null || box.sdk == null || c.min_sdk <= box.sdk));
  const rank = (c: UpdateCandidate) => (primary && c.abis.includes(primary) ? 1000 - c.abis.length : c.abis.length === 0 ? 500 : 0);
  return ok.sort((a, b) => compareVersions(b, a) || rank(b) - rank(a) || b.uploaded_at - a.uploaded_at)[0] ?? null;
}

export const newestCandidate = (cands: UpdateCandidate[]) => [...cands].sort((a, b) => compareVersions(b, a) || b.uploaded_at - a.uploaded_at)[0] ?? null;

export type UpdateBoxState =
  | 'update'            // a newer compatible build is ready
  | 'current'           // already on the newest build Screens knows
  | 'ahead'             // newer than anything Screens has (never downgraded)
  | 'store'             // installed and kept up to date by Google Play / another store
  | 'pinned'            // policy keeps the current version
  | 'incompatible'      // newer builds exist, none for this box's processor / Android version
  | 'signer_mismatch'   // newer build is signed by a different developer key
  | 'no_source'         // Screens has no builds of this app
  | 'unknown';          // version or processor not read yet

export interface BoxStateInput {
  installed: VersionRef;
  installer?: string | null;
  mode: UpdateMode;
  cands: UpdateCandidate[];
  box: BoxProfile;
  signer?: BoxSigner | null;
}

export function boxState(i: BoxStateInput): { state: UpdateBoxState; candidate: UpdateCandidate | null; detail: string } {
  if (isStoreInstaller(i.installer)) return { state: 'store', candidate: null, detail: `Installed from ${STORE_INSTALLERS[i.installer!]}, which keeps it up to date.` };
  const newest = newestCandidate(i.cands);
  if (!newest) return { state: 'no_source', candidate: null, detail: 'Screens has no builds of this app. Upload one to the library or add a GitHub source.' };
  if (i.installed.version_code == null && !i.installed.version_name) return { state: 'unknown', candidate: null, detail: 'The installed version hasn’t been read yet.' };
  const cmp = compareVersions(i.installed, newest);
  if (cmp > 0) return { state: 'ahead', candidate: null, detail: `Newer than the newest build Screens has (${versionText(newest)}). Screens never downgrades.` };
  if (cmp === 0) return { state: 'current', candidate: null, detail: 'Up to date.' };
  if (i.mode === 'pin') return { state: 'pinned', candidate: null, detail: `Pinned. ${versionText(newest)} is available.` };
  if (!i.box.abis.length && newest.abis.length) return { state: 'unknown', candidate: null, detail: 'Waiting to read which processor type this box has.' };
  const best = pickCandidate(i.cands, i.box);
  if (!best || compareVersions(best, i.installed) <= 0) {
    const sdkBlocked = newest.min_sdk != null && i.box.sdk != null && newest.min_sdk > i.box.sdk;
    return {
      state: 'incompatible', candidate: null,
      detail: sdkBlocked ? `${versionText(newest)} needs a newer Android version than this box has.` : `${versionText(newest)} has no build for this box’s processor (${(i.box.abi_override ?? i.box.abis[0]) || 'unknown'}).`,
    };
  }
  const v = signerVerdict(best.signing, i.signer, i.box.sdk);
  if (v === 'mismatch') return { state: 'signer_mismatch', candidate: best, detail: `${versionText(best)} is signed with a different developer key than the installed app, so Android would refuse it. Screens won’t uninstall to force it.` };
  return { state: 'update', candidate: best, detail: `${versionText(i.installed)} → ${versionText(best)}` };
}

/** Rollout order: the chosen canary first (if it's online), then online boxes by name, offline ones last. */
export function rolloutOrder<T extends { id: string; name: string; online: boolean }>(boxes: T[], preferredCanary?: string | null): T[] {
  return [...boxes].sort((a, b) => {
    const pa = a.id === preferredCanary && a.online ? 0 : 1, pb = b.id === preferredCanary && b.online ? 0 : 1;
    return pa - pb || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

/** Asset file name glob: `*` and `?` only, matched case-insensitively against the whole name. */
export function globMatch(pattern: string, name: string): boolean {
  const re = pattern.trim().split('*').map((p) => p.split('?').map((x) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*');
  return new RegExp(`^${re}$`, 'i').test(name);
}

// ---------------------------------------------------------------------------------------------- API shapes

/** A GitHub releases source for one package. */
export interface UpdateSource {
  package: string; kind: 'github';
  repo: string;                          // owner/repo
  asset_pattern: string;                 // e.g. "*.apk" (used for boxes without a more specific ABI pattern)
  abi_patterns: Record<string, string>;  // e.g. { "arm64-v8a": "*arm64*.apk", "armeabi-v7a": "*armeabi-v7a*.apk" }
  include_prereleases: boolean;
  enabled: boolean;
  /** Trusted signing key (SHA-256), learnt from the first release imported. Later releases must match. */
  signer_sha256?: string | null;
  last_checked?: number | null; last_status?: 'ok' | 'not_modified' | 'error' | 'rate_limited' | null;
  last_error?: string | null; latest_tag?: string | null;
  created_at: number; updated_at: number;
}

export interface UpdateBox {
  device_id: string; device_name: string; site_id: string; site_name: string;
  online: boolean;
  version_name: string | null; version_code: number | null;
  installer: string | null;
  state: UpdateBoxState; detail: string;
  mode: UpdateMode; mode_from: 'site' | 'fleet' | 'default';
  candidate?: { apk_id: string; version_code: number | null; version_name: string | null; abis: string[] } | null;
  /** An update for this box is queued or running right now. */
  busy?: boolean;
  last_result?: { status: 'ok' | 'error'; detail: string; at: number; job_id: string } | null;
}

export interface UpdatePackage {
  package: string; label: string;
  builtin: boolean;                      // the Screens Launcher
  latest: UpdateCandidate | null;        // newest build Screens has (any processor)
  versions: UpdateCandidate[];           // builds in the library, newest first
  source: UpdateSource | null;
  fleet_mode: UpdateMode | null;         // explicit fleet default (null = notify)
  site_modes: Record<string, UpdateMode>;
  boxes: UpdateBox[];
  counts: { boxes: number; update: number; store: number; current: number; blocked: number };
}

export interface UpdateSiteSettings {
  site_id: string; site_name: string; timezone: string;
  window_start: string; window_end: string;
  canary_device_id: string | null;
  in_window: boolean; next_window_at: number | null;
  gateway_online: boolean;
}

export type RolloutStatus = 'canary' | 'rolling' | 'done' | 'failed' | 'cancelled';
export type RolloutDeviceStatus = 'pending' | 'installing' | 'verifying' | 'ok' | 'failed' | 'skipped' | 'waiting';
export interface RolloutDevice {
  device_id: string; name: string; status: RolloutDeviceStatus; detail?: string | null; job_id?: string | null; at?: number | null;
  canary?: boolean; tries?: number;
  /** Chosen by hand from the box's page: installed even if someone is using the box. */
  force?: boolean;
}

export interface UpdateRollout {
  id: string; site_id: string; site_name?: string | null;
  package: string; label: string | null;
  version_code: number | null; version_name: string | null;
  trigger: 'auto' | 'manual';
  status: RolloutStatus;
  devices: RolloutDevice[];
  detail: string | null; actor: string | null;
  created_at: number; updated_at: number; finished_at: number | null;
}

export interface UpdateDeviceInfo {
  device_id: string; name: string; site_id: string; site_name: string; online: boolean;
  model: string | null; sdk: number | null;
  abis: string[]; abi_override: string | null; probed_at: number | null;
}

export interface UpdatesOverview {
  packages: UpdatePackage[];
  sites: UpdateSiteSettings[];
  devices: UpdateDeviceInfo[];
  rollouts: UpdateRollout[];
  jobs: Job[];
  github: { backoff_until: number | null; last_check: number | null };
  summary: UpdatesSummary;
}

export interface UpdatesSummary {
  /** Box × app pairs with an update ready. */
  available: number;
  apps_with_updates: number;
  boxes_with_updates: number;
  auto_apps: number;
  store_managed: number;
  failed_7d: number;
  running: number;
  last_check: number | null;
  top: { package: string; label: string; to: string; boxes: number }[];
}

export interface DeviceUpdateItem {
  package: string; label: string;
  installed: string | null; available: string | null;
  state: UpdateBoxState; detail: string; mode: UpdateMode;
  apk_id?: string | null; busy?: boolean;
}
export interface DeviceUpdates { device_id: string; items: DeviceUpdateItem[]; probed_at: number | null; abis: string[] }

/** POST /api/updates/run */
export interface UpdateRunRequest { package: string; site_id?: string; device_id?: string }
export interface UpdateRunResult { rollouts: UpdateRollout[]; skipped: { site_id: string; reason: string }[] }

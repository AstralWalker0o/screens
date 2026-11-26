// Mock of the app update manager (/api/updates/*). Uses the same decision logic as the Worker
// (src/shared/updates.ts), so states, ordering and windows behave like the real thing.

import { ApiError } from '../api';
import type { Alert, Apk, Device, DeviceApp, Job } from '../../shared/types';
import type {
  ApkSigning, BoxSigner, DeviceUpdates, RolloutDevice, UpdateBox, UpdateCandidate, UpdateCheckResult, UpdateDeviceInfo, UpdateMode, UpdatePackage,
  UpdatePolicyRow, UpdateRollout, UpdateSiteSettings, UpdateSource, UpdatesOverview, UpdatesSummary,
} from '../../shared/updates';
import {
  boxState, DEFAULT_WINDOW, inWindow, LAUNCHER_PACKAGE, newestCandidate, nextWindowStart, parseHm, resolveMode, rolloutOrder, versionText,
} from '../../shared/updates';
import { D, H, M, NOW } from './data';
import { hex } from './rand';

interface MockDb {
  sites: { id: string; name: string; timezone: string }[];
  devices: Device[];
  apps: Record<string, DeviceApp[]>;
  apks: Apk[];
  jobs: Job[];
  alerts: Alert[];
}
type Ctx = { params: string[]; q: URLSearchParams; body: unknown };
type On = (method: string, pattern: string, h: (c: Ctx) => unknown) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const err = (status: number, code: string, message: string) => new ApiError(status, code, message);
const ARM = ['arm64-v8a', 'armeabi-v7a', 'armeabi'];
const cert = (seed: string) => ({ sha256: seed.repeat(64).slice(0, 64), java_hash: seed.repeat(8).slice(0, 8) });
const K_ST = cert('5a'), K_PROJ = cert('7c'), K_PROJ_NEW = cert('e1'), K_JF = cert('3b'), K_LAUNCHER = cert('9d');
const signed = (c: { sha256: string; java_hash: string }): ApkSigning => ({ schemes: ['v2'], v31: [], v3: [], v2: [{ min_sdk: 0, max_sdk: 0x7fffffff, certs: [c], lineage: [] }], v1: [] });
const PLAY = new Set(['com.netflix.ninja', 'com.google.android.youtube.tv', 'com.plexapp.android', 'au.com.stan.and', 'com.disney.disneyplus', 'com.amazon.amazonvideo.livingroom',
  'com.spotify.tv.android', 'au.net.abc.iview', 'com.mxtech.videoplayer.ad', 'tv.pluto.android']);

const app = (pkg: string, label: string, version_name: string, o: Partial<DeviceApp> = {}): DeviceApp => ({
  package: pkg, label, version_name, version_code: null, system: false, enabled: true, permissions: [], category: null, risk: null, first_seen: NOW - 40 * D, last_seen: NOW - 5 * M, ...o,
});

export function registerUpdates(on: On, db: MockDb) {
  // ------------------------------------------------------------------------------------------ seed
  db.apps.dev_lr_shield?.push(app('org.jellyfin.androidtv', 'Jellyfin', '0.16.11', { category: 'streaming' }));
  db.apps.dev_beach_shield?.push(app('org.jellyfin.androidtv', 'Jellyfin', '0.16.11', { category: 'streaming' }), app(LAUNCHER_PACKAGE, 'Screens Launcher', '1.0.2', { category: 'launcher' }));
  db.apps.dev_beach_bed_shield?.push(app(LAUNCHER_PACKAGE, 'Screens Launcher', '1.0.1', { category: 'launcher' }));

  const extraApks: (Apk & { abis: string[]; source: 'library' | 'github'; tag?: string; signing: ApkSigning })[] = [
    { id: 'apk_st_2912_a64', package: 'com.teamsmart.videomanager.tv', label: 'SmartTube', version_name: '29.12', version_code: 2912, sha256: hex(64), size: 31_204_115, notes: 'From GitHub yuliskov/SmartTube v29.12 (arm64-v8a)', uploaded_at: NOW - 20 * H, abis: ['arm64-v8a'], source: 'github', tag: 'v29.12', signing: signed(K_ST) },
    { id: 'apk_st_2912_v7', package: 'com.teamsmart.videomanager.tv', label: 'SmartTube', version_name: '29.12', version_code: 2912, sha256: hex(64), size: 28_771_032, notes: 'From GitHub yuliskov/SmartTube v29.12', uploaded_at: NOW - 20 * H, abis: ['armeabi-v7a'], source: 'github', tag: 'v29.12', signing: signed(K_ST) },
    { id: 'apk_jf_0170', package: 'org.jellyfin.androidtv', label: 'Jellyfin', version_name: '0.17.0', version_code: 1700, sha256: hex(64), size: 27_510_902, notes: 'From GitHub jellyfin/jellyfin-androidtv v0.17.0', uploaded_at: NOW - 3 * D, abis: [], source: 'github', tag: 'v0.17.0', signing: signed(K_JF) },
    { id: 'apk_proj_465', package: 'com.spocky.projengmenu', label: 'Projectivy Launcher', version_name: '4.65', version_code: 465, sha256: hex(64), size: 9_530_118, notes: 'Downloaded from a mirror', uploaded_at: NOW - 2 * D, abis: [], source: 'library', signing: signed(K_PROJ_NEW) },
    { id: 'apk_launcher_10002', package: LAUNCHER_PACKAGE, label: 'Screens Launcher', version_name: '1.0.2', version_code: 10002, sha256: hex(64), size: 2_311_204, notes: 'Built-in: kiosk launcher + welcome screen', uploaded_at: NOW - 4 * D, abis: [], source: 'library', signing: signed(K_LAUNCHER) },
  ];
  db.apks.unshift(...extraApks.map(({ abis: _a, source: _s, tag: _t, signing: _g, ...a }) => a));
  const meta = new Map<string, { abis: string[]; source: 'library' | 'github'; tag?: string; signing: ApkSigning }>(extraApks.map((a) => [a.id, a]));
  meta.set('apk_smarttube', { abis: ['arm64-v8a', 'armeabi-v7a'], source: 'library', signing: signed(K_ST) });
  meta.set('apk_projectivy', { abis: [], source: 'library', signing: signed(K_PROJ) });

  const signers: Record<string, BoxSigner> = {
    'dev_lr_shield|com.spocky.projengmenu': { java_hash: [K_PROJ.java_hash] },
    'dev_lr_shield|com.teamsmart.videomanager.tv': { sha256: [K_ST.sha256] },
  };
  const sources: UpdateSource[] = [
    { package: 'com.teamsmart.videomanager.tv', kind: 'github', repo: 'yuliskov/SmartTube', asset_pattern: '*stable*armeabi-v7a.apk', abi_patterns: { 'arm64-v8a': '*stable*arm64-v8a.apk' }, include_prereleases: false, enabled: true,
      signer_sha256: K_ST.sha256, last_checked: NOW - 2 * H - 10 * M, last_status: 'not_modified', last_error: null, latest_tag: 'v29.12', created_at: NOW - 30 * D, updated_at: NOW - 30 * D },
    { package: 'org.jellyfin.androidtv', kind: 'github', repo: 'jellyfin/jellyfin-androidtv', asset_pattern: '*.apk', abi_patterns: {}, include_prereleases: false, enabled: true,
      signer_sha256: K_JF.sha256, last_checked: NOW - 2 * H - 9 * M, last_status: 'ok', last_error: null, latest_tag: 'v0.17.0', created_at: NOW - 30 * D, updated_at: NOW - 30 * D },
  ];
  let policies: UpdatePolicyRow[] = [
    { package: 'com.teamsmart.videomanager.tv', scope_type: 'fleet', scope_id: '', mode: 'auto' },
    { package: LAUNCHER_PACKAGE, scope_type: 'fleet', scope_id: '', mode: 'auto' },
    { package: 'org.jellyfin.androidtv', scope_type: 'site', scope_id: 's_beach', mode: 'pin' },
  ];
  const windows: Record<string, { window_start: string; window_end: string; canary_device_id: string | null }> = {
    s_beach: { window_start: '03:00', window_end: '05:00', canary_device_id: 'dev_beach_shield' },
  };
  const devInfo: Record<string, { abis: string[]; sdk: number; abi_override: string | null; probed_at: number }> = {};
  for (const d of db.devices.filter((x) => x.kind === 'android')) devInfo[d.id] = { abis: ARM, sdk: 30, abi_override: null, probed_at: NOW - 3 * H - 20 * M };

  let jobSeq = 500;
  const addJob = (o: Partial<Job> & { params: Record<string, unknown> }): Job => {
    const d = db.devices.find((x) => x.id === o.device_id);
    const j: Job = { id: `j_upd_${jobSeq++}`, kind: 'app_update', status: 'ok', actor: 'automation:updates', created_at: Date.now(), finished_at: Date.now(), site_id: d?.site_id, site_name: db.sites.find((s) => s.id === d?.site_id)?.name, device_name: d?.name, ...o };
    db.jobs.unshift(j);
    return j;
  };
  const rd = (id: string, status: RolloutDevice['status'], detail: string, canary = false, at = NOW): RolloutDevice => ({ device_id: id, name: db.devices.find((d) => d.id === id)?.name ?? id, status, detail, canary, at });
  const rollouts: UpdateRollout[] = [
    { id: 'upd_proj', site_id: 's_home', package: 'com.spocky.projengmenu', label: 'Projectivy Launcher', version_code: 465, version_name: '4.65', trigger: 'manual', status: 'failed',
      devices: [rd('dev_lr_shield', 'failed', 'The new build is signed with a different developer key than the app on this box, so Android would refuse it. Nothing was changed. Screens never uninstalls to force an update.', true, NOW - 26 * H)],
      detail: 'Updated 0 of 1 box, 1 failed', actor: 'owner@supercluster.au', created_at: NOW - 26 * H, updated_at: NOW - 26 * H, finished_at: NOW - 26 * H },
    { id: 'upd_launcher', site_id: 's_beach', package: LAUNCHER_PACKAGE, label: 'Screens Launcher', version_code: 10002, version_name: '1.0.2', trigger: 'auto', status: 'done',
      devices: [rd('dev_beach_shield', 'ok', 'Updated from 1.0.1 to 1.0.2. The Screens Launcher answered after the update.', true, NOW - 2 * D), rd('dev_beach_bed_shield', 'skipped', 'The box is offline. Gave up after 24 tries.', false, NOW - 2 * D + 2 * H)],
      detail: 'Updated 1 of 2 boxes, 1 skipped', actor: 'automation:updates', created_at: NOW - 2 * D - 30 * M, updated_at: NOW - 2 * D + 2 * H, finished_at: NOW - 2 * D + 2 * H },
    { id: 'upd_st', site_id: 's_home', package: 'com.teamsmart.videomanager.tv', label: 'SmartTube', version_code: 2866, version_name: '28.66', trigger: 'auto', status: 'done',
      devices: [rd('dev_lr_shield', 'ok', 'Updated from 28.50 to 28.66. Opened and came to the front.', true, NOW - 12 * D)],
      detail: 'Updated 1 of 1 box', actor: 'automation:updates', created_at: NOW - 12 * D, updated_at: NOW - 12 * D, finished_at: NOW - 12 * D },
  ];
  addJob({ device_id: 'dev_lr_shield', status: 'ok', created_at: NOW - 12 * D, finished_at: NOW - 12 * D + 48_000, params: { package: 'com.teamsmart.videomanager.tv', label: 'SmartTube', from: '28.50', to: '28.66', canary: true, rollout_id: 'upd_st' }, result: { ok: true, detail: 'Updated from 28.50 to 28.66. Opened and came to the front.' } });
  addJob({ device_id: 'dev_beach_shield', status: 'ok', created_at: NOW - 2 * D, finished_at: NOW - 2 * D + 21_000, params: { package: LAUNCHER_PACKAGE, label: 'Screens Launcher', from: '1.0.1', to: '1.0.2', canary: true, rollout_id: 'upd_launcher' }, result: { ok: true, detail: 'Updated from 1.0.1 to 1.0.2. The Screens Launcher answered after the update.' } });
  addJob({ device_id: 'dev_lr_shield', status: 'error', actor: 'owner@supercluster.au', created_at: NOW - 26 * H, finished_at: NOW - 26 * H + 4_000, params: { package: 'com.spocky.projengmenu', label: 'Projectivy Launcher', from: '4.62', to: '4.65', canary: true, rollout_id: 'upd_proj' }, result: { ok: false, detail: rollouts[0].devices[0].detail } });
  db.jobs.sort((a, b) => b.created_at - a.created_at);
  db.alerts.push({ id: 'al_upd_proj', at: NOW - 26 * H, severity: 'warning', type: 'update.failed', site_id: 's_home', device_id: 'dev_lr_shield', title: 'Projectivy Launcher update failed on Living Room Shield',
    details: `${rollouts[0].devices[0].detail} The rollout was stopped, so no other box at this site was changed.`, site_name: 'Home', device_name: 'Living Room Shield' });

  // ------------------------------------------------------------------------------------------ view
  const candidates = (): Map<string, UpdateCandidate[]> => {
    const m = new Map<string, UpdateCandidate[]>();
    for (const a of db.apks) {
      if (!a.package) continue;
      const x = meta.get(a.id);
      const c: UpdateCandidate = { apk_id: a.id, package: a.package, version_code: a.version_code ?? null, version_name: a.version_name ?? null, abis: x?.abis ?? [], min_sdk: 21, signing: x?.signing ?? null, source: x?.source ?? 'library', size: a.size, uploaded_at: a.uploaded_at, tag: x?.tag ?? null };
      m.set(a.package, [...(m.get(a.package) ?? []), c]);
    }
    return m;
  };
  const isActive = (r: UpdateRollout) => r.status === 'canary' || r.status === 'rolling';
  const androids = () => db.devices.filter((d) => d.kind === 'android');
  const siteName = (id: string) => db.sites.find((s) => s.id === id)?.name ?? id;
  const online = (d: Device) => d.status === 'online' || d.status === 'standby';

  function box(d: Device, a: DeviceApp, cands: UpdateCandidate[]): UpdateBox {
    const m = resolveMode(a.package, d.site_id, policies);
    const info = devInfo[d.id];
    const installer = PLAY.has(a.package) ? 'com.android.vending' : null;
    const st = boxState({ installed: { version_code: a.version_code ?? null, version_name: a.version_name ?? null }, installer, mode: m.mode, cands, box: { abis: info?.abis ?? [], abi_override: info?.abi_override, sdk: info?.sdk }, signer: signers[`${d.id}|${a.package}`] ?? null });
    const job = db.jobs.find((j) => j.kind === 'app_update' && j.device_id === d.id && (j.params as { package?: string }).package === a.package && j.status !== 'running');
    return {
      device_id: d.id, device_name: d.name, site_id: d.site_id, site_name: siteName(d.site_id), online: online(d), version_name: a.version_name ?? null, version_code: a.version_code ?? null,
      installer, state: st.state, detail: st.detail, mode: m.mode, mode_from: m.from,
      candidate: st.candidate ? { apk_id: st.candidate.apk_id, version_code: st.candidate.version_code, version_name: st.candidate.version_name, abis: st.candidate.abis } : null,
      busy: rollouts.some((r) => isActive(r) && r.package === a.package && r.devices.some((x) => x.device_id === d.id && ['pending', 'installing', 'verifying', 'waiting'].includes(x.status))),
      last_result: job ? { status: job.status === 'ok' ? 'ok' : 'error', detail: String((job.result as { detail?: string })?.detail ?? ''), at: job.created_at, job_id: job.id } : null,
    };
  }

  function packages(filterDevice?: string): UpdatePackage[] {
    const cands = candidates();
    const byPkg = new Map<string, { d: Device; a: DeviceApp }[]>();
    for (const d of androids().filter((x) => !filterDevice || x.id === filterDevice)) for (const a of db.apps[d.id] ?? []) if (!a.system) byPkg.set(a.package, [...(byPkg.get(a.package) ?? []), { d, a }]);
    const all = new Set([...byPkg.keys(), ...(filterDevice ? [] : [...cands.keys(), ...sources.map((s) => s.package)])]);
    const out: UpdatePackage[] = [];
    for (const pkg of all) {
      const list = cands.get(pkg) ?? [];
      const boxes = (byPkg.get(pkg) ?? []).map(({ d, a }) => box(d, a, list)).sort((x, y) => x.site_name.localeCompare(y.site_name) || x.device_name.localeCompare(y.device_name));
      const label = byPkg.get(pkg)?.[0]?.a.label ?? db.apks.find((x) => x.package === pkg)?.label ?? pkg;
      const site_modes: Record<string, UpdateMode> = {};
      for (const p of policies) if (p.package === pkg && p.scope_type === 'site') site_modes[p.scope_id] = p.mode;
      const count = (s: UpdateBox['state'][]) => boxes.filter((b) => s.includes(b.state)).length;
      out.push({
        package: pkg, label, builtin: pkg === LAUNCHER_PACKAGE, latest: newestCandidate(list),
        versions: [...list].sort((a, b) => (b.version_code ?? 0) - (a.version_code ?? 0) || b.uploaded_at - a.uploaded_at),
        source: sources.find((s) => s.package === pkg) ?? null, fleet_mode: policies.find((p) => p.package === pkg && p.scope_type === 'fleet')?.mode ?? null, site_modes, boxes,
        counts: { boxes: boxes.length, update: count(['update']), store: count(['store']), current: count(['current', 'ahead']), blocked: count(['incompatible', 'signer_mismatch']) },
      });
    }
    const rank = (p: UpdatePackage) => (p.counts.update ? 0 : p.latest || p.source ? 1 : p.counts.store ? 3 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }

  function siteSettings(): UpdateSiteSettings[] {
    const t = Date.now();
    return db.sites.map((s) => {
      const w = windows[s.id] ?? { window_start: DEFAULT_WINDOW.start, window_end: DEFAULT_WINDOW.end, canary_device_id: null };
      return { site_id: s.id, site_name: s.name, timezone: s.timezone, ...w, in_window: inWindow(t, s.timezone, w.window_start, w.window_end), next_window_at: nextWindowStart(t, s.timezone, w.window_start, w.window_end), gateway_online: s.id !== 's_office' };
    }).sort((a, b) => a.site_name.localeCompare(b.site_name));
  }

  function summary(pkgs: UpdatePackage[]): UpdatesSummary {
    const withUpd = pkgs.filter((p) => p.counts.update > 0);
    return {
      available: withUpd.reduce((a, p) => a + p.counts.update, 0), apps_with_updates: withUpd.length,
      boxes_with_updates: new Set(withUpd.flatMap((p) => p.boxes.filter((b) => b.state === 'update').map((b) => b.device_id))).size,
      auto_apps: pkgs.filter((p) => p.fleet_mode === 'auto' || Object.values(p.site_modes).includes('auto')).length,
      store_managed: pkgs.filter((p) => p.counts.store > 0).length,
      failed_7d: db.jobs.filter((j) => j.kind === 'app_update' && j.status === 'error' && j.created_at > Date.now() - 7 * D).length,
      running: rollouts.filter(isActive).length, last_check: Math.max(...sources.map((s) => s.last_checked ?? 0)) || null,
      top: withUpd.slice(0, 4).map((p) => ({ package: p.package, label: p.label, to: p.latest ? versionText(p.latest) : '', boxes: p.counts.update })),
    };
  }

  function overview(): UpdatesOverview {
    const pkgs = packages();
    const devices: UpdateDeviceInfo[] = androids().map((d) => ({
      device_id: d.id, name: d.name, site_id: d.site_id, site_name: siteName(d.site_id), online: online(d), model: d.model ?? null,
      sdk: devInfo[d.id]?.sdk ?? null, abis: devInfo[d.id]?.abis ?? [], abi_override: devInfo[d.id]?.abi_override ?? null, probed_at: devInfo[d.id]?.probed_at ?? null,
    }));
    return {
      packages: pkgs, sites: siteSettings(), devices,
      rollouts: [...rollouts].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.created_at - a.created_at).map((r) => ({ ...r, site_name: siteName(r.site_id) })),
      jobs: db.jobs.filter((j) => j.kind === 'app_update').slice(0, 40), github: { backoff_until: null, last_check: NOW - 2 * H - 9 * M }, summary: summary(pkgs),
    };
  }

  // ------------------------------------------------------------------------------------------ simulated rollouts
  async function drive(r: UpdateRollout) {
    const save = () => { r.updated_at = Date.now(); };
    const cancelled = () => (r.status as string) === 'cancelled'; // changes while we sleep
    for (const d of r.devices) {
      if (cancelled()) return;
      const dev = db.devices.find((x) => x.id === d.device_id)!;
      if (!online(dev)) { d.status = 'waiting'; d.detail = 'The box is offline'; d.tries = 1; d.at = Date.now(); if (d.canary) { d.canary = false; const n = r.devices.find((x) => x.status === 'pending'); if (n) n.canary = true; } save(); continue; }
      d.status = 'installing'; d.at = Date.now(); save();
      await sleep(1800);
      if (cancelled()) return;
      d.status = 'verifying'; save();
      await sleep(900);
      const a = db.apps[d.device_id]?.find((x) => x.package === r.package);
      const from = a?.version_name ?? null;
      if (a) a.version_name = r.version_name;
      d.status = 'ok'; d.at = Date.now();
      d.detail = `Updated from ${from ?? 'the old version'} to ${r.version_name}. ${d.canary ? 'Opened and came to the front.' : 'Verified the new version.'}`;
      const j = addJob({ device_id: d.device_id, actor: r.actor ?? 'you', params: { package: r.package, label: r.label, from, to: r.version_name, canary: !!d.canary, rollout_id: r.id }, result: { ok: true, detail: d.detail } });
      d.job_id = j.id;
      if (d.canary && r.status === 'canary') { r.status = 'rolling'; r.detail = r.devices.length > 1 ? `Canary ${d.name} passed: updating the other boxes` : null; }
      save();
    }
    if (r.devices.some((d) => d.status === 'waiting')) { r.status = 'rolling'; r.detail = 'Waiting for boxes that are offline or in use; Screens tries again every few minutes.'; return; }
    const ok = r.devices.filter((d) => d.status === 'ok').length;
    r.status = 'done'; r.finished_at = Date.now(); r.detail = `Updated ${ok} of ${r.devices.length} box${r.devices.length === 1 ? '' : 'es'}`; save();
  }

  function startRollout(pkg: UpdatePackage, boxes: UpdateBox[]): UpdateRollout {
    const vc = Math.max(...boxes.map((b) => b.candidate?.version_code ?? 0));
    const target = boxes.filter((b) => (b.candidate?.version_code ?? 0) === vc);
    const w = windows[target[0].site_id];
    const ordered = rolloutOrder(target.map((b) => ({ id: b.device_id, name: b.device_name, online: b.online })), w?.canary_device_id);
    const r: UpdateRollout = {
      id: `upd_${hex(8)}`, site_id: target[0].site_id, site_name: target[0].site_name, package: pkg.package, label: pkg.label, version_code: vc, version_name: target[0].candidate?.version_name ?? null,
      trigger: 'manual', status: 'canary', devices: ordered.map((b, i) => ({ device_id: b.id, name: b.name, status: 'pending', canary: i === 0 })),
      detail: ordered.length > 1 ? `Canary: ${ordered[0].name}` : null, actor: 'owner@supercluster.au', created_at: Date.now(), updated_at: Date.now(), finished_at: null,
    };
    rollouts.unshift(r);
    void drive(r);
    return r;
  }

  // ------------------------------------------------------------------------------------------ routes
  const b = <T,>(c: Ctx) => (c.body ?? {}) as T;
  on('GET', '/api/updates', () => overview());
  on('GET', '/api/updates/summary', () => summary(packages()));
  on('GET', '/api/updates/device/:id', (c): DeviceUpdates => {
    const id = c.params[0];
    const items = packages(id).flatMap((p) => p.boxes.map((x) => ({
      package: p.package, label: p.label, installed: x.version_name, available: x.candidate ? versionText(x.candidate) : null, state: x.state, detail: x.detail, mode: x.mode, apk_id: x.candidate?.apk_id ?? null, busy: x.busy,
    }))).filter((i) => i.state !== 'no_source');
    return { device_id: id, items, probed_at: devInfo[id]?.probed_at ?? null, abis: devInfo[id]?.abis ?? [] };
  });
  on('PUT', '/api/updates/policies', (c) => {
    const x = b<{ package: string; scope_type?: 'fleet' | 'site'; scope_id?: string | null; mode: UpdateMode | null }>(c);
    const scope = x.scope_type === 'site' ? 'site' : 'fleet', id = scope === 'site' ? String(x.scope_id ?? '') : '';
    policies = policies.filter((p) => !(p.package === x.package && p.scope_type === scope && p.scope_id === id));
    if (x.mode) policies.push({ package: x.package, scope_type: scope, scope_id: id, mode: x.mode });
    return { ok: true };
  });
  on('POST', '/api/updates/sources', async (c) => {
    const x = b<Partial<UpdateSource> & { package: string }>(c);
    const repo = String(x.repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repo)) throw err(400, 'bad_request', 'Enter the GitHub repository as owner/name, e.g. jellyfin/jellyfin-androidtv');
    await sleep(1300);
    const existing = sources.find((s) => s.package === x.package);
    const src: UpdateSource = { package: x.package, kind: 'github', repo, asset_pattern: x.asset_pattern || '*.apk', abi_patterns: x.abi_patterns ?? {}, include_prereleases: !!x.include_prereleases, enabled: x.enabled !== false,
      signer_sha256: existing?.repo === repo ? existing.signer_sha256 : null, last_checked: Date.now(), last_status: 'ok', last_error: null, latest_tag: existing?.latest_tag ?? null, created_at: existing?.created_at ?? Date.now(), updated_at: Date.now() };
    const check: UpdateCheckResult = { package: x.package, status: 'ok', detail: 'Already in the library.', imported: [] };
    if (!candidates().get(x.package)?.length) {
      // First release for this app: pretend one build was downloaded (a little newer than what's installed).
      const installed = Object.values(db.apps).flat().find((a) => a.package === x.package);
      const parts = (installed?.version_name ?? '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
      parts[parts.length - 1]++;
      const v = parts.join('.');
      const id = `apk_${hex(6)}`;
      db.apks.unshift({ id, package: x.package, label: installed?.label ?? x.package, version_name: v, version_code: null, sha256: hex(64), size: 18_400_000, notes: `From GitHub ${repo} v${v}`, uploaded_at: Date.now() });
      meta.set(id, { abis: [], source: 'github', tag: `v${v}`, signing: signed(cert('42')) });
      src.signer_sha256 = cert('42').sha256; src.latest_tag = `v${v}`;
      check.detail = `Imported v${v}.`; check.tag = `v${v}`;
      check.imported.push({ asset: `${repo.split('/')[1]}-v${v}.apk`, abi: null, status: 'imported', version: v, apk_id: id });
    }
    const i = sources.findIndex((s) => s.package === x.package);
    if (i >= 0) sources[i] = src; else sources.push(src);
    return { source: src, check };
  });
  on('PATCH', '/api/updates/sources/:pkg', (c) => {
    const s = sources.find((x) => x.package === c.params[0]);
    if (!s) throw err(404, 'not_found', 'No update source for that app');
    const x = b<Partial<UpdateSource> & { reset_signer?: boolean }>(c);
    Object.assign(s, { ...x, reset_signer: undefined, signer_sha256: x.reset_signer ? null : s.signer_sha256, updated_at: Date.now() });
    return s;
  });
  on('DELETE', '/api/updates/sources/:pkg', (c) => {
    const i = sources.findIndex((x) => x.package === c.params[0]);
    if (i >= 0) sources.splice(i, 1);
    return { ok: true };
  });
  on('POST', '/api/updates/check', async (c) => {
    const only = b<{ package?: string }>(c).package;
    await sleep(1400);
    const results: UpdateCheckResult[] = sources.filter((s) => s.enabled && (!only || s.package === only)).map((s) => {
      s.last_checked = Date.now(); s.last_status = 'not_modified';
      return { package: s.package, status: 'not_modified', detail: 'No new release.', imported: [], tag: s.latest_tag };
    });
    return { results };
  });
  on('PUT', '/api/updates/sites/:id', (c) => {
    const id = c.params[0];
    if (!db.sites.some((s) => s.id === id)) throw err(404, 'not_found', 'Site not found');
    const x = b<{ window_start: string; window_end: string; canary_device_id: string | null }>(c);
    if (parseHm(x.window_start) == null || parseHm(x.window_end) == null) throw err(400, 'bad_request', 'Times must look like 03:00');
    if (x.window_start === x.window_end) throw err(400, 'bad_request', 'The window must end at a different time than it starts');
    windows[id] = { window_start: x.window_start, window_end: x.window_end, canary_device_id: x.canary_device_id || null };
    return siteSettings().find((s) => s.site_id === id);
  });
  on('PUT', '/api/updates/devices/:id', (c) => {
    const info = devInfo[c.params[0]];
    if (!info) throw err(404, 'not_found', 'Android box not found');
    const abi = b<{ abi_override?: string | null }>(c).abi_override || null;
    if (abi && !info.abis.includes(abi)) throw err(400, 'bad_request', 'That box’s processor doesn’t support that build type');
    info.abi_override = abi;
    return { ok: true };
  });
  on('POST', '/api/updates/run', async (c) => {
    const x = b<{ package: string; site_id?: string; device_id?: string }>(c);
    await sleep(400);
    const p = packages().find((y) => y.package === x.package);
    if (!p) throw err(404, 'not_found', 'That app isn’t installed on any Android box.');
    let boxes = p.boxes.filter((y) => y.state === 'update' && !y.busy && (!x.site_id || y.site_id === x.site_id));
    if (x.device_id) {
      const one = p.boxes.find((y) => y.device_id === x.device_id);
      if (!one) throw err(404, 'not_found', 'That box doesn’t have this app.');
      if (one.state !== 'update') throw err(409, 'not_updatable', one.detail);
      boxes = [one];
    }
    if (!boxes.length) throw err(409, 'nothing_to_do', `Every box already has the newest ${p.label} Screens can install.`);
    const bySite = new Map<string, UpdateBox[]>();
    for (const y of boxes) bySite.set(y.site_id, [...(bySite.get(y.site_id) ?? []), y]);
    return { rollouts: [...bySite.values()].map((list) => startRollout(p, list)), skipped: [] };
  });
  on('POST', '/api/updates/rollouts/:id/cancel', (c) => {
    const r = rollouts.find((x) => x.id === c.params[0]);
    if (!r) throw err(404, 'not_found', 'Rollout not found');
    if (isActive(r)) {
      for (const d of r.devices) if (d.status === 'pending' || d.status === 'waiting') { d.status = 'skipped'; d.detail = 'Cancelled'; }
      r.status = 'cancelled'; r.finished_at = Date.now(); r.detail = 'Cancelled by you';
    }
    return r;
  });
  on('POST', '/api/updates/probe', async () => {
    await sleep(600);
    const list = androids().filter(online);
    for (const d of list) devInfo[d.id].probed_at = Date.now();
    return { ok: true, devices: list.length };
  });
}

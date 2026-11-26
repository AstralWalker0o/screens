// Builds the fleet picture: every sideloaded app on every Android box, which build fits each box, and what
// the update manager would do there. Used by the dashboard API and by each site hub's planner, so both agree.

import type {
  BoxSigner, DeviceUpdates, UpdateBox, UpdateCandidate, UpdatePackage, UpdatePolicyRow, UpdateRollout, UpdateSource, UpdatesSummary,
} from '../../shared/updates';
import { boxState, LAUNCHER_PACKAGE, newestCandidate, resolveMode, versionText } from '../../shared/updates';
import type { Env } from '../env';
import type { Row } from '../lib/db';
import { parseJson } from '../lib/util';
import { loadCandidates, loadPolicies, toRollout, toSource } from './store';

export interface FleetData {
  devices: Row[];
  apps: Row[];
  meta: Map<string, Row>;
  info: Map<string, Row>;
  cands: Map<string, UpdateCandidate[]>;
  sources: Map<string, UpdateSource>;
  policies: UpdatePolicyRow[];
  labels: Map<string, string>;
  active: UpdateRollout[];
  lastJobs: Map<string, Row>;
}

const key = (dev: string, pkg: string) => `${dev}|${pkg}`;

export async function loadFleet(env: Env, opts: { siteId?: string; deviceId?: string } = {}): Promise<FleetData> {
  const where = ["d.kind = 'android'"]; const args: unknown[] = [];
  if (opts.siteId) { where.push('d.site_id = ?'); args.push(opts.siteId); }
  if (opts.deviceId) { where.push('d.id = ?'); args.push(opts.deviceId); }
  const w = where.join(' AND ');
  const [devices, apps, meta, info, sources, labels, active, jobs, cands, policies] = await Promise.all([
    env.DB.prepare(`SELECT d.*, s.name site_name, s.timezone FROM devices d JOIN sites s ON s.id = d.site_id WHERE ${w} ORDER BY s.name, d.name`).bind(...args).all<Row>(),
    env.DB.prepare(`SELECT a.device_id, a.package, a.label, a.version_name, a.version_code FROM device_apps a JOIN devices d ON d.id = a.device_id WHERE ${w} AND a.system = 0`).bind(...args).all<Row>(),
    env.DB.prepare(`SELECT m.* FROM update_device_apps m JOIN devices d ON d.id = m.device_id WHERE ${w}`).bind(...args).all<Row>(),
    env.DB.prepare(`SELECT u.* FROM update_devices u JOIN devices d ON d.id = u.device_id WHERE ${w}`).bind(...args).all<Row>(),
    env.DB.prepare('SELECT * FROM update_sources').all<Row>(),
    env.DB.prepare('SELECT package, label FROM app_catalog WHERE label IS NOT NULL').all<Row>(),
    env.DB.prepare(`SELECT r.*, s.name site_name FROM update_rollouts r LEFT JOIN sites s ON s.id = r.site_id WHERE r.status IN ('canary','rolling')${opts.siteId ? ' AND r.site_id = ?' : ''}`).bind(...(opts.siteId ? [opts.siteId] : [])).all<Row>(),
    env.DB.prepare(`SELECT id, device_id, status, params, result, created_at FROM jobs WHERE kind = 'app_update' AND created_at > ? ${opts.siteId ? 'AND site_id = ?' : ''} ORDER BY created_at DESC LIMIT 1000`).bind(Date.now() - 30 * 86_400_000, ...(opts.siteId ? [opts.siteId] : [])).all<Row>(),
    loadCandidates(env),
    loadPolicies(env),
  ]);
  const lastJobs = new Map<string, Row>();
  for (const j of jobs.results) {
    const p = parseJson<any>(j.params, {});
    const k = key(j.device_id, p.package);
    if (j.device_id && p.package && !lastJobs.has(k)) lastJobs.set(k, j);
  }
  return {
    devices: devices.results, apps: apps.results,
    meta: new Map(meta.results.map((m) => [key(m.device_id, m.package), m])),
    info: new Map(info.results.map((i) => [i.device_id as string, i])),
    cands, sources: new Map(sources.results.map((s) => [s.package as string, toSource(s)])), policies,
    labels: new Map(labels.results.map((l) => [l.package as string, l.label as string])),
    active: active.results.map(toRollout), lastJobs,
  };
}

export function boxSigner(meta: Row | undefined, versionCode: number | null): BoxSigner | null {
  if (!meta) return null;
  const strong = meta.signer_vc != null && meta.signer_vc === versionCode ? parseJson<string[]>(meta.signer_sha256, []) : [];
  const weak = parseJson<string[]>(meta.sig_hashes, []);
  return strong.length || weak.length ? { sha256: strong.length ? strong : null, java_hash: weak.length ? weak : null } : null;
}

const online = (d: Row) => d.status === 'online' || d.status === 'standby';

export function buildBox(d: FleetData, dev: Row, app: Row): UpdateBox {
  const pkg = app.package as string;
  const meta = d.meta.get(key(dev.id, pkg));
  const info = d.info.get(dev.id);
  const version_code = app.version_code ?? meta?.version_code ?? null;
  const m = resolveMode(pkg, dev.site_id, d.policies);
  const sdk = info?.sdk ?? parseJson<any>(dev.facts, {}).sdk ?? null;
  const st = boxState({
    installed: { version_code, version_name: app.version_name ?? null },
    installer: meta?.installer ?? null, mode: m.mode, cands: d.cands.get(pkg) ?? [],
    box: { abis: parseJson<string[]>(info?.abis, []), abi_override: info?.abi_override ?? null, sdk },
    signer: boxSigner(meta, version_code),
  });
  const job = d.lastJobs.get(key(dev.id, pkg));
  const busy = d.active.some((r) => r.site_id === dev.site_id && r.package === pkg && r.devices.some((x) => x.device_id === dev.id && ['pending', 'installing', 'verifying', 'waiting'].includes(x.status)));
  return {
    device_id: dev.id, device_name: dev.name, site_id: dev.site_id, site_name: dev.site_name, online: online(dev),
    version_name: app.version_name ?? null, version_code, installer: meta?.installer ?? null,
    state: st.state, detail: st.detail, mode: m.mode, mode_from: m.from,
    candidate: st.candidate ? { apk_id: st.candidate.apk_id, version_code: st.candidate.version_code, version_name: st.candidate.version_name, abis: st.candidate.abis } : null,
    busy,
    last_result: job && job.status !== 'running' ? { status: job.status === 'ok' ? 'ok' : 'error', detail: String(parseJson<any>(job.result, {})?.detail ?? ''), at: job.created_at, job_id: job.id } : null,
  };
}

export function buildPackages(d: FleetData): UpdatePackage[] {
  const devs = new Map(d.devices.map((x) => [x.id as string, x]));
  const byPkg = new Map<string, Row[]>();
  for (const a of d.apps) if (devs.has(a.device_id)) byPkg.set(a.package, [...(byPkg.get(a.package) ?? []), a]);
  const pkgs = new Set<string>([...byPkg.keys(), ...d.cands.keys(), ...d.sources.keys()]);
  const out: UpdatePackage[] = [];
  for (const pkg of pkgs) {
    const apps = byPkg.get(pkg) ?? [];
    const cands = [...(d.cands.get(pkg) ?? [])];
    const boxes = apps.map((a) => buildBox(d, devs.get(a.device_id)!, a)).sort((a, b) => a.site_name.localeCompare(b.site_name) || a.device_name.localeCompare(b.device_name));
    const label = apps.find((a) => a.label)?.label ?? d.labels.get(pkg) ?? (pkg === LAUNCHER_PACKAGE ? 'Screens Launcher' : null) ?? pkg;
    const site_modes: Record<string, UpdatePackage['fleet_mode'] & string> = {};
    for (const p of d.policies) if (p.package === pkg && p.scope_type === 'site') site_modes[p.scope_id] = p.mode;
    const count = (s: UpdateBox['state'][]) => boxes.filter((b) => s.includes(b.state)).length;
    out.push({
      package: pkg, label, builtin: pkg === LAUNCHER_PACKAGE,
      latest: newestCandidate(cands),
      versions: cands.sort((a, b) => (b.version_code ?? 0) - (a.version_code ?? 0) || b.uploaded_at - a.uploaded_at).slice(0, 12),
      source: d.sources.get(pkg) ?? null,
      fleet_mode: d.policies.find((p) => p.package === pkg && p.scope_type === 'fleet')?.mode ?? null,
      site_modes, boxes,
      counts: { boxes: boxes.length, update: count(['update']), store: count(['store']), current: count(['current', 'ahead']), blocked: count(['incompatible', 'signer_mismatch']) },
    });
  }
  // Apps with updates first, then those Screens can update, then store-managed ones; alphabetical within.
  const rank = (p: UpdatePackage) => (p.counts.update ? 0 : p.latest || p.source ? 1 : p.counts.store ? 3 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

export function summarize(pkgs: UpdatePackage[], extra: { failed_7d: number; running: number; last_check: number | null }): UpdatesSummary {
  const withUpd = pkgs.filter((p) => p.counts.update > 0);
  const boxes = new Set(withUpd.flatMap((p) => p.boxes.filter((b) => b.state === 'update').map((b) => b.device_id)));
  return {
    available: withUpd.reduce((a, p) => a + p.counts.update, 0), apps_with_updates: withUpd.length, boxes_with_updates: boxes.size,
    auto_apps: pkgs.filter((p) => p.fleet_mode === 'auto' || Object.values(p.site_modes).includes('auto')).length,
    store_managed: pkgs.filter((p) => p.counts.store > 0).length,
    ...extra,
    top: withUpd.slice(0, 4).map((p) => ({ package: p.package, label: p.label, to: p.latest ? versionText(p.latest) : '', boxes: p.counts.update })),
  };
}

export function deviceUpdates(d: FleetData, deviceId: string): DeviceUpdates {
  const dev = d.devices.find((x) => x.id === deviceId);
  const info = d.info.get(deviceId);
  if (!dev) return { device_id: deviceId, items: [], probed_at: null, abis: [] };
  const items = d.apps.filter((a) => a.device_id === deviceId).map((a) => {
    const b = buildBox(d, dev, a);
    return {
      package: a.package, label: a.label ?? d.labels.get(a.package) ?? a.package,
      installed: a.version_name ?? (a.version_code != null ? String(a.version_code) : null),
      available: b.candidate ? versionText(b.candidate) : null, state: b.state, detail: b.detail, mode: b.mode, apk_id: b.candidate?.apk_id ?? null, busy: b.busy,
    };
  }).filter((x) => x.state !== 'no_source');
  return { device_id: deviceId, items, probed_at: info?.probed_at ?? null, abis: parseJson<string[]>(info?.abis, []) };
}

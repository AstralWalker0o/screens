// The update manager inside each SiteHub: reads boxes, plans automatic updates in the site's maintenance window,
// and runs staged rollouts (one canary box first, verified, then the rest), one box at a time.
// It never blocks the hub's alarm (work runs in the background, one step after another), never uninstalls,
// never downgrades (installs use `-r` without `-d`, and the live version is re-read before each install).

import type { BoxSigner, RolloutDevice, UpdateRollout } from '../../shared/updates';
import {
  effectiveSigner, inWindow, isStoreInstaller, LAUNCHER_PACKAGE, pickCandidate, rolloutOrder, signerVerdict, versionText,
} from '../../shared/updates';
import type { Env } from '../env';
import { signAgentUrl } from '../lib/crypto';
import { audit, createJob, finishJob, raiseAlert, resolveAlert, type Row } from '../lib/db';
import { assertPackage, HttpError, now, parseJson, rid } from '../lib/util';
import {
  busyReason, installedSigning, installErrorText, launchCheckCmd, launchVerdict, markers, parsePreflight, parseProbe, preflightCmd, PROBE_CMD, versionCmd,
} from './device';
import { loadCandidates, saveRollout, siteWindow, toRollout } from './store';
import { buildPackages, loadFleet } from './view';

export interface UpdateHub {
  env: Env;
  siteId(): string;
  origin(): string;
  online(): boolean;
  gw<T = any>(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  diag(level: 'info' | 'warn' | 'error', source: string, message: string, data?: Record<string, unknown>): void;
  syncApps(deviceId: string): Promise<unknown>;
  command(deviceId: string, command: string, args: Record<string, any>, actor: string): Promise<any>;
  waitUntil(p: Promise<unknown>): void;
}

const RETRY_MS = 5 * 60_000;          // a busy/offline box is tried again after this
const MAX_TRIES = 24;                 // …this many times, then skipped
const MAX_FAILS = 2;                  // a rollout stops after this many failed boxes
const ROLLOUT_TTL = 3 * 86_400_000;   // unfinished boxes are given up after 3 days
const PROBE_EVERY = 6 * 3_600_000;
const PLAN_EVERY = 5 * 60_000;
const AUTO_COOLDOWN = 20 * 3_600_000; // one automatic rollout per version per site per day
const FAILED_COOLDOWN = 7 * 86_400_000;

type Outcome = { status: 'ok' | 'failed' | 'skipped' | 'waiting'; detail: string; job_id?: string };

export class UpdateRunner {
  private running: Promise<void> | null = null;
  private lastPlan = 0;
  constructor(private h: UpdateHub) {}

  private get env() { return this.h.env; }
  private get siteId() { return this.h.siteId(); }

  /** Alarm hook (every minute while the gateway is online). Starts background work if none is running. */
  onTick() {
    if (!this.running && this.h.online()) this.kick();
  }

  private kick() {
    if (this.running) return;
    const p = this.run()
      .catch((e) => this.h.diag('error', 'updates', `update step failed: ${e?.message ?? e}`))
      .finally(() => { this.running = null; });
    this.running = p;
    this.h.waitUntil(p);
  }

  private async run() {
    const started = now();
    await this.probeDue(started);
    // Keep going while there's quick progress (skips, finished rollouts), within a time budget.
    for (let i = 0; i < 12 && now() - started < 8 * 60_000; i++) {
      let r = await this.nextRollout();
      if (!r && now() - this.lastPlan >= PLAN_EVERY) {
        this.lastPlan = now();
        await this.planAuto(now());
        r = await this.nextRollout();
      }
      if (!r || !(await this.step(r))) break;
    }
  }

  // ------------------------------------------------------------------------------------------ reading boxes

  private sh(row: Row) {
    const serial = `${row.ip}:${row.port || 5555}`;
    return (cmd: string, t = 30_000) => this.h.gw<{ stdout: string; exit_code: number }>('adb.shell', { serial, cmd, timeout_ms: t }, t + 5_000);
  }

  private async probeDue(t: number) {
    const rows = (await this.env.DB.prepare(`SELECT d.* FROM devices d LEFT JOIN update_devices u ON u.device_id = d.id
      WHERE d.site_id = ? AND d.kind = 'android' AND d.status IN ('online','standby') AND d.ip IS NOT NULL AND (u.probed_at IS NULL OR u.probed_at < ?) LIMIT 2`)
      .bind(this.siteId, t - PROBE_EVERY).all<Row>()).results;
    for (const d of rows) await this.probeDevice(d).catch(() => undefined);
  }

  /** Processor ABIs, Android version, and installer + signer hash of every sideloaded app on one box. */
  async probeDevice(row: Row) {
    const t = now();
    let res;
    try { res = parseProbe((await this.sh(row)(PROBE_CMD, 90_000)).stdout); } catch (e: any) {
      // Try again in 15 minutes rather than every minute.
      await this.env.DB.prepare(`INSERT INTO update_devices (device_id, probed_at) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET probed_at = excluded.probed_at`)
        .bind(row.id, t - PROBE_EVERY + 15 * 60_000).run();
      this.h.diag('warn', 'updates', `couldn't read app details from ${row.name}: ${e?.message ?? e}`, { device_id: row.id });
      return;
    }
    const stmts: D1PreparedStatement[] = [
      this.env.DB.prepare(`INSERT INTO update_devices (device_id, abis, sdk, probed_at) VALUES (?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET abis = excluded.abis, sdk = coalesce(excluded.sdk, sdk), probed_at = excluded.probed_at`)
        .bind(row.id, JSON.stringify(res.abis), res.sdk, t),
    ];
    for (const [pkg, a] of res.apps) {
      stmts.push(this.env.DB.prepare(`INSERT INTO update_device_apps (device_id, package, version_code, installer, sig_hashes, checked_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(device_id, package) DO UPDATE SET version_code = excluded.version_code, installer = excluded.installer, sig_hashes = excluded.sig_hashes, checked_at = excluded.checked_at`)
        .bind(row.id, pkg, a.version_code, a.installer, JSON.stringify(a.sig_hashes), t));
    }
    stmts.push(this.env.DB.prepare('DELETE FROM update_device_apps WHERE device_id = ? AND checked_at < ?').bind(row.id, t));
    for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
  }

  /** "Re-read boxes" from the dashboard: app inventory + update details, in the background. */
  async probe(deviceIds?: string[]): Promise<{ devices: number }> {
    const rows = (await this.env.DB.prepare("SELECT * FROM devices WHERE site_id = ? AND kind = 'android' AND status IN ('online','standby') AND ip IS NOT NULL").bind(this.siteId).all<Row>()).results
      .filter((d) => !deviceIds?.length || deviceIds.includes(d.id));
    this.h.waitUntil((async () => {
      for (const d of rows) {
        await this.h.syncApps(d.id).catch(() => undefined);
        await this.probeDevice(d).catch(() => undefined);
      }
      // Fresh facts: look for automatic updates straight away instead of at the next 5-minute plan.
      this.lastPlan = 0;
      if (this.running) await this.running.catch(() => undefined);
      this.kick();
    })());
    return { devices: rows.length };
  }

  // ------------------------------------------------------------------------------------------ planning

  private async site(): Promise<Row> {
    const s = await this.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(this.siteId).first<Row>();
    if (!s) throw new HttpError(404, 'not_found', 'Site not found');
    return s;
  }

  private async inWindowNow(t: number): Promise<boolean> {
    const [s, w] = await Promise.all([this.site(), siteWindow(this.env, this.siteId)]);
    return inWindow(t, s.timezone || 'UTC', w.window_start, w.window_end);
  }

  /** In the maintenance window: start one automatic rollout for an app whose policy is "auto". */
  async planAuto(t: number) {
    if (!(await this.inWindowNow(t))) return;
    const pkgs = buildPackages(await loadFleet(this.env, { siteId: this.siteId }));
    for (const p of pkgs) {
      const boxes = p.boxes.filter((b) => b.state === 'update' && b.mode === 'auto' && !b.busy && b.candidate?.version_code != null);
      if (!boxes.length) continue;
      const vc = Math.max(...boxes.map((b) => b.candidate!.version_code!));
      const recent = (await this.env.DB.prepare('SELECT status, created_at FROM update_rollouts WHERE site_id = ? AND package = ? AND version_code = ? AND created_at > ?')
        .bind(this.siteId, p.package, vc, t - FAILED_COOLDOWN).all<Row>()).results;
      if (recent.some((r) => r.status === 'failed' || r.status === 'cancelled' || t - r.created_at < AUTO_COOLDOWN)) continue;
      const target = boxes.filter((b) => b.candidate!.version_code === vc);
      const vname = target[0].candidate!.version_name;
      await this.create(p.package, p.label, vc, vname, 'auto', target.map((b) => ({ id: b.device_id, name: b.device_name, online: b.online })), 'automation:updates', false);
      return;
    }
  }

  private async create(pkg: string, label: string, vc: number | null, vname: string | null, trigger: 'auto' | 'manual', boxes: { id: string; name: string; online: boolean }[], actor: string, force: boolean): Promise<UpdateRollout> {
    const w = await siteWindow(this.env, this.siteId);
    const ordered = rolloutOrder(boxes, w.canary_device_id);
    const t = now();
    const r: UpdateRollout = {
      id: rid('upd'), site_id: this.siteId, package: pkg, label, version_code: vc, version_name: vname, trigger, status: 'canary',
      devices: ordered.map((b, i) => ({ device_id: b.id, name: b.name, status: 'pending', canary: i === 0, ...(force ? { force: true } : {}) })),
      detail: ordered.length > 1 ? `Canary: ${ordered[0].name}` : null, actor, created_at: t, updated_at: t, finished_at: null,
    };
    await this.env.DB.prepare(`INSERT INTO update_rollouts (id, site_id, package, label, version_code, version_name, trigger, status, devices, detail, actor, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(r.id, r.site_id, pkg, label, vc, vname, trigger, r.status, JSON.stringify(r.devices), r.detail, actor, t, t).run();
    this.h.diag('info', 'updates', `${trigger} rollout of ${pkg} ${vname ?? vc} to ${ordered.length} box(es)`, { rollout_id: r.id, canary: ordered[0]?.id });
    return r;
  }

  /** "Update now" (dashboard): one app at this site, all boxes that need it or the chosen ones. */
  async updateNow(req: { package: string; device_ids?: string[]; force?: boolean }, actor: string): Promise<UpdateRollout> {
    const pkgName = assertPackage(req.package);
    const pkg = buildPackages(await loadFleet(this.env, { siteId: this.siteId })).find((p) => p.package === pkgName);
    if (!pkg || !pkg.boxes.length) throw new HttpError(404, 'not_found', 'That app isn’t installed on any Android box at this site.');
    let boxes = pkg.boxes.filter((b) => b.state === 'update');
    if (req.device_ids?.length) {
      const chosen = pkg.boxes.filter((b) => req.device_ids!.includes(b.device_id));
      if (!chosen.length) throw new HttpError(404, 'not_found', 'That box doesn’t have this app.');
      // Choosing a box explicitly also updates it when the policy pins the app.
      boxes = chosen.filter((b) => b.state === 'update' || b.state === 'pinned');
      if (!boxes.length) throw new HttpError(409, 'not_updatable', chosen[0].detail);
      if (boxes.some((b) => b.state === 'pinned')) {
        const pinned = await this.pinnedCandidates(pkgName, boxes.map((b) => b.device_id));
        boxes = boxes.map((b) => (b.state === 'pinned' ? { ...b, candidate: pinned.get(b.device_id) ?? null } : b)).filter((b) => b.candidate);
        if (!boxes.length) throw new HttpError(409, 'not_updatable', chosen[0].detail);
      }
    }
    boxes = boxes.filter((b) => b.candidate?.version_code != null);
    if (!boxes.length) throw new HttpError(409, 'nothing_to_do', `Every box at this site already has the newest ${pkg.label} Screens can install.`);
    const vc = Math.max(...boxes.map((b) => b.candidate!.version_code!));
    const target = boxes.filter((b) => b.candidate!.version_code === vc);
    const active = (await this.env.DB.prepare("SELECT * FROM update_rollouts WHERE site_id = ? AND package = ? AND status IN ('canary','rolling')").bind(this.siteId, pkgName).all<Row>()).results.map(toRollout);
    const same = active.find((r) => r.version_code === vc && target.every((b) => r.devices.some((d) => d.device_id === b.device_id && ['pending', 'installing', 'verifying', 'waiting'].includes(d.status))));
    if (same) { this.kick(); return same; }
    const r = await this.create(pkgName, pkg.label, vc, target[0].candidate!.version_name, 'manual', target.map((b) => ({ id: b.device_id, name: b.device_name, online: b.online })), actor, !!req.force);
    await audit(this.env, actor, 'updates.run', { target_type: 'app', target_id: pkgName, site_id: this.siteId, details: { version: versionText(target[0].candidate!), devices: target.map((b) => b.device_id) } });
    this.kick();
    return r;
  }

  /** For a pinned box the operator updates by hand: the build boxState would have offered without the pin. */
  private async pinnedCandidates(pkg: string, ids: string[]) {
    const data = await loadFleet(this.env, { siteId: this.siteId });
    data.policies = data.policies.filter((p) => p.package !== pkg);
    const p = buildPackages(data).find((x) => x.package === pkg);
    return new Map((p?.boxes ?? []).filter((b) => ids.includes(b.device_id) && b.state === 'update' && b.candidate).map((b) => [b.device_id, b.candidate!]));
  }

  async cancel(id: string, actor: string) {
    const row = await this.env.DB.prepare("SELECT * FROM update_rollouts WHERE id = ? AND site_id = ?").bind(id, this.siteId).first<Row>();
    if (!row) throw new HttpError(404, 'not_found', 'Rollout not found');
    const r = toRollout(row);
    if (r.status !== 'canary' && r.status !== 'rolling') return r;
    for (const d of r.devices) if (d.status === 'pending' || d.status === 'waiting') { d.status = 'skipped'; d.detail = 'Cancelled'; }
    r.status = 'cancelled'; r.finished_at = now(); r.detail = `Cancelled by ${actor}`;
    await saveRollout(this.env, r);
    await audit(this.env, actor, 'updates.cancel', { target_type: 'rollout', target_id: id, site_id: this.siteId, details: { package: r.package } });
    return r;
  }

  // ------------------------------------------------------------------------------------------ running rollouts

  private async nextRollout(): Promise<UpdateRollout | null> {
    const row = await this.env.DB.prepare(`SELECT * FROM update_rollouts WHERE site_id = ? AND status IN ('canary','rolling')
      ORDER BY CASE trigger WHEN 'manual' THEN 0 ELSE 1 END, created_at LIMIT 1`).bind(this.siteId).first<Row>();
    return row ? toRollout(row) : null;
  }

  /** Save progress without undoing a cancel that happened while a box was installing. */
  private async save(r: UpdateRollout) {
    r.updated_at = now();
    const res = await this.env.DB.prepare(`UPDATE update_rollouts SET devices = ?, detail = CASE WHEN status = 'cancelled' THEN detail ELSE ? END,
      status = CASE WHEN status = 'cancelled' THEN status ELSE ? END, finished_at = coalesce(finished_at, ?), updated_at = ? WHERE id = ? RETURNING status`)
      .bind(JSON.stringify(r.devices), r.detail, r.status, r.finished_at, r.updated_at, r.id).first<Row>();
    if (res?.status === 'cancelled') r.status = 'cancelled';
  }

  private async finish(r: UpdateRollout) {
    const ok = r.devices.filter((d) => d.status === 'ok').length;
    const failed = r.devices.filter((d) => d.status === 'failed').length;
    const skipped = r.devices.filter((d) => d.status === 'skipped').length;
    r.status = failed ? 'failed' : 'done';
    r.finished_at = now();
    r.detail = [`Updated ${ok} of ${r.devices.length} box${r.devices.length === 1 ? '' : 'es'}`, failed && `${failed} failed`, skipped && `${skipped} skipped`].filter(Boolean).join(', ');
    await this.save(r);
    this.h.diag(failed ? 'warn' : 'info', 'updates', `rollout ${r.package} ${r.version_name ?? r.version_code}: ${r.detail}`, { rollout_id: r.id });
  }

  /** One unit of work on a rollout. Returns false when there's nothing to do right now. */
  async step(r: UpdateRollout): Promise<boolean> {
    const t = now();
    if (t - r.created_at > ROLLOUT_TTL) {
      for (const d of r.devices) if (d.status === 'pending' || d.status === 'waiting') { d.status = 'skipped'; d.detail = 'Gave up after 3 days'; }
      await this.finish(r);
      return true;
    }
    if (r.trigger === 'auto' && !(await this.inWindowNow(t))) return false; // resumes in the next window
    // Pending, waiting long enough, or stuck mid-install after the hub restarted.
    const due = (d: RolloutDevice) => d.status === 'pending' || (d.status === 'waiting' && (d.at ?? 0) + RETRY_MS <= t)
      || ((d.status === 'installing' || d.status === 'verifying') && (d.at ?? 0) + 15 * 60_000 <= t);
    const settled = () => r.devices.every((d) => d.status === 'ok' || d.status === 'failed' || d.status === 'skipped');

    if (r.status === 'canary') {
      const c = r.devices.find((d) => d.canary) ?? r.devices[0];
      if (!c) { await this.finish(r); return true; }
      if (c.status === 'ok') { r.status = 'rolling'; await this.save(r); return true; }
      if (c.status === 'failed') { await this.finish(r); return true; }
      if (due(c)) return this.act(r, c);
      if (c.status === 'skipped' || c.status === 'waiting') {
        // The canary can't take it right now (already current, busy, offline): the next box that can becomes the canary.
        const next = r.devices.find((d) => d !== c && due(d));
        if (next) { c.canary = false; next.canary = true; r.detail = `Canary: ${next.name}`; return this.act(r, next); }
        if (settled()) { await this.finish(r); return true; }
      }
      return false;
    }

    const next = r.devices.find(due);
    if (!next) {
      if (!settled()) return false;
      await this.finish(r);
      return true;
    }
    return this.act(r, next);
  }

  private async act(r: UpdateRollout, d: RolloutDevice): Promise<boolean> {
    d.status = 'installing'; d.at = now();
    await this.save(r);
    if (r.status === 'cancelled') return true;
    let out: Outcome;
    try { out = await this.installOn(r, d); } catch (e: any) { out = { status: 'failed', detail: installErrorText(e?.message ?? String(e)) }; }
    d.at = now();
    d.detail = out.detail;
    d.job_id = out.job_id ?? d.job_id ?? null;
    if (out.status === 'waiting') {
      d.tries = (d.tries ?? 0) + 1;
      d.status = d.tries >= MAX_TRIES ? 'skipped' : 'waiting';
      if (d.status === 'skipped') d.detail = `${out.detail}. Gave up after ${MAX_TRIES} tries.`;
    } else d.status = out.status;

    if (d.status === 'ok' && d.canary && r.status === 'canary') {
      r.status = 'rolling';
      r.detail = r.devices.length > 1 ? `Canary ${d.name} passed: updating the other boxes` : null;
    }
    if (d.status === 'failed') {
      const label = r.label ?? r.package;
      const stopping = d.canary || r.devices.filter((x) => x.status === 'failed').length >= MAX_FAILS;
      await raiseAlert(this.env, {
        severity: 'warning', type: 'update.failed', title: `${label} update failed on ${d.name}`,
        details: `${d.detail}${stopping ? ' The rollout was stopped, so no other box at this site was changed.' : ''}`,
        site_id: this.siteId, device_id: d.device_id, dedupe_key: `upd_fail:${d.device_id}:${r.package}`,
      });
      this.h.diag('error', 'updates', `${r.package} ${r.version_name ?? r.version_code} failed on ${d.name}: ${d.detail}`, { rollout_id: r.id, device_id: d.device_id, canary: !!d.canary });
      if (stopping) {
        for (const x of r.devices) if (x.status === 'pending' || x.status === 'waiting') { x.status = 'skipped'; x.detail = d.canary ? 'Not attempted: the canary box failed' : 'Not attempted: the rollout stopped after failures'; }
        await this.finish(r);
        return true;
      }
    }
    await this.save(r);
    return true;
  }

  /** Update one box. Every early exit explains itself in plain English. */
  private async installOn(r: UpdateRollout, d: RolloutDevice): Promise<Outcome> {
    const pkg = assertPackage(r.package);
    const row = await this.env.DB.prepare('SELECT * FROM devices WHERE id = ? AND site_id = ?').bind(d.device_id, this.siteId).first<Row>();
    if (!row) return { status: 'skipped', detail: 'The box was removed from Screens' };
    if (!(row.status === 'online' || row.status === 'standby') || !row.ip) return { status: 'waiting', detail: 'The box is offline' };
    if (!this.h.online()) return { status: 'waiting', detail: 'The site gateway is offline' };
    const sh = this.sh(row);
    const pre = parsePreflight((await sh(preflightCmd(pkg))).stdout);
    if (!pre.present) return { status: 'skipped', detail: 'The app is no longer installed on this box' };
    if (r.version_code != null && pre.version_code != null && pre.version_code >= r.version_code) {
      this.h.waitUntil(this.h.syncApps(row.id).catch(() => undefined));
      return { status: 'skipped', detail: pre.version_code === r.version_code ? 'Already on this version' : 'Already on a newer version (Screens never downgrades)' };
    }
    if (isStoreInstaller(pre.installer)) return { status: 'skipped', detail: 'Installed from Google Play, which keeps it up to date' };
    if (!d.force) {
      const busy = busyReason(pre);
      if (busy) return { status: 'waiting', detail: busy };
    }

    // The build of this exact version made for this box's processor.
    const info = await this.env.DB.prepare('SELECT * FROM update_devices WHERE device_id = ?').bind(row.id).first<Row>();
    const sdk = info?.sdk ?? parseJson<any>(row.facts, {}).sdk ?? null;
    const box = { abis: parseJson<string[]>(info?.abis, []), abi_override: info?.abi_override ?? null, sdk };
    const builds = ((await loadCandidates(this.env, pkg)).get(pkg) ?? []).filter((c) => c.version_code === r.version_code);
    const apk = pickCandidate(builds, box);
    if (!apk) return { status: 'skipped', detail: `No build of this version for this box’s processor (${box.abi_override ?? box.abis[0] ?? 'not read yet'})` };

    // Same developer key as the installed app (or a key it rotated from)? Read the real certificate off the box.
    const signer: BoxSigner = { java_hash: pre.sig_hashes.length ? pre.sig_hashes : null };
    const installed = await installedSigning(sh, pkg).catch(() => null);
    const eff = effectiveSigner(installed, sdk);
    if (eff) {
      signer.sha256 = eff.certs.map((c) => c.sha256);
      await this.env.DB.prepare(`INSERT INTO update_device_apps (device_id, package, version_code, installer, signer_sha256, signer_vc, checked_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(device_id, package) DO UPDATE SET signer_sha256 = excluded.signer_sha256, signer_vc = excluded.signer_vc`)
        .bind(row.id, pkg, pre.version_code, pre.installer, JSON.stringify(signer.sha256), pre.version_code, now()).run();
    }
    const verdict = signerVerdict(apk.signing, signer, sdk);
    if (verdict === 'mismatch') return { status: 'failed', detail: 'The new build is signed with a different developer key than the app on this box, so Android would refuse it. Nothing was changed. Screens never uninstalls to force an update.' };
    if (verdict === 'unknown' && r.trigger === 'auto') return { status: 'skipped', detail: 'Couldn’t confirm the installed app’s signing key, so it wasn’t updated automatically. Use “Update now” to try.' };

    const from = pre.version_code;
    const fromName = (await this.env.DB.prepare('SELECT version_name FROM device_apps WHERE device_id = ? AND package = ?').bind(row.id, pkg).first<Row>())?.version_name
      ?? (from != null ? `build ${from}` : null);
    const apkRow = await this.env.DB.prepare('SELECT r2_key, sha256, version_name FROM apks WHERE id = ?').bind(apk.apk_id).first<Row>();
    if (!apkRow) return { status: 'skipped', detail: 'The build was deleted from the library' };
    const job_id = await createJob(this.env, {
      site_id: this.siteId, device_id: row.id, kind: 'app_update', actor: r.actor ?? (r.trigger === 'auto' ? 'automation:updates' : 'system'),
      params: { package: pkg, label: r.label, from: fromName, from_code: from, to: apk.version_name ?? String(apk.version_code), apk_id: apk.apk_id, rollout_id: r.id, canary: !!d.canary, trigger: r.trigger, abis: apk.abis },
    });
    const fail = async (detail: string): Promise<Outcome> => {
      await finishJob(this.env, job_id, 'error', { ok: false, detail });
      return { status: 'failed', detail, job_id };
    };
    d.status = 'installing'; d.job_id = job_id;
    await this.save(r);

    try {
      const url = await signAgentUrl(this.env.SIGNING_SECRET, this.h.origin(), 'GET', apkRow.r2_key, 30 * 60_000);
      // -r replaces keeping data; no -d (downgrade) and no -g (don't silently grant new permissions).
      await this.h.gw('adb.install', { serial: `${row.ip}:${row.port || 5555}`, url, sha256: apkRow.sha256, flags: ['-r'] }, 600_000);
    } catch (e: any) {
      return fail(installErrorText(e?.message ?? String(e)));
    }

    d.status = 'verifying';
    await this.save(r);
    const vc = Number(markers((await sh(versionCmd(pkg))).stdout).vc);
    if (vc !== r.version_code) return fail(`Installed, but the box still reports version ${vc || 'unknown'} instead of ${versionText(apk)}.`);
    await this.env.DB.prepare('UPDATE device_apps SET version_code = ?, version_name = ? WHERE device_id = ? AND package = ?').bind(vc, apk.version_name, row.id, pkg).run();

    let health = 'Verified the new version.';
    if (pkg === LAUNCHER_PACKAGE) {
      // Re-push the site's launcher settings so the new build is configured; STATUS proves it runs.
      const st = await this.h.command(row.id, 'launcher_config', {}, 'automation:updates').catch((e: any) => ({ ok: false, detail: e?.message }));
      if (!st?.status?.installed) return fail(`The Screens Launcher updated but didn’t answer afterwards${st?.detail ? ` (${st.detail})` : ''}. Check the box.`);
      health = 'The Screens Launcher answered after the update.';
    } else if (d.canary) {
      const lc = launchVerdict((await sh(launchCheckCmd(pkg), 25_000)).stdout, pkg, pre.awake);
      if (!lc.ok) return fail(`${lc.detail} The app was updated on this box; Screens can’t roll back (Android doesn’t allow downgrades without wiping the app).`);
      health = lc.detail;
    }
    const detail = `Updated ${fromName ? `from ${fromName} ` : ''}to ${versionText(apk)}. ${health}`;
    await finishJob(this.env, job_id, 'ok', { ok: true, detail, from, to: vc, apk_id: apk.apk_id, abis: apk.abis });
    await audit(this.env, r.actor ?? 'system', 'device.app_update', { target_type: 'device', target_id: row.id, site_id: this.siteId, details: { package: pkg, from, to: vc, rollout: r.id } });
    await resolveAlert(this.env, `upd_fail:${row.id}:${pkg}`);
    this.h.waitUntil(this.h.syncApps(row.id).catch(() => undefined));
    return { status: 'ok', detail, job_id };
  }
}

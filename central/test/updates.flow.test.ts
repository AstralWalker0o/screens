// Update manager flows against the real migrations (node:sqlite as D1), real APK fixtures in a fake R2,
// a fake GitHub, and fake Android boxes that enforce Android's own rules (same signer, no downgrades).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { b64Encode } from '../src/worker/lib/crypto';
import { AdapterError } from '../src/worker/adapters/types';
import { bytesReader, inspectApk } from '../src/worker/updates/apk';
import { checkSource } from '../src/worker/updates/github';
import { UpdateRunner, type UpdateHub } from '../src/worker/updates/runner';
import { ensureApkInfo, toRollout } from '../src/worker/updates/store';
import { buildPackages, deviceUpdates, loadFleet } from '../src/worker/updates/view';
import { effectiveSigner } from '../src/shared/updates';
import { makeEnv } from './helpers/d1';

const FIX = join(__dirname, 'fixtures', 'updates');
const fx = (n: string) => new Uint8Array(readFileSync(join(FIX, n)));
const PKG = 'au.supercluster.screens.fixture';
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------------------------------------------ fake GitHub

interface GhAssetFx { id: number; name: string; file: string; type?: string }
function fakeGitHub(o: { tag: string; assets: GhAssetFx[]; etag?: string; redirectTo?: string; status?: number; headers?: Record<string, string> }) {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    log.push({ url, headers });
    const u = new URL(url);
    if (u.host === 'api.github.com') {
      if (o.status) return new Response('{"message":"API rate limit exceeded"}', { status: o.status, headers: o.headers });
      if (o.etag && headers['if-none-match'] === o.etag) return new Response(null, { status: 304 });
      const body = { id: 7, tag_name: o.tag, draft: false, prerelease: false, published_at: '2026-11-20T00:00:00Z',
        assets: o.assets.map((a) => ({ id: a.id, name: a.name, size: fx(a.file).length, state: 'uploaded', content_type: 'application/vnd.android.package-archive', browser_download_url: `https://github.com/acme/app/releases/download/${o.tag}/${a.name}` })) };
      return Response.json(body, { headers: o.etag ? { etag: o.etag } : {} });
    }
    if (u.host === 'github.com') {
      const a = o.assets.find((x) => url.endsWith(`/${x.name}`));
      return new Response(null, { status: 302, headers: { location: o.redirectTo ?? `https://objects.githubusercontent.com/github-production-release-asset/${a?.id}?sig=x` } });
    }
    if (u.host === 'objects.githubusercontent.com') {
      const a = o.assets.find((x) => u.pathname.endsWith(`/${x.id}`))!;
      const b = fx(a.file);
      return new Response(b, { headers: { 'content-type': a.type ?? 'application/octet-stream', 'content-length': String(b.length) } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { fetcher, log };
}

async function addSource(env: any, pkg = PKG, extra: Record<string, unknown> = {}) {
  await env.DB.prepare('INSERT INTO update_sources (package, repo, asset_pattern, abi_patterns, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind(pkg, 'acme/app', extra.asset_pattern ?? '*universal*.apk', JSON.stringify(extra.abi_patterns ?? { 'arm64-v8a': '*arm64*.apk' }), 0, 0).run();
  return () => env.DB.prepare('SELECT * FROM update_sources WHERE package = ?').bind(pkg).first();
}

describe('GitHub source → library', () => {
  it('imports per-ABI builds through GitHub’s redirect, learns the signing key, then uses the ETag', async () => {
    const { env, files } = makeEnv();
    const src = await addSource(env);
    const gh = fakeGitHub({ tag: 'v1.1', etag: '"e1"', assets: [{ id: 11, name: 'app-arm64-v8a.apk', file: 'v2-k1-arm64.apk' }, { id: 12, name: 'app-universal.apk', file: 'v2-k1-universal.apk' }, { id: 13, name: 'notes.txt', file: 'expected.json' }] });
    const r = await checkSource(env, (await src())!, { fetcher: gh.fetcher });
    expect(r.status).toBe('ok');
    expect(r.imported.map((i) => [i.abi, i.status])).toEqual([['arm64-v8a', 'imported'], [null, 'imported']]);
    const apks = (await env.DB.prepare('SELECT a.*, i.abis, i.source, i.tag FROM apks a JOIN update_apk_info i ON i.apk_id = a.id ORDER BY a.size').all()).results;
    expect(apks.map((a: any) => [a.package, a.version_code, a.abis, a.source, a.tag])).toEqual([
      [PKG, 2, '["arm64-v8a"]', 'github', 'v1.1'], [PKG, 2, '["arm64-v8a","armeabi-v7a","x86_64","x86"]', 'github', 'v1.1'],
    ]);
    expect(apks[0].sha256).toBe(await sha(fx('v2-k1-arm64.apk')));
    expect([...files.objects.keys()].length).toBe(2);
    const k1 = effectiveSigner((await inspectApk(bytesReader(fx('v1-k1.apk')))).signing, 30)!.certs[0].sha256;
    expect((await src())!.signer_sha256).toBe(k1);
    // Unauthenticated, and nothing but GitHub hosts was contacted.
    expect(gh.log.every((l) => !l.headers.authorization)).toBe(true);
    expect(new Set(gh.log.map((l) => new URL(l.url).host))).toEqual(new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com']));

    const again = await checkSource(env, (await src())!, { fetcher: gh.fetcher });
    expect(again.status).toBe('not_modified');
    expect(gh.log.at(-1)!.headers['if-none-match']).toBe('"e1"');
  });

  it('accepts a key rotation with proof, refuses a different key, and refuses the wrong app', async () => {
    const { env, files } = makeEnv();
    const src = await addSource(env, PKG, { asset_pattern: '*.apk', abi_patterns: {} });
    await checkSource(env, (await src())!, { fetcher: fakeGitHub({ tag: 'v1', assets: [{ id: 1, name: 'a.apk', file: 'v1-k1.apk' }] }).fetcher });
    const rotated = await checkSource(env, (await src())!, { fetcher: fakeGitHub({ tag: 'v3', assets: [{ id: 3, name: 'a.apk', file: 'v3-rotated.apk' }] }).fetcher });
    expect(rotated.status).toBe('ok');
    const k2 = effectiveSigner((await inspectApk(bytesReader(fx('v2-k2.apk')))).signing, 30)!.certs[0].sha256;
    expect((await src())!.signer_sha256).toBe(k2); // now trusts the new key

    await env.DB.prepare('UPDATE update_sources SET signer_sha256 = (SELECT signer_sha256 FROM update_sources) WHERE package = ?').bind(PKG).run();
    // Re-trust k1 only, then offer a build signed by k2 without a rotation proof.
    const k1 = effectiveSigner((await inspectApk(bytesReader(fx('v1-k1.apk')))).signing, 30)!.certs[0].sha256;
    await env.DB.prepare('UPDATE update_sources SET signer_sha256 = ? WHERE package = ?').bind(k1, PKG).run();
    const before = files.objects.size;
    const bad = await checkSource(env, (await src())!, { fetcher: fakeGitHub({ tag: 'v9', assets: [{ id: 9, name: 'a.apk', file: 'v2-k2.apk' }] }).fetcher });
    expect(bad.status).toBe('error');
    expect(bad.detail).toMatch(/different key/);
    expect(files.objects.size).toBe(before); // the download was deleted
    expect((await env.DB.prepare("SELECT count(*) n FROM alerts WHERE type = 'update.signer'").first()).n).toBe(1);

    const other = await addSource(env, 'com.example.other', { asset_pattern: '*.apk', abi_patterns: {} });
    const wrong = await checkSource(env, (await other())!, { fetcher: fakeGitHub({ tag: 'v1', assets: [{ id: 21, name: 'a.apk', file: 'v1-k1.apk' }] }).fetcher });
    expect(wrong.detail).toMatch(/contains au\.supercluster\.screens\.fixture, not com\.example\.other/);
  });

  it('refuses redirects off GitHub and non-APK content', async () => {
    const { env, files } = makeEnv();
    const src = await addSource(env, PKG, { asset_pattern: '*.apk', abi_patterns: {} });
    const evil = await checkSource(env, (await src())!, { fetcher: fakeGitHub({ tag: 'v1', redirectTo: 'https://evil.example.com/x.apk', assets: [{ id: 1, name: 'a.apk', file: 'v1-k1.apk' }] }).fetcher });
    expect(evil.detail).toMatch(/evil\.example\.com/);
    const html = await checkSource(env, (await src())!, { fetcher: fakeGitHub({ tag: 'v1', assets: [{ id: 1, name: 'a.apk', file: 'v1-k1.apk', type: 'text/html' }] }).fetcher });
    expect(html.detail).toMatch(/text\/html/);
    expect(files.objects.size).toBe(0);
  });

  it('backs off when GitHub’s rate limit is used up', async () => {
    const { env } = makeEnv();
    const src = await addSource(env);
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const gh = fakeGitHub({ tag: 'v1', assets: [], status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
    expect((await checkSource(env, (await src())!, { fetcher: gh.fetcher })).status).toBe('rate_limited');
    const calls = gh.log.length;
    expect((await checkSource(env, (await src())!, { fetcher: gh.fetcher })).status).toBe('rate_limited');
    expect(gh.log.length).toBe(calls); // didn't even ask
  });
});

// ------------------------------------------------------------------------------------------------ fake boxes

interface Box { ip: string; vc: number; apk: Uint8Array; installer: string | null; awake: boolean; fg: string; playing: boolean; abis: string[]; installs: string[]; launches: number; crashOnLaunch?: boolean }

async function certOf(apk: Uint8Array) { return effectiveSigner((await inspectApk(bytesReader(apk))).signing, 30)!.certs[0]; }

function fakeHub(env: any, boxes: Box[], builds: Map<string, { bytes: Uint8Array; vc: number }>) {
  const pending: Promise<unknown>[] = [];
  const shellLog: string[] = [];
  const byIp = new Map(boxes.map((b) => [b.ip, b]));
  const shell = async (b: Box, cmd: string): Promise<string> => {
    shellLog.push(cmd.slice(0, 40));
    const cert = await certOf(b.apk);
    const sigs = `PackageSignatures{1 version:2, signatures:[${cert.java_hash}], past signatures:[]}`;
    if (cmd.startsWith('echo @@upd=probe')) return ['@@upd=probe', `@@abi=${b.abis[0]}`, `@@abilist=${b.abis.join(',')}`, '@@sdk=30', '@@PKGS', `${PKG}|versionCode=${b.vc}|installerPackageName=${b.installer ?? 'null'}|${sigs}|`, '@@END'].join('\n');
    if (cmd.startsWith('echo @@upd=pre')) return ['@@present=1', `@@vc=${b.vc}`, `@@installer=${b.installer ?? 'null'}`, `@@sigs=${sigs}`, `@@wake=${b.awake ? 'Awake' : 'Asleep'}`,
      `@@resumed=  mResumedActivity: ActivityRecord{1 u0 ${b.fg}/.Main t1}`, '@@home=com.google.android.tvlauncher/.MainActivity', `@@playing=${b.playing ? 1 : 0}`].join('\n');
    if (cmd.startsWith('echo @@upd=apktail')) return [`@@path=/data/app/~~x==/${PKG}-1==/base.apk`, `@@size=${b.apk.length}`, `@@b64=${b64Encode(b.apk.subarray(Math.max(0, b.apk.length - 192 * 1024)))}`].join('\n');
    if (cmd.startsWith('echo @@upd=apkpart')) {
      const from = Number(cmd.match(/tail -c \+(\d+)/)![1]) - 1, len = Number(cmd.match(/head -c (\d+)/)![1]);
      return `@@b64=${b64Encode(b.apk.subarray(from, from + len))}`;
    }
    if (cmd.startsWith('echo @@upd=ver')) return `@@vc=${b.vc}`;
    if (cmd.startsWith('echo @@upd=launch')) {
      b.launches++;
      return b.crashOnLaunch ? '@@crash0=0\n@@pid=\n@@resumed=\n@@crash1=1' : `@@crash0=0\n@@pid=4242\n@@resumed=  mResumedActivity: ActivityRecord{1 u0 ${PKG}/.Main t1}\n@@crash1=0\n@@done=1`;
    }
    throw new Error(`unexpected shell: ${cmd.slice(0, 80)}`);
  };
  const hub: UpdateHub = {
    env, siteId: () => 's1', origin: () => 'https://screens.test', online: () => true,
    async gw(op: string, args: any) {
      const b = byIp.get(String(args.serial).split(':')[0])!;
      if (op === 'adb.shell') return { stdout: await shell(b, String(args.cmd)), exit_code: 0 } as any;
      if (op === 'adb.install') {
        expect(args.flags).toEqual(['-r']); // never -d (downgrade) or -g (grant permissions)
        expect(String(args.url)).toMatch(/^https:\/\/screens\.test\//);
        const n = builds.get(args.sha256)!;
        if ((await certOf(n.bytes)).sha256 !== (await certOf(b.apk)).sha256) throw new AdapterError('failed', 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]');
        if (n.vc < b.vc) throw new AdapterError('failed', 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]');
        b.apk = n.bytes; b.vc = n.vc; b.installs.push(args.sha256);
        return { output: 'Success' } as any;
      }
      throw new Error(`unexpected op ${op}`);
    },
    diag: () => undefined,
    syncApps: async () => [],
    command: async () => ({ ok: true, status: { installed: true } }),
    waitUntil: (p) => { pending.push(p); },
  };
  const settle = async () => { while (pending.length) await pending.shift(); };
  return { hub, settle, shellLog };
}

async function seedSite(env: any, boxes: { id: string; name: string; ip: string; vc: number }[], buildFiles: string[]) {
  await env.DB.prepare("INSERT INTO clients (id, name, created_at) VALUES ('cl', 'Client', 0)").run();
  await env.DB.prepare("INSERT INTO sites (id, client_id, name, slug, timezone, created_at) VALUES ('s1', 'cl', 'Beach House', 'beach', 'Australia/Sydney', 0)").run();
  for (const b of boxes) {
    await env.DB.prepare("INSERT INTO devices (id, site_id, kind, name, ip, port, status, facts, created_at, updated_at) VALUES (?, 's1', 'android', ?, ?, 5555, 'online', '{\"sdk\":30}', 0, 0)").bind(b.id, b.name, b.ip).run();
    await env.DB.prepare("INSERT INTO device_apps (device_id, package, label, version_name, version_code, system, enabled, permissions, first_seen, last_seen) VALUES (?, ?, 'Fixture', ?, ?, 0, 1, '[]', 0, 0)").bind(b.id, PKG, `1.${b.vc - 1}`, b.vc).run();
  }
  const builds = new Map<string, { bytes: Uint8Array; vc: number }>();
  let i = 0;
  for (const f of buildFiles) {
    const bytes = fx(f);
    const h = await sha(bytes);
    const info = await inspectApk(bytesReader(bytes));
    await env.FILES.put(`apks/${h}.apk`, bytes);
    await env.DB.prepare('INSERT INTO apks (id, package, label, version_name, version_code, r2_key, sha256, size, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(`apk_${i++}`, PKG, 'Fixture', info.version_name, info.version_code, `apks/${h}.apk`, h, bytes.length, i).run();
    builds.set(h, { bytes, vc: info.version_code! });
  }
  await ensureApkInfo(env, 10); // reads ABIs + signer through R2 range reads
  return builds;
}

const BOXES = [{ id: 'dev_a', name: 'Alpha', ip: '10.0.0.1', vc: 1 }, { id: 'dev_b', name: 'Bravo', ip: '10.0.0.2', vc: 1 }, { id: 'dev_c', name: 'Charlie', ip: '10.0.0.3', vc: 1 }];
const box = (ip: string, o: Partial<Box> = {}): Box => ({ ip, vc: 1, apk: fx('v1-k1.apk'), installer: null, awake: false, fg: 'com.google.android.tvlauncher', playing: false, abis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'], installs: [], launches: 0, ...o });
const rollouts = async (env: any) => (await env.DB.prepare('SELECT * FROM update_rollouts ORDER BY created_at').all()).results.map(toRollout);

describe('staged rollout on a site', () => {
  let T = Date.UTC(2026, 10, 26, 2, 0); // 13:00 in Sydney: outside the default window
  beforeEach(() => { T = Date.UTC(2026, 10, 26, 2, 0); vi.spyOn(Date, 'now').mockImplementation(() => T); });
  afterEach(() => vi.restoreAllMocks());

  it('updates the canary first, checks it opens, then the rest, each with the build for its processor', async () => {
    const { env } = makeEnv();
    const builds = await seedSite(env, BOXES, ['v2-k1-arm64.apk', 'v2-k1-armv7.apk']);
    const boxes = [box('10.0.0.1'), box('10.0.0.2', { abis: ['armeabi-v7a', 'armeabi'] }), box('10.0.0.3', { awake: true })];
    const { hub, settle } = fakeHub(env, boxes, builds);
    const runner = new UpdateRunner(hub);
    await runner.probe(); await settle();
    const view = buildPackages(await loadFleet(env, { siteId: 's1' })).find((p) => p.package === PKG)!;
    expect(view.boxes.map((b) => [b.device_name, b.state, b.candidate?.abis])).toEqual([['Alpha', 'update', ['arm64-v8a']], ['Bravo', 'update', ['armeabi-v7a']], ['Charlie', 'update', ['arm64-v8a']]]);

    const r = await runner.updateNow({ package: PKG }, 'owner@test');
    expect(r.devices.map((d) => [d.name, !!d.canary])).toEqual([['Alpha', true], ['Bravo', false], ['Charlie', false]]);
    await settle();
    const [done] = await rollouts(env);
    expect(done.status).toBe('done');
    expect(done.devices.map((d) => d.status)).toEqual(['ok', 'ok', 'ok']);
    expect(boxes.map((b) => b.vc)).toEqual([2, 2, 2]);
    expect(boxes.map((b) => b.launches)).toEqual([1, 0, 0]); // only the canary is opened
    const arm64 = await sha(fx('v2-k1-arm64.apk')), armv7 = await sha(fx('v2-k1-armv7.apk'));
    expect(boxes.map((b) => b.installs[0])).toEqual([arm64, armv7, arm64]);
    const jobs = (await env.DB.prepare("SELECT status, device_id, params FROM jobs WHERE kind = 'app_update' ORDER BY created_at, device_id").all()).results;
    expect(jobs.map((j: any) => j.status)).toEqual(['ok', 'ok', 'ok']);
    expect(JSON.parse(jobs[0].params)).toMatchObject({ package: PKG, from: '1', to: '1.1', canary: true });
    expect(deviceUpdates(await loadFleet(env, { deviceId: 'dev_b' }), 'dev_b').items[0]).toMatchObject({ state: 'current', installed: '1.1' });
    // The strong signer (SHA-256 read off the box) was cached for next time.
    expect((await env.DB.prepare("SELECT signer_sha256 FROM update_device_apps WHERE device_id = 'dev_a'").first()).signer_sha256).toMatch(/^\["[0-9a-f]{64}"\]$/);
  });

  it('stops at the canary when the new build has a different signing key, touching nothing', async () => {
    const { env } = makeEnv();
    const builds = await seedSite(env, BOXES, ['v2-k1-arm64.apk']);
    for (const b of BOXES) await env.DB.prepare("INSERT INTO update_devices (device_id, abis, sdk, probed_at) VALUES (?, '[\"arm64-v8a\"]', 30, 0)").bind(b.id).run();
    await env.DB.prepare("INSERT INTO update_sites (site_id, canary_device_id, updated_at) VALUES ('s1', 'dev_b', 0)").run();
    const boxes = [box('10.0.0.1'), box('10.0.0.2', { apk: fx('v2-k2.apk') }), box('10.0.0.3')];
    const { hub, settle } = fakeHub(env, boxes, builds);
    const runner = new UpdateRunner(hub);
    await runner.updateNow({ package: PKG }, 'owner@test');
    await settle();
    const [r] = await rollouts(env);
    expect(r.status).toBe('failed');
    expect(r.devices.map((d) => [d.name, d.status])).toEqual([['Bravo', 'failed'], ['Alpha', 'skipped'], ['Charlie', 'skipped']]);
    expect(r.devices[0].detail).toMatch(/different developer key/);
    expect(boxes.every((b) => b.installs.length === 0)).toBe(true);
    const alert = await env.DB.prepare("SELECT * FROM alerts WHERE type = 'update.failed'").first();
    expect(alert.title).toBe('Fixture update failed on Bravo');
    expect(alert.details).toMatch(/no other box/);
  });

  it('stops when the canary’s app crashes after the update', async () => {
    const { env } = makeEnv();
    const builds = await seedSite(env, BOXES, ['v2-k1-universal.apk']);
    const boxes = [box('10.0.0.1', { crashOnLaunch: true }), box('10.0.0.2'), box('10.0.0.3')];
    const { hub, settle } = fakeHub(env, boxes, builds);
    const runner = new UpdateRunner(hub);
    await runner.probe(); await settle();
    await runner.updateNow({ package: PKG }, 'owner@test'); await settle();
    const [r] = await rollouts(env);
    expect(r.status).toBe('failed');
    expect(r.devices[0].detail).toMatch(/crashed/);
    expect(boxes.map((b) => b.vc)).toEqual([2, 1, 1]);
  });

  it('waits for boxes that are in use, hands the canary role on, and comes back later', async () => {
    const { env } = makeEnv();
    const builds = await seedSite(env, BOXES, ['v2-k1-universal.apk']);
    const boxes = [box('10.0.0.1', { awake: true, playing: true }), box('10.0.0.2'), box('10.0.0.3')];
    const { hub, settle } = fakeHub(env, boxes, builds);
    const runner = new UpdateRunner(hub);
    await runner.probe(); await settle();
    await runner.updateNow({ package: PKG }, 'owner@test'); await settle();
    let [r] = await rollouts(env);
    expect(r.status).toBe('rolling');
    expect(r.devices.map((d) => [d.name, d.status, !!d.canary])).toEqual([['Alpha', 'waiting', false], ['Bravo', 'ok', true], ['Charlie', 'ok', false]]);
    expect(r.devices[0].detail).toMatch(/playing/);
    boxes[0].playing = false;
    T += 6 * 60_000;
    runner.onTick(); await settle();
    [r] = await rollouts(env);
    expect(r.status).toBe('done');
    expect(boxes.map((b) => b.vc)).toEqual([2, 2, 2]);
  });

  it('plans automatic updates only inside the site’s maintenance window, once per version', async () => {
    const { env } = makeEnv();
    const builds = await seedSite(env, BOXES, ['v2-k1-universal.apk']);
    await env.DB.prepare("INSERT INTO update_policies (package, scope_type, scope_id, mode, updated_at) VALUES (?, 'fleet', '', 'auto', 0)").bind(PKG).run();
    const boxes = BOXES.map((b) => box(b.ip));
    const { hub, settle } = fakeHub(env, boxes, builds);
    const runner = new UpdateRunner(hub);
    await runner.probe(); await settle();
    await runner.planAuto(T);
    expect(await rollouts(env)).toEqual([]);
    T = Date.UTC(2026, 10, 26, 16, 30); // 03:30 in Sydney
    await runner.planAuto(T);
    const [r] = await rollouts(env);
    expect(r).toMatchObject({ trigger: 'auto', status: 'canary', version_code: 2 });
    runner.onTick(); await settle();
    expect((await rollouts(env))[0].status).toBe('done');
    expect(boxes.map((b) => b.vc)).toEqual([2, 2, 2]);
    await runner.planAuto(T + 10 * 60_000);
    expect((await rollouts(env)).length).toBe(1);
  });

  it('pins, store-managed apps and newer installs are never touched', async () => {
    const { env } = makeEnv();
    const builds = await seedSite(env, [{ id: 'dev_a', name: 'Alpha', ip: '10.0.0.1', vc: 3 }, { id: 'dev_b', name: 'Bravo', ip: '10.0.0.2', vc: 1 }, { id: 'dev_c', name: 'Charlie', ip: '10.0.0.3', vc: 1 }], ['v2-k1-universal.apk']);
    await env.DB.prepare("INSERT INTO update_policies (package, scope_type, scope_id, mode, updated_at) VALUES (?, 'site', 's1', 'pin', 0)").bind(PKG).run();
    const boxes = [box('10.0.0.1', { vc: 3 }), box('10.0.0.2', { installer: 'com.android.vending' }), box('10.0.0.3')];
    const { hub, settle } = fakeHub(env, boxes, builds);
    const runner = new UpdateRunner(hub);
    await runner.probe(); await settle();
    const p = buildPackages(await loadFleet(env, { siteId: 's1' })).find((x) => x.package === PKG)!;
    expect(p.boxes.map((b) => [b.device_name, b.state])).toEqual([['Alpha', 'ahead'], ['Bravo', 'store'], ['Charlie', 'pinned']]);
    await expect(runner.updateNow({ package: PKG }, 'owner@test')).rejects.toThrow(/already has the newest/);
    await expect(runner.updateNow({ package: PKG, device_ids: ['dev_a'] }, 'owner@test')).rejects.toThrow(/never downgrades/);
    // Choosing the pinned box by hand updates it.
    await runner.updateNow({ package: PKG, device_ids: ['dev_c'], force: true }, 'owner@test'); await settle();
    expect(boxes.map((b) => b.vc)).toEqual([3, 1, 2]);
  });
});

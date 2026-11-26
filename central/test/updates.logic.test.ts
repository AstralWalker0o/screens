import { describe, expect, it } from 'vitest';
import {
  boxState, globMatch, inWindow, localMinutes, nextWindowStart, pickCandidate, resolveMode, rolloutOrder,
  type UpdateCandidate, type UpdatePolicyRow,
} from '../src/shared/updates';
import { busyReason, installErrorText, launchVerdict, parsePreflight, parseProbe, parseSigHashes } from '../src/worker/updates/device';
import { allowedUrl, ghConfig, pickRelease, selectAssets, type GhRelease } from '../src/worker/updates/github';

const K1 = { sha256: 'a'.repeat(64), java_hash: '315c745e' };
const K2 = { sha256: 'b'.repeat(64), java_hash: '6a641ddf' };

describe('maintenance window (site time zone)', () => {
  const syd = 'Australia/Sydney';
  it('uses the site’s wall clock, including daylight saving', () => {
    // 2026-11-26 16:30 UTC = 03:30 AEDT (UTC+11)
    expect(localMinutes(Date.UTC(2026, 10, 26, 16, 30), syd)).toBe(3 * 60 + 30);
    expect(inWindow(Date.UTC(2026, 10, 26, 16, 30), syd, '03:00', '05:00')).toBe(true);
    expect(inWindow(Date.UTC(2026, 10, 26, 18, 0), syd, '03:00', '05:00')).toBe(false); // 05:00 local: the end is exclusive
    // 2026-06-26 17:30 UTC = 03:30 AEST (UTC+10)
    expect(inWindow(Date.UTC(2026, 5, 26, 17, 30), syd, '03:00', '05:00')).toBe(true);
    expect(inWindow(Date.UTC(2026, 5, 26, 16, 30), syd, '03:00', '05:00')).toBe(false); // 02:30 AEST
    expect(inWindow(Date.UTC(2026, 10, 26, 16, 30), 'Europe/London', '03:00', '05:00')).toBe(false); // 16:30 GMT
    expect(inWindow(Date.UTC(2026, 10, 26, 8, 15), 'America/Los_Angeles', '00:00', '01:00')).toBe(true); // 00:15 PST
  });
  it('handles windows that wrap midnight, and bad input', () => {
    expect(inWindow(Date.UTC(2026, 10, 26, 23, 30), 'UTC', '23:00', '02:00')).toBe(true);
    expect(inWindow(Date.UTC(2026, 10, 27, 1, 59), 'UTC', '23:00', '02:00')).toBe(true);
    expect(inWindow(Date.UTC(2026, 10, 27, 2, 0), 'UTC', '23:00', '02:00')).toBe(false);
    expect(inWindow(Date.UTC(2026, 10, 27, 12, 0), 'UTC', '23:00', '02:00')).toBe(false);
    expect(inWindow(Date.UTC(2026, 10, 27, 3, 0), 'UTC', '03:00', '03:00')).toBe(false);
    expect(inWindow(Date.UTC(2026, 10, 27, 3, 0), 'UTC', '3am', '05:00')).toBe(false);
  });
  it('finds the next opening across daylight-saving changes', () => {
    // Sydney DST starts 2026-10-04 02:00 → 03:00: the next 03:00 after Oct 3 noon is 03:00 AEDT = 16:00 UTC Oct 3.
    expect(nextWindowStart(Date.UTC(2026, 9, 3, 2, 0), syd, '03:00', '05:00')).toBe(Date.UTC(2026, 9, 3, 16, 0));
    // DST ends 2026-04-05 03:00 → 02:00: 03:00 AEST on Apr 5 is 17:00 UTC Apr 4.
    expect(nextWindowStart(Date.UTC(2026, 3, 4, 2, 0), syd, '03:00', '05:00')).toBe(Date.UTC(2026, 3, 4, 17, 0));
    const open = Date.UTC(2026, 10, 26, 16, 30);
    expect(nextWindowStart(open, syd, '03:00', '05:00')).toBe(open);
    expect(nextWindowStart(open, syd, '03:00', '03:00')).toBeNull();
  });
});

describe('policy resolution', () => {
  const pol: UpdatePolicyRow[] = [
    { package: 'org.jellyfin.androidtv', scope_type: 'fleet', scope_id: '', mode: 'auto' },
    { package: 'org.jellyfin.androidtv', scope_type: 'site', scope_id: 's_beach', mode: 'pin' },
    { package: 'com.teamsmart.videomanager.tv', scope_type: 'site', scope_id: 's_home', mode: 'auto' },
  ];
  it('site override beats the fleet default, which beats notify', () => {
    expect(resolveMode('org.jellyfin.androidtv', 's_beach', pol)).toEqual({ mode: 'pin', from: 'site' });
    expect(resolveMode('org.jellyfin.androidtv', 's_home', pol)).toEqual({ mode: 'auto', from: 'fleet' });
    expect(resolveMode('com.teamsmart.videomanager.tv', 's_beach', pol)).toEqual({ mode: 'notify', from: 'default' });
    expect(resolveMode('com.teamsmart.videomanager.tv', 's_home', pol)).toEqual({ mode: 'auto', from: 'site' });
  });
});

const cand = (id: string, vc: number, abis: string[], o: Partial<UpdateCandidate> = {}): UpdateCandidate => ({
  apk_id: id, package: 'p.q', version_code: vc, version_name: `1.${vc}`, abis, min_sdk: 21, source: 'github', size: 1, uploaded_at: vc, ...o,
});

describe('which build fits a box', () => {
  const arm64 = { abis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'], sdk: 30 };
  const armv7 = { abis: ['armeabi-v7a', 'armeabi'], sdk: 28 };
  const list = [cand('univ', 2, ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']), cand('a64', 2, ['arm64-v8a']), cand('v7', 2, ['armeabi-v7a']), cand('old', 1, [])];
  it('prefers the build for the box’s primary ABI, then a universal one', () => {
    expect(pickCandidate(list, arm64)?.apk_id).toBe('a64');
    expect(pickCandidate(list, armv7)?.apk_id).toBe('v7');
    expect(pickCandidate(list.filter((c) => c.apk_id !== 'v7'), armv7)?.apk_id).toBe('univ');
    expect(pickCandidate([cand('x86', 3, ['x86'])], armv7)).toBeNull();
  });
  it('honours a per-box ABI choice', () => {
    expect(pickCandidate(list, { ...arm64, abi_override: 'armeabi-v7a' })?.apk_id).toBe('v7');
  });
  it('respects minSdk, and waits to read the processor before picking native builds', () => {
    expect(pickCandidate([cand('new', 3, [], { min_sdk: 31 }), cand('old', 2, [])], armv7)?.apk_id).toBe('old');
    expect(pickCandidate(list, { abis: [] })?.apk_id).toBe('old');
  });
});

describe('box state', () => {
  const box = { abis: ['arm64-v8a', 'armeabi-v7a'], sdk: 30 };
  const base = { mode: 'notify' as const, cands: [cand('a', 5, ['arm64-v8a'])], box };
  it('covers every state', () => {
    expect(boxState({ ...base, installed: { version_code: 4 } }).state).toBe('update');
    expect(boxState({ ...base, installed: { version_code: 5 } }).state).toBe('current');
    expect(boxState({ ...base, installed: { version_code: 6 } }).state).toBe('ahead');
    expect(boxState({ ...base, installed: { version_code: 4 }, installer: 'com.android.vending' }).state).toBe('store');
    expect(boxState({ ...base, cands: [], installed: { version_code: 4 }, installer: 'com.android.vending' }).state).toBe('store');
    expect(boxState({ ...base, cands: [], installed: { version_code: 4 } }).state).toBe('no_source');
    expect(boxState({ ...base, mode: 'pin', installed: { version_code: 4 } }).state).toBe('pinned');
    expect(boxState({ ...base, installed: {} }).state).toBe('unknown');
    expect(boxState({ ...base, box: { abis: ['x86'] }, installed: { version_code: 4 } }).state).toBe('incompatible');
    expect(boxState({ ...base, box: { abis: [] }, installed: { version_code: 4 } }).state).toBe('unknown');
    expect(boxState({ ...base, cands: [cand('n', 5, [], { min_sdk: 33 })], installed: { version_code: 4 } }).detail).toMatch(/newer Android/);
  });
  it('blocks a build signed with a different developer key', () => {
    const signing = { schemes: ['v2' as const], v31: [], v3: [], v2: [{ min_sdk: 0, max_sdk: 0x7fffffff, certs: [K2], lineage: [] }], v1: [] };
    const cands = [cand('a', 5, [], { signing })];
    expect(boxState({ ...base, cands, installed: { version_code: 4 }, signer: { java_hash: [K1.java_hash] } }).state).toBe('signer_mismatch');
    expect(boxState({ ...base, cands, installed: { version_code: 4 }, signer: { sha256: [K1.sha256] } }).state).toBe('signer_mismatch');
    expect(boxState({ ...base, cands, installed: { version_code: 4 }, signer: { java_hash: [K2.java_hash] } }).state).toBe('update');
    expect(boxState({ ...base, cands, installed: { version_code: 4 }, signer: null }).state).toBe('update'); // checked again on the box before installing
  });
});

describe('rollout order', () => {
  const boxes = [
    { id: 'd3', name: 'Lounge', online: true }, { id: 'd1', name: 'Bedroom', online: false },
    { id: 'd2', name: 'Kitchen', online: true }, { id: 'd4', name: 'Attic', online: true },
  ];
  it('puts the chosen canary first, then online boxes by name, offline last', () => {
    expect(rolloutOrder(boxes, 'd2').map((b) => b.id)).toEqual(['d2', 'd4', 'd3', 'd1']);
    expect(rolloutOrder(boxes).map((b) => b.id)).toEqual(['d4', 'd2', 'd3', 'd1']);
    expect(rolloutOrder(boxes, 'd1').map((b) => b.id)).toEqual(['d4', 'd2', 'd3', 'd1']); // an offline canary can't go first
  });
});

describe('reading boxes over adb', () => {
  it('parses the probe (ABIs, installer, dumpsys signature hashes)', () => {
    const out = [
      '@@upd=probe', '@@abi=arm64-v8a', '@@abilist=arm64-v8a,armeabi-v7a,armeabi', '@@sdk=30', '@@PKGS',
      'org.jellyfin.androidtv|versionCode=1709|installerPackageName=null|PackageSignatures{9f2c1a0 version:2, signatures:[315c745e], past signatures:[]}|',
      'com.netflix.ninja|versionCode=123|PackageSignatures{4c1 version:3, signatures:[ab12cd34], past signatures:[ab12cd34 flags: 17]}|installerPackageName=com.android.vending|',
      'com.old.app|versionCode=7|PackageSignatures{77aa [95b62ef]}|',
      'bad pkg|versionCode=1|',
      '@@END',
    ].join('\n');
    const p = parseProbe(out);
    expect(p.abis).toEqual(['arm64-v8a', 'armeabi-v7a', 'armeabi']);
    expect(p.sdk).toBe(30);
    expect(p.apps.get('org.jellyfin.androidtv')).toEqual({ version_code: 1709, installer: null, sig_hashes: ['315c745e'] });
    expect(p.apps.get('com.netflix.ninja')).toEqual({ version_code: 123, installer: 'com.android.vending', sig_hashes: ['ab12cd34'] });
    expect(p.apps.get('com.old.app')?.sig_hashes).toEqual(['95b62ef']);
    expect(p.apps.has('bad pkg')).toBe(false);
    expect(parseSigHashes('garbage')).toEqual([]);
  });

  it('decides whether a box is in use', () => {
    const pre = (o: Record<string, string>) => parsePreflight(Object.entries({ present: '1', vc: '5', wake: 'Awake', home: 'com.google.android.tvlauncher/.MainActivity', playing: '0', ...o }).map(([k, v]) => `@@${k}=${v}`).join('\n'));
    expect(busyReason(pre({ resumed: '  mResumedActivity: ActivityRecord{1a2b u0 com.google.android.tvlauncher/.MainActivity t1}' }))).toBeNull();
    expect(busyReason(pre({ resumed: '  topResumedActivity=ActivityRecord{1a2b u0 org.jellyfin.androidtv/.ui.MainActivity t9}' }))).toMatch(/jellyfin/);
    expect(busyReason(pre({ wake: 'Asleep', resumed: '  mResumedActivity: ActivityRecord{1 u0 org.jellyfin.androidtv/.Main t9}' }))).toBeNull();
    expect(busyReason(pre({ wake: 'Asleep', playing: '1' }))).toMatch(/playing/);
    expect(busyReason(pre({ resumed: 'ActivityRecord{1 u0 com.spocky.projengmenu/.ui.home.HomeActivity t2}', home: 'com.spocky.projengmenu/.Home' }))).toBeNull();
    const p = pre({ installer: 'com.android.vending', sigs: 'PackageSignatures{1 version:2, signatures:[abc], past signatures:[]}' });
    expect(p).toMatchObject({ present: true, version_code: 5, installer: 'com.android.vending', sig_hashes: ['abc'], awake: true });
  });

  it('judges the launch check', () => {
    const v = (lines: string[], awake = true) => launchVerdict(lines.join('\n'), 'org.jellyfin.androidtv', awake);
    expect(v(['@@crash0=0', '@@pid=4242', '@@resumed=  mResumedActivity: ActivityRecord{1 u0 org.jellyfin.androidtv/.Main t9}', '@@crash1=0']).ok).toBe(true);
    expect(v(['@@crash0=1', '@@pid=', '@@resumed=', '@@crash1=2']).ok).toBe(false);
    expect(v(['@@crash0=0', '@@pid=', '@@resumed=  mResumedActivity: ActivityRecord{1 u0 com.google.android.tvlauncher/.Main t1}', '@@crash1=0']).ok).toBe(false);
    expect(v(['@@crash0=0', '@@pid=4242', '@@resumed=', '@@crash1=0'], false)).toEqual({ ok: true, detail: expect.stringMatching(/asleep/) });
    expect(v(['@@nolaunch=1']).ok).toBe(true);
  });

  it('explains install failures in plain English', () => {
    expect(installErrorText('adb: failed to install x.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package org.x signatures do not match]')).toMatch(/different key/);
    expect(installErrorText('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]')).toMatch(/never downgrades/);
    expect(installErrorText('sha256 mismatch: got abc')).toMatch(/checksum/);
  });
});

describe('GitHub source safety', () => {
  const prod = ghConfig({});
  it('only follows GitHub download hosts, over https', () => {
    expect(allowedUrl('https://github.com/jellyfin/jellyfin-androidtv/releases/download/v0.17.0/x.apk', prod)).toBe(true);
    expect(allowedUrl('https://objects.githubusercontent.com/github-production-release-asset-2e65be/1?X-Amz=1', prod)).toBe(true);
    expect(allowedUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1', prod)).toBe(true);
    expect(allowedUrl('http://objects.githubusercontent.com/x', prod)).toBe(false);
    expect(allowedUrl('https://evil.example.com/x.apk', prod)).toBe(false);
    expect(allowedUrl('https://objects.githubusercontent.com.evil.com/x', prod)).toBe(false);
    expect(allowedUrl('https://user:pw@github.com/x', prod)).toBe(false);
    expect(allowedUrl('https://github.com:8443/x', prod)).toBe(false);
    expect(allowedUrl('http://127.0.0.1:8791/x', prod)).toBe(false);
    expect(allowedUrl('file:///etc/passwd', prod)).toBe(false);
  });
  it('allows the test stand-in only when configured', () => {
    const test = ghConfig({ GITHUB_API_BASE: 'http://127.0.0.1:8791/' });
    expect(test.api).toBe('http://127.0.0.1:8791');
    expect(allowedUrl('http://127.0.0.1:8791/dl/1', test)).toBe(true);
    expect(allowedUrl('http://127.0.0.1:9999/dl/1', test)).toBe(false);
    expect(allowedUrl('https://objects.githubusercontent.com/x', test)).toBe(true);
  });
  const rel: GhRelease = {
    id: 1, tag_name: 'v28.66', assets: [
      { id: 1, name: 'SmartTube_stable_28.66_arm64-v8a.apk', size: 10, browser_download_url: 'https://github.com/a/b/1' },
      { id: 2, name: 'SmartTube_stable_28.66_armeabi-v7a.apk', size: 10, browser_download_url: 'https://github.com/a/b/2' },
      { id: 3, name: 'SmartTube_stable_28.66_universal.apk', size: 10, browser_download_url: 'https://github.com/a/b/3' },
      { id: 4, name: 'SmartTube_stable_28.66_x86.apk', size: 0, browser_download_url: 'https://github.com/a/b/4' },
      { id: 5, name: 'checksums.txt', size: 10, browser_download_url: 'https://github.com/a/b/5' },
      { id: 6, name: 'huge.apk', size: 300 * 1024 * 1024, browser_download_url: 'https://github.com/a/b/6' },
    ],
  };
  it('matches file names with simple wildcards', () => {
    expect(globMatch('*.apk', 'SmartTube_stable_28.66_arm64-v8a.apk')).toBe(true);
    expect(globMatch('*arm64*.apk', 'SmartTube_stable_28.66_arm64-v8a.apk')).toBe(true);
    expect(globMatch('*arm64*.apk', 'SmartTube_stable_28.66_armeabi-v7a.apk')).toBe(false);
    expect(globMatch('jellyfin-androidtv-v?.??.?-release.apk', 'jellyfin-androidtv-v0.17.0-release.apk')).toBe(true);
    expect(globMatch('*.apk', 'app.apk.sha256')).toBe(false);
    expect(globMatch('a.b*', 'aXb.apk')).toBe(false); // dots are literal
  });
  it('picks one asset per ABI pattern plus one general build', () => {
    const picks = selectAssets(rel, { asset_pattern: '*universal*.apk', abi_patterns: { 'arm64-v8a': '*arm64*.apk', 'armeabi-v7a': '*armeabi-v7a*.apk' } });
    expect(picks.map((p) => [p.abi, p.asset.id])).toEqual([['arm64-v8a', 1], ['armeabi-v7a', 2], [null, 3]]);
    expect(selectAssets(rel, { asset_pattern: '*.apk', abi_patterns: {} }).map((p) => p.asset.id)).toEqual([1]);
    expect(selectAssets(rel, { asset_pattern: '*.txt', abi_patterns: {} })).toEqual([]);
    expect(selectAssets(rel, { asset_pattern: 'huge.apk', abi_patterns: {} })).toEqual([]);
  });
  it('skips drafts and (unless allowed) pre-releases', () => {
    const list = [
      { id: 3, tag_name: 'v3-beta', prerelease: true, published_at: '2026-11-20T00:00:00Z', assets: [] },
      { id: 4, tag_name: 'v4', draft: true, published_at: '2026-11-25T00:00:00Z', assets: [] },
      { id: 2, tag_name: 'v2', published_at: '2026-11-10T00:00:00Z', assets: [] },
    ];
    expect(pickRelease(list, false)?.tag_name).toBe('v2');
    expect(pickRelease(list, true)?.tag_name).toBe('v3-beta');
  });
});

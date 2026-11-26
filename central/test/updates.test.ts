import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { allCerts, bytesReader, inspectApk, javaHash, newestSignerCert, signingFromTail, type RandomAccess } from '../src/worker/updates/apk';
import { parseManifest } from '../src/worker/updates/axml';
import {
  boxState, compareVersionNames, compareVersions, effectiveSigner, globMatch, inWindow, localMinutes, nextWindowStart, pickCandidate,
  resolveMode, rolloutOrder, signerVerdict, type UpdateCandidate, type UpdatePolicyRow,
} from '../src/shared/updates';

const FIX = join(__dirname, 'fixtures', 'updates');
const fx = (n: string) => new Uint8Array(readFileSync(join(FIX, n)));
const expected = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8')) as { package: string; k1: { sha256: string; java_hash: string }; k2: { sha256: string; java_hash: string } };
const { k1, k2 } = expected;

describe('APK inspection (real APKs built with aapt2 + apksigner)', () => {
  it('reads package, version and signer of a v1+v2+v3 signed APK', async () => {
    const a = await inspectApk(bytesReader(fx('v1-k1.apk')));
    expect(a).toMatchObject({ package: expected.package, version_code: 1, version_name: '1.0', min_sdk: 21, target_sdk: 34, label: 'Screens Fixture', abis: [] });
    expect(a.signing.schemes).toEqual(['v3', 'v2', 'v1']);
    expect(a.signing.v2[0].certs[0]).toMatchObject({ sha256: k1.sha256, java_hash: k1.java_hash, subject: 'CN=Screens test fixture k1' });
    expect(a.signing.v1[0].certs[0].sha256).toBe(k1.sha256);
    expect(newestSignerCert(a.signing)?.sha256).toBe(k1.sha256);
  });

  it('lists native ABIs', async () => {
    expect((await inspectApk(bytesReader(fx('v2-k1-arm64.apk')))).abis).toEqual(['arm64-v8a']);
    expect((await inspectApk(bytesReader(fx('v2-k1-armv7.apk')))).abis).toEqual(['armeabi-v7a']);
    expect((await inspectApk(bytesReader(fx('v2-k1-universal.apk')))).abis).toEqual(['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86']);
  });

  it('follows key rotation (v3.1 for Android 13+, v3 below)', async () => {
    const a = await inspectApk(bytesReader(fx('v3-rotated.apk')));
    expect(a.signing.schemes).toEqual(['v3.1', 'v3', 'v2', 'v1']);
    expect(effectiveSigner(a.signing, 30)?.certs[0].sha256).toBe(k1.sha256);
    const t = effectiveSigner(a.signing, 34)!;
    expect(t.scheme).toBe('v3.1');
    expect(t.certs[0].sha256).toBe(k2.sha256);
    expect(t.lineage.map((c) => c.sha256)).toEqual([k1.sha256, k2.sha256]);
    // A box signed with the old key accepts the rotated build on both platform versions.
    expect(signerVerdict(a.signing, { sha256: [k1.sha256] }, 30)).toBe('match');
    expect(signerVerdict(a.signing, { sha256: [k1.sha256] }, 34)).toBe('match');
    expect(allCerts(a.signing).map((c) => c.sha256).sort()).toEqual([k1.sha256, k2.sha256].sort());
  });

  it('reads rotation in the plain v3 block', async () => {
    const a = await inspectApk(bytesReader(fx('v3-rotated-p.apk')));
    const p = effectiveSigner(a.signing, 30)!;
    expect(p.scheme).toBe('v3');
    expect(p.certs[0].sha256).toBe(k2.sha256);
    expect(p.lineage.map((c) => c.sha256)).toEqual([k1.sha256, k2.sha256]);
    expect(effectiveSigner(a.signing, 26)?.certs[0].sha256).toBe(k1.sha256); // Android 8 uses v2
  });

  it('reads the certificate from a JAR-only (v1) signature', async () => {
    const a = await inspectApk(bytesReader(fx('v4-k1-jaronly.apk')));
    expect(a.signing.schemes).toEqual(['v1']);
    expect(effectiveSigner(a.signing, 30)?.certs[0]).toMatchObject({ sha256: k1.sha256, java_hash: k1.java_hash });
  });

  it('combines versionCodeMajor into the long version code', async () => {
    const a = await inspectApk(bytesReader(fx('v5-major.apk')));
    expect(a.version_code).toBe(2 ** 32 + 5);
    expect(a.version_name).toBe('2.0');
  });

  it('flags a different signer', async () => {
    const a = await inspectApk(bytesReader(fx('v2-k2.apk')));
    expect(signerVerdict(a.signing, { sha256: [k1.sha256] }, 30)).toBe('mismatch');
    expect(signerVerdict(a.signing, { java_hash: [k1.java_hash] }, 30)).toBe('mismatch');
    expect(signerVerdict(a.signing, { java_hash: [k2.java_hash] }, 30)).toBe('match');
    expect(signerVerdict(a.signing, null, 30)).toBe('unknown');
  });

  it('reads only the signing block through range reads (as done on a box)', async () => {
    const buf = fx('v2-k1-universal.apk');
    const reads: [number, number][] = [];
    const r: RandomAccess = { size: buf.length, read: async (o, l) => { reads.push([o, l]); return buf.subarray(o, o + l); } };
    const s = await signingFromTail(r);
    expect(effectiveSigner(s, 30)?.certs[0].sha256).toBe(k1.sha256);
    expect(reads.every(([o]) => o >= buf.length - 128 * 1024)).toBe(true);
  });

  it('rejects things that are not APKs', async () => {
    await expect(inspectApk(bytesReader(new TextEncoder().encode('<html>rate limited</html>')))).rejects.toThrow(/ZIP|small/);
    await expect(inspectApk(bytesReader(zipSync({ 'hello.txt': new TextEncoder().encode('hi') })))).rejects.toThrow(/AndroidManifest/);
    await expect(inspectApk(bytesReader(zipSync({ 'AndroidManifest.xml': new Uint8Array([3, 0, 8, 0, 255, 255, 255, 255]) })))).rejects.toThrow(/manifest/);
  });

  it('computes Java Arrays.hashCode like dumpsys (no leading zeros, signed bytes)', () => {
    expect(javaHash(new Uint8Array([]))).toBe('1');
    expect(javaHash(new Uint8Array([0x80, 0x7f]))).toBe((((31 + -128) * 31 + 127) >>> 0).toString(16));
  });

  it('survives truncated or garbled manifests', () => {
    const good = fx('v1-k1.apk');
    void good;
    const rnd = new Uint8Array(4096).map((_, i) => (i * 2654435761) >>> 24);
    rnd[0] = 3; rnd[1] = 0; rnd[2] = 8; rnd[3] = 0;
    expect(() => parseManifest(rnd)).not.toThrow();
    expect(parseManifest(new Uint8Array(3))).toBeNull();
  });
});

describe('version order', () => {
  it('compares version names', () => {
    expect(compareVersionNames('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersionNames('v0.17.0', '0.16.11')).toBe(1);
    expect(compareVersionNames('2.0.0-beta1', '2.0.0')).toBe(-1);
    expect(compareVersionNames('2.0.0-rc2', '2.0.0-rc10')).toBe(-1);
    expect(compareVersionNames('9.6.0 build 2', '9.6.0')).toBe(0);
    expect(compareVersionNames('28.66', '28.66')).toBe(0);
    expect(compareVersionNames(null, '1.0')).toBe(-1);
  });
  it('prefers versionCode when both are known', () => {
    expect(compareVersions({ version_code: 2866, version_name: '28.66' }, { version_code: 2900, version_name: '28.70' })).toBe(-1);
    expect(compareVersions({ version_code: 10, version_name: '9.0' }, { version_code: 9, version_name: '10.0' })).toBe(1);
    expect(compareVersions({ version_code: null, version_name: '1.2' }, { version_code: 5, version_name: '1.10' })).toBe(-1);
  });
});

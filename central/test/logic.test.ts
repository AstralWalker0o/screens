import { describe, expect, it } from 'vitest';
import { buildRules, classify, guessCategory, parseList, serializeRules } from '../src/worker/dns/compile';
import { cronMatches, nextRun, parseCron } from '../src/worker/automations/cron';
import { parseMarkers, parseMicUsage, parsePackages, parseResumed, parseScreen } from '../src/worker/adapters/android';
import { parseDidl, parseZoneGroups, soapEnvelope } from '../src/worker/adapters/sonos';
import { fingerprint } from '../src/worker/adapters';
import { scoreDevice } from '../src/worker/privacy/score';
import { signAgentUrl, verifyAgentUrl, sealJson, openJson, verifyEd25519, b64urlEncode } from '../src/worker/lib/crypto';
import { certNotAfter } from '../src/worker/acme/acme';
import { normMac, isPrivateIPv4, domainValid, assertPackage } from '../src/worker/lib/util';
import type { DnsSummary } from '../src/shared/types';

describe('blocklist parsing', () => {
  it('parses domains, hosts and adblock formats', () => {
    expect(parseList('# c\nfoo.com\n*.bar.net\nlocalhost\nbad\n  baz.org # note\n', 'domains')).toEqual(['foo.com', 'bar.net', 'baz.org']);
    expect(parseList('0.0.0.0 ads.x.com\n127.0.0.1 localhost\n0.0.0.0 t.y.io\n', 'hosts')).toEqual(['ads.x.com', 't.y.io']);
    expect(parseList('! c\n||ads.z.com^\n@@||ok.com^\n||path.com/x\n', 'adblock')).toEqual(['ads.z.com']);
  });
  it('guesses categories', () => {
    expect(guessCategory('log-ingestion.samsungacr.com', 'telemetry')).toBe('acr');
    expect(guessCategory('acr-au-prd.samsungcloud.tv', 'telemetry')).toBe('acr');
    expect(guessCategory('us.ad.lgsmartad.com', 'telemetry')).toBe('ads');
    expect(guessCategory('metrics.icloud.com', 'tracking')).toBe('telemetry');
    expect(guessCategory('cdn.example.com', 'tracking')).toBe('tracking');
  });
  it('builds policies with curated allows overriding broad list blocks', () => {
    const lists = [{ domains: ['samsungcloudsolution.com', 'samsungotn.net', 'ads.example.com'], category: 'telemetry' as const, policies: ['balanced' as const, 'strict' as const] }];
    const rules = buildRules('balanced', lists, [{ domain: 'mine.example', action: 'block', scope_type: 'global', policies: '["balanced"]' }]);
    const by = new Map(rules.map((r) => [r.domain, r]));
    expect(by.get('samsungotn.net')?.action).toBe('a');           // curated allow wins
    expect(by.get('time.samsungcloudsolution.com')?.action).toBe('a');
    expect(by.get('samsungacr.com')).toMatchObject({ action: 'b', cat: 'acr' });
    expect(by.get('mine.example')?.action).toBe('b');
    expect(buildRules('strict', lists, [{ domain: 'mine.example', action: 'block', scope_type: 'global', policies: '["balanced"]' }]).find((r) => r.domain === 'mine.example')).toBeUndefined();
    const text = serializeRules('balanced', rules);
    expect(text.split('\n')[0]).toMatch(/^# screens-policy v1 id=balanced/);
    expect(text).toContain('b samsungacr.com acr');
  });
  it('classifies by most specific curated suffix', () => {
    expect(classify('x.time.samsungcloudsolution.com').category).toBe('essential');
    expect(classify('foo.samsungcloudsolution.com').category).toBe('vendor');
    expect(classify('example.org').category).toBeNull();
  });
});

describe('cron', () => {
  it('matches in a timezone', () => {
    // 2026-11-26 13:00 UTC = 2026-11-27 00:00 in Sydney (AEDT, UTC+11)
    const t = Date.UTC(2026, 10, 26, 13, 0);
    expect(cronMatches('0 0 * * *', t, 'Australia/Sydney')).toBe(true);
    expect(cronMatches('0 0 * * *', t, 'UTC')).toBe(false);
    expect(cronMatches('0 13 * * 4', t, 'UTC')).toBe(true); // Thursday
    expect(cronMatches('*/15 9-17 * * 1-5', Date.UTC(2026, 10, 26, 10, 30), 'UTC')).toBe(true);
  });
  it('validates and computes next run', () => {
    expect(() => parseCron('61 * * * *')).toThrow();
    expect(() => parseCron('* * *')).toThrow();
    const n = nextRun('30 11 * * *', Date.UTC(2026, 10, 26, 0, 0), 'UTC');
    expect(n).toBe(Date.UTC(2026, 10, 26, 11, 30));
  });
});

describe('android parsing', () => {
  it('parses markers, screen and resumed activity', () => {
    const m = parseMarkers('@@model=SHIELD Android TV\n@@sdk=30\njunk\n@@wm=Physical size: 1920x1080 ');
    expect(m.model).toBe('SHIELD Android TV');
    expect(parseScreen(m.wm)).toEqual({ width: 1920, height: 1080 });
    expect(parseScreen('Physical size: 3840x2160 Override size: 1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseResumed('  mResumedActivity: ActivityRecord{1a2b u0 com.netflix.ninja/.MainActivity t42}')).toBe('com.netflix.ninja');
    expect(parseResumed('topResumedActivity=ActivityRecord{9 u0 com.google.android.tvlauncher/.MainActivity t1}')).toBe('com.google.android.tvlauncher');
  });
  it('parses package listings', () => {
    const out = [
      '@@3P', 'package:com.netflix.ninja', 'package:com.spotify.tv.android',
      '@@ALL',
      'package:/data/app/~~abc==/com.netflix.ninja-xyz==/base.apk=com.netflix.ninja versionCode:123',
      'package:/system/priv-app/Katniss/Katniss.apk=com.google.android.katniss versionCode:9',
      'package:/data/app/com.spotify.tv.android-1/base.apk=com.spotify.tv.android versionCode:5',
      '@@DIS', 'package:com.spotify.tv.android',
      '@@MIC', 'com.google.android.katniss',
      '@@CAM',
      '@@VER', 'com.netflix.ninja 8.1.0 build 4', 'com.spotify.tv.android 1.2',
      '@@END',
    ].join('\n');
    const apps = parsePackages(out);
    const n = apps.find((a) => a.package === 'com.netflix.ninja')!;
    expect(n).toMatchObject({ system: false, enabled: true, version_code: 123, version_name: '8.1.0 build 4' });
    expect(apps.find((a) => a.package === 'com.google.android.katniss')).toMatchObject({ system: true, permissions: ['RECORD_AUDIO'] });
    expect(apps.find((a) => a.package === 'com.spotify.tv.android')?.enabled).toBe(false);
  });
  it('parses mic usage', () => {
    const u = parseMicUsage(['  Uid u0a12:', '    Package com.google.android.katniss:', '      RECORD_AUDIO (allow):', '        Access: [top-s] 2026-11-26 09:58:12.345 (-2m14s345ms) duration=+3s'].join('\n'));
    expect(u[0].package).toBe('com.google.android.katniss');
    expect(u[0].last_access).toContain('2026-11-26 09:58:12');
  });
});

describe('sonos parsing', () => {
  it('parses zone groups and DIDL', () => {
    const zgs = '&lt;ZoneGroupState&gt;&lt;ZoneGroups&gt;&lt;ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1"&gt;&lt;ZoneGroupMember UUID="RINCON_A" Location="http://10.0.20.50:1400/xml/device_description.xml" ZoneName="Lounge"/&gt;&lt;ZoneGroupMember UUID="RINCON_B" Location="http://10.0.20.51:1400/xml/device_description.xml" ZoneName="Kitchen"/&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;&lt;/ZoneGroupState&gt;';
    const m = parseZoneGroups(zgs);
    expect(m).toHaveLength(2);
    expect(m[1]).toMatchObject({ uuid: 'RINCON_B', name: 'Kitchen', ip: '10.0.20.51', coordinator: 'RINCON_A' });
    const didl = '&lt;DIDL-Lite&gt;&lt;item&gt;&lt;dc:title&gt;Song&lt;/dc:title&gt;&lt;dc:creator&gt;Artist&lt;/dc:creator&gt;&lt;upnp:album&gt;LP&lt;/upnp:album&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;';
    expect(parseDidl(didl)).toMatchObject({ title: 'Song', artist: 'Artist', album: 'LP' });
    expect(soapEnvelope('RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: 20 })).toContain('<DesiredVolume>20</DesiredVolume>');
  });
});

describe('fingerprinting', () => {
  it('recognises the fleet', () => {
    expect(fingerprint({ ip: '1', ports: [1400], mdns: [], ssdp: [] }).kind).toBe('sonos');
    expect(fingerprint({ ip: '1', ports: [8001, 8002, 9197], mdns: [], ssdp: [] }).kind).toBe('samsung');
    expect(fingerprint({ ip: '1', ports: [3000, 3001], mdns: [], ssdp: [] }).kind).toBe('lg');
    expect(fingerprint({ ip: '1', ports: [3000], mdns: [], ssdp: [] }).kind).toBeNull();   // e.g. a Grafana box
    expect(fingerprint({ ip: '1', ports: [], mdns: [], ssdp: [{ server: 'WebOS/4.1.0 UPnP/1.0' }] }).kind).toBe('lg');
    const shield = fingerprint({ ip: '1', ports: [5555, 8008, 8009], mdns: [{ service: '_googlecast._tcp', instance: 'x', txt: { fn: 'Lounge Shield', md: 'SHIELD Android TV' } }], ssdp: [] });
    expect(shield).toMatchObject({ kind: 'android', name: 'Lounge Shield', manufacturer: 'NVIDIA' });
    expect(fingerprint({ ip: '1', ports: [22], mdns: [], ssdp: [] }).kind).toBeNull();
  });
});

describe('privacy score', () => {
  const empty: DnsSummary = { hours: 24, queries: 0, blocked: 0, would_block: 0, by_category: {}, series: [], top_domains: [], top_blocked: [], by_device: [] };
  it('penalises bypass and unblocked ACR', () => {
    const t = Date.now();
    const bad = scoreDevice({ kind: 'samsung', dns_mode: 'monitor', online: true, summary: { ...empty, by_category: { acr: 40 }, would_block: 300 }, last_query_at: t - 3 * 3_600_000, checklist_done: {}, mic: [], private_dns: false, acr_unblocked: 40 }, t);
    expect(bad.bypass_suspected).toBe(true);
    expect(bad.grade).toBe('F');
    const good = scoreDevice({ kind: 'samsung', dns_mode: 'enforce', online: true, summary: { ...empty, by_category: { acr: 40 }, blocked: 300 }, last_query_at: t - 60_000, checklist_done: { viewing_info: true, interest_ads: true, voice: true, autorun: true, account: true, power_on_mobile: true, access_notification: true }, mic: [], private_dns: false, acr_unblocked: 0 }, t);
    expect(good.score).toBe(100);
    expect(good.checklist.find((c) => c.key === 'dns_routed')?.done).toBe(true);
  });
});

describe('crypto', () => {
  it('signs and verifies agent URLs', async () => {
    const url = await signAgentUrl('s3cret', 'https://x.dev', 'GET', 'policies/balanced/abc.gz', 60_000);
    const u = new URL(url);
    expect(u.pathname).toBe('/agent/v1/files/policies/balanced/abc.gz');
    expect(await verifyAgentUrl('s3cret', 'GET', 'policies/balanced/abc.gz', u.searchParams.get('exp'), u.searchParams.get('sig'))).toBe(true);
    expect(await verifyAgentUrl('s3cret', 'PUT', 'policies/balanced/abc.gz', u.searchParams.get('exp'), u.searchParams.get('sig'))).toBe(false);
    expect(await verifyAgentUrl('other', 'GET', 'policies/balanced/abc.gz', u.searchParams.get('exp'), u.searchParams.get('sig'))).toBe(false);
  });
  it('seals secrets', async () => {
    const key = btoa('0123456789abcdef0123456789abcdef');
    const sealed = await sealJson(key, { token: '1234' });
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(await openJson(key, sealed, {})).toEqual({ token: '1234' });
    expect(await openJson(btoa('x'.repeat(32)), sealed, { none: true })).toEqual({ none: true });
  });
  it('verifies ed25519 connect signatures', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = b64urlEncode(await crypto.subtle.exportKey('raw', kp.publicKey));
    const msg = 'screens-agent-v1\ngw_1\n123\nnonce';
    const sig = b64urlEncode(await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(msg)));
    expect(await verifyEd25519(pub, msg, sig)).toBe(true);
    expect(await verifyEd25519(pub, msg + 'x', sig)).toBe(false);
  });
});

describe('util', () => {
  it('validates inputs', () => {
    expect(normMac('BC-24-11-AA-BB-CC')).toBe('bc:24:11:aa:bb:cc');
    expect(isPrivateIPv4('10.0.20.5')).toBe(true);
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(domainValid('log-config.samsungacr.com')).toBe(true);
    expect(domainValid('not a domain')).toBe(false);
    expect(() => assertPackage('com.foo; rm -rf /')).toThrow();
    expect(assertPackage('com.netflix.ninja')).toBe('com.netflix.ninja');
  });
});

describe('acme helpers', () => {
  it('reads notAfter from a certificate', () => {
    // Real self-signed P-256 cert generated with openssl (notAfter Feb 24 09:24:26 2027 GMT)
    const pem = `-----BEGIN CERTIFICATE-----
MIIBizCCATGgAwIBAgIUeqAO20cW2HWa3x6RbWVhsl2YJ7cwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQdGVzdC5kbnMuZXhhbXBsZTAeFw0yNjExMjYwOTI0MjZaFw0y
NzAyMjQwOTI0MjZaMBsxGTAXBgNVBAMMEHRlc3QuZG5zLmV4YW1wbGUwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAARP0Um1/X7jSVpDRinrpmLKPzvz8QRxD8WGXY/e
Kid8FyrAMWxiATMKIJJfAw4EAJ1dOdM5zH5ax7YMaVuxL0rbo1MwUTAdBgNVHQ4E
FgQUBuTP/WC1kQi6lke6dPRXj6o6pVAwHwYDVR0jBBgwFoAUBuTP/WC1kQi6lke6
dPRXj6o6pVAwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEAg0yO
kQSe7QehXnhOzkd9KFsypsHguZSI+bNtL9DEHlUCIH27Wd0NO2Lyxk9TVuYsKTSD
UU/DlCFPff1UUNlBsF7h
-----END CERTIFICATE-----`;
    expect(certNotAfter(pem)).toBe(1803461066000);
  });
});

import { parseBroadcast } from '../src/worker/adapters/android';
describe('launcher broadcast parsing', () => {
  it('parses am broadcast results', () => {
    expect(parseBroadcast('Broadcasting: Intent { act=x }\nBroadcast completed: result=1, data="ok:abc123"\n')).toEqual({ result: 1, data: 'ok:abc123' });
    const st = parseBroadcast('Broadcast completed: result=1, data="status:{\\"version\\":\\"1.0.0\\",\\"is_home\\":true}"');
    expect(st.result).toBe(1);
    expect(JSON.parse(st.data!.slice(7))).toEqual({ version: '1.0.0', is_home: true });
    expect(parseBroadcast('Broadcast completed: result=0')).toEqual({ result: 0, data: null });
    expect(parseBroadcast('Error: no receiver').result).toBeNull();
  });
});

import { parseFavorites } from '../src/worker/adapters/sonos';
describe('sonos favorites', () => {
  it('parses FV:2 browse results', () => {
    const r = '&lt;DIDL-Lite&gt;&lt;item id="FV:2/1"&gt;&lt;dc:title&gt;Triple J&lt;/dc:title&gt;&lt;res&gt;x-sonosapi-stream:s25065?sid=254&amp;amp;flags=8224&lt;/res&gt;&lt;r:resMD&gt;&amp;lt;DIDL-Lite&amp;gt;meta&amp;lt;/DIDL-Lite&amp;gt;&lt;/r:resMD&gt;&lt;/item&gt;&lt;item id="FV:2/2"&gt;&lt;dc:title&gt;Chill&lt;/dc:title&gt;&lt;res&gt;x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a1&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;';
    const f = parseFavorites(r);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ title: 'Triple J', kind: 'radio' });
    expect(f[0].uri).toBe('x-sonosapi-stream:s25065?sid=254&flags=8224');
    expect(f[0].meta).toBe('<DIDL-Lite>meta</DIDL-Lite>');
    expect(f[1]).toMatchObject({ title: 'Chill', kind: 'playlist' });
  });
});

import { checkControl, mirrorOptions, ScrcpyVideoParser, serverCommand } from '../src/worker/hub/mirror';
describe('scrcpy mirroring', () => {
  const be32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
  const cat = (...p: Uint8Array[]) => { const out = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of p) { out.set(x, o); o += x.length; } return out; };
  const pkt = (hi: number, lo: number, payload: number[]) => cat(be32(hi), be32(lo), be32(payload.length), new Uint8Array(payload));
  const name = new Uint8Array(64); name.set(new TextEncoder().encode('SHIELD Android TV'));
  const stream = cat(new Uint8Array([0]), name, be32(0x68323634), cat(be32(0x80000000), be32(1280), be32(720)),
    pkt(0x40000000, 0, [0, 0, 0, 1, 0x67, 0x64, 0, 0x1f]),           // config (SPS)
    pkt(0x20000000, 0, [0, 0, 0, 1, 0x65, 1, 2, 3]),                   // keyframe
    pkt(0, 33333, [0, 0, 0, 1, 0x41, 9]),                              // delta
    cat(be32(0x80000001), be32(720), be32(1280)));                     // rotation: new session
  it('parses a stream fed in arbitrary chunk sizes', () => {
    for (const chunk of [1, 3, 7, 12, 64, 1000]) {
      const units: string[] = []; const metas: any[] = [];
      const p = new ScrcpyVideoParser((u, k) => units.push(`${k}:${u.length}`), (m) => metas.push(m));
      for (let i = 0; i < stream.length; i += chunk) p.push(stream.subarray(i, i + chunk));
      expect(units).toEqual(['session:12', 'config:20', 'key:20', 'delta:18', 'session:12']);
      expect(metas[0]).toEqual({ device_name: 'SHIELD Android TV', codec: 'h264', width: 1280, height: 720 });
      expect(metas[1]).toMatchObject({ width: 720, height: 1280 });
      expect(p.lastConfig?.length).toBe(20);
    }
  });
  it('rejects a device-side configuration error', () => {
    const p = new ScrcpyVideoParser(() => undefined, () => undefined);
    expect(() => p.push(cat(new Uint8Array([0]), name, be32(1)))).toThrow(/configuration error/);
  });
  it('allow-lists control messages', () => {
    const touch = new Uint8Array(32); touch[0] = 2;
    expect(checkControl(touch)).toBeNull();
    expect(checkControl(new Uint8Array([2, 0, 0]))).toMatch(/32 bytes/);
    const key = new Uint8Array(14); key[0] = 0;
    expect(checkControl(key)).toBeNull();
    expect(checkControl(cat(new Uint8Array([1]), be32(2), new Uint8Array([104, 105])))).toBeNull();
    expect(checkControl(cat(new Uint8Array([1]), be32(400), new Uint8Array(400)))).toMatch(/text length/);
    expect(checkControl(new Uint8Array([17]))).toBeNull();
    expect(checkControl(new Uint8Array([16, 0]))).toMatch(/not allowed/);   // START_APP
    expect(checkControl(new Uint8Array([9]))).toMatch(/not allowed/);       // SET_CLIPBOARD
  });
  it('builds a safe server command', () => {
    const cmd = serverCommand('0a1b2c3d', mirrorOptions(new URLSearchParams('max_size=99999&max_fps=2&bitrate=abc')));
    expect(cmd).toContain('com.genymobile.scrcpy.Server 5.0.1 scid=0a1b2c3d');
    expect(cmd).toContain('max_size=1920');
    expect(cmd).toContain('max_fps=5');
    expect(cmd).toContain('video_bit_rate=4000000');
    expect(cmd).toContain('tunnel_forward=true');
    expect(() => serverCommand('0a1b; reboot', mirrorOptions(new URLSearchParams()))).toThrow();
  });
});

// Drives the real Sonos adapter against tools/sim/sim.py over plain HTTP (no gateway, no Worker).
// Opt-in, because it needs the simulator running on free loopback addresses:
//   python3 tools/sim/sim.py --sonos 127.0.0.30,127.0.0.31,127.0.0.32 &
//   SONOS_SIM=127.0.0.30,127.0.0.31,127.0.0.32 npx vitest run test/sonos.sim.test.ts
// The sim keeps state, so start it fresh before each run.
import { describe, expect, it } from 'vitest';
import { fetchArt, siteOverview, sonos } from '../src/worker/adapters/sonos';
import type { AdapterCtx } from '../src/worker/adapters/types';
import { AdapterError } from '../src/worker/adapters/types';

const IPS = (process.env.SONOS_SIM ?? '').split(',').filter(Boolean);
const uuid = (ip: string) => `RINCON_SIM${ip.split('.').pop()!.padStart(3, '0')}01400`;

function makeCtx(ip: string, rows: Record<string, any>[]): AdapterCtx & { row: any; logs: string[] } {
  const row = rows.find((r) => r.ip === ip)!;
  const logs: string[] = [];
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }), first: async () => rows[0] }) }) };
  return {
    row, logs, env: { DB: db } as any, device: row, origin: 'http://localhost',
    async gw(op: string, args: any = {}) {
      if (op !== 'http.request') throw new AdapterError('not_supported', op);
      const r = await fetch(args.url, { method: args.method ?? 'GET', body: args.body, headers: args.headers, signal: AbortSignal.timeout(args.timeout_ms ?? 5000) });
      const buf = new Uint8Array(await r.arrayBuffer());
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      try { return { status: r.status, headers, body: new TextDecoder('utf-8', { fatal: true }).decode(buf) } as any; }
      catch { return { status: r.status, headers, body_b64: Buffer.from(buf).toString('base64') } as any; }
    },
    openWs: async () => { throw new Error('no ws'); }, getSecrets: async () => ({}) as any, setSecrets: async () => undefined,
    async update(f: any) {
      if (f.facts) row.facts = JSON.stringify({ ...JSON.parse(row.facts || '{}'), ...f.facts });
      for (const k of Object.keys(f)) if (k !== 'facts') row[k] = f[k];
    },
    log: (m: string) => logs.push(m),
  };
}

describe.skipIf(IPS.length < 3)('sonos adapter against the simulator', () => {
  const rows = IPS.map((ip, i) => ({ id: `dev_${i}`, site_id: 's_sim', kind: 'sonos', name: ['Living Room', 'Kitchen', 'Office'][i], ip, model: null, facts: '{}', status: 'online' }));
  const [lr, kitchen, arc] = IPS.map((ip) => makeCtx(ip, rows));
  const facts = (c: { row: any }) => JSON.parse(c.row.facts);

  it('refresh reads the stopped YouTube Music session with usable art', async () => {
    for (const c of [lr, kitchen, arc]) await c.update(await sonos.refresh(c));
    const f = facts(kitchen);
    expect(f.now_playing).toMatchObject({ state: 'STOPPED', title: 'Space Blues', artist: 'Sweeps', service: 'YouTube Music' });
    expect(f.now_playing.art).toMatch(/^\/getaa\?s=1&u=x-sonosapi-hls-static/);
    expect(f.has_line_in).toBe(true);
    expect(facts(arc).has_tv).toBe(true);
    expect(kitchen.row.model).toBe('Sonos Era 100');
  });

  it('Play on an ended app session falls back to the Sonos queue and really plays', async () => {
    const r = await sonos.command(kitchen, 'media', { action: 'play' });
    expect(r).toMatchObject({ ok: true, state: 'PLAYING' });
    expect(r.detail).toMatch(/session had ended/);
    expect(facts(kitchen).now_playing.state).toBe('PLAYING');
    expect(kitchen.logs.join('\n')).toMatch(/Play refused \(UPnP 701\); source session/);
  });

  it('serves album art through the proxy path', async () => {
    const art = await fetchArt(kitchen, facts(kitchen).now_playing.art);
    expect(art.content_type).toBe('image/png');
    expect(Buffer.from(art.body_b64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    await expect(fetchArt(kitchen, '/xml/device_description.xml')).rejects.toThrow(/album-art/);
  });

  it('groups, reads group volume, routes transport to the coordinator', async () => {
    await sonos.command(kitchen, 'join', { coordinator_uuid: uuid(IPS[0]) });
    const st = await sonos.command(kitchen, 'status', {});
    expect(st.group.members.map((m: any) => m.name)).toEqual(['Living Room', 'Kitchen']);
    expect(st.group.is_coordinator).toBe(false);
    expect(st.group.volume).toBe(25);
    expect((await sonos.command(kitchen, 'group_volume', { level: 40 })).level).toBe(40);
    expect((await sonos.command(kitchen, 'volume', { uuid: uuid(IPS[0]), level: 10 })).level).toBe(10);
    const p = await sonos.command(kitchen, 'media', { action: 'pause' });
    expect(p.state).toBe('PAUSED_PLAYBACK');
    // Pausing again is fine (Sonos would answer 701).
    expect((await sonos.command(kitchen, 'media', { action: 'pause' })).ok).toBe(true);
    await expect(sonos.command(kitchen, 'join', { coordinator_uuid: uuid(IPS[0]) })).resolves.toMatchObject({ detail: /already/ });
  });

  it('queue: list, play a position, remove, clear; empty queue gives a plain reason', async () => {
    const q = await sonos.command(lr, 'queue', {});
    expect(q.total).toBe(4);
    expect(q.items[3]).toMatchObject({ index: 4, title: 'Rock & Roll', artist: 'Led Zeppelin', duration_s: 210 });
    expect(q.items[0].art).toMatch(/^\/getaa\?/);
    const pq = await sonos.command(lr, 'play_queue', { index: 3 });
    expect(pq).toMatchObject({ state: 'PLAYING' });
    expect(facts(lr).now_playing.title).toBe('Breathe Deeper');
    await sonos.command(lr, 'remove_from_queue', { index: 4 });
    expect((await sonos.command(lr, 'queue', {})).total).toBe(3);
    const pm = await sonos.command(lr, 'play_mode', { shuffle: true, repeat: 'all' });
    expect(pm.play_mode).toEqual({ shuffle: true, repeat: 'all' });
    const seek = await sonos.command(lr, 'seek', { track: 2 });
    expect(seek.now_playing.title).toBe('Midnight City');
    await sonos.command(lr, 'clear_queue', {});
    await sonos.command(lr, 'clear_queue', {}); // already empty: 804 is fine
    await sonos.command(lr, 'media', { action: 'stop' });
    await expect(sonos.command(lr, 'media', { action: 'play' })).rejects.toThrow(/queue is empty/);
  });

  it('plays a Sonos playlist and a favourite station; shuffle on radio explains why not', async () => {
    const pls = await sonos.command(lr, 'playlists', {});
    expect(pls.map((p: any) => p.title)).toEqual(['Dinner & Drinks', 'Sunday']);
    const r = await sonos.command(lr, 'play_favorite', { uri: pls[0].uri, meta: pls[0].meta });
    expect(r.state).toBe('PLAYING');
    expect((await sonos.command(lr, 'queue', {})).items[0].title).toBe('Playlist item 1');
    const favs = await sonos.command(lr, 'favorites', {});
    await sonos.command(lr, 'play_favorite', { uri: favs[0].uri, meta: favs[0].meta });
    await expect(sonos.command(lr, 'play_mode', { shuffle: true })).rejects.toThrow(/only work when playing from the Sonos queue/);
  });

  it('settings: home-theatre levels on the soundbar only, button lock, alarms', async () => {
    const one = await sonos.command(lr, 'settings', {});
    expect(one).toMatchObject({ ok: true, led: true, button_lock: false, ht: null, has_tv: false });
    const bar = await sonos.command(arc, 'settings', {});
    expect(bar.has_tv).toBe(true);
    expect(bar.ht).toMatchObject({ night_mode: false, surround_level: 0, audio_delay: 0 });
    const eq = await sonos.command(arc, 'eq', { night_mode: true, surround_level: 20, audio_delay: 3 });
    expect(eq.ht).toMatchObject({ night_mode: true, surround_level: 15, audio_delay: 3 });
    expect(eq.eq.night_mode).toBe(true);
    const unsupported = await sonos.command(lr, 'eq', { night_mode: true });
    expect(unsupported.eq.night_mode).toBe('not supported');
    expect((await sonos.command(lr, 'button_lock', { on: true })).button_lock).toBe(true);
    const alarms = await sonos.command(lr, 'alarms', {});
    expect(alarms).toEqual([expect.objectContaining({ id: '12', time: '07:00', days: 'Weekdays', enabled: true, room: 'Living Room', program: 'Sonos chime' })]);
    const off = await sonos.command(lr, 'alarm_enable', { id: '12', enabled: false });
    expect(off.alarm.enabled).toBe(false);
    expect((await sonos.command(lr, 'alarms', {}))[0]).toMatchObject({ enabled: false, volume: 25, play_mode: 'SHUFFLE_NOREPEAT' });
  });

  it('party mode, the site overview and pause-all', async () => {
    const p = await sonos.command(arc, 'party', {});
    expect(p.joined).toBe(2);
    await sonos.command(arc, 'play_input', { kind: 'tv' });
    const ov = await siteOverview(lr, rows as any);
    expect(ov.groups).toHaveLength(1);
    expect(ov.groups[0]).toMatchObject({ name: 'Office + Kitchen + Living Room', coordinator_uuid: uuid(IPS[2]), device_id: 'dev_2' });
    expect(ov.groups[0].members.map((m) => m.device_id)).toEqual(['dev_2', 'dev_1', 'dev_0']);
    await sonos.command(kitchen, 'ungroup', {});
    await sonos.command(kitchen, 'media', { action: 'play' }).catch(() => undefined);
    const all = await sonos.command(lr, 'pause_all', {});
    expect(all.ok).toBe(true);
    const after = await siteOverview(lr, rows as any);
    expect(after.groups.every((g) => g.state !== 'PLAYING')).toBe(true);
  });
});

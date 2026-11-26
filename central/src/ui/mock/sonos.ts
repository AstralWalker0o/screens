// Mock Sonos household for the dashboard's mock mode: every Sonos command the adapter supports,
// plus the site overview. Album art is inline SVG (the real art proxy isn't available in mock mode).

import { ApiError } from '../api';
import type { CommandResult, Device, SonosAlarm, SonosBrowseItem, SonosFacts, SonosInput, SonosQueue, SonosQueueItem, SonosSiteOverview, SonosZone } from '../../shared/types';

const err = (status: number, code: string, message: string) => new ApiError(status, code, message);

export function mockArt(hue: number): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${hue},70%,58%)'/><stop offset='1' stop-color='hsl(${(hue + 50) % 360},65%,32%)'/></linearGradient></defs><rect width='100' height='100' fill='url(#g)'/><circle cx='50' cy='50' r='24' fill='none' stroke='white' stroke-opacity='.45' stroke-width='3'/><circle cx='50' cy='50' r='5' fill='white' fill-opacity='.6'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const T = (title: string, artist: string, album: string, duration_s: number, hue: number) => ({ title, artist, album, duration_s, art: mockArt(hue) });
const TRACKS = [
  T('Midnight City', 'M83', 'Hurry Up, We’re Dreaming', 243, 280), T('Breathe Deeper', 'Tame Impala', 'The Slow Rush', 372, 20),
  T('Innerbloom', 'RÜFÜS DU SOL', 'Bloom', 577, 200), T('Lost in Yesterday', 'Tame Impala', 'The Slow Rush', 249, 30),
  T('Weightless', 'Marconi Union', 'Ambient', 480, 170), T('Dreams', 'Fleetwood Mac', 'Rumours', 257, 330),
];

export const SONOS_FAVORITES: SonosBrowseItem[] = [
  { title: 'triple j', uri: 'x-sonosapi-stream:s14986?sid=254&flags=8224&sn=0', meta: '<DIDL-Lite/>', kind: 'radio', art: mockArt(10) },
  { title: 'Double J', uri: 'x-sonosapi-stream:s148587?sid=254&flags=8224&sn=0', meta: '<DIDL-Lite/>', kind: 'radio', art: mockArt(45) },
  { title: 'ABC Classic', uri: 'x-sonosapi-stream:s17219?sid=254&flags=8224&sn=0', meta: '<DIDL-Lite/>', kind: 'radio' },
  { title: 'Dinner Jazz', uri: 'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZF1DX4xuWVBs4FgJ', meta: '<DIDL-Lite/>', kind: 'playlist', art: mockArt(220) },
  { title: 'Discover Weekly', uri: 'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9dQZEVXcJ', meta: '<DIDL-Lite/>', kind: 'playlist', art: mockArt(140) },
  { title: 'Weightless — Marconi Union', uri: 'x-sonos-spotify:spotify%3atrack%3a6kkwzB6hXLIONkEk9JciA6', meta: '<DIDL-Lite/>', kind: 'track', art: mockArt(170) },
];
const PLAYLISTS: SonosBrowseItem[] = [
  { id: 'SQ:3', title: 'Dinner & Drinks', uri: 'file:///jffs/settings/savedqueues.rsq#3', meta: '<DIDL-Lite/>', kind: 'playlist' },
  { id: 'SQ:7', title: 'Sunday Morning', uri: 'file:///jffs/settings/savedqueues.rsq#7', meta: '<DIDL-Lite/>', kind: 'playlist' },
];

const queues = new Map<string, { items: typeof TRACKS; active: boolean; current: number }>();
const alarms: SonosAlarm[] = [
  { id: '12', time: '07:00', duration: '01:00', recurrence: 'WEEKDAYS', days: 'Weekdays', enabled: true, room_uuid: 'RINCON_48A6B89C44D101400', room: 'Kitchen', program: 'triple j', volume: 18, play_mode: 'NORMAL', include_grouped: false },
  { id: '14', time: '08:30', duration: '02:00', recurrence: 'WEEKENDS', days: 'Weekends', enabled: false, room_uuid: 'RINCON_48A6B872103C01400', room: 'Living Room', program: 'Sonos chime', volume: 25, play_mode: 'SHUFFLE_NOREPEAT', include_grouped: true },
];
const settingsState = new Map<string, { button_lock: boolean; ht: Record<string, number | boolean | null> | null; crossfade: boolean }>();

const sf = (d: Device) => d.facts as unknown as SonosFacts & Record<string, unknown>;
const isPlaying = (s?: string) => s === 'PLAYING' || s === 'TRANSITIONING';
const household = (all: Device[], d: Device) => all.filter((x) => x.kind === 'sonos' && x.site_id === d.site_id);
const coordOf = (d: Device) => sf(d).group?.coordinator ?? sf(d).uuid;
const queueFor = (coord: string) => {
  let q = queues.get(coord);
  if (!q) { q = { items: TRACKS.slice(0, 4), active: true, current: 1 }; queues.set(coord, q); }
  return q;
};

/** Recompute group membership, group volume and zones for every speaker at the site. */
function sync(devs: Device[]) {
  const zones: SonosZone[] = devs.map((x) => ({ uuid: sf(x).uuid, name: x.name, ip: x.ip ?? null, coordinator: coordOf(x), ...(sf(x).zones?.find((z) => z.uuid === sf(x).uuid)?.bonded ? { bonded: sf(x).zones!.find((z) => z.uuid === sf(x).uuid)!.bonded } : {}) }));
  for (const o of devs) {
    const c = coordOf(o);
    const members = devs.filter((x) => coordOf(x) === c).sort((a, b) => (sf(a).uuid === c ? -1 : sf(b).uuid === c ? 1 : a.name.localeCompare(b.name)));
    const vols = members.map((m) => Number(sf(m).now_playing?.volume ?? 20));
    o.facts.group = {
      coordinator: c, is_coordinator: c === sf(o).uuid,
      members: members.map((m) => ({ uuid: sf(m).uuid, name: m.name, ip: m.ip ?? null, volume: sf(m).now_playing?.volume ?? null, muted: sf(m).now_playing?.muted ?? null })),
      volume: Math.round(vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length)), muted: members.every((m) => !!sf(m).now_playing?.muted),
    };
    o.facts.zones = zones;
  }
}

/** Apply now-playing changes to the whole group (keeping each speaker's own volume). */
function setGroupPlaying(devs: Device[], coord: string, np: Record<string, unknown>, position?: Record<string, unknown>) {
  for (const o of devs.filter((x) => coordOf(x) === coord)) {
    const own = (sf(o).now_playing ?? {}) as Record<string, unknown>;
    o.facts.now_playing = { ...own, ...np, volume: own.volume, muted: own.muted };
    if (position) o.facts.position = { ...position, at: Date.now() };
    o.current_app = np.state === 'PLAYING' ? (np.title as string) ?? 'Playing' : null;
  }
}

function advance(d: Device) {
  const p = sf(d).position;
  if (!p || p.elapsed_s == null || !p.at || !isPlaying(sf(d).now_playing?.state)) return;
  const e = p.elapsed_s + (Date.now() - p.at) / 1000;
  d.facts.position = { ...p, elapsed_s: p.duration_s ? Math.min(p.duration_s, e) : e, at: Date.now() };
}

const trackNp = (t: (typeof TRACKS)[number]) => ({ title: t.title, artist: t.artist, album: t.album, art: t.art, source: 'music', service: 'Spotify', station: undefined });

/** Handles a Sonos command in mock mode; undefined = not a Sonos-specific command. */
export async function sonosMock(d: Device, cmd: string, args: Record<string, unknown>, all: Device[]): Promise<CommandResult | undefined> {
  const devs = household(all, d);
  const byUuid = (u: unknown) => devs.find((x) => sf(x).uuid === u);
  const target = args.uuid ? byUuid(args.uuid) : d;
  if (args.uuid && !target) throw err(400, 'bad_args', 'That speaker isn’t part of this Sonos system any more. Refresh and try again.');
  const coord = coordOf(target!);
  const leader = byUuid(coord) ?? target!;
  const q = queueFor(coord);
  sync(devs);
  switch (cmd) {
    case 'status': {
      devs.forEach(advance);
      const st = settingsState.get(d.id);
      const np = sf(d).now_playing ?? {};
      const kind = np.source === 'radio' ? 'radio' : np.source === 'tv' ? 'tv' : np.source === 'line_in' ? 'line_in' : np.source === 'app' ? 'session' : q.active ? 'queue' : 'track';
      d.facts.transport = { kind, can_seek: kind === 'queue', can_skip: kind === 'queue', can_shuffle: kind === 'queue' };
      d.facts.play_mode ??= { shuffle: false, repeat: 'off' };
      d.facts.crossfade = st?.crossfade ?? false;
      d.facts.status_at = Date.now();
      return { ok: true, data: { ok: true, ...d.facts } };
    }
    case 'media': {
      let a = String(args.action);
      if (a === 'toggle') a = isPlaying(sf(leader).now_playing?.state) ? 'pause' : 'play';
      const np = (sf(leader).now_playing ?? {}) as Record<string, unknown>;
      if (a === 'play') {
        if (np.source === 'app') {
          // The field case: the app session ended; fall back to the Sonos queue.
          q.active = true;
          const t = q.items[q.current - 1] ?? TRACKS[0];
          setGroupPlaying(devs, coord, { state: 'PLAYING', ...trackNp(t) }, { elapsed_s: 0, duration_s: t.duration_s, track: q.current });
          return { ok: true, data: { ok: true, state: 'PLAYING', detail: 'The app session had ended, so the Sonos queue was started instead.', now_playing: sf(d).now_playing, position: sf(d).position } };
        }
        setGroupPlaying(devs, coord, { state: 'PLAYING' });
      } else if (a === 'pause' || a === 'stop') setGroupPlaying(devs, coord, { state: a === 'stop' || np.source === 'radio' ? 'STOPPED' : 'PAUSED_PLAYBACK' });
      else if (a === 'next' || a === 'prev') {
        if (np.source === 'radio') throw err(502, 'failed', 'This source doesn’t let you skip tracks (radio and some streaming services don’t).');
        q.current = Math.min(q.items.length, Math.max(1, q.current + (a === 'next' ? 1 : -1)));
        const t = q.items[q.current - 1];
        if (t) setGroupPlaying(devs, coord, { state: 'PLAYING', ...trackNp(t) }, { elapsed_s: 0, duration_s: t.duration_s, track: q.current });
      } else throw err(400, 'bad_args', 'action must be play|pause|stop|next|prev|toggle');
      return { ok: true, data: { ok: true, now_playing: sf(d).now_playing, position: sf(d).position } };
    }
    case 'seek': {
      const p = sf(d).position;
      if (args.track !== undefined) {
        q.current = Math.max(1, Math.min(q.items.length, Number(args.track)));
        const t = q.items[q.current - 1];
        setGroupPlaying(devs, coord, trackNp(t), { elapsed_s: 0, duration_s: t.duration_s, track: q.current });
      } else for (const o of devs.filter((x) => coordOf(x) === coord)) o.facts.position = { ...(p ?? { duration_s: null }), elapsed_s: Number(args.position_s), at: Date.now() };
      return { ok: true, data: { ok: true, position: sf(d).position, now_playing: sf(d).now_playing } };
    }
    case 'play_mode': {
      if (!q.active || sf(leader).now_playing?.source !== 'music') throw err(502, 'failed', 'Shuffle and repeat only work when playing from the Sonos queue — not radio, TV, line-in or music an app is controlling.');
      const cur = sf(d).play_mode ?? { shuffle: false, repeat: 'off' as const };
      const next = { shuffle: args.shuffle === undefined ? cur.shuffle : !!args.shuffle, repeat: (args.repeat ?? cur.repeat) as 'off' | 'all' | 'one' };
      for (const o of devs.filter((x) => coordOf(x) === coord)) o.facts.play_mode = next;
      return { ok: true, data: { ok: true, play_mode: next } };
    }
    case 'crossfade': {
      settingsState.set(d.id, { ...(settingsState.get(d.id) ?? { button_lock: false, ht: null, crossfade: false }), crossfade: args.on !== false });
      d.facts.crossfade = args.on !== false;
      return { ok: true, data: { ok: true, crossfade: args.on !== false } };
    }
    case 'volume': {
      const np = (sf(target!).now_playing ?? {}) as Record<string, unknown>;
      const level = Math.max(0, Math.min(100, Math.round(args.level != null ? Number(args.level) : Number(np.volume ?? 20) + Number(args.delta ?? 0))));
      target!.facts.now_playing = { ...np, volume: level };
      sync(devs);
      return { ok: true, data: { ok: true, level } };
    }
    case 'mute': {
      target!.facts.now_playing = { ...(sf(target!).now_playing ?? {}), muted: args.mute !== false };
      sync(devs);
      return { ok: true, data: { ok: true } };
    }
    case 'group_volume': {
      const members = devs.filter((x) => coordOf(x) === coord);
      const cur = Number(sf(leader).group?.volume ?? 20);
      const want = Math.max(0, Math.min(100, args.delta != null ? cur + Number(args.delta) : Number(args.level)));
      for (const m of members) m.facts.now_playing = { ...(sf(m).now_playing ?? {}), volume: Math.max(0, Math.min(100, Number(sf(m).now_playing?.volume ?? cur) + want - cur)) };
      sync(devs);
      return { ok: true, data: { ok: true, level: want } };
    }
    case 'group_mute': {
      for (const m of devs.filter((x) => coordOf(x) === coord)) m.facts.now_playing = { ...(sf(m).now_playing ?? {}), muted: args.mute !== false };
      sync(devs);
      return { ok: true, data: { ok: true } };
    }
    case 'group':
    case 'join': {
      const lead = args.coordinator_uuid ? byUuid(args.coordinator_uuid) : all.find((x) => x.id === args.coordinator_id);
      if (!lead) throw err(400, 'bad_args', 'Unknown speaker to join (refresh it first)');
      const who = target!;
      const c = coordOf(lead);
      if (coordOf(who) === c) return { ok: true, data: { ok: true, detail: `${who.name} is already in that group` } };
      who.facts.group = { ...(sf(who).group ?? { members: [] }), coordinator: c, is_coordinator: false, members: [] };
      who.facts.now_playing = { ...(sf(lead).now_playing ?? {}), volume: sf(who).now_playing?.volume, muted: sf(who).now_playing?.muted };
      who.facts.position = sf(lead).position;
      sync(devs);
      return { ok: true, data: { ok: true, group: sf(d).group, zones: sf(d).zones } };
    }
    case 'ungroup': {
      const who = target!;
      if (devs.filter((x) => coordOf(x) === coordOf(who)).length <= 1) return { ok: true, data: { ok: true, detail: `${who.name} is already playing on its own` } };
      const wasCoord = coordOf(who) === sf(who).uuid;
      if (wasCoord) {
        // The rest of the group keeps playing under a new coordinator.
        const heir = devs.find((x) => x !== who && coordOf(x) === sf(who).uuid)!;
        for (const o of devs.filter((x) => x !== who && coordOf(x) === sf(who).uuid)) o.facts.group = { ...(sf(o).group ?? { members: [] }), coordinator: sf(heir).uuid, is_coordinator: false, members: [] };
      }
      who.facts.group = { coordinator: sf(who).uuid, is_coordinator: true, members: [] };
      who.facts.now_playing = { ...(sf(who).now_playing ?? {}), state: 'STOPPED' };
      who.current_app = null;
      sync(devs);
      return { ok: true, data: { ok: true, group: sf(d).group, zones: sf(d).zones } };
    }
    case 'party': {
      const others = devs.filter((x) => coordOf(x) !== coord);
      for (const o of others) {
        o.facts.group = { coordinator: coord, is_coordinator: false, members: [] };
        o.facts.now_playing = { ...(sf(leader).now_playing ?? {}), volume: sf(o).now_playing?.volume, muted: sf(o).now_playing?.muted };
      }
      sync(devs);
      return { ok: true, data: { ok: true, joined: others.length, detail: others.length ? `Grouped ${others.length} more ${others.length === 1 ? 'room' : 'rooms'}` : 'All rooms were already grouped', group: sf(d).group } };
    }
    case 'pause_all': {
      const coords = [...new Set(devs.map(coordOf))].filter((c) => isPlaying(sf(byUuid(c) ?? d).now_playing?.state));
      for (const c of coords) setGroupPlaying(devs, c, { state: 'PAUSED_PLAYBACK' });
      return { ok: true, data: { ok: true, paused: coords.length, detail: coords.length ? `Paused ${coords.length} ${coords.length === 1 ? 'group' : 'groups'}` : 'Nothing was playing' } };
    }
    case 'favorites': return { ok: true, data: SONOS_FAVORITES };
    case 'playlists': return { ok: true, data: PLAYLISTS };
    case 'play_favorite': {
      const fav = [...SONOS_FAVORITES, ...PLAYLISTS].find((f) => f.uri === args.uri);
      if (!fav) throw err(400, 'bad_args', 'uri (from favorites or playlists) required');
      if (fav.kind === 'radio') {
        q.active = false;
        setGroupPlaying(devs, coord, { state: 'PLAYING', title: 'Live radio', artist: undefined, album: undefined, station: fav.title, art: fav.art, source: 'radio', service: 'TuneIn' }, { elapsed_s: null, duration_s: null });
      } else {
        q.items = fav.kind === 'track' ? [TRACKS[4]] : [TRACKS[5], TRACKS[1], TRACKS[2], TRACKS[3]];
        q.active = true; q.current = 1;
        const t = q.items[0];
        setGroupPlaying(devs, coord, { state: 'PLAYING', ...trackNp(t) }, { elapsed_s: 0, duration_s: t.duration_s, track: 1 });
      }
      return { ok: true, data: { ok: true, state: 'PLAYING', now_playing: sf(d).now_playing, position: sf(d).position } };
    }
    case 'queue': {
      const items: SonosQueueItem[] = q.items.map((t, i) => ({ index: i + 1, title: t.title, artist: t.artist, album: t.album, art: t.art, duration_s: t.duration_s }));
      const data: SonosQueue = { items, total: items.length, start: 0, current: q.active ? q.current : null, active: q.active };
      return { ok: true, data };
    }
    case 'play_queue': {
      const i = Number(args.index);
      const t = q.items[i - 1];
      if (!t) throw err(400, 'bad_args', 'That position or track number is past the end of what’s playing.');
      q.active = true; q.current = i;
      setGroupPlaying(devs, coord, { state: 'PLAYING', ...trackNp(t) }, { elapsed_s: 0, duration_s: t.duration_s, track: i });
      return { ok: true, data: { ok: true, state: 'PLAYING', now_playing: sf(d).now_playing, position: sf(d).position } };
    }
    case 'remove_from_queue': {
      const i = Number(args.index);
      q.items = q.items.filter((_, n) => n !== i - 1);
      if (q.current > q.items.length) q.current = Math.max(1, q.items.length);
      return { ok: true, data: { ok: true } };
    }
    case 'clear_queue': {
      q.items = [];
      q.current = 1;
      return { ok: true, data: { ok: true } };
    }
    case 'inputs': {
      const out: SonosInput[] = [];
      for (const x of devs) {
        if (x.id === d.id && sf(x).has_tv) out.push({ kind: 'tv', uuid: sf(x).uuid, name: 'TV', device_id: x.id });
        if (sf(x).has_line_in) out.push({ kind: 'line_in', uuid: sf(x).uuid, name: x.id === d.id ? 'Line-in' : `Line-in on ${x.name}`, device_id: x.id });
      }
      return { ok: true, data: out };
    }
    case 'play_input': {
      const tv = args.kind === 'tv';
      q.active = false;
      setGroupPlaying(devs, coord, { state: 'PLAYING', title: tv ? 'TV' : 'Line-in', artist: undefined, album: undefined, station: undefined, art: undefined, source: tv ? 'tv' : 'line_in', service: null }, { elapsed_s: null, duration_s: null });
      return { ok: true, data: { ok: true, detail: tv ? 'Switched to the TV input' : 'Switched to the line-in' } };
    }
    case 'led':
      d.facts.led = args.on !== false;
      return { ok: true, data: { ok: true } };
    case 'button_lock': {
      const st = settingsState.get(d.id) ?? { button_lock: false, ht: null, crossfade: false };
      settingsState.set(d.id, { ...st, button_lock: args.on !== false });
      return { ok: true, data: { ok: true, button_lock: args.on !== false } };
    }
    case 'settings': {
      const soundbar = !!sf(d).has_tv;
      const st = settingsState.get(d.id) ?? { button_lock: false, ht: soundbar ? { night_mode: false, speech: true, sub_enabled: true, sub_gain: 2, surround_enabled: null, surround_level: null, music_surround_level: null, height_level: 0, audio_delay: 1 } : null, crossfade: false };
      settingsState.set(d.id, st);
      const subInRoom = sf(d).zones?.find((z) => z.uuid === sf(d).uuid)?.bonded?.some((b) => /sub/i.test(b.role)) ?? false;
      return { ok: true, data: { ok: true, led: sf(d).led ?? true, button_lock: st.button_lock, eq: sf(d).eq ?? { bass: 0, treble: 0, loudness: true }, ht: st.ht, crossfade: st.crossfade, sleep_timer_s: null, has_tv: soundbar, has_sub: subInRoom } };
    }
    case 'eq': {
      const cur = (sf(d).eq ?? { bass: 0, treble: 0, loudness: true }) as unknown as Record<string, unknown>;
      const clamp = (v: unknown, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, Number(v))));
      const next: Record<string, unknown> = { ...cur };
      if (args.bass !== undefined) next.bass = clamp(args.bass, -10, 10);
      if (args.treble !== undefined) next.treble = clamp(args.treble, -10, 10);
      if (args.loudness !== undefined) next.loudness = !!args.loudness;
      const soundbar = !!sf(d).has_tv;
      if (args.night_mode !== undefined) next.night_mode = soundbar ? !!args.night_mode : 'not supported';
      if (args.speech !== undefined) next.speech = soundbar ? !!args.speech : 'not supported';
      d.facts.eq = next;
      const st = settingsState.get(d.id);
      let ht = st?.ht ?? null;
      const htKeys = ['sub_enabled', 'sub_gain', 'surround_enabled', 'surround_level', 'music_surround_level', 'height_level', 'audio_delay', 'night_mode', 'speech'];
      if (ht && htKeys.some((k) => args[k] !== undefined)) {
        ht = { ...ht };
        for (const k of htKeys) if (args[k] !== undefined && ht[k] !== null) ht[k] = typeof args[k] === 'boolean' ? args[k] as boolean : Number(args[k]);
        settingsState.set(d.id, { ...st!, ht });
      }
      return { ok: true, data: { ok: true, eq: next, ...(ht ? { ht } : {}) } };
    }
    case 'sleep_timer': {
      const mins = Math.round(Math.min(180, Math.max(0, Number(args.minutes) || 0)));
      d.facts.sleep_timer = mins ? { remaining_s: mins * 60, at: Date.now() } : null;
      return { ok: true, data: { ok: true, minutes: mins } };
    }
    case 'alarms': return { ok: true, data: alarms };
    case 'alarm_enable': {
      const a = alarms.find((x) => x.id === String(args.id));
      if (!a) throw err(404, 'not_found', 'That alarm no longer exists. It may have been deleted in the Sonos app.');
      a.enabled = args.enabled !== false;
      return { ok: true, data: { ok: true, alarm: a } };
    }
    case 'topology':
      return { ok: true, data: sf(d).zones ?? [] };
    default:
      return undefined;
  }
}

/** GET /api/sites/:id/sonos in mock mode. */
export function sonosOverview(siteId: string, all: Device[]): SonosSiteOverview {
  const devs = all.filter((x) => x.kind === 'sonos' && x.site_id === siteId);
  if (!devs.length) throw err(404, 'not_found', 'There are no Sonos speakers at this site');
  sync(devs);
  const coords = [...new Set(devs.map(coordOf))];
  const groups = coords.map((c) => {
    const members = devs.filter((x) => coordOf(x) === c).sort((a, b) => (sf(a).uuid === c ? -1 : sf(b).uuid === c ? 1 : a.name.localeCompare(b.name)));
    const lead = members[0];
    const np = sf(lead).now_playing ?? {};
    return {
      id: c, coordinator_uuid: c, name: members.map((m) => m.name).join(' + '), device_id: lead.id, state: np.state ?? 'STOPPED',
      title: np.title, artist: np.artist, album: np.album, art: np.art, station: np.station, source: np.source, service: np.service ?? null,
      volume: members.length > 1 ? sf(lead).group?.volume ?? null : np.volume ?? null, muted: members.length > 1 ? sf(lead).group?.muted ?? null : np.muted ?? null,
      members: members.map((m) => ({ uuid: sf(m).uuid, name: m.name, ip: m.ip ?? null, device_id: m.id, volume: sf(m).now_playing?.volume ?? null, muted: sf(m).now_playing?.muted ?? null, ...(sf(m).zones?.find((z) => z.uuid === sf(m).uuid)?.bonded ? { bonded: sf(m).zones!.find((z) => z.uuid === sf(m).uuid)!.bonded } : {}) })),
    };
  }).sort((a, b) => (isPlaying(a.state) ? 0 : 1) - (isPlaying(b.state) ? 0 : 1) || a.name.localeCompare(b.name));
  return { anchor_device_id: devs.find((x) => x.status === 'online')?.id ?? devs[0].id, groups, updated_at: Date.now() };
}

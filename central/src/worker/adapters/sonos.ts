import type { SonosAlarm, SonosHtLevels, SonosInput, SonosSettings, SonosSiteGroup, SonosSiteOverview } from '../../shared/sonos';
import type { Row } from '../lib/db';
import { parseJson, sleep } from '../lib/util';
import {
  adapterCodeFor, alarmView, artPathAllowed, describeSource, groupName, hms, modelInputs, nowPlayingFrom, parseAlarms, parseDescription,
  parseFavorites, parsePlaylists, parsePlayMode, parseQueue, parseZoneGroups, planResume, playModeName, SERVICES, type Service, soapEnvelope,
  sonosErrorMessage, toHms, unwrapXml, updateAlarmArgs, upnpCode, uriKind, visibleZones, type ZoneMember,
} from './sonos-parse';
import type { Adapter, AdapterCtx } from './types';
import { AdapterError, xmlTag, xmlUnescape } from './types';

// Re-exported for tests and other modules that imported them from here.
export { parseDidl, parseFavorites, parseZoneGroups, soapEnvelope, type ZoneMember } from './sonos-parse';

/**
 * Sonos — local UPnP/SOAP on port 1400 (S1 and S2), sent through the site gateway's http.request.
 * Transport (play/pause/seek/queue/play mode/sleep timer) goes to the group coordinator; volume,
 * EQ, LED and button lock go to the speaker itself. See sonos-parse.ts for credits.
 */

/** A failed SOAP action, with the UPnP code (if any) and a plain-English message. */
export class SonosError extends AdapterError {
  constructor(public action: string, public upnp: number | null, message: string, code = adapterCodeFor(upnp)) { super(code, message); }
}

const SLOW_ACTIONS = new Set(['Play', 'SetAVTransportURI', 'AddURIToQueue', 'RemoveAllTracksFromQueue', 'Browse', 'ListAlarms']);

async function soap(ctx: AdapterCtx, ip: string, service: Service, action: string, args: Record<string, string | number> = {}): Promise<string> {
  const t = SLOW_ACTIONS.has(action) ? 10_000 : 5_000;
  let r: { status: number; body?: string };
  try {
    r = await ctx.gw('http.request', {
      url: `http://${ip}:1400${SERVICES[service]}`, method: 'POST', body: soapEnvelope(service, action, args),
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"` },
      timeout_ms: t,
    }, t + 4_000);
  } catch (e: any) {
    if (e instanceof AdapterError && e.code === 'timeout') throw new SonosError(action, null, `The speaker at ${ip} didn’t answer in time. It may be switched off or unplugged.`, 'timeout');
    if (e instanceof AdapterError && e.code === 'failed') throw new SonosError(action, null, `The gateway couldn’t reach the speaker at ${ip} (${e.message}).`, 'unreachable');
    throw e;
  }
  if (r.status !== 200) {
    const code = upnpCode(r.body);
    ctx.log(`${service}#${action} on ${ip} → HTTP ${r.status}${code ? ` UPnP ${code}` : ''}`);
    throw new SonosError(action, code, sonosErrorMessage(action, code, r.status));
  }
  return r.body ?? '';
}

const avt = (ctx: AdapterCtx, ip: string, action: string, args: Record<string, string | number> = {}) => soap(ctx, ip, 'AVTransport', action, { InstanceID: 0, ...args });
const rc = (ctx: AdapterCtx, ip: string, action: string, args: Record<string, string | number> = {}) => soap(ctx, ip, 'RenderingControl', action, { InstanceID: 0, ...args });
const grc = (ctx: AdapterCtx, ip: string, action: string, args: Record<string, string | number> = {}) => soap(ctx, ip, 'GroupRenderingControl', action, { InstanceID: 0, ...args });
const tag = (x: string, t: string) => xmlTag(x, t);
const isUpnp = (e: unknown, ...codes: number[]): e is SonosError => e instanceof SonosError && e.upnp != null && (!codes.length || codes.includes(e.upnp));
const clamp = (v: unknown, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, Number(v) || 0)));
const factsOf = (ctx: AdapterCtx) => parseJson<Record<string, any>>(ctx.device.facts, {});

// ---------------------------------------------------------------- topology / group resolution

async function topology(ctx: AdapterCtx, ip = ctx.device.ip as string): Promise<ZoneMember[]> {
  const body = await soap(ctx, ip, 'ZoneGroupTopology', 'GetZoneGroupState');
  return parseZoneGroups(tag(body, 'ZoneGroupState') ?? '');
}

interface Group {
  members: ZoneMember[];
  /** The room this device (or `uuid`) belongs to — satellites resolve to their main speaker. */
  room: ZoneMember | undefined;
  coordIp: string; coordUuid: string;
  /** Visible rooms in the same group. */
  rooms: ZoneMember[];
}

/** Live group lookup (never trusts stored facts: groups change from the Sonos app at any time). */
async function resolve(ctx: AdapterCtx, uuid?: string): Promise<Group> {
  const facts = factsOf(ctx);
  let members: ZoneMember[] = [];
  try { members = await topology(ctx); } catch (e) { if (uuid) throw e; }
  let me = uuid ? members.find((m) => m.uuid === uuid) : members.find((m) => m.uuid === facts.uuid) ?? members.find((m) => m.ip === ctx.device.ip);
  if (uuid && !me) throw new AdapterError('bad_args', 'That speaker isn’t part of this Sonos system any more. Refresh and try again.');
  if (me?.bonded_to) me = members.find((m) => m.uuid === me!.bonded_to) ?? me;
  const coord = me ? members.find((m) => m.uuid === me!.coordinator) : undefined;
  const coordUuid = coord?.uuid ?? me?.coordinator ?? facts.uuid ?? '';
  return {
    members, room: me, coordIp: coord?.ip ?? me?.ip ?? ctx.device.ip, coordUuid,
    rooms: members.filter((m) => m.coordinator === coordUuid && !m.invisible),
  };
}

/** The speaker a per-speaker command acts on: `uuid` (any room in the household) or this device. */
async function speakerIp(ctx: AdapterCtx, uuid: unknown): Promise<string> {
  if (!uuid) return ctx.device.ip;
  const m = (await topology(ctx)).find((x) => x.uuid === String(uuid));
  if (!m?.ip) throw new AdapterError('bad_args', 'That speaker isn’t part of this Sonos system any more. Refresh and try again.');
  return m.ip;
}

function groupFacts(g: Group, myUuid: string) {
  return {
    coordinator: g.coordUuid, is_coordinator: !g.room || g.coordUuid === (g.room?.uuid ?? myUuid),
    members: g.rooms.map((m) => ({ uuid: m.uuid, name: m.name, ip: m.ip })),
  };
}

function bondedTo(members: ZoneMember[], uuid: string) {
  const me = members.find((m) => m.uuid === uuid);
  if (!me?.bonded_to) return null;
  return { uuid: me.bonded_to, name: members.find((m) => m.uuid === me.bonded_to)?.name ?? me.name, role: me.role ?? 'Bonded speaker' };
}

// ---------------------------------------------------------------- transport

async function transportState(ctx: AdapterCtx, ip: string): Promise<string> {
  return tag(await avt(ctx, ip, 'GetTransportInfo'), 'CurrentTransportState') ?? 'UNKNOWN';
}

/** After Play, give the speaker a moment: TRANSITIONING → PLAYING usually takes < 2 s. */
async function settle(ctx: AdapterCtx, ip: string, ms = 3_000): Promise<string> {
  let st = 'UNKNOWN';
  for (let waited = 0; waited <= ms; waited += 500) {
    await sleep(waited === 0 ? 300 : 500);
    st = await transportState(ctx, ip).catch(() => st);
    if (st === 'PLAYING') return st;
  }
  return st;
}

async function queueSize(ctx: AdapterCtx, ip: string): Promise<number> {
  const r = await soap(ctx, ip, 'ContentDirectory', 'Browse', { ObjectID: 'Q:0', BrowseFlag: 'BrowseDirectChildren', Filter: '', StartingIndex: 0, RequestedCount: 1, SortCriteria: '' });
  return Number(tag(r, 'TotalMatches') ?? 0) || 0;
}

async function mediaInfo(ctx: AdapterCtx, ip: string) {
  const mi = await avt(ctx, ip, 'GetMediaInfo');
  const meta = unwrapXml(tag(mi, 'CurrentURIMetaData'));
  return { uri: xmlUnescape(tag(mi, 'CurrentURI') ?? ''), meta: meta === 'NOT_IMPLEMENTED' ? '' : meta, nrTracks: Number(tag(mi, 'NrTracks') ?? 0) || 0 };
}

/**
 * Play that actually plays. Sonos answers Play with UPnP 701 ("transition not available") — or
 * accepts it and stays STOPPED — when the loaded source can't be resumed: an app/cloud session
 * (YouTube Music, Spotify Connect, AirPlay) that has ended, an expired stream URL, or an empty
 * queue. Home Assistant simply ignores 701 here; we try what the Sonos app would do instead.
 */
async function play(ctx: AdapterCtx, g: Group): Promise<{ ok: true; state: string; detail?: string }> {
  const ip = g.coordIp;
  let first: SonosError | null = null;
  try { await avt(ctx, ip, 'Play', { Speed: 1 }); } catch (e) { if (!isUpnp(e)) throw e; first = e; }
  if (!first) {
    const st = await settle(ctx, ip);
    if (st === 'PLAYING' || st === 'TRANSITIONING') return { ok: true, state: st };
  }
  const [mi, pi] = await Promise.all([mediaInfo(ctx, ip), avt(ctx, ip, 'GetPositionInfo')]);
  const qs = uriKind(mi.uri) === 'queue' ? mi.nrTracks : await queueSize(ctx, ip).catch(() => 0);
  const plan = planResume({ transportUri: mi.uri, transportMeta: mi.meta, nrTracks: mi.nrTracks, track: Number(tag(pi, 'Track') ?? 0) || 0, queueSize: qs, coordUuid: g.coordUuid });
  ctx.log(`play: ${first ? `Play refused (UPnP ${first.upnp})` : 'Play accepted but nothing started'}; source ${plan.kind} ${mi.uri.slice(0, 80)}; trying: ${plan.attempts.map((a) => a.label).join(' → ') || 'nothing'}`);
  for (const a of plan.attempts) {
    try {
      for (const s of a.steps) {
        if (s.op === 'set_uri') await avt(ctx, ip, 'SetAVTransportURI', { CurrentURI: s.uri, CurrentURIMetaData: s.meta });
        else if (s.op === 'seek_track') await avt(ctx, ip, 'Seek', { Unit: 'TRACK_NR', Target: s.track });
        else await avt(ctx, ip, 'Play', { Speed: 1 });
      }
      const st = await settle(ctx, ip);
      if (st === 'PLAYING' || st === 'TRANSITIONING') return { ok: true, state: st, ...(a.note ? { detail: a.note } : {}) };
    } catch (e) {
      if (!isUpnp(e)) throw e;
      ctx.log(`play: "${a.label}" failed (UPnP ${e.upnp})`);
    }
  }
  throw new SonosError('Play', first?.upnp ?? null, plan.fail, 'failed');
}

/** Pause; live streams that can't pause are stopped; pausing something already paused is fine. */
async function pause(ctx: AdapterCtx, ip: string): Promise<string> {
  try {
    await avt(ctx, ip, 'Pause');
    return 'PAUSED_PLAYBACK';
  } catch (e) {
    if (!isUpnp(e, 701)) throw e;
    const st = await transportState(ctx, ip);
    if (st !== 'PLAYING' && st !== 'TRANSITIONING') return st;
    await avt(ctx, ip, 'Stop');
    return 'STOPPED';
  }
}

/** Cheap post-command read of what's playing; updates this device's facts. */
async function readNowPlaying(ctx: AdapterCtx, ip: string) {
  const [ti, pi] = await Promise.all([avt(ctx, ip, 'GetTransportInfo'), avt(ctx, ip, 'GetPositionInfo')]);
  const old = factsOf(ctx).now_playing ?? {};
  const now_playing = { ...old, state: tag(ti, 'CurrentTransportState') ?? old.state, ...nowPlayingFrom(tag(pi, 'TrackMetaData'), xmlUnescape(tag(pi, 'TrackURI') ?? '')) };
  const position = { elapsed_s: hms(tag(pi, 'RelTime')), duration_s: hms(tag(pi, 'TrackDuration')), track: Number(tag(pi, 'Track') ?? 0) || null, at: Date.now() };
  await ctx.update({ facts: { now_playing, position } });
  return { now_playing, position };
}

// ---------------------------------------------------------------- full status (on demand)

async function status(ctx: AdapterCtx) {
  const facts = factsOf(ctx);
  const g = await resolve(ctx);
  const ip = g.coordIp;
  const roomIp = g.room?.ip ?? ctx.device.ip;
  const multi = g.rooms.length > 1;
  const volOf = (mip: string | null) => (mip ? Promise.all([rc(ctx, mip, 'GetVolume', { Channel: 'Master' }), rc(ctx, mip, 'GetMute', { Channel: 'Master' })])
    .then(([v, m]) => ({ volume: Number(tag(v, 'CurrentVolume')), muted: tag(m, 'CurrentMute') === '1' })).catch(() => null) : Promise.resolve(null));
  const [ti, pi, mi, ts, cf, sl, acts, mine, memberVols, gv, gm] = await Promise.all([
    avt(ctx, ip, 'GetTransportInfo'), avt(ctx, ip, 'GetPositionInfo'), mediaInfo(ctx, ip).catch(() => ({ uri: '', meta: '', nrTracks: 0 })),
    avt(ctx, ip, 'GetTransportSettings').catch(() => ''), avt(ctx, ip, 'GetCrossfadeMode').catch(() => ''),
    avt(ctx, ip, 'GetRemainingSleepTimerDuration').catch(() => ''), avt(ctx, ip, 'GetCurrentTransportActions').catch(() => ''),
    volOf(roomIp),
    multi ? Promise.all(g.rooms.map((m) => (m.ip === roomIp ? Promise.resolve(null) : volOf(m.ip)))) : Promise.resolve([] as null[]),
    multi ? grc(ctx, ip, 'SnapshotGroupVolume').then(() => grc(ctx, ip, 'GetGroupVolume')).catch(() => '') : Promise.resolve(''),
    multi ? grc(ctx, ip, 'GetGroupMute').catch(() => '') : Promise.resolve(''),
  ]);
  const trackUri = xmlUnescape(tag(pi, 'TrackURI') ?? '');
  const np = nowPlayingFrom(tag(pi, 'TrackMetaData'), trackUri);
  const src = describeSource(trackUri, mi.uri);
  const kind = uriKind(mi.uri);
  const station = kind === 'radio' ? (nowPlayingFrom(mi.meta).title ?? np.station) : np.station;
  const actions = (tag(acts, 'Actions') ?? '').split(',').map((s) => s.trim());
  const duration = hms(tag(pi, 'TrackDuration'));
  const sleepS = hms(tag(sl, 'RemainingSleepTimerDuration'));
  const out = {
    now_playing: {
      state: tag(ti, 'CurrentTransportState') ?? undefined, ...np, ...(station ? { station } : {}), source: src.source, service: src.service ?? np.service,
      volume: mine?.volume ?? facts.now_playing?.volume, muted: mine?.muted ?? facts.now_playing?.muted,
    },
    position: { elapsed_s: hms(tag(pi, 'RelTime')), duration_s: duration, track: Number(tag(pi, 'Track') ?? 0) || null, at: Date.now() },
    group: {
      ...groupFacts(g, facts.uuid),
      members: g.rooms.map((m, i) => ({ uuid: m.uuid, name: m.name, ip: m.ip, ...((m.ip === roomIp ? mine : memberVols[i]) ?? {}) })),
      volume: multi ? (tag(gv, 'CurrentVolume') != null ? Number(tag(gv, 'CurrentVolume')) : null) : mine?.volume ?? null,
      muted: multi ? (tag(gm, 'CurrentMute') != null ? tag(gm, 'CurrentMute') === '1' : null) : mine?.muted ?? null,
    },
    zones: g.members.length ? visibleZones(g.members) : facts.zones,
    bonded_to: bondedTo(g.members, facts.uuid),
    play_mode: ts ? parsePlayMode(tag(ts, 'PlayMode')) : null,
    crossfade: cf ? tag(cf, 'CrossfadeMode') === '1' : null,
    sleep_timer: sleepS ? { remaining_s: sleepS, at: Date.now() } : null,
    transport: {
      kind,
      can_seek: acts ? actions.some((a) => /Seek(Time)?$/i.test(a) || a === 'Seek') && !!duration : (kind === 'queue' || kind === 'track') && !!duration,
      can_skip: acts ? actions.includes('Next') : kind === 'queue' && mi.nrTracks > 1,
      can_shuffle: kind === 'queue',
    },
    status_at: Date.now(),
  };
  await ctx.update({ facts: out });
  return { ok: true, ...out };
}

// ---------------------------------------------------------------- settings helpers

const HT_TYPES: [keyof SonosHtLevels, string, 'bool' | 'int'][] = [
  ['night_mode', 'NightMode', 'bool'], ['speech', 'DialogLevel', 'bool'], ['surround_enabled', 'SurroundEnable', 'bool'],
  ['surround_level', 'SurroundLevel', 'int'], ['music_surround_level', 'MusicSurroundLevel', 'int'], ['height_level', 'HeightChannelLevel', 'int'],
  ['audio_delay', 'AudioDelay', 'int'], ['sub_enabled', 'SubEnable', 'bool'], ['sub_gain', 'SubGain', 'int'],
];
const HT_RANGE: Partial<Record<keyof SonosHtLevels, [number, number]>> = {
  surround_level: [-15, 15], music_surround_level: [-15, 15], height_level: [-10, 10], audio_delay: [0, 5], sub_gain: [-15, 15],
};

async function readHt(ctx: AdapterCtx, ip: string, opts: { tv: boolean; sub: boolean }): Promise<SonosHtLevels | null> {
  const types = HT_TYPES.filter(([k]) => (opts.tv ? true : k === 'sub_enabled' || k === 'sub_gain') && (opts.sub || (k !== 'sub_enabled' && k !== 'sub_gain')));
  if (!types.length) return null;
  const vals = await Promise.all(types.map(([, t, kind]) => rc(ctx, ip, 'GetEQ', { EQType: t }).then((r) => {
    const v = tag(r, 'CurrentValue');
    return v == null ? null : kind === 'bool' ? v === '1' : Number(v);
  }).catch(() => null)));
  return Object.fromEntries(types.map(([k], i) => [k, vals[i]])) as SonosHtLevels;
}

async function readEq(ctx: AdapterCtx, ip: string) {
  const [b, t, l] = await Promise.all([rc(ctx, ip, 'GetBass'), rc(ctx, ip, 'GetTreble'), rc(ctx, ip, 'GetLoudness', { Channel: 'Master' })]);
  return { bass: Number(tag(b, 'CurrentBass')), treble: Number(tag(t, 'CurrentTreble')), loudness: tag(l, 'CurrentLoudness') === '1' };
}

function hasSub(g: Group): boolean {
  return !!g.room && g.members.some((m) => m.bonded_to === g.room!.uuid && /sub/i.test(m.role ?? ''));
}

// ---------------------------------------------------------------- playing things

/** Containers and single tracks are queued (replacing the queue) like the Sonos app's "Play now"; streams play directly. */
async function playUri(ctx: AdapterCtx, g: Group, uri: string, meta: string) {
  const ip = g.coordIp;
  const k = uriKind(uri);
  if (k === 'container' || k === 'track') {
    await avt(ctx, ip, 'RemoveAllTracksFromQueue').catch((e) => { if (!isUpnp(e, 804)) throw e; });
    await avt(ctx, ip, 'AddURIToQueue', { EnqueuedURI: uri, EnqueuedURIMetaData: meta, DesiredFirstTrackNumberEnqueued: 0, EnqueueAsNext: 0 });
    await avt(ctx, ip, 'SetAVTransportURI', { CurrentURI: `x-rincon-queue:${g.coordUuid}#0`, CurrentURIMetaData: '' });
    await avt(ctx, ip, 'Seek', { Unit: 'TRACK_NR', Target: 1 }).catch(() => undefined);
  } else {
    await avt(ctx, ip, 'SetAVTransportURI', { CurrentURI: uri, CurrentURIMetaData: meta });
  }
  await avt(ctx, ip, 'Play', { Speed: 1 });
  return settle(ctx, ip);
}

// ---------------------------------------------------------------- album art (proxied)

/** Fetch speaker-relative album art ("/getaa?…") through the gateway. Any speaker in the household can serve it. */
export async function fetchArt(ctx: AdapterCtx, path: string): Promise<{ content_type: string; body_b64: string }> {
  if (!artPathAllowed(path)) throw new AdapterError('bad_args', 'Not an album-art path');
  const r = await ctx.gw<{ status: number; headers?: Record<string, string>; body?: string; body_b64?: string; truncated?: boolean }>('http.request', {
    url: `http://${ctx.device.ip}:1400${path}`, timeout_ms: 6_000, max_body: 2 << 20,
  }, 10_000);
  const type = (r.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  // Raster images only: an SVG served from our origin could carry script.
  if (r.status !== 200 || !r.body_b64 || r.truncated || !/^image\/(jpeg|png|gif|webp|bmp)$/.test(type)) throw new AdapterError('not_found', 'No album art for this item');
  return { content_type: type, body_b64: r.body_b64 };
}

// ---------------------------------------------------------------- site-wide view

/** Every group at the site in one call (topology + per-group transport + volumes). `rows` = the site's Sonos devices. */
export async function siteOverview(ctx: AdapterCtx, rows: Row[]): Promise<SonosSiteOverview> {
  const members = await topology(ctx);
  const byUuid = new Map<string, string>();
  for (const r of rows) { const u = parseJson<any>(r.facts, {}).uuid; if (u) byUuid.set(u, r.id); }
  for (const r of rows) for (const m of members) if (!byUuid.has(m.uuid) && m.ip && m.ip === r.ip) byUuid.set(m.uuid, r.id);
  const rooms = visibleZones(members);
  const coords = [...new Set(rooms.map((r) => r.coordinator))];
  const vol = (ip: string | null) => (ip ? Promise.all([rc(ctx, ip, 'GetVolume', { Channel: 'Master' }), rc(ctx, ip, 'GetMute', { Channel: 'Master' })])
    .then(([v, m]) => ({ volume: Number(tag(v, 'CurrentVolume')), muted: tag(m, 'CurrentMute') === '1' })).catch(() => ({ volume: null, muted: null })) : Promise.resolve({ volume: null, muted: null }));
  const groups = await Promise.all(coords.map(async (cu): Promise<SonosSiteGroup> => {
    const inGroup = rooms.filter((r) => r.coordinator === cu).sort((a, b) => (a.uuid === cu ? -1 : b.uuid === cu ? 1 : a.name.localeCompare(b.name)));
    const ip = members.find((m) => m.uuid === cu)?.ip ?? inGroup[0]?.ip ?? null;
    const multi = inGroup.length > 1;
    const [ti, pi, gv, gm, vols] = await Promise.all([
      ip ? avt(ctx, ip, 'GetTransportInfo').catch(() => '') : '', ip ? avt(ctx, ip, 'GetPositionInfo').catch(() => '') : '',
      multi && ip ? grc(ctx, ip, 'SnapshotGroupVolume').then(() => grc(ctx, ip, 'GetGroupVolume')).catch(() => '') : '',
      multi && ip ? grc(ctx, ip, 'GetGroupMute').catch(() => '') : '',
      Promise.all(inGroup.map((m) => vol(m.ip))),
    ]);
    const np = nowPlayingFrom(tag(pi, 'TrackMetaData'), xmlUnescape(tag(pi, 'TrackURI') ?? ''));
    const deviceId = byUuid.get(cu) ?? inGroup.map((m) => byUuid.get(m.uuid)).find(Boolean) ?? null;
    return {
      id: cu, coordinator_uuid: cu, name: groupName(members, cu), device_id: deviceId, state: tag(ti, 'CurrentTransportState') ?? 'UNKNOWN',
      ...np,
      volume: multi ? (tag(gv, 'CurrentVolume') != null ? Number(tag(gv, 'CurrentVolume')) : null) : vols[0].volume,
      muted: multi ? (tag(gm, 'CurrentMute') != null ? tag(gm, 'CurrentMute') === '1' : null) : vols[0].muted,
      members: inGroup.map((m, i) => ({ uuid: m.uuid, name: m.name, ip: m.ip, device_id: byUuid.get(m.uuid) ?? null, ...vols[i], ...(m.bonded ? { bonded: m.bonded } : {}) })),
    };
  }));
  groups.sort((a, b) => (a.state === 'PLAYING' ? 0 : 1) - (b.state === 'PLAYING' ? 0 : 1) || a.name.localeCompare(b.name));
  return { anchor_device_id: ctx.device.id, groups, updated_at: Date.now() };
}

// ---------------------------------------------------------------- the adapter

const QUIET = new Set(['status', 'queue', 'favorites', 'playlists', 'inputs', 'settings', 'alarms', 'seek', 'play_mode', 'crossfade', 'group_volume', 'group_mute', 'play_queue']);

export const sonos: Adapter = {
  quiet: QUIET,

  async refresh(ctx) {
    const r = await ctx.gw('http.request', { url: `http://${ctx.device.ip}:1400/xml/device_description.xml`, timeout_ms: 4000 }, 8000).catch(() => null);
    if (!r || r.status !== 200 || !r.body) return { status: 'offline' };
    const desc = parseDescription(r.body as string);
    const uuid = desc.uuid;
    const facts: Record<string, unknown> = {
      uuid, room: desc.room, model_number: desc.model_number, hardware: desc.hardware, display_version: desc.display_version, api_version: desc.api_version,
      has_line_in: desc.has_line_in, has_tv: desc.has_tv,
    };
    let nowPlaying: Record<string, unknown> = {};
    try {
      // One topology read gives the coordinator and the group (refresh runs every few minutes: keep it to 6 SOAP calls).
      const members = await topology(ctx).catch(() => [] as ZoneMember[]);
      let me = members.find((m) => m.uuid === uuid) ?? members.find((m) => m.ip === ctx.device.ip);
      const satellite = me?.bonded_to ? me : null;
      if (me?.bonded_to) me = members.find((m) => m.uuid === me!.bonded_to) ?? me;
      const coordUuid = me?.coordinator ?? uuid;
      const ip = members.find((m) => m.uuid === coordUuid)?.ip ?? ctx.device.ip;
      const roomIp = me?.ip ?? ctx.device.ip;
      const [ti, pi, vol, mute, led] = await Promise.all([
        avt(ctx, ip, 'GetTransportInfo'), avt(ctx, ip, 'GetPositionInfo'),
        rc(ctx, roomIp, 'GetVolume', { Channel: 'Master' }), rc(ctx, roomIp, 'GetMute', { Channel: 'Master' }),
        soap(ctx, ctx.device.ip, 'DeviceProperties', 'GetLEDState').catch(() => ''),
      ]);
      facts.led = led ? tag(led, 'CurrentLEDState') === 'On' : null;
      facts.position = { elapsed_s: hms(tag(pi, 'RelTime')), duration_s: hms(tag(pi, 'TrackDuration')), track: Number(tag(pi, 'Track') ?? 0) || null, at: Date.now() };
      nowPlaying = {
        state: tag(ti, 'CurrentTransportState'), ...nowPlayingFrom(tag(pi, 'TrackMetaData'), xmlUnescape(tag(pi, 'TrackURI') ?? '')),
        volume: Number(tag(vol, 'CurrentVolume')), muted: tag(mute, 'CurrentMute') === '1',
      };
      const g: Group = { members, room: me, coordIp: ip, coordUuid, rooms: members.filter((m) => m.coordinator === coordUuid && !m.invisible) };
      if (members.length) {
        facts.group = groupFacts(g, uuid);
        facts.zones = visibleZones(members);
        facts.bonded_to = satellite ? bondedTo(members, satellite.uuid) : null;
      }
    } catch { /* speaker reachable but transport info failed */ }
    facts.now_playing = nowPlaying;
    const state = String(nowPlaying.state ?? '');
    return {
      status: 'online', power: 'on', manufacturer: 'Sonos', model: desc.model_name,
      serial: desc.serial, firmware: desc.software, os_version: desc.display_version ? `Sonos ${desc.display_version}` : null,
      current_app: state === 'PLAYING' ? ((nowPlaying.title as string) ?? 'Playing') : null, facts,
    };
  },

  async pair() {
    return { ok: true, detail: 'Sonos needs no pairing on the local network.' };
  },

  async command(ctx, command, args) {
    const facts = factsOf(ctx);
    switch (command) {
      // ------------------------------------------------ transport
      case 'media': {
        const g = await resolve(ctx, args.uuid ? String(args.uuid) : undefined);
        const ip = g.coordIp;
        let action = String(args.action);
        if (action === 'toggle') {
          const st = await transportState(ctx, ip);
          action = st === 'PLAYING' || st === 'TRANSITIONING' ? 'pause' : 'play';
        }
        let result: { ok: true; state?: string; detail?: string };
        if (action === 'play') result = await play(ctx, g);
        else if (action === 'pause') result = { ok: true, state: await pause(ctx, ip) };
        else if (action === 'stop') { await avt(ctx, ip, 'Stop').catch((e) => { if (!isUpnp(e, 701)) throw e; }); result = { ok: true, state: 'STOPPED' }; }
        else if (action === 'next' || action === 'prev') { await avt(ctx, ip, action === 'next' ? 'Next' : 'Previous'); result = { ok: true }; }
        else throw new AdapterError('bad_args', 'action must be play|pause|stop|next|prev|toggle');
        if (args.uuid) return result;
        const fresh = await readNowPlaying(ctx, ip).catch(() => null);
        return { ...result, ...(fresh ?? {}) };
      }
      case 'seek': {
        const g = await resolve(ctx);
        if (args.track !== undefined) await avt(ctx, g.coordIp, 'Seek', { Unit: 'TRACK_NR', Target: clamp(args.track, 1, 100_000) });
        else if (args.position_s !== undefined) await avt(ctx, g.coordIp, 'Seek', { Unit: 'REL_TIME', Target: toHms(clamp(args.position_s, 0, 24 * 3600)) });
        else throw new AdapterError('bad_args', 'position_s or track required');
        return { ok: true, ...(await readNowPlaying(ctx, g.coordIp).catch(() => ({}))) };
      }
      case 'play_mode': {
        const g = await resolve(ctx);
        const cur = parsePlayMode(tag(await avt(ctx, g.coordIp, 'GetTransportSettings'), 'PlayMode'));
        const repeat = args.repeat === undefined ? cur.repeat : (['off', 'all', 'one'].includes(String(args.repeat)) ? String(args.repeat) : null);
        if (!repeat) throw new AdapterError('bad_args', 'repeat must be off|all|one');
        const next = { shuffle: args.shuffle === undefined ? cur.shuffle : !!args.shuffle, repeat: repeat as 'off' | 'all' | 'one' };
        await avt(ctx, g.coordIp, 'SetPlayMode', { NewPlayMode: playModeName(next.shuffle, next.repeat) });
        await ctx.update({ facts: { play_mode: next } });
        return { ok: true, play_mode: next };
      }
      case 'crossfade': {
        const g = await resolve(ctx);
        await avt(ctx, g.coordIp, 'SetCrossfadeMode', { CrossfadeMode: args.on === false ? 0 : 1 });
        await ctx.update({ facts: { crossfade: args.on !== false } });
        return { ok: true, crossfade: args.on !== false };
      }
      case 'status': return status(ctx);
      case 'pause_all': {
        const members = await topology(ctx);
        const coords = [...new Set(members.filter((m) => !m.invisible).map((m) => m.coordinator))];
        const res = await Promise.all(coords.map(async (cu) => {
          const ip = members.find((m) => m.uuid === cu)?.ip;
          if (!ip) return false;
          const st = await transportState(ctx, ip).catch(() => '');
          if (st !== 'PLAYING' && st !== 'TRANSITIONING') return false;
          await pause(ctx, ip);
          return true;
        }));
        const n = res.filter(Boolean).length;
        return { ok: true, paused: n, detail: n ? `Paused ${n} ${n === 1 ? 'group' : 'groups'}` : 'Nothing was playing' };
      }
      case 'power_off': {
        const g = await resolve(ctx);
        await pause(ctx, g.coordIp).catch(() => undefined);
        return { ok: true, detail: 'Sonos speakers cannot be switched off remotely; playback paused.' };
      }

      // ------------------------------------------------ volume
      case 'volume': {
        const ip = await speakerIp(ctx, args.uuid);
        let level: number;
        if (typeof args.delta === 'number') {
          const v = await rc(ctx, ip, 'GetVolume', { Channel: 'Master' });
          level = Number(tag(v, 'CurrentVolume')) + args.delta;
        } else level = Number(args.level);
        level = clamp(level, 0, 100);
        await rc(ctx, ip, 'SetVolume', { Channel: 'Master', DesiredVolume: level });
        if (!args.uuid) await ctx.update({ facts: { now_playing: { ...(facts.now_playing ?? {}), volume: level } } });
        return { ok: true, level };
      }
      case 'mute': {
        const ip = await speakerIp(ctx, args.uuid);
        await rc(ctx, ip, 'SetMute', { Channel: 'Master', DesiredMute: args.mute === false ? 0 : 1 });
        if (!args.uuid) await ctx.update({ facts: { now_playing: { ...(facts.now_playing ?? {}), muted: args.mute !== false } } });
        return { ok: true };
      }
      case 'group_volume': {
        const g = await resolve(ctx, args.uuid ? String(args.uuid) : undefined);
        // Snapshot first so Sonos keeps the members' relative volumes (as SoCo does).
        await grc(ctx, g.coordIp, 'SnapshotGroupVolume');
        if (typeof args.delta === 'number') {
          const r = await grc(ctx, g.coordIp, 'SetRelativeGroupVolume', { Adjustment: clamp(args.delta, -100, 100) });
          return { ok: true, level: Number(tag(r, 'NewVolume')) };
        }
        const level = clamp(args.level, 0, 100);
        await grc(ctx, g.coordIp, 'SetGroupVolume', { DesiredVolume: level });
        return { ok: true, level };
      }
      case 'group_mute': {
        const g = await resolve(ctx, args.uuid ? String(args.uuid) : undefined);
        await grc(ctx, g.coordIp, 'SetGroupMute', { DesiredMute: args.mute === false ? 0 : 1 });
        return { ok: true };
      }

      // ------------------------------------------------ grouping
      case 'group':
      case 'join': {
        let lead = args.coordinator_uuid ? String(args.coordinator_uuid) : '';
        if (!lead && args.coordinator_id) {
          const coord = await ctx.env.DB.prepare('SELECT facts FROM devices WHERE id = ? AND site_id = ?').bind(String(args.coordinator_id), ctx.device.site_id).first<any>();
          lead = parseJson<any>(coord?.facts, {}).uuid ?? '';
        }
        if (!lead) throw new AdapterError('bad_args', 'Unknown speaker to join (refresh it first)');
        const members = await topology(ctx);
        const who = args.uuid ? members.find((m) => m.uuid === String(args.uuid)) : members.find((m) => m.uuid === facts.uuid) ?? members.find((m) => m.ip === ctx.device.ip);
        let target = members.find((m) => m.uuid === lead);
        if (target?.bonded_to) target = members.find((m) => m.uuid === target!.bonded_to);
        if (!who || !target) throw new AdapterError('bad_args', 'That speaker isn’t part of this Sonos system any more. Refresh and try again.');
        if (who.invisible) throw new AdapterError('bad_args', `${who.name}’s ${who.role ?? 'bonded speaker'} always plays with its room and can’t be grouped on its own.`);
        const coordUuid = target.coordinator;
        if (who.coordinator === coordUuid) return { ok: true, detail: `${who.name} is already in that group` };
        const whoIp = who.ip ?? (who.uuid === facts.uuid ? ctx.device.ip : null);
        if (!whoIp) throw new AdapterError('bad_args', `Screens doesn’t know ${who.name}’s address yet. Refresh and try again.`);
        await avt(ctx, whoIp, 'SetAVTransportURI', { CurrentURI: `x-rincon:${coordUuid}`, CurrentURIMetaData: '' });
        await updateGroupFacts(ctx);
        return { ok: true };
      }
      case 'ungroup': {
        const members = await topology(ctx).catch(() => [] as ZoneMember[]);
        const who = args.uuid ? members.find((m) => m.uuid === String(args.uuid)) : members.find((m) => m.uuid === facts.uuid) ?? members.find((m) => m.ip === ctx.device.ip);
        if (args.uuid && !who) throw new AdapterError('bad_args', 'That speaker isn’t part of this Sonos system any more. Refresh and try again.');
        if (who && members.filter((m) => m.coordinator === who.coordinator && !m.invisible).length <= 1) return { ok: true, detail: `${who.name} is already playing on its own` };
        await avt(ctx, who?.ip ?? ctx.device.ip, 'BecomeCoordinatorOfStandaloneGroup');
        await updateGroupFacts(ctx);
        return { ok: true };
      }
      case 'party': {
        const g = await resolve(ctx);
        const others = g.members.filter((m) => !m.invisible && m.coordinator !== g.coordUuid && m.ip);
        // One at a time: concurrent regrouping requests can race on the speakers.
        for (const m of others) await avt(ctx, m.ip!, 'SetAVTransportURI', { CurrentURI: `x-rincon:${g.coordUuid}`, CurrentURIMetaData: '' });
        await updateGroupFacts(ctx);
        return { ok: true, joined: others.length, detail: others.length ? `Grouped ${others.length} more ${others.length === 1 ? 'room' : 'rooms'}` : 'All rooms were already grouped' };
      }
      case 'topology': return topology(ctx);

      // ------------------------------------------------ browse / play
      case 'favorites': {
        const r = await soap(ctx, ctx.device.ip, 'ContentDirectory', 'Browse', { ObjectID: 'FV:2', BrowseFlag: 'BrowseDirectChildren', Filter: '*', StartingIndex: 0, RequestedCount: 100, SortCriteria: '' });
        return parseFavorites(tag(r, 'Result') ?? '');
      }
      case 'playlists': {
        const r = await soap(ctx, ctx.device.ip, 'ContentDirectory', 'Browse', { ObjectID: 'SQ:', BrowseFlag: 'BrowseDirectChildren', Filter: '*', StartingIndex: 0, RequestedCount: 100, SortCriteria: '' });
        return parsePlaylists(tag(r, 'Result') ?? '');
      }
      case 'play_favorite': {
        const uri = String(args.uri ?? ''); const meta = String(args.meta ?? '');
        if (!uri || uri.length > 2000 || meta.length > 8000) throw new AdapterError('bad_args', 'uri (from favorites or playlists) required');
        const g = await resolve(ctx);
        const state = await playUri(ctx, g, uri, meta);
        const fresh = await readNowPlaying(ctx, g.coordIp).catch(() => null);
        return { ok: true, state, ...(fresh ?? {}) };
      }
      case 'queue': {
        const g = await resolve(ctx);
        const start = clamp(args.start, 0, 100_000);
        const count = clamp(args.count ?? 100, 1, 100);
        const [r, mi, pi] = await Promise.all([
          soap(ctx, g.coordIp, 'ContentDirectory', 'Browse', { ObjectID: 'Q:0', BrowseFlag: 'BrowseDirectChildren', Filter: '*', StartingIndex: start, RequestedCount: count, SortCriteria: '' }),
          mediaInfo(ctx, g.coordIp), avt(ctx, g.coordIp, 'GetPositionInfo'),
        ]);
        const active = uriKind(mi.uri) === 'queue';
        return { items: parseQueue(tag(r, 'Result') ?? '', start), total: Number(tag(r, 'TotalMatches') ?? 0) || 0, start, current: active ? Number(tag(pi, 'Track') ?? 0) || null : null, active };
      }
      case 'play_queue': {
        const index = clamp(args.index, 1, 100_000);
        const g = await resolve(ctx);
        const mi = await mediaInfo(ctx, g.coordIp);
        if (uriKind(mi.uri) !== 'queue') await avt(ctx, g.coordIp, 'SetAVTransportURI', { CurrentURI: `x-rincon-queue:${g.coordUuid}#0`, CurrentURIMetaData: '' });
        await avt(ctx, g.coordIp, 'Seek', { Unit: 'TRACK_NR', Target: index });
        await avt(ctx, g.coordIp, 'Play', { Speed: 1 });
        const state = await settle(ctx, g.coordIp);
        return { ok: true, state, ...(await readNowPlaying(ctx, g.coordIp).catch(() => ({}))) };
      }
      case 'remove_from_queue': {
        const index = clamp(args.index, 1, 100_000);
        const g = await resolve(ctx);
        await avt(ctx, g.coordIp, 'RemoveTrackFromQueue', { ObjectID: `Q:0/${index}`, UpdateID: 0 });
        return { ok: true };
      }
      case 'clear_queue': {
        const g = await resolve(ctx);
        await avt(ctx, g.coordIp, 'RemoveAllTracksFromQueue').catch((e) => { if (!isUpnp(e, 804)) throw e; });
        return { ok: true };
      }
      case 'inputs': {
        const rows = (await ctx.env.DB.prepare("SELECT id, name, model, facts FROM devices WHERE site_id = ? AND kind = 'sonos'").bind(ctx.device.site_id).all<Row>()).results;
        const out: SonosInput[] = [];
        for (const r of rows) {
          const f = parseJson<any>(r.facts, {});
          const has = { line_in: f.has_line_in ?? modelInputs(r.model).line_in, tv: f.has_tv ?? modelInputs(r.model).tv };
          if (!f.uuid) continue;
          if (r.id === ctx.device.id && has.tv) out.push({ kind: 'tv', uuid: f.uuid, name: 'TV', device_id: r.id });
          if (has.line_in) out.push({ kind: 'line_in', uuid: f.uuid, name: r.id === ctx.device.id ? 'Line-in' : `Line-in on ${r.name}`, device_id: r.id });
        }
        return out;
      }
      case 'play_input': {
        const kind = String(args.kind);
        if (kind === 'tv') {
          if (!(facts.has_tv ?? modelInputs(ctx.device.model).tv)) throw new AdapterError('not_supported', 'This speaker has no TV input.');
          // TV audio always plays from the soundbar itself (it leaves any group it was in).
          await avt(ctx, ctx.device.ip, 'SetAVTransportURI', { CurrentURI: `x-sonos-htastream:${facts.uuid}:spdif`, CurrentURIMetaData: '' });
          await avt(ctx, ctx.device.ip, 'Play', { Speed: 1 }).catch((e) => { if (!isUpnp(e, 701)) throw e; });
          return { ok: true, detail: 'Switched to the TV input' };
        }
        if (kind !== 'line_in') throw new AdapterError('bad_args', 'kind must be line_in or tv');
        const src = String(args.uuid ?? facts.uuid ?? '');
        if (!/^RINCON_[0-9A-F]+$/i.test(src)) throw new AdapterError('bad_args', 'Unknown line-in speaker');
        const g = await resolve(ctx);
        await avt(ctx, g.coordIp, 'SetAVTransportURI', { CurrentURI: `x-rincon-stream:${src}`, CurrentURIMetaData: '' });
        try { await avt(ctx, g.coordIp, 'Play', { Speed: 1 }); } catch (e) {
          if (isUpnp(e, 701, 714)) throw new SonosError('Play', e.upnp, 'Nothing is coming in on the line-in. Check a device is plugged in (Era speakers need the Sonos USB-C line-in adapter) and is playing.');
          throw e;
        }
        return { ok: true, detail: 'Switched to the line-in' };
      }

      // ------------------------------------------------ settings
      case 'led': {
        await soap(ctx, ctx.device.ip, 'DeviceProperties', 'SetLEDState', { DesiredLEDState: args.on === false ? 'Off' : 'On' });
        await ctx.update({ facts: { led: args.on !== false } });
        return { ok: true };
      }
      case 'button_lock': {
        await soap(ctx, ctx.device.ip, 'DeviceProperties', 'SetButtonLockState', { DesiredButtonLockState: args.on === false ? 'Off' : 'On' });
        await ctx.update({ facts: { button_lock: args.on !== false } });
        return { ok: true, button_lock: args.on !== false };
      }
      case 'settings': {
        const g = await resolve(ctx);
        const roomIp = g.room?.ip ?? ctx.device.ip;
        const tv = !!(facts.has_tv ?? modelInputs(ctx.device.model).tv);
        const sub = hasSub(g);
        const [led, lock, eq, ht, cf, sl] = await Promise.all([
          soap(ctx, ctx.device.ip, 'DeviceProperties', 'GetLEDState').then((r) => tag(r, 'CurrentLEDState') === 'On').catch(() => null),
          soap(ctx, ctx.device.ip, 'DeviceProperties', 'GetButtonLockState').then((r) => tag(r, 'CurrentButtonLockState') === 'On').catch(() => null),
          readEq(ctx, roomIp).catch(() => null),
          readHt(ctx, roomIp, { tv, sub }),
          avt(ctx, g.coordIp, 'GetCrossfadeMode').then((r) => tag(r, 'CrossfadeMode') === '1').catch(() => null),
          avt(ctx, g.coordIp, 'GetRemainingSleepTimerDuration').then((r) => hms(tag(r, 'RemainingSleepTimerDuration'))).catch(() => null),
        ]);
        const eqFacts = eq ? { ...eq, ...(ht && ht.night_mode != null ? { night_mode: ht.night_mode } : {}), ...(ht && ht.speech != null ? { speech: ht.speech } : {}) } : null;
        const settings: SonosSettings = { led, button_lock: lock, eq: eqFacts, ht, crossfade: cf, sleep_timer_s: sl, has_tv: tv, has_sub: sub };
        await ctx.update({ facts: { led, button_lock: lock, ...(eqFacts ? { eq: eqFacts } : {}), ht, crossfade: cf, sleep_timer: sl ? { remaining_s: sl, at: Date.now() } : null } });
        return { ok: true, ...settings };
      }
      case 'eq': {
        const g = await resolve(ctx);
        const ip = g.room?.ip ?? ctx.device.ip;
        const out: Record<string, unknown> = {};
        const tone = (v: unknown) => clamp(v, -10, 10);
        if (args.bass !== undefined) await rc(ctx, ip, 'SetBass', { DesiredBass: tone(args.bass) });
        if (args.treble !== undefined) await rc(ctx, ip, 'SetTreble', { DesiredTreble: tone(args.treble) });
        if (args.loudness !== undefined) await rc(ctx, ip, 'SetLoudness', { Channel: 'Master', DesiredLoudness: args.loudness ? 1 : 0 });
        // Soundbar / Sub settings: speakers without them refuse; report "not supported" instead of failing.
        let htTouched = false;
        for (const [k, t, kind] of HT_TYPES) {
          if (args[k] === undefined) continue;
          htTouched = true;
          const range = HT_RANGE[k];
          const value = kind === 'bool' ? (args[k] ? 1 : 0) : clamp(args[k], range![0], range![1]);
          const ok = await rc(ctx, ip, 'SetEQ', { EQType: t, DesiredValue: value }).then(() => true).catch(() => 'not supported');
          if (k === 'night_mode' || k === 'speech') out[k] = ok === true ? !!args[k] : ok;
          else if (ok !== true) out[k] = ok;
        }
        const eq = { ...(await readEq(ctx, ip)), ...Object.fromEntries(Object.entries(out).filter(([k]) => k === 'night_mode' || k === 'speech')) };
        const ht = htTouched ? await readHt(ctx, ip, { tv: !!(facts.has_tv ?? modelInputs(ctx.device.model).tv), sub: hasSub(g) }) : undefined;
        await ctx.update({ facts: { eq, ...(ht !== undefined ? { ht } : {}) } });
        return { ok: true, eq, ...(ht !== undefined ? { ht } : {}), ...(Object.values(out).includes('not supported') ? { unsupported: Object.keys(out).filter((k) => out[k] === 'not supported') } : {}) };
      }
      case 'sleep_timer': {
        const mins = clamp(args.minutes, 0, 180);
        const g = await resolve(ctx);
        const dur = mins ? `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00` : '';
        await avt(ctx, g.coordIp, 'ConfigureSleepTimer', { NewSleepTimerDuration: dur });
        await ctx.update({ facts: { sleep_timer: mins ? { remaining_s: mins * 60, at: Date.now() } : null } });
        return { ok: true, minutes: mins };
      }
      case 'alarms': {
        const [r, members] = await Promise.all([soap(ctx, ctx.device.ip, 'AlarmClock', 'ListAlarms'), topology(ctx).catch(() => [] as ZoneMember[])]);
        const name = (u: string) => members.find((m) => m.uuid === u)?.name ?? null;
        return parseAlarms(tag(r, 'CurrentAlarmList') ?? '').map((a) => alarmView(a, name(a.RoomUUID))).sort((a: SonosAlarm, b: SonosAlarm) => a.time.localeCompare(b.time));
      }
      case 'alarm_enable': {
        const id = String(args.id ?? '');
        if (!/^\d+$/.test(id)) throw new AdapterError('bad_args', 'alarm id required');
        const [r, members] = await Promise.all([soap(ctx, ctx.device.ip, 'AlarmClock', 'ListAlarms'), topology(ctx).catch(() => [] as ZoneMember[])]);
        const raw = parseAlarms(tag(r, 'CurrentAlarmList') ?? '').find((a) => a.ID === id);
        if (!raw) throw new AdapterError('not_found', 'That alarm no longer exists. It may have been deleted in the Sonos app.');
        // UpdateAlarm replaces the whole alarm, so send back exactly what ListAlarms returned with only Enabled changed.
        await soap(ctx, ctx.device.ip, 'AlarmClock', 'UpdateAlarm', updateAlarmArgs(raw, { enabled: args.enabled !== false }));
        return { ok: true, alarm: alarmView({ ...raw, Enabled: args.enabled !== false ? '1' : '0' }, members.find((m) => m.uuid === raw.RoomUUID)?.name ?? null) };
      }
      default:
        throw new AdapterError('not_supported', `Sonos speakers don't support "${command}"`);
    }
  },
};

/** After regrouping: give Sonos a moment, then store this device's new group (one topology read). */
async function updateGroupFacts(ctx: AdapterCtx) {
  await sleep(400);
  const g = await resolve(ctx).catch(() => null);
  if (!g?.members.length) return;
  await ctx.update({ facts: { group: groupFacts(g, factsOf(ctx).uuid), zones: visibleZones(g.members) } }).catch(() => undefined);
}

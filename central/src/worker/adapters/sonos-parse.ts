// Pure Sonos helpers (no I/O): SOAP envelopes, DIDL / topology / alarm parsing, UPnP error
// messages, URI classification, album-art normalisation and the "how do we resume?" planner.
//
// Behaviour is modelled on the open-source Sonos libraries (reimplemented, not copied):
//   - SoCo (MIT) — envelope format, play-mode table, queue/seek/sleep/alarm/EQ argument shapes,
//     album art "prefix the speaker base URL unless absolute", party mode.
//   - svrooij/node-sonos-ts and sonos-api-docs (MIT) — UPnP error descriptions incl. 800
//     "not a coordinator", which actions are coordinator-only, notification restore pattern
//     (re-set URI + metadata, then Play).
//   - Home Assistant sonos (Apache-2.0) — 701/711/712 are routine transport answers, favourites
//     that aren't radio are queued and played from the queue, line-in/TV model lists.
//   - jishi/node-sonos-http-api (MIT) — transport commands always go to the group coordinator.

import type { SonosAlarm, SonosBonded, SonosQueueItem, SonosRepeat, SonosSource, SonosZone } from '../../shared/sonos';
import { xmlAttrs, xmlEscape, xmlTag, xmlUnescape } from './types';

// ---------------------------------------------------------------- SOAP

export const SERVICES = {
  AVTransport: '/MediaRenderer/AVTransport/Control',
  RenderingControl: '/MediaRenderer/RenderingControl/Control',
  GroupRenderingControl: '/MediaRenderer/GroupRenderingControl/Control',
  ZoneGroupTopology: '/ZoneGroupTopology/Control',
  DeviceProperties: '/DeviceProperties/Control',
  ContentDirectory: '/MediaServer/ContentDirectory/Control',
  AlarmClock: '/AlarmClock/Control',
} as const;
export type Service = keyof typeof SERVICES;

export function soapEnvelope(service: Service, action: string, args: Record<string, string | number>): string {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${inner}</u:${action}></s:Body></s:Envelope>`;
}

/** UPnP errorCode from a SOAP fault body. */
export function upnpCode(body: string | null | undefined): number | null {
  const c = body ? xmlTag(body, 'errorCode') : null;
  return c && /^\d+$/.test(c) ? Number(c) : null;
}

// ---------------------------------------------------------------- errors

const TRANSPORT_ACTIONS = new Set(['Play', 'Pause', 'Stop', 'Next', 'Previous', 'Seek', 'SetAVTransportURI', 'AddURIToQueue']);

/**
 * Plain-English explanation of a failed Sonos SOAP action. Codes: UPnP Device Architecture (4xx/6xx),
 * AVTransport (7xx), Sonos extensions (8xx) — descriptions per SoCo / sonos-api-docs.
 */
export function sonosErrorMessage(action: string, code: number | null, http?: number): string {
  switch (code) {
    case 701:
      if (action === 'Play') return 'The speaker can’t restart what it was last playing — usually because the app that started it (for example YouTube Music, Spotify or AirPlay) has ended its session. Pick a favourite, playlist or the queue to start something new.';
      if (action === 'Pause' || action === 'Stop') return 'Nothing is playing on this speaker.';
      if (action === 'Next' || action === 'Previous') return 'This source doesn’t let you skip tracks (radio and some streaming services don’t).';
      if (action === 'Seek') return 'This source doesn’t support jumping to a position (live radio and streams don’t).';
      return 'The speaker can’t do that with what it’s playing right now.';
    case 702: return 'There’s nothing loaded on this speaker to play.';
    case 703: return 'The speaker couldn’t read the music — the stream or file is unavailable or the network dropped.';
    case 704: return 'This speaker can’t play that kind of file or stream.';
    case 705: return 'Playback is locked by another source (for example a TV or AirPlay session). Stop it there first.';
    case 711: return action === 'Seek' ? 'That position or track number is past the end of what’s playing.' : 'That position isn’t valid.';
    case 712: return 'Shuffle and repeat only work when playing from the Sonos queue — not radio, TV, line-in or music an app is controlling.';
    case 714: return 'The speaker can’t play this item (unsupported format). Try a different track or station.';
    case 715: return 'The speaker is busy. Try again in a moment.';
    case 716: return 'The music service couldn’t find this item. It may have been removed, or the speaker’s login to the service has expired — check the service in the Sonos app.';
    case 718: return 'The speaker rejected the request (invalid instance).';
    case 800: return 'Only the group’s main speaker can do that, and the group changed while Screens was asking. Try again.';
    case 801: return 'There’s already an alarm at that time.';
    case 804: return 'The queue is already empty.';
    case 401: case 602: return 'This speaker model doesn’t support that feature.';
    case 402: case 600: case 601: return 'The speaker didn’t accept the value that was sent.';
    case 501: return TRANSPORT_ACTIONS.has(action) ? 'The speaker couldn’t do that right now — the music source may be unavailable.' : 'The speaker couldn’t do that right now.';
    case 606: return 'The speaker refused the request (not authorised).';
    case null: case undefined:
      return http ? `The speaker refused the request (HTTP ${http}).` : 'The speaker didn’t answer.';
    default:
      return `The speaker refused the request (Sonos error ${code}).`;
  }
}

/** AdapterError code for a UPnP error (drives the HTTP status the dashboard sees). */
export function adapterCodeFor(code: number | null): string {
  if (code === 401 || code === 602) return 'not_supported';
  if (code === 402 || code === 600 || code === 601 || code === 711) return 'bad_args';
  return 'failed';
}

// ---------------------------------------------------------------- small parsers

/** Text that carries an escaped XML document (DIDL in SOAP, ZoneGroupState, alarm lists) → that document. */
export function unwrapXml(s: string | null | undefined): string {
  if (!s) return '';
  const t = s.trim();
  return t.startsWith('&lt;') ? xmlUnescape(t) : t;
}

/** Entity-decoded text of the first <tag> (any namespace prefix). */
function text(x: string, tag: string): string | undefined {
  const v = xmlTag(x, tag);
  if (v == null) return undefined;
  const s = xmlUnescape(v).trim();
  return s || undefined;
}

/** "H:MM:SS" (optionally with fractions) → seconds; anything else (NOT_IMPLEMENTED, "") → null. */
export function hms(t: string | null | undefined): number | null {
  const m = t?.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export function toHms(s: number): string {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 3600)}:${String(Math.floor((v % 3600) / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- DIDL

export interface DidlInfo {
  title?: string; artist?: string; album?: string; art?: string; stream_content?: string; radio_show?: string; upnp_class?: string;
  duration_s?: number | null;
}

/** DIDL-Lite metadata (escaped once inside SOAP) → fields, entity-decoded, art normalised. */
export function parseDidl(meta: string | null | undefined): DidlInfo {
  if (!meta || meta === 'NOT_IMPLEMENTED') return {};
  const x = unwrapXml(meta);
  const res = x.match(/<res\b([^>]*)>/);
  const out: DidlInfo = {
    title: text(x, 'title'), artist: text(x, 'creator') ?? text(x, 'albumArtist'), album: text(x, 'album'),
    art: normalizeArt(text(x, 'albumArtURI')), stream_content: text(x, 'streamContent'), radio_show: text(x, 'radioShowMd'),
    upnp_class: text(x, 'class'), duration_s: res ? hms(xmlAttrs(res[1]).duration) : undefined,
  };
  for (const k of Object.keys(out) as (keyof DidlInfo)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Sonos shows "ZPSTR_CONNECTING" etc. while a stream starts. */
const ZPSTR: Record<string, string> = { ZPSTR_CONNECTING: 'Connecting…', ZPSTR_BUFFERING: 'Buffering…', ZPSTR_CONNECTION_LOST: 'Connection lost' };

/**
 * Track metadata → what to show. Radio puts the station in dc:title and "Artist - Song" in
 * r:streamContent; music services put title/creator/album in the usual places.
 */
export function nowPlayingFrom(trackMeta: string | null | undefined, trackUri?: string | null) {
  const d = parseDidl(trackMeta);
  const looksLikeUri = (s?: string) => !!s && /^(x-[\w-]+|https?|aac|hls-radio|file):\S*$/i.test(s);
  let title = looksLikeUri(d.title) ? undefined : d.title;
  let artist = d.artist;
  let station: string | undefined;
  const sc = d.stream_content ? (ZPSTR[d.stream_content] ?? d.stream_content) : undefined;
  if (sc && !d.stream_content?.startsWith('ZPSTR_')) {
    station = title;
    const parts = sc.split(' - ');
    if (!artist && parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); } else title = sc;
  } else if (sc && !title) title = sc;
  const src = describeSource(trackUri ?? '');
  return {
    title, artist, album: d.album, art: d.art, ...(station ? { station } : {}),
    source: src.source, service: src.service,
  };
}

// ---------------------------------------------------------------- URIs, sources and services

export type UriKind = 'empty' | 'queue' | 'group' | 'session' | 'tv' | 'line_in' | 'radio' | 'container' | 'track' | 'stream' | 'other';

export function uriKind(uri: string | null | undefined): UriKind {
  const u = (uri ?? '').trim();
  if (!u) return 'empty';
  if (/^x-rincon-queue:/i.test(u)) return 'queue';
  if (/^x-rincon:/i.test(u)) return 'group';
  if (/^x-sonos-vli:/i.test(u)) return 'session';
  if (/^x-sonos-htastream:/i.test(u)) return 'tv';
  if (/^x-rincon-stream:/i.test(u)) return 'line_in';
  if (/^(x-sonosapi-stream|x-sonosapi-radio|x-rincon-mp3radio|x-sonosapi-hls|x-sonosprog-http|hls-radio|aac):/i.test(u)) return 'radio';
  if (/^(x-rincon-cpcontainer|x-rincon-playlist):/i.test(u) || /^file:\/\/\/jffs\/settings\/savedqueues\.rsq/i.test(u)) return 'container';
  if (/^(x-sonos-http|x-sonosapi-hls-static|x-sonos-spotify|x-file-cifs|x-sonos-mms|x-sonosapi-rtrecent):/i.test(u)) return 'track';
  if (/^https?:/i.test(u)) return 'stream';
  return 'other';
}

/** Music service ids (the sid= in Sonos URIs) we can name confidently. */
const SERVICE_NAMES: Record<number, string> = {
  2: 'Deezer', 9: 'Spotify', 12: 'Spotify', 160: 'SoundCloud', 174: 'TIDAL', 201: 'Amazon Music', 204: 'Apple Music',
  254: 'TuneIn', 284: 'YouTube Music', 303: 'Sonos Radio',
};

export function serviceFromUri(uri: string | null | undefined): string | null {
  const u = decodeURIComponent((uri ?? '').replace(/%(?![0-9a-f]{2})/gi, '%25'));
  if (/^x-sonos-spotify:|spotify[:%]/i.test(u)) return 'Spotify';
  if (/^x-file-cifs:/i.test(u)) return 'Music library';
  const sid = u.match(/[?&]sid=(\d+)/)?.[1];
  return sid ? SERVICE_NAMES[Number(sid)] ?? null : null;
}

export function describeSource(trackUri: string, transportUri?: string | null): { source: SonosSource; service: string | null } {
  const tk = uriKind(trackUri);
  const xk = transportUri != null ? uriKind(transportUri) : null;
  const session = xk === 'session' ? transportUri! : tk === 'session' ? trackUri : null;
  if (session) {
    if (/airplay/i.test(session)) return { source: 'airplay', service: 'AirPlay' };
    if (/spotify/i.test(session)) return { source: 'spotify_connect', service: 'Spotify' };
    return { source: 'app', service: serviceFromUri(trackUri) };
  }
  if (tk === 'tv' || xk === 'tv') return { source: 'tv', service: null };
  if (tk === 'line_in' || xk === 'line_in') return { source: 'line_in', service: null };
  if (tk === 'empty' && (!xk || xk === 'empty')) return { source: 'none', service: null };
  if (tk === 'radio' || xk === 'radio' || tk === 'stream') return { source: 'radio', service: serviceFromUri(trackUri || transportUri) };
  return { source: 'music', service: serviceFromUri(trackUri) };
}

// ---------------------------------------------------------------- album art

/**
 * Normalise an albumArtURI for the dashboard:
 *   - absolute public http(s) → as-is (the browser loads it directly)
 *   - speaker-relative ("/getaa?s=1&u=…") or an absolute URL on a speaker (:1400) → the relative path,
 *     which /api/devices/:id/sonos/art fetches from the speaker through the gateway
 *   - other LAN URLs (a NAS) can't be reached from the browser → dropped
 */
export function normalizeArt(raw: string | null | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  if (s.startsWith('/')) return artPathAllowed(s) ? s : undefined;
  let u: URL;
  try { u = new URL(s); } catch { return undefined; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(u.hostname) || /\.local$|^localhost$/i.test(u.hostname) || !u.hostname.includes('.');
  if (!lan) return s;
  const path = u.pathname + u.search;
  return u.port === '1400' && artPathAllowed(path) ? path : undefined;
}

/** Paths the art proxy may request from a speaker. */
export function artPathAllowed(path: string): boolean {
  return path.length <= 2000 && /^\/(getaa\?|img\/)/.test(path) && !/[\s\\]/.test(path) && !path.includes('..');
}

// ---------------------------------------------------------------- topology

export interface ZoneMember {
  uuid: string; name: string; ip: string | null; coordinator: string; invisible: boolean;
  /** For satellites / hidden stereo partners: the visible room they belong to. */
  bonded_to?: string; role?: string;
}

const ipOf = (location?: string) => location?.match(/\/\/([\d.]+):/)?.[1] ?? null;

/** Map of uuid → channel role from a ChannelMapSet / HTSatChanMapSet ("RINCON_A:LF,RF;RINCON_B:SW"). */
function channelRoles(map?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (map ?? '').split(';')) {
    const [uuid, ch] = part.split(':');
    if (!uuid || !ch) continue;
    const c = [...new Set(ch.split(','))].join(',');
    out.set(uuid, c === 'SW' ? 'Sub' : c === 'LR' ? 'Left surround' : c === 'RR' ? 'Right surround' : c === 'RF' ? 'Right' : c === 'LF' ? 'Left' : c);
  }
  return out;
}

/**
 * ZoneGroupState → flat member list. Home-theatre satellites (nested <Satellite>) and hidden
 * stereo-pair partners (Invisible="1") are included as invisible with `bonded_to` set.
 */
export function parseZoneGroups(stateXml: string): ZoneMember[] {
  const xml = unwrapXml(stateXml);
  const out: ZoneMember[] = [];
  for (const g of xml.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const coordinator = xmlAttrs(g[1]).Coordinator ?? '';
    const groupMembers: (ZoneMember & { channelMap?: string })[] = [];
    for (const m of g[2].matchAll(/<ZoneGroupMember\s([^>]*?)(?:\/>|>([\s\S]*?)<\/ZoneGroupMember>)/g)) {
      const a = xmlAttrs(m[1]);
      const member = { uuid: a.UUID, name: a.ZoneName, ip: ipOf(a.Location), coordinator, invisible: a.Invisible === '1', channelMap: [a.ChannelMapSet, a.HTSatChanMapSet].filter(Boolean).join(';') || undefined };
      groupMembers.push(member);
      const roles = channelRoles(a.HTSatChanMapSet);
      for (const s of (m[2] ?? '').matchAll(/<Satellite\s([^>]*?)\/?>/g)) {
        const sa = xmlAttrs(s[1]);
        groupMembers.push({ uuid: sa.UUID, name: sa.ZoneName ?? a.ZoneName, ip: ipOf(sa.Location), coordinator, invisible: true, bonded_to: a.UUID, role: roles.get(sa.UUID) ?? 'Satellite' });
      }
    }
    for (const m of groupMembers) {
      if (m.invisible && !m.bonded_to) {
        // Hidden half of a stereo pair (or a bonded Sub): attach to the visible member that lists it, else same name.
        const owner = groupMembers.find((o) => !o.invisible && (o.channelMap?.includes(m.uuid) || o.name === m.name)) ?? groupMembers.find((o) => !o.invisible);
        if (owner) { m.bonded_to = owner.uuid; m.role = channelRoles(m.channelMap ?? owner.channelMap).get(m.uuid) ?? 'Bonded speaker'; }
      }
      const { channelMap: _cm, ...rest } = m;
      void _cm;
      out.push(rest);
    }
  }
  return out;
}

/** Rooms (visible members) with their bonded speakers. */
export function visibleZones(members: ZoneMember[]): SonosZone[] {
  return members.filter((m) => !m.invisible).map((m) => {
    const bonded: SonosBonded[] = members.filter((b) => b.bonded_to === m.uuid).map((b) => ({ uuid: b.uuid, role: b.role ?? 'Bonded speaker', ip: b.ip }));
    return { uuid: m.uuid, name: m.name, ip: m.ip, coordinator: m.coordinator, ...(bonded.length ? { bonded } : {}) };
  });
}

/** Group display name: "Office + Living Area" (coordinator first). */
export function groupName(members: ZoneMember[], coordinator: string): string {
  const rooms = members.filter((m) => m.coordinator === coordinator && !m.invisible).sort((a, b) => (a.uuid === coordinator ? -1 : b.uuid === coordinator ? 1 : a.name.localeCompare(b.name)));
  return rooms.map((r) => r.name).join(' + ');
}

// ---------------------------------------------------------------- browse results

export interface BrowseEntry {
  id: string; parent: string; container: boolean; title: string; uri: string; meta: string; art?: string;
  upnp_class?: string; artist?: string; album?: string; duration_s?: number | null; type?: string; description?: string;
}

/** ContentDirectory Browse Result (DIDL items and containers). */
export function parseBrowse(result: string): BrowseEntry[] {
  const x = unwrapXml(result);
  const out: BrowseEntry[] = [];
  for (const m of x.matchAll(/<(item|container)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const a = xmlAttrs(m[2]);
    const body = m[3];
    const res = body.match(/<res\b([^>]*)>([\s\S]*?)<\/res>/);
    out.push({
      id: a.id ?? '', parent: a.parentID ?? '', container: m[1] === 'container',
      title: text(body, 'title') ?? '', uri: res ? xmlUnescape(res[2].trim()) : '', meta: xmlUnescape(xmlTag(body, 'resMD') ?? ''),
      art: normalizeArt(text(body, 'albumArtURI')), upnp_class: text(body, 'class'), artist: text(body, 'creator'), album: text(body, 'album'),
      duration_s: res ? hms(xmlAttrs(res[1]).duration) : null, type: text(body, 'type'), description: text(body, 'description'),
    });
  }
  return out;
}

export function favoriteKind(uri: string): 'radio' | 'playlist' | 'track' {
  const k = uriKind(uri);
  if (k === 'radio' || k === 'stream' || k === 'line_in' || k === 'tv') return 'radio';
  if (k === 'container' || /container|playlist/i.test(uri)) return 'playlist';
  return 'track';
}

export function parseFavorites(result: string): { title: string; uri: string; meta: string; art?: string; kind: 'radio' | 'playlist' | 'track'; description?: string }[] {
  return parseBrowse(result).filter((e) => e.uri).map((e) => ({
    title: e.title || 'Favourite', uri: e.uri, meta: e.meta, ...(e.art ? { art: e.art } : {}), kind: favoriteKind(e.uri), ...(e.description ? { description: e.description } : {}),
  }));
}

/** Browse Q:0 → queue rows (1-based index). */
export function parseQueue(result: string, start = 0): SonosQueueItem[] {
  return parseBrowse(result).map((e, i) => ({
    index: start + i + 1, title: e.title || 'Untitled', ...(e.artist ? { artist: e.artist } : {}), ...(e.album ? { album: e.album } : {}),
    ...(e.art ? { art: e.art } : {}), duration_s: e.duration_s ?? null,
  }));
}

/** DIDL metadata AddURIToQueue expects for a Sonos playlist (SQ:n). */
export function playlistMeta(id: string, title: string): string {
  return `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="${xmlEscape(id)}" parentID="SQ:" restricted="true"><dc:title>${xmlEscape(title)}</dc:title><upnp:class>object.container.playlistContainer</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">RINCON_AssociatedZPUDN</desc></item></DIDL-Lite>`;
}

export function parsePlaylists(result: string) {
  return parseBrowse(result).filter((e) => e.uri).map((e) => ({
    id: e.id, title: e.title || 'Playlist', uri: e.uri, meta: playlistMeta(e.id, e.title || 'Playlist'), ...(e.art ? { art: e.art } : {}), kind: 'playlist' as const,
  }));
}

// ---------------------------------------------------------------- play mode

/** SoCo's PLAY_MODES table: NewPlayMode ↔ (shuffle, repeat). */
const PLAY_MODES: Record<string, { shuffle: boolean; repeat: SonosRepeat }> = {
  NORMAL: { shuffle: false, repeat: 'off' }, SHUFFLE_NOREPEAT: { shuffle: true, repeat: 'off' },
  REPEAT_ALL: { shuffle: false, repeat: 'all' }, SHUFFLE: { shuffle: true, repeat: 'all' },
  REPEAT_ONE: { shuffle: false, repeat: 'one' }, SHUFFLE_REPEAT_ONE: { shuffle: true, repeat: 'one' },
};

export function parsePlayMode(mode: string | null | undefined): { shuffle: boolean; repeat: SonosRepeat } {
  return PLAY_MODES[(mode ?? '').toUpperCase()] ?? PLAY_MODES.NORMAL;
}

export function playModeName(shuffle: boolean, repeat: SonosRepeat): string {
  return Object.entries(PLAY_MODES).find(([, v]) => v.shuffle === shuffle && v.repeat === repeat)![0];
}

// ---------------------------------------------------------------- resume ("Play") planning

export interface ResumeContext {
  /** GetMediaInfo CurrentURI / CurrentURIMetaData (metadata already unwrapped to DIDL XML). */
  transportUri: string; transportMeta: string;
  /** GetMediaInfo NrTracks and GetPositionInfo Track (1-based, 0 = none). */
  nrTracks: number; track: number;
  /** Items in the coordinator's Sonos queue (Q:0). */
  queueSize: number;
  coordUuid: string;
}

export type ResumeStep = { op: 'set_uri'; uri: string; meta: string } | { op: 'seek_track'; track: number } | { op: 'play' };
export interface ResumeAttempt { label: string; steps: ResumeStep[]; note?: string }
export interface ResumePlan { kind: UriKind; attempts: ResumeAttempt[]; fail: string }

const queueUri = (coord: string) => `x-rincon-queue:${coord}#0`;

/**
 * What to try when Play didn't start playback. Mature controllers do one of: re-select the queue and
 * seek to the current track; re-set the current URI with its metadata (node-sonos-ts' restore); or fall
 * back to the local queue when the previous source belonged to an app session that has ended.
 */
export function planResume(c: ResumeContext): ResumePlan {
  const kind = uriKind(c.transportUri);
  const toQueue: ResumeAttempt = { label: 'play the Sonos queue', steps: [{ op: 'set_uri', uri: queueUri(c.coordUuid), meta: '' }, { op: 'play' }], note: 'The previous source had ended, so the Sonos queue was started instead.' };
  const nothing = 'Nothing is loaded on this speaker. Pick a favourite or playlist to start something.';
  switch (kind) {
    case 'queue': {
      if (c.nrTracks <= 0 && c.queueSize <= 0) return { kind, attempts: [], fail: 'The Sonos queue is empty. Pick a favourite or playlist to start something.' };
      const total = Math.max(c.nrTracks, c.queueSize);
      const cur = c.track >= 1 && c.track <= total ? c.track : 1;
      const attempts: ResumeAttempt[] = [{ label: 'restart the current queue track', steps: [{ op: 'set_uri', uri: queueUri(c.coordUuid), meta: '' }, { op: 'seek_track', track: cur }, { op: 'play' }] }];
      if (cur < total) attempts.push({ label: 'skip to the next queue track', steps: [{ op: 'seek_track', track: cur + 1 }, { op: 'play' }], note: 'The current track couldn’t be played, so the next one was started.' });
      return { kind, attempts, fail: 'The tracks in the queue can’t be played right now. The music service may be unavailable or its login may have expired — check it in the Sonos app.' };
    }
    case 'session': {
      const app = /airplay/i.test(c.transportUri) ? 'AirPlay' : /spotify/i.test(c.transportUri) ? 'Spotify Connect' : null;
      const fail = app === 'AirPlay'
        ? 'This speaker was playing via AirPlay, which can only be restarted from the phone or Mac that started it. Pick a favourite or playlist to play something else.'
        : app === 'Spotify Connect'
          ? 'This speaker was playing through Spotify Connect, which can only be restarted from the Spotify app. Pick a favourite or playlist to play something else.'
          : 'This speaker was last controlled by another app (for example the YouTube Music or Spotify app) and that session has ended. Start it again from that app, or pick a favourite or playlist here.';
      return { kind, attempts: c.queueSize > 0 ? [{ ...toQueue, note: `The ${app ?? 'app'} session had ended, so the Sonos queue was started instead.` }] : [], fail };
    }
    case 'tv':
      return { kind, attempts: [{ label: 'reselect the TV input', steps: [{ op: 'set_uri', uri: c.transportUri, meta: '' }, { op: 'play' }] }], fail: 'No sound is coming from the TV input. Check the TV is on and set to use the soundbar.' };
    case 'line_in':
      return { kind, attempts: [{ label: 'reselect the line-in', steps: [{ op: 'set_uri', uri: c.transportUri, meta: c.transportMeta }, { op: 'play' }] }], fail: 'Nothing is coming in on the line-in. Check the device plugged into it is on and playing.' };
    case 'group':
      return { kind, attempts: [], fail: 'This speaker is part of a group and the group changed while Screens was asking. Try again.' };
    case 'empty':
      return { kind, attempts: c.queueSize > 0 ? [{ ...toQueue, note: undefined }] : [], fail: nothing };
    default: {
      // radio / stream / container / track / other: re-set the same URI with its metadata, then fall back to the queue.
      const attempts: ResumeAttempt[] = [{ label: 'reload what was playing', steps: [{ op: 'set_uri', uri: c.transportUri, meta: c.transportMeta }, { op: 'play' }] }];
      if (c.queueSize > 0) attempts.push(toQueue);
      return { kind, attempts, fail: kind === 'radio' ? 'The station or stream couldn’t be restarted. It may be offline — try a different favourite.' : 'What was playing couldn’t be restarted. Pick a favourite or playlist to start something.' };
    }
  }
}

// ---------------------------------------------------------------- alarms

export type RawAlarm = Record<string, string>;

export function parseAlarms(listXml: string): RawAlarm[] {
  const x = unwrapXml(listXml);
  return [...x.matchAll(/<Alarm\s([^>]*?)\/?>/g)].map((m) => xmlAttrs(m[1])).filter((a) => a.ID);
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function recurrenceLabel(rec: string): string {
  const r = (rec ?? '').toUpperCase();
  if (r === 'DAILY' || r === 'ON_0123456') return 'Every day';
  if (r === 'WEEKDAYS' || r === 'ON_12345') return 'Weekdays';
  if (r === 'WEEKENDS' || r === 'ON_06') return 'Weekends';
  if (r === 'ONCE' || r === 'ON_') return 'Once';
  const m = r.match(/^ON_([0-6]+)$/);
  if (!m) return rec;
  const days = [...new Set(m[1].split(''))].map(Number).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const key = [...days].sort().join('');
  if (key === '0123456') return 'Every day';
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  return days.map((d) => DAY[d]).join(', ');
}

export function alarmView(a: RawAlarm, roomName: string | null): SonosAlarm {
  const program = !a.ProgramURI || a.ProgramURI === 'x-rincon-buzzer:0' ? 'Sonos chime' : (parseDidl(a.ProgramMetaData).title ?? 'Music');
  return {
    id: a.ID, time: (a.StartTime ?? '').slice(0, 5), duration: a.Duration ? a.Duration.slice(0, 5) : null, recurrence: a.Recurrence ?? '', days: recurrenceLabel(a.Recurrence ?? ''),
    enabled: a.Enabled === '1', room_uuid: a.RoomUUID ?? '', room: roomName, program, volume: Number(a.Volume ?? 0), play_mode: a.PlayMode ?? 'NORMAL',
    include_grouped: a.IncludeLinkedZones === '1',
  };
}

/** UpdateAlarm arguments: every field round-tripped from ListAlarms, with the requested changes (SoCo Alarm.save). */
export function updateAlarmArgs(a: RawAlarm, patch: { enabled?: boolean }): Record<string, string> {
  return {
    ID: a.ID, StartLocalTime: a.StartTime ?? '', Duration: a.Duration ?? '', Recurrence: a.Recurrence ?? 'ONCE',
    Enabled: patch.enabled === undefined ? (a.Enabled ?? '0') : patch.enabled ? '1' : '0',
    RoomUUID: a.RoomUUID ?? '', ProgramURI: a.ProgramURI || 'x-rincon-buzzer:0', ProgramMetaData: a.ProgramMetaData ?? '',
    PlayMode: a.PlayMode ?? 'NORMAL', Volume: a.Volume ?? '20', IncludeLinkedZones: a.IncludeLinkedZones ?? '0',
  };
}

// ---------------------------------------------------------------- device description

/** Models with a line-in (HA's model lists, plus Era 100/300 and Move 2 via the Sonos USB-C line-in adapter). */
const LINE_IN_MODELS = /(^|\s)(connect|connect:amp|port|play:5|five|amp|era 100|era 300|move 2)$/i;
const TV_MODELS = /(^|\s)(arc|arc ultra|beam|ray|playbar|playbase|amp)$/i;

/** Which inputs a model has, from its model name ("Sonos Arc", "Sonos Era 100"…). */
export function modelInputs(model: string | null | undefined): { line_in: boolean; tv: boolean } {
  const m = (model ?? '').trim();
  return { line_in: LINE_IN_MODELS.test(m), tv: TV_MODELS.test(m) };
}

export function parseDescription(x: string) {
  const model = text(x, 'modelName') ?? '';
  return {
    uuid: (text(x, 'UDN') ?? '').replace(/^uuid:/, ''), room: text(x, 'roomName') ?? null, model_name: model || null, model_number: text(x, 'modelNumber') ?? null,
    hardware: text(x, 'hardwareVersion') ?? null, display_version: text(x, 'displayVersion') ?? null, api_version: text(x, 'apiVersion') ?? null,
    serial: text(x, 'serialNum') ?? null, software: text(x, 'softwareVersion') ?? null,
    has_line_in: modelInputs(model).line_in,
    has_tv: modelInputs(model).tv,
  };
}

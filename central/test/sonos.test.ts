import { describe, expect, it } from 'vitest';
import {
  adapterCodeFor, alarmView, artPathAllowed, describeSource, groupName, hms, modelInputs, nowPlayingFrom, normalizeArt, parseAlarms, parseBrowse,
  parseDescription, parseDidl, parsePlaylists, parsePlayMode, parseQueue, parseZoneGroups, planResume, playModeName, recurrenceLabel, serviceFromUri,
  sonosErrorMessage, toHms, updateAlarmArgs, upnpCode, uriKind, visibleZones,
} from '../src/worker/adapters/sonos-parse';
import { xmlEscape, xmlTag, xmlUnescape } from '../src/worker/adapters/types';

/** Wrap an inner XML document the way Sonos does inside a SOAP text node (escaped once). */
const esc = (x: string) => xmlEscape(x).replace(/&apos;/g, "'");
const soapBody = (action: string, inner: string) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${inner}</u:${action}Response></s:Body></s:Envelope>`;

// The live case from the field: Office (Era 100) coordinating Living Area (Era 300), stopped on YouTube Music.
const YTM_TRACK_URI = 'x-sonosapi-hls-static:ALkSOiGh9I73trQZHA5HxwnkhgHoAR-gmqWT-4yiBpc0cJI1?sid=284&flags=8&sn=2';
const YTM_DIDL = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
  + '<item id="-1" parentID="-1" restricted="true"><res protocolInfo="sonos.com-http:*:application/x-mpegURL:*" duration="0:02:29">' + esc(YTM_TRACK_URI) + '</res>'
  + '<r:streamContent></r:streamContent><upnp:albumArtURI>' + esc('/getaa?s=1&u=x-sonosapi-hls-static%3aALkSOiGh9I73trQZHA5HxwnkhgHoAR-gmqWT-4yiBpc0cJI1%3fsid%3d284%26flags%3d8%26sn%3d2') + '</upnp:albumArtURI>'
  + '<dc:title>Space Blues</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><dc:creator>Sweeps</dc:creator><upnp:album>' + esc('Rock & Roll <Live>') + '</upnp:album></item></DIDL-Lite>';
const POSITION_INFO = soapBody('GetPositionInfo', `<Track>1</Track><TrackDuration>0:02:29</TrackDuration><TrackMetaData>${esc(YTM_DIDL)}</TrackMetaData><TrackURI>${esc(YTM_TRACK_URI)}</TrackURI><RelTime>0:00:00</RelTime><AbsTime>NOT_IMPLEMENTED</AbsTime><RelCount>2147483647</RelCount><AbsCount>2147483647</AbsCount>`);

describe('sonos DIDL / now playing', () => {
  it('decodes nested entities and normalises speaker-relative art (the field case)', () => {
    const meta = xmlTag(POSITION_INFO, 'TrackMetaData');
    const np = nowPlayingFrom(meta, xmlUnescape(xmlTag(POSITION_INFO, 'TrackURI') ?? ''));
    expect(np).toMatchObject({ title: 'Space Blues', artist: 'Sweeps', album: 'Rock & Roll <Live>', source: 'music', service: 'YouTube Music' });
    // Before the fix this was "/getaa?s=1&amp;u=…" and never shown.
    expect(np.art).toBe('/getaa?s=1&u=x-sonosapi-hls-static%3aALkSOiGh9I73trQZHA5HxwnkhgHoAR-gmqWT-4yiBpc0cJI1%3fsid%3d284%26flags%3d8%26sn%3d2');
    expect(parseDidl(meta).duration_s).toBe(149);
  });

  it('uses r:streamContent for radio and hides URI-like titles', () => {
    const didl = '<DIDL-Lite><item id="-1" parentID="-1"><res>x-sonosapi-stream:s25065?sid=254&amp;flags=8224&amp;sn=0</res>'
      + '<r:streamContent>Tame Impala - Breathe Deeper</r:streamContent><dc:title>x-sonosapi-stream:s25065?sid=254&amp;flags=8224&amp;sn=0</dc:title>'
      + '<upnp:class>object.item</upnp:class></item></DIDL-Lite>';
    const np = nowPlayingFrom(esc(didl), 'x-sonosapi-stream:s25065?sid=254&flags=8224&sn=0');
    expect(np).toMatchObject({ title: 'Breathe Deeper', artist: 'Tame Impala', source: 'radio', service: 'TuneIn' });
    const connecting = nowPlayingFrom(esc('<DIDL-Lite><item><r:streamContent>ZPSTR_CONNECTING</r:streamContent><dc:title>triple j</dc:title></item></DIDL-Lite>'), 'x-sonosapi-stream:s1?sid=254');
    expect(connecting.title).toBe('triple j');
    expect(nowPlayingFrom(esc('<DIDL-Lite><item><r:streamContent>ZPSTR_BUFFERING</r:streamContent></item></DIDL-Lite>')).title).toBe('Buffering…');
    expect(nowPlayingFrom(esc('<DIDL-Lite><item><dc:title>Re:Stacks</dc:title></item></DIDL-Lite>')).title).toBe('Re:Stacks');
    expect(parseDidl('NOT_IMPLEMENTED')).toEqual({});
    expect(parseDidl('')).toEqual({});
  });

  it('names sources and services', () => {
    expect(serviceFromUri('x-sonos-spotify:spotify%3atrack%3a6kkw?sid=12&flags=8224&sn=1')).toBe('Spotify');
    expect(serviceFromUri('x-sonosapi-hls-static:abc%3fsid%3d284')).toBe('YouTube Music');
    expect(serviceFromUri('x-sonosapi-radio:x?sid=999')).toBeNull();
    expect(serviceFromUri('weird%zzuri?sid=204')).toBe('Apple Music');
    expect(describeSource('x-sonos-htastream:RINCON_A01400:spdif')).toEqual({ source: 'tv', service: null });
    expect(describeSource('x-rincon-stream:RINCON_A01400')).toMatchObject({ source: 'line_in' });
    expect(describeSource('x-sonos-spotify:spotify:track:1?sid=12', 'x-sonos-vli:RINCON_A01400:2,spotify:e934')).toMatchObject({ source: 'spotify_connect', service: 'Spotify' });
    expect(describeSource('', 'x-sonos-vli:RINCON_A01400:1,airplay:abc')).toMatchObject({ source: 'airplay' });
    expect(describeSource(YTM_TRACK_URI, 'x-sonos-vli:RINCON_A01400:3,cloud:xyz')).toMatchObject({ source: 'app', service: 'YouTube Music' });
    expect(describeSource('')).toMatchObject({ source: 'none' });
  });

  it('classifies transport URIs', () => {
    expect(uriKind('x-rincon-queue:RINCON_A01400#0')).toBe('queue');
    expect(uriKind('x-rincon:RINCON_A01400')).toBe('group');
    expect(uriKind('x-sonos-vli:RINCON_A01400:2,spotify:x')).toBe('session');
    expect(uriKind('x-sonosapi-radio:ytm?sid=284')).toBe('radio');
    expect(uriKind('x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a1')).toBe('container');
    expect(uriKind('file:///jffs/settings/savedqueues.rsq#3')).toBe('container');
    expect(uriKind(YTM_TRACK_URI)).toBe('track');
    expect(uriKind('https://stream.example/live.mp3')).toBe('stream');
    expect(uriKind('')).toBe('empty');
  });
});

describe('sonos album art', () => {
  it('keeps public URLs, proxies speaker paths, drops other LAN hosts and junk', () => {
    expect(normalizeArt('https://i.ytimg.com/vi/abc/hqdefault.jpg')).toBe('https://i.ytimg.com/vi/abc/hqdefault.jpg');
    expect(normalizeArt('http://10.10.50.205:1400/getaa?s=1&u=x-sonos-spotify%3a1')).toBe('/getaa?s=1&u=x-sonos-spotify%3a1');
    expect(normalizeArt('/getaa?u=x-file-cifs%3a%2f%2fnas%2fa.flac&v=12')).toBe('/getaa?u=x-file-cifs%3a%2f%2fnas%2fa.flac&v=12');
    expect(normalizeArt('http://192.168.1.5:8200/AlbumArt/1.jpg')).toBeUndefined();
    expect(normalizeArt('/xml/device_description.xml')).toBeUndefined();
    expect(normalizeArt('javascript:alert(1)')).toBeUndefined();
    expect(normalizeArt('')).toBeUndefined();
    expect(artPathAllowed('/getaa?s=1&u=x')).toBe(true);
    expect(artPathAllowed('//evil.example/getaa?')).toBe(false);
    expect(artPathAllowed('/getaa?u=../../status')).toBe(false);
    expect(artPathAllowed('/MediaRenderer/AVTransport/Control')).toBe(false);
  });
});

describe('sonos UPnP errors', () => {
  const fault = (code: number) => `<s:Envelope><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
  it('extracts codes and explains them in plain English', () => {
    expect(upnpCode(fault(701))).toBe(701);
    expect(upnpCode('<html>nope</html>')).toBeNull();
    expect(sonosErrorMessage('Play', 701)).toMatch(/session/);
    expect(sonosErrorMessage('Next', 701)).toMatch(/skip/);
    expect(sonosErrorMessage('Seek', 711)).toMatch(/past the end/);
    expect(sonosErrorMessage('SetPlayMode', 712)).toMatch(/Sonos queue/);
    expect(sonosErrorMessage('Play', 714)).toMatch(/format/);
    expect(sonosErrorMessage('Play', 716)).toMatch(/couldn’t find/);
    expect(sonosErrorMessage('ConfigureSleepTimer', 800)).toMatch(/main speaker/);
    expect(sonosErrorMessage('SetEQ', 402)).toMatch(/didn’t accept/);
    expect(sonosErrorMessage('GetEQ', 401)).toMatch(/doesn’t support/);
    expect(sonosErrorMessage('Play', 501)).toMatch(/source may be unavailable/);
    expect(sonosErrorMessage('Play', null, 500)).toMatch(/HTTP 500/);
    expect(sonosErrorMessage('Play', 999)).toMatch(/Sonos error 999/);
    // No message leaks protocol jargon like "UPnP".
    for (const c of [701, 702, 703, 704, 705, 711, 712, 714, 715, 716, 800, 801, 804, 401, 402, 501]) expect(sonosErrorMessage('Play', c)).not.toMatch(/UPnP|SOAP/);
    expect(adapterCodeFor(402)).toBe('bad_args');
    expect(adapterCodeFor(602)).toBe('not_supported');
    expect(adapterCodeFor(701)).toBe('failed');
  });
});

describe('sonos play fallback planning', () => {
  const base = { transportMeta: '', nrTracks: 0, track: 0, queueSize: 0, coordUuid: 'RINCON_F85C2422775E01400' };
  const ops = (p: ReturnType<typeof planResume>) => p.attempts.map((a) => a.steps.map((s) => (s.op === 'set_uri' ? `set:${s.uri}` : s.op === 'seek_track' ? `seek:${s.track}` : 'play')).join(' '));

  it('ended app session: falls back to the Sonos queue, or explains what to do', () => {
    const withQueue = planResume({ ...base, transportUri: 'x-sonos-vli:RINCON_F85C2422775E01400:3,cloud:abc', queueSize: 12 });
    expect(withQueue.kind).toBe('session');
    expect(ops(withQueue)).toEqual(['set:x-rincon-queue:RINCON_F85C2422775E01400#0 play']);
    expect(withQueue.attempts[0].note).toMatch(/session had ended/);
    const none = planResume({ ...base, transportUri: 'x-sonos-vli:RINCON_F85C2422775E01400:3,cloud:abc' });
    expect(none.attempts).toEqual([]);
    expect(none.fail).toMatch(/YouTube Music or Spotify app/);
    expect(planResume({ ...base, transportUri: 'x-sonos-vli:RINCON_X:2,spotify:e93' }).fail).toMatch(/Spotify app/);
    expect(planResume({ ...base, transportUri: 'x-sonos-vli:RINCON_X:1,airplay:e93' }).fail).toMatch(/AirPlay/);
  });

  it('queue: re-selects the queue at the current track, then tries the next one', () => {
    const p = planResume({ ...base, transportUri: 'x-rincon-queue:RINCON_F85C2422775E01400#0', nrTracks: 20, track: 7 });
    expect(ops(p)).toEqual(['set:x-rincon-queue:RINCON_F85C2422775E01400#0 seek:7 play', 'seek:8 play']);
    expect(ops(planResume({ ...base, transportUri: 'x-rincon-queue:RINCON_F85C2422775E01400#0', nrTracks: 3, track: 3 }))).toHaveLength(1);
    expect(ops(planResume({ ...base, transportUri: 'x-rincon-queue:RINCON_F85C2422775E01400#0', nrTracks: 3, track: 0 }))[0]).toContain('seek:1');
    const empty = planResume({ ...base, transportUri: 'x-rincon-queue:RINCON_F85C2422775E01400#0' });
    expect(empty.attempts).toEqual([]);
    expect(empty.fail).toMatch(/queue is empty/);
  });

  it('radio / single track: re-sets the URI with its metadata, then the queue', () => {
    const meta = '<DIDL-Lite><item><dc:title>YouTube Music radio</dc:title></item></DIDL-Lite>';
    const p = planResume({ ...base, transportUri: 'x-sonosapi-radio:RDAMVM?sid=284&flags=8300&sn=2', transportMeta: meta, queueSize: 4 });
    expect(p.kind).toBe('radio');
    expect(p.attempts[0].steps[0]).toEqual({ op: 'set_uri', uri: 'x-sonosapi-radio:RDAMVM?sid=284&flags=8300&sn=2', meta });
    expect(ops(p)[1]).toBe('set:x-rincon-queue:RINCON_F85C2422775E01400#0 play');
    expect(ops(planResume({ ...base, transportUri: YTM_TRACK_URI }))).toEqual([`set:${YTM_TRACK_URI} play`]);
  });

  it('nothing loaded / TV / grouped', () => {
    expect(planResume({ ...base, transportUri: '' }).fail).toMatch(/Nothing is loaded/);
    expect(ops(planResume({ ...base, transportUri: '', queueSize: 2 }))).toEqual(['set:x-rincon-queue:RINCON_F85C2422775E01400#0 play']);
    expect(planResume({ ...base, transportUri: 'x-sonos-htastream:RINCON_BAR:spdif' }).fail).toMatch(/TV/);
    expect(planResume({ ...base, transportUri: 'x-rincon:RINCON_F85C2422775E01400' }).attempts).toEqual([]);
  });
});

describe('sonos topology', () => {
  const zgs = esc('<ZoneGroupState><ZoneGroups>'
    + '<ZoneGroup Coordinator="RINCON_F85C2422775E01400" ID="RINCON_F85C2422775E01400:2858">'
    + '<ZoneGroupMember UUID="RINCON_F85C2422775E01400" Location="http://10.10.50.205:1400/xml/device_description.xml" ZoneName="Office" Icon="" Configuration="1" SoftwareVersion="85.0-64200" SWGen="2" MinCompatibleVersion="84.0-00000" BootSeq="40" TVConfigurationError="0" HdmiCecAvailable="0" WirelessMode="0" WifiEnabled="1" EthLink="0" MicEnabled="0" AirPlayEnabled="1" IdleState="1" MoreInfo="RawBattery:N/A" SSLPort="1443" HHSSLPort="1843"/>'
    + '<ZoneGroupMember UUID="RINCON_C43875CA135801400" Location="http://10.10.50.251:1400/xml/device_description.xml" ZoneName="Living Area" Icon="" SWGen="2"/>'
    + '</ZoneGroup>'
    + '<ZoneGroup Coordinator="RINCON_BAR01400" ID="RINCON_BAR01400:12">'
    + '<ZoneGroupMember UUID="RINCON_BAR01400" Location="http://10.10.50.10:1400/xml/device_description.xml" ZoneName="Lounge &amp; Deck" HTSatChanMapSet="RINCON_BAR01400:LF,RF;RINCON_SUB01400:SW;RINCON_SL01400:LR;RINCON_SR01400:RR">'
    + '<Satellite UUID="RINCON_SUB01400" Location="http://10.10.50.11:1400/xml/device_description.xml" ZoneName="Lounge &amp; Deck" Invisible="1"/>'
    + '<Satellite UUID="RINCON_SL01400" Location="http://10.10.50.12:1400/xml/device_description.xml" ZoneName="Lounge &amp; Deck" Invisible="1"/>'
    + '<Satellite UUID="RINCON_SR01400" Location="http://10.10.50.13:1400/xml/device_description.xml" ZoneName="Lounge &amp; Deck" Invisible="1"/>'
    + '</ZoneGroupMember></ZoneGroup>'
    + '<ZoneGroup Coordinator="RINCON_L01400" ID="RINCON_L01400:3">'
    + '<ZoneGroupMember UUID="RINCON_L01400" Location="http://10.10.50.20:1400/xml/device_description.xml" ZoneName="Bedroom" ChannelMapSet="RINCON_L01400:LF,LF;RINCON_R01400:RF,RF"/>'
    + '<ZoneGroupMember UUID="RINCON_R01400" Location="http://10.10.50.21:1400/xml/device_description.xml" ZoneName="Bedroom" ChannelMapSet="RINCON_L01400:LF,LF;RINCON_R01400:RF,RF" Invisible="1"/>'
    + '</ZoneGroup></ZoneGroups><VanishedDevices></VanishedDevices></ZoneGroupState>');

  it('lists rooms, not satellites or stereo partners', () => {
    const members = parseZoneGroups(zgs);
    expect(members).toHaveLength(8);
    expect(members.find((m) => m.uuid === 'RINCON_C43875CA135801400')).toMatchObject({ ip: '10.10.50.251', coordinator: 'RINCON_F85C2422775E01400', invisible: false });
    expect(members.find((m) => m.uuid === 'RINCON_SUB01400')).toMatchObject({ invisible: true, bonded_to: 'RINCON_BAR01400', role: 'Sub', ip: '10.10.50.11' });
    expect(members.find((m) => m.uuid === 'RINCON_R01400')).toMatchObject({ invisible: true, bonded_to: 'RINCON_L01400', role: 'Right' });
    const rooms = visibleZones(members);
    expect(rooms.map((r) => r.name)).toEqual(['Office', 'Living Area', 'Lounge & Deck', 'Bedroom']);
    expect(rooms[2].bonded?.map((b) => b.role)).toEqual(['Sub', 'Left surround', 'Right surround']);
    expect(rooms[3].bonded).toEqual([{ uuid: 'RINCON_R01400', role: 'Right', ip: '10.10.50.21' }]);
    expect(rooms[0].bonded).toBeUndefined();
    expect(groupName(members, 'RINCON_F85C2422775E01400')).toBe('Office + Living Area');
  });

  it('still parses the old flat (already unescaped) format', () => {
    const m = parseZoneGroups('<ZoneGroups><ZoneGroup Coordinator="RINCON_A" ID="x"><ZoneGroupMember UUID="RINCON_A" Location="http://10.0.0.5:1400/x" ZoneName="A"/></ZoneGroup></ZoneGroups>');
    expect(m).toEqual([{ uuid: 'RINCON_A', name: 'A', ip: '10.0.0.5', coordinator: 'RINCON_A', invisible: false }]);
  });
});

describe('sonos browse', () => {
  it('parses the queue with 1-based indexes from the start offset', () => {
    const didl = esc('<DIDL-Lite><item id="Q:0/11" parentID="Q:0" restricted="true"><res duration="0:03:20">x-sonos-spotify:spotify%3atrack%3a1?sid=12</res><upnp:albumArtURI>/getaa?s=1&amp;u=x-sonos-spotify%3a1</upnp:albumArtURI><dc:title>Track &amp; Field</dc:title><dc:creator>Band</dc:creator><upnp:album>LP</upnp:album></item>'
      + '<item id="Q:0/12" parentID="Q:0"><res>x-file-cifs://nas/a.flac</res><dc:title>Local</dc:title></item></DIDL-Lite>');
    const q = parseQueue(esc(xmlUnescape(didl)), 10);
    expect(q).toEqual([
      { index: 11, title: 'Track & Field', artist: 'Band', album: 'LP', art: '/getaa?s=1&u=x-sonos-spotify%3a1', duration_s: 200 },
      { index: 12, title: 'Local', duration_s: null },
    ]);
  });

  it('parses Sonos playlists with playable metadata', () => {
    const r = esc('<DIDL-Lite><container id="SQ:3" parentID="SQ:" restricted="true"><dc:title>Dinner &amp; Drinks</dc:title><res protocolInfo="file:*:audio/mpegurl:*">file:///jffs/settings/savedqueues.rsq#3</res><upnp:class>object.container.playlistContainer</upnp:class></container></DIDL-Lite>');
    const p = parsePlaylists(r);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: 'SQ:3', title: 'Dinner & Drinks', uri: 'file:///jffs/settings/savedqueues.rsq#3', kind: 'playlist' });
    expect(p[0].meta).toContain('<dc:title>Dinner &amp; Drinks</dc:title>');
    expect(p[0].meta).toContain('id="SQ:3"');
    expect(parseBrowse(r)[0].container).toBe(true);
  });
});

describe('sonos alarms, play mode, description, time', () => {
  const list = esc('<Alarms>'
    + '<Alarm ID="12" StartTime="07:00:00" Duration="02:00:00" Recurrence="WEEKDAYS" Enabled="1" RoomUUID="RINCON_F85C2422775E01400" ProgramURI="x-rincon-buzzer:0" ProgramMetaData="" PlayMode="SHUFFLE_NOREPEAT" Volume="25" IncludeLinkedZones="0"/>'
    + `<Alarm ID="14" StartTime="21:30:00" Duration="" Recurrence="ON_135" Enabled="0" RoomUUID="RINCON_C43875CA135801400" ProgramURI="x-sonosapi-stream:s25065?sid=254&amp;flags=8224" ProgramMetaData="${esc('<DIDL-Lite><item><dc:title>triple j &amp; friends</dc:title></item></DIDL-Lite>')}" PlayMode="NORMAL" Volume="12" IncludeLinkedZones="1"/>`
    + '</Alarms>');

  it('lists alarms and round-trips every field on update', () => {
    const raw = parseAlarms(list);
    expect(raw).toHaveLength(2);
    expect(alarmView(raw[0], 'Office')).toMatchObject({ id: '12', time: '07:00', duration: '02:00', days: 'Weekdays', enabled: true, room: 'Office', program: 'Sonos chime', volume: 25 });
    expect(alarmView(raw[1], null)).toMatchObject({ days: 'Mon, Wed, Fri', enabled: false, program: 'triple j & friends', include_grouped: true, duration: null });
    const args = updateAlarmArgs(raw[1], { enabled: true });
    expect(args).toMatchObject({ ID: '14', StartLocalTime: '21:30:00', Enabled: '1', Recurrence: 'ON_135', Volume: '12', IncludeLinkedZones: '1', PlayMode: 'NORMAL' });
    expect(args.ProgramURI).toBe('x-sonosapi-stream:s25065?sid=254&flags=8224');
    expect(args.ProgramMetaData).toBe('<DIDL-Lite><item><dc:title>triple j &amp; friends</dc:title></item></DIDL-Lite>');
    expect(updateAlarmArgs(raw[0], {}).Enabled).toBe('1');
    expect(recurrenceLabel('ON_06')).toBe('Weekends');
    expect(recurrenceLabel('ON_60')).toBe('Weekends');
    expect(recurrenceLabel('ON_0')).toBe('Sun');
    expect(recurrenceLabel('DAILY')).toBe('Every day');
  });

  it('maps play modes both ways', () => {
    expect(parsePlayMode('SHUFFLE')).toEqual({ shuffle: true, repeat: 'all' });
    expect(parsePlayMode('REPEAT_ONE')).toEqual({ shuffle: false, repeat: 'one' });
    expect(parsePlayMode('garbage')).toEqual({ shuffle: false, repeat: 'off' });
    expect(playModeName(true, 'off')).toBe('SHUFFLE_NOREPEAT');
    expect(playModeName(true, 'one')).toBe('SHUFFLE_REPEAT_ONE');
    expect(playModeName(false, 'all')).toBe('REPEAT_ALL');
  });

  it('reads the device description and model inputs', () => {
    const d = parseDescription('<root><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><modelNumber>S38</modelNumber><modelName>Sonos Era 100</modelName><softwareVersion>85.0-64200</softwareVersion><serialNum>F8-5C-24-22-77-5E:4</serialNum><UDN>uuid:RINCON_F85C2422775E01400</UDN><roomName>Office</roomName><displayVersion>17.3</displayVersion><apiVersion>1.55.0</apiVersion><deviceList><device><UDN>uuid:RINCON_F85C2422775E01400_MR</UDN></device></deviceList></device></root>');
    expect(d).toMatchObject({ uuid: 'RINCON_F85C2422775E01400', room: 'Office', model_name: 'Sonos Era 100', has_line_in: true, has_tv: false, api_version: '1.55.0' });
    expect(modelInputs('Sonos Arc')).toEqual({ line_in: false, tv: true });
    expect(modelInputs('Sonos Amp')).toEqual({ line_in: true, tv: true });
    expect(modelInputs('Sonos One')).toEqual({ line_in: false, tv: false });
    expect(modelInputs('Sonos Era 300')).toEqual({ line_in: true, tv: false });
  });

  it('converts times', () => {
    expect(hms('0:02:29')).toBe(149);
    expect(hms('1:00:00.000')).toBe(3600);
    expect(hms('NOT_IMPLEMENTED')).toBeNull();
    expect(hms('')).toBeNull();
    expect(toHms(149)).toBe('0:02:29');
    expect(toHms(3725)).toBe('1:02:05');
  });
});

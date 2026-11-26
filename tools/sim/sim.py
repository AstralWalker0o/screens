#!/usr/bin/env python3
"""
Device simulators for end-to-end testing of Screens without real hardware.

  Samsung TV  : HTTP :8001 /api/v2/, WSS :8002 remote channel, UPnP :9197
  Sonos       : HTTP :1400 device description, album art, SOAP (AVTransport incl. queue/play mode, RenderingControl,
                GroupRenderingControl, ZoneGroupTopology, ContentDirectory, DeviceProperties, AlarmClock)
  Android/ADB : TCP :5555 minimal adbd (CNXN without auth, shell:, exec:, streaming install, sync push)
                Screens Launcher: v2 by default (STATUS v2 fields, asset ContentProvider via `content write/query`,
                config v1 + v2); an APK containing the bytes SCREENS_LAUNCHER_V1 installs as the 1.0.0 app
                (STATUS v1, rejects "v": 2, no asset provider). docs/LAUNCHER-V2.md

Usage:  sudo python3 sim.py --samsung 10.99.0.20 --sonos 10.99.0.30,10.99.0.31 --android 10.99.0.10,10.99.0.11
The IPs must exist on this host (e.g. `ip addr add 10.99.0.20/32 dev lo`).
Every command a device receives is appended to sim.log as JSON lines for assertions.
"""
import argparse, base64, hashlib, http.server, json, os, re, socket, socketserver, ssl, struct, subprocess, sys, tempfile, threading, time, zlib

LOG = os.environ.get('SIM_LOG', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sim.log'))
_lock = threading.Lock()

def log(kind, **kw):
    with _lock, open(LOG, 'a') as f:
        f.write(json.dumps({'ts': time.time(), 'kind': kind, **kw}) + '\n')

class ThreadingHTTP(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    def server_bind(self):  # skip HTTPServer's reverse-DNS lookup (hangs in an isolated netns)
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

# --------------------------------------------------------------------------- minimal websocket
def ws_handshake(conn, headers):
    key = headers.get('sec-websocket-key', '')
    acc = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
    conn.sendall(f'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {acc}\r\n\r\n'.encode())

def ws_send(conn, text):
    data = text.encode()
    hdr = bytearray([0x81])
    n = len(data)
    if n < 126: hdr.append(n)
    elif n < 65536: hdr += bytes([126]) + struct.pack('>H', n)
    else: hdr += bytes([127]) + struct.pack('>Q', n)
    conn.sendall(bytes(hdr) + data)

def recv_exact(conn, n):
    buf = b''
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk: raise ConnectionError('closed')
        buf += chunk
    return buf

def ws_recv(conn):
    b1, b2 = recv_exact(conn, 2)
    op = b1 & 0x0f
    n = b2 & 0x7f
    if n == 126: n = struct.unpack('>H', recv_exact(conn, 2))[0]
    elif n == 127: n = struct.unpack('>Q', recv_exact(conn, 8))[0]
    mask = recv_exact(conn, 4) if b2 & 0x80 else b'\0\0\0\0'
    data = bytes(b ^ mask[i % 4] for i, b in enumerate(recv_exact(conn, n)))
    if op == 8: raise ConnectionError('close')
    if op == 9: return None
    return data.decode(errors='replace')

def read_http_head(conn):
    data = b''
    while b'\r\n\r\n' not in data:
        chunk = conn.recv(4096)
        if not chunk: raise ConnectionError('closed')
        data += chunk
    head = data.split(b'\r\n\r\n', 1)[0].decode()
    lines = head.split('\r\n')
    headers = {k.strip().lower(): v.strip() for k, v in (l.split(':', 1) for l in lines[1:] if ':' in l)}
    return lines[0], headers

# --------------------------------------------------------------------------- Samsung
SAMSUNG_APPS = [
    {'appId': '3201907018807', 'app_type': 2, 'icon': '/opt/usr/apps/netflix.png', 'is_lock': 0, 'name': 'Netflix'},
    {'appId': '111299001912', 'app_type': 2, 'icon': '/opt/usr/apps/yt.png', 'is_lock': 0, 'name': 'YouTube'},
    {'appId': '3201910019365', 'app_type': 2, 'icon': '/opt/usr/apps/prime.png', 'is_lock': 0, 'name': 'Prime Video'},
]

def samsung(ip, certfile, keyfile, mode='classic'):
    """mode: classic (connect right away) | tizen9 (silent until a register frame) | deny (Access Notification off)."""
    state = {'power': 'on'}
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            if self.path.startswith('/api/v2'):
                body = json.dumps({'device': {'PowerState': state['power'], 'TokenAuthSupport': 'true', 'FrameTVSupport': 'false', 'OS': 'Tizen', 'modelName': 'QA65Q80BAWXXY', 'model': '22_PONTUSM_QTV', 'name': '[TV] Lounge', 'wifiMac': 'a0:d0:5b:00:00:20', 'firmwareVersion': 'T-PTMAKUC-1520.3', 'resolution': '3840x2160', 'networkType': 'wired'}, 'name': '[TV] Lounge', 'type': 'Samsung SmartTV'}).encode()
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
            else:
                self.send_response(404); self.end_headers()
        def do_POST(self):
            n = int(self.headers.get('content-length', 0)); body = self.rfile.read(n).decode()
            log('samsung.upnp', ip=ip, action=self.headers.get('soapaction'), body=body[-200:])
            self.send_response(200); self.end_headers(); self.wfile.write(b'<ok/>')
    threading.Thread(target=ThreadingHTTP((ip, 8001), H).serve_forever, daemon=True).start()
    threading.Thread(target=ThreadingHTTP((ip, 9197), H).serve_forever, daemon=True).start()

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(certfile, keyfile)
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind((ip, 8002)); srv.listen(16)
    def client(raw):
        try:
            conn = ctx.wrap_socket(raw, server_side=True)
            line, headers = read_http_head(conn)
            path = line.split(' ')[1]
            ws_handshake(conn, headers)
            log('samsung.ws_connect', ip=ip, path=path, mode=mode)
            has_token = 'token=12345678' in path
            if mode == 'deny':
                ws_send(conn, json.dumps({'event': 'ms.channel.unauthorized'})); conn.close(); return
            if mode == 'classic' or has_token:
                ws_send(conn, json.dumps({'event': 'ms.channel.connect', 'data': {'id': 'abc', 'token': '12345678', 'clients': []}}))
            while True:
                m = ws_recv(conn)
                if m is None: continue
                msg = json.loads(m)
                if msg.get('method') == 'ms.channel.connect' and mode == 'tizen9' and not has_token:
                    log('samsung.register', ip=ip, params=msg.get('params'))
                    ws_send(conn, json.dumps({'event': 'ms.error', 'data': {'message': 'No Authorized'}}))
                    time.sleep(1.5)  # the owner presses Allow
                    ws_send(conn, json.dumps({'event': 'ms.channel.connect', 'data': {'id': 'abc', 'token': '12345678', 'clients': []}}))
                    has_token = True
                    continue
                if msg.get('method') == 'ms.remote.control':
                    p = msg['params']; log('samsung.key', ip=ip, key=p.get('DataOfCmd'), type=p.get('TypeOfRemote'))
                    if p.get('DataOfCmd') == 'KEY_POWER': state['power'] = 'standby' if state['power'] == 'on' else 'on'
                elif msg.get('method') == 'ms.channel.emit':
                    ev = msg['params'].get('event'); log('samsung.emit', ip=ip, event=ev, data=msg['params'].get('data'))
                    if ev == 'ed.installedApp.get':
                        ws_send(conn, json.dumps({'event': 'ed.installedApp.get', 'from': 'host', 'data': {'data': SAMSUNG_APPS}}))
        except Exception as e:
            pass
    def accept():
        while True:
            c, _ = srv.accept(); threading.Thread(target=client, args=(c,), daemon=True).start()
    threading.Thread(target=accept, daemon=True).start()

# --------------------------------------------------------------------------- Sonos
def sonos(ips):
    """Sonos speakers. The first plays its queue; the second is STOPPED on an app session that has ended
    (x-sonos-vli…dead-session): Play answers UPnP 701 until the Sonos queue (or anything else) is selected —
    the "Play doesn't work" case seen in the field. The third (if any) is a Sonos Arc for home-theatre EQ."""
    from xml.sax.saxutils import escape as xesc
    from html import unescape as xun
    uuids = {ip: f'RINCON_SIM{ip.split(".")[-1]:0>3}01400' for ip in ips}
    names = {ip: n for ip, n in zip(ips, ['Living Room', 'Kitchen', 'Office', 'Patio'])}
    models = {ip: m for ip, m in zip(ips, ['Sonos One', 'Sonos Era 100', 'Sonos Arc', 'Sonos One'])}
    def track(i, t, a, al):
        return {'uri': f'x-sonos-spotify:spotify%3atrack%3asim{i}?sid=12&flags=8224&sn=1', 'title': t, 'artist': a, 'album': al, 'dur': '0:03:30',
                'art': f'/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253asim{i}%3fsid%3d12'}
    tracks = [track(1, 'Weightless', 'Marconi Union', 'Ambient'), track(2, 'Midnight City', 'M83', 'Hurry Up, We’re Dreaming'),
              track(3, 'Breathe Deeper', 'Tame Impala', 'The Slow Rush'), track(4, 'Rock & Roll', 'Led Zeppelin', 'IV')]
    ytm = {'uri': 'x-sonosapi-hls-static:ALkSOiGh9I73trQZHA5HxwnkhgHoAR?sid=284&flags=8&sn=2', 'title': 'Space Blues', 'artist': 'Sweeps', 'album': '', 'dur': '0:02:29',
           'art': '/getaa?s=1&u=x-sonosapi-hls-static%3aALkSOiGh9I73trQZHA5HxwnkhgHoAR%3fsid%3d284%26flags%3d8%26sn%3d2'}
    st = {}
    for i, ip in enumerate(ips):
        st[ip] = {'state': 'PLAYING' if i == 0 else 'STOPPED', 'vol': 25, 'mute': 0, 'coord': uuids[ip], 'led': 'On', 'lock': 'Off',
                  'uri': f'x-rincon-queue:{uuids[ip]}#0' if i == 0 else f'x-sonos-vli:{uuids[ip]}:3,cloud:dead-session', 'meta': '',
                  'queue': list(tracks) if i == 0 else tracks[:3], 'track': 1, 'mode': 'NORMAL', 'xfade': 0, 'sleep': '', 'eq': {}}
    alarms = {'12': {'ID': '12', 'StartTime': '07:00:00', 'Duration': '02:00:00', 'Recurrence': 'WEEKDAYS', 'Enabled': '1', 'RoomUUID': uuids[ips[0]],
                     'ProgramURI': 'x-rincon-buzzer:0', 'ProgramMetaData': '', 'PlayMode': 'SHUFFLE_NOREPEAT', 'Volume': '25', 'IncludeLinkedZones': '0'}}
    def topology():
        groups = {}
        for ip in ips: groups.setdefault(st[ip]['coord'], []).append(ip)
        x = '<ZoneGroupState><ZoneGroups>'
        for coord, members in groups.items():
            x += f'<ZoneGroup Coordinator="{coord}" ID="{coord}:1">' + ''.join(f'<ZoneGroupMember UUID="{uuids[m]}" Location="http://{m}:1400/xml/device_description.xml" ZoneName="{names[m]}"/>' for m in members) + '</ZoneGroup>'
        x += '</ZoneGroups></ZoneGroupState>'
        return xesc(x)
    def didl(t, item_id='-1', parent='-1'):
        return (f'<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
                f'<item id="{item_id}" parentID="{parent}" restricted="true"><res protocolInfo="sonos.com-http:*:audio/mp4:*" duration="{t["dur"]}">{xesc(t["uri"])}</res>'
                f'<upnp:albumArtURI>{xesc(t["art"])}</upnp:albumArtURI><dc:title>{xesc(t["title"])}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>'
                f'<dc:creator>{xesc(t["artist"])}</dc:creator><upnp:album>{xesc(t["album"])}</upnp:album></item></DIDL-Lite>')
    def coord_ip(ip):
        return next((m for m in ips if uuids[m] == st[ip]['coord']), ip)
    def current(s):
        if s['uri'].startswith('x-rincon-queue:') and s['queue']: return s['queue'][min(s['track'], len(s['queue'])) - 1]
        if 'dead' in s['uri']: return ytm
        return None
    def make(ip):
        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def reply(self, body, code=200, ctype='text/xml'):
                b = body if isinstance(body, bytes) else body.encode(); self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
            def do_GET(self):
                if self.path == '/xml/device_description.xml':
                    self.reply(f'<?xml version="1.0"?><root><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>{ip} - {models[ip]}</friendlyName><manufacturer>Sonos, Inc.</manufacturer><modelNumber>S18</modelNumber><modelName>{models[ip]}</modelName><softwareVersion>83.1-61240</softwareVersion><hardwareVersion>1.20.1.6-2.1</hardwareVersion><serialNum>48-A6-B8-00-00-{ip.split(".")[-1]}:A</serialNum><UDN>uuid:{uuids[ip]}</UDN><roomName>{names[ip]}</roomName><displayVersion>16.4</displayVersion><apiVersion>1.40.0</apiVersion></device></root>')
                elif self.path.startswith('/getaa?'):
                    log('sonos.art', ip=ip, path=self.path)
                    global PNG
                    PNG = PNG or png_bytes(64, 64)
                    self.reply(PNG, ctype='image/png')
                else: self.reply('', 404)
            def do_POST(self):
                n = int(self.headers.get('content-length', 0)); body = self.rfile.read(n).decode()
                action = (self.headers.get('soapaction') or '').strip('"').split('#')[-1]
                log('sonos.soap', ip=ip, action=action)
                s = st[ip]
                def resp(inner=''):
                    svc = re.search(r'service:(\w+):1', self.headers.get('soapaction') or '').group(1)
                    return self.reply(f'<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:{action}Response xmlns:u="urn:schemas-upnp-org:service:{svc}:1">{inner}</u:{action}Response></s:Body></s:Envelope>')
                def fault(code):
                    log('sonos.fault', ip=ip, action=action, code=code)
                    return self.reply(f'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>{code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>', 500)
                val = lambda tag: xun((re.search(f'<{tag}>(.*?)</{tag}>', body, re.S) or [None, ''])[1])
                member = s['coord'] != uuids[ip]
                group = [m for m in ips if st[m]['coord'] == s['coord']]
                if action == 'GetZoneGroupState': return resp(f'<ZoneGroupState>{topology()}</ZoneGroupState>')
                # ---- AVTransport
                if action == 'GetTransportInfo': return resp(f'<CurrentTransportState>{st[coord_ip(ip)]["state"] if member else s["state"]}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>')
                if action == 'GetPositionInfo':
                    t = current(s)
                    if not t: return resp('<Track>0</Track><TrackDuration>0:00:00</TrackDuration><TrackMetaData></TrackMetaData><TrackURI></TrackURI><RelTime>0:00:00</RelTime>')
                    return resp(f'<Track>{s["track"] if s["uri"].startswith("x-rincon-queue:") else 1}</Track><TrackDuration>{t["dur"]}</TrackDuration><TrackMetaData>{xesc(didl(t))}</TrackMetaData><TrackURI>{xesc(t["uri"])}</TrackURI><RelTime>{"0:01:23" if s["state"] == "PLAYING" else "0:00:00"}</RelTime>')
                if action == 'GetMediaInfo':
                    uri = f'x-rincon:{s["coord"]}' if member else s['uri']
                    nr = len(s['queue']) if uri.startswith('x-rincon-queue:') else (1 if uri else 0)
                    return resp(f'<NrTracks>{nr}</NrTracks><MediaDuration>NOT_IMPLEMENTED</MediaDuration><CurrentURI>{xesc(uri)}</CurrentURI><CurrentURIMetaData>{xesc(s["meta"])}</CurrentURIMetaData><NextURI></NextURI><NextURIMetaData></NextURIMetaData><PlayMedium>NETWORK</PlayMedium>')
                if action == 'GetCurrentTransportActions':
                    q = s['uri'].startswith('x-rincon-queue:')
                    return resp(f'<Actions>{"Set, Stop, Pause, Play, X_DLNA_SeekTime, Next, Previous, X_DLNA_SeekTrackNr" if q else "Set, Stop, Play"}</Actions>')
                if action in ('Play', 'Pause', 'Stop', 'Next', 'Previous', 'Seek', 'SetPlayMode', 'ConfigureSleepTimer', 'SetCrossfadeMode', 'RemoveAllTracksFromQueue') and member:
                    return fault(800)
                if action == 'Play':
                    if 'dead' in s['uri'] or not s['uri'] or (s['uri'].startswith('x-rincon-queue:') and not s['queue']): return fault(701)
                    s['state'] = 'PLAYING'; return resp()
                if action == 'Pause':
                    if s['state'] != 'PLAYING': return fault(701)
                    s['state'] = 'PAUSED_PLAYBACK'; return resp()
                if action == 'Stop': s['state'] = 'STOPPED'; return resp()
                if action in ('Next', 'Previous'):
                    if not s['uri'].startswith('x-rincon-queue:'): return fault(701)
                    s['track'] = max(1, min(len(s['queue']), s['track'] + (1 if action == 'Next' else -1))); return resp()
                if action == 'Seek':
                    unit, target = val('Unit'), val('Target')
                    if unit == 'TRACK_NR':
                        if not s['uri'].startswith('x-rincon-queue:') or not (1 <= int(target or 0) <= len(s['queue'])): return fault(711)
                        s['track'] = int(target)
                    else: s['rel'] = target
                    return resp()
                if action == 'SetAVTransportURI':
                    uri = val('CurrentURI')
                    if uri.startswith('x-rincon:'): s['coord'] = uri.split(':', 1)[1]
                    else:
                        s['coord'] = uuids[ip]; s['uri'] = uri; s['meta'] = val('CurrentURIMetaData'); s['state'] = 'STOPPED'
                    return resp()
                if action == 'BecomeCoordinatorOfStandaloneGroup': s['coord'] = uuids[ip]; s['state'] = 'STOPPED'; return resp()
                if action == 'GetTransportSettings': return resp(f'<PlayMode>{s["mode"]}</PlayMode><RecQualityMode>NOT_IMPLEMENTED</RecQualityMode>')
                if action == 'SetPlayMode':
                    if not s['uri'].startswith('x-rincon-queue:'): return fault(712)
                    s['mode'] = val('NewPlayMode'); return resp()
                if action == 'GetCrossfadeMode': return resp(f'<CrossfadeMode>{s["xfade"]}</CrossfadeMode>')
                if action == 'SetCrossfadeMode': s['xfade'] = int(val('CrossfadeMode') or 0); return resp()
                if action == 'ConfigureSleepTimer': s['sleep'] = val('NewSleepTimerDuration'); s['last_ConfigureSleepTimer'] = body[-300:]; return resp()
                if action == 'GetRemainingSleepTimerDuration': return resp(f'<RemainingSleepTimerDuration>{s["sleep"]}</RemainingSleepTimerDuration><CurrentSleepTimerGeneration>1</CurrentSleepTimerGeneration>')
                if action == 'RemoveAllTracksFromQueue':
                    if not s['queue']: return fault(804)
                    s['queue'] = []; s['track'] = 1; return resp()
                if action == 'AddURIToQueue':
                    uri = val('EnqueuedURI')
                    many = 'container' in uri or 'savedqueues' in uri
                    added = [track(10 + i, f'{"Playlist" if many else "Track"} item {i + 1}', 'Various', 'Sim') for i in range(3 if many else 1)]
                    first = len(s['queue']) + 1; s['queue'] += added
                    return resp(f'<FirstTrackNumberEnqueued>{first}</FirstTrackNumberEnqueued><NumTracksAdded>{len(added)}</NumTracksAdded><NewQueueLength>{len(s["queue"])}</NewQueueLength>')
                if action == 'RemoveTrackFromQueue':
                    m = re.match(r'Q:0/(\d+)$', val('ObjectID'))
                    if not m or not (1 <= int(m.group(1)) <= len(s['queue'])): return fault(701)
                    del s['queue'][int(m.group(1)) - 1]; s['track'] = max(1, min(s['track'], len(s['queue']) or 1)); return resp()
                # ---- RenderingControl / GroupRenderingControl
                if action == 'GetVolume': return resp(f'<CurrentVolume>{s["vol"]}</CurrentVolume>')
                if action == 'SetVolume': s['vol'] = int(val('DesiredVolume') or 0); return resp()
                if action == 'GetMute': return resp(f'<CurrentMute>{s["mute"]}</CurrentMute>')
                if action == 'SetMute': s['mute'] = int(val('DesiredMute') or 0); return resp()
                if action == 'SnapshotGroupVolume': return resp()
                if action == 'GetGroupVolume': return resp(f'<CurrentVolume>{round(sum(st[m]["vol"] for m in group) / len(group))}</CurrentVolume>')
                if action in ('SetGroupVolume', 'SetRelativeGroupVolume'):
                    cur = round(sum(st[m]['vol'] for m in group) / len(group))
                    want = int(val('DesiredVolume') or 0) if action == 'SetGroupVolume' else cur + int(val('Adjustment') or 0)
                    for m in group: st[m]['vol'] = max(0, min(100, st[m]['vol'] + want - cur))
                    return resp(f'<NewVolume>{max(0, min(100, want))}</NewVolume>' if action == 'SetRelativeGroupVolume' else '')
                if action == 'GetGroupMute': return resp(f'<CurrentMute>{int(all(st[m]["mute"] for m in group))}</CurrentMute>')
                if action == 'SetGroupMute':
                    for m in group: st[m]['mute'] = int(val('DesiredMute') or 0)
                    return resp()
                if action in ('SetBass', 'SetTreble', 'SetLoudness'):
                    s[action[3:].lower()] = int(val('Desired' + action[3:]) or 0); return resp()
                if action == 'GetBass': return resp(f'<CurrentBass>{s.get("bass", 0)}</CurrentBass>')
                if action == 'GetTreble': return resp(f'<CurrentTreble>{s.get("treble", 0)}</CurrentTreble>')
                if action == 'GetLoudness': return resp(f'<CurrentLoudness>{s.get("loudness", 1)}</CurrentLoudness>')
                if action in ('SetEQ', 'GetEQ'):
                    t = val('EQType')
                    if models[ip] != 'Sonos Arc': return fault(402)  # only soundbars have night/speech/surround levels
                    if action == 'SetEQ': s['eq'][t] = int(val('DesiredValue') or 0); s['last_SetEQ'] = body[-300:]; return resp()
                    return resp(f'<CurrentValue>{s["eq"].get(t, 0)}</CurrentValue>')
                # ---- DeviceProperties
                if action == 'SetLEDState': s['led'] = val('DesiredLEDState'); return resp()
                if action == 'GetLEDState': return resp(f'<CurrentLEDState>{s["led"]}</CurrentLEDState>')
                if action == 'SetButtonLockState': s['lock'] = val('DesiredButtonLockState'); return resp()
                if action == 'GetButtonLockState': return resp(f'<CurrentButtonLockState>{s["lock"]}</CurrentButtonLockState>')
                # ---- ContentDirectory
                if action == 'Browse':
                    oid = val('ObjectID')
                    if oid == 'FV:2':
                        items = ('<DIDL-Lite><item id="FV:2/1"><dc:title>Triple J</dc:title><res>x-sonosapi-stream:s25065?sid=254</res><r:resMD>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</r:resMD></item>'
                                 '<item id="FV:2/2"><dc:title>Chill Mix</dc:title><res>x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a1</res></item></DIDL-Lite>')
                        return resp(f'<Result>{xesc(items)}</Result><NumberReturned>2</NumberReturned><TotalMatches>2</TotalMatches>')
                    if oid == 'SQ:':
                        items = ('<DIDL-Lite><container id="SQ:3" parentID="SQ:" restricted="true"><dc:title>Dinner &amp; Drinks</dc:title><res protocolInfo="file:*:audio/mpegurl:*">file:///jffs/settings/savedqueues.rsq#3</res><upnp:class>object.container.playlistContainer</upnp:class></container>'
                                 '<container id="SQ:7" parentID="SQ:" restricted="true"><dc:title>Sunday</dc:title><res protocolInfo="file:*:audio/mpegurl:*">file:///jffs/settings/savedqueues.rsq#7</res><upnp:class>object.container.playlistContainer</upnp:class></container></DIDL-Lite>')
                        return resp(f'<Result>{xesc(items)}</Result><NumberReturned>2</NumberReturned><TotalMatches>2</TotalMatches>')
                    if oid == 'Q:0':
                        start, count = int(val('StartingIndex') or 0), int(val('RequestedCount') or 100)
                        page = s['queue'][start:start + count]
                        items = '<DIDL-Lite>' + ''.join(re.sub(r'^<DIDL-Lite[^>]*>|</DIDL-Lite>$', '', didl(t, f'Q:0/{start + i + 1}', 'Q:0')) for i, t in enumerate(page)) + '</DIDL-Lite>'
                        return resp(f'<Result>{xesc(items)}</Result><NumberReturned>{len(page)}</NumberReturned><TotalMatches>{len(s["queue"])}</TotalMatches>')
                    return fault(701)
                # ---- AlarmClock
                if action == 'ListAlarms':
                    x = '<Alarms>' + ''.join('<Alarm ' + ' '.join(f'{k}="{xesc(v, {chr(34): "&quot;"})}"' for k, v in a.items()) + '/>' for a in alarms.values()) + '</Alarms>'
                    return resp(f'<CurrentAlarmList>{xesc(x)}</CurrentAlarmList><CurrentAlarmListVersion>{uuids[ips[0]]}:7</CurrentAlarmListVersion>')
                if action == 'UpdateAlarm':
                    a = alarms.get(val('ID'))
                    if not a: return fault(801)
                    a.update({'StartTime': val('StartLocalTime'), 'Duration': val('Duration'), 'Recurrence': val('Recurrence'), 'Enabled': val('Enabled'), 'RoomUUID': val('RoomUUID'),
                              'ProgramURI': val('ProgramURI'), 'ProgramMetaData': val('ProgramMetaData'), 'PlayMode': val('PlayMode'), 'Volume': val('Volume'), 'IncludeLinkedZones': val('IncludeLinkedZones')})
                    log('sonos.alarm', ip=ip, alarm=a); return resp()
                return fault(401)
        return H
    for ip in ips:
        threading.Thread(target=ThreadingHTTP((ip, 1400), make(ip)).serve_forever, daemon=True).start()

# --------------------------------------------------------------------------- ADB (minimal adbd)
A_CNXN, A_OPEN, A_OKAY, A_CLSE, A_WRTE, A_AUTH = 0x4e584e43, 0x4e45504f, 0x59414b4f, 0x45534c43, 0x45545257, 0x48545541

def png_bytes(w=1280, h=720):
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            row += bytes([(x * 255 // w), (y * 255 // h), 0x80 if (x // 80 + y // 80) % 2 else 0x30])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')

PNG = None

class FakeAndroid:
    def __init__(self, ip, n):
        self.ip, self.n = ip, n
        self.disabled = set()
        self.cleared = []
        self.packages = {
            'com.netflix.ninja': ('/data/app/~~a==/com.netflix.ninja-1==/base.apk', 123, '8.120.0'),
            'com.google.android.youtube.tv': ('/data/app/~~b==/com.google.android.youtube.tv-2==/base.apk', 45, '4.10.1'),
            'com.spotify.tv.android': ('/data/app/~~c==/com.spotify.tv.android-3==/base.apk', 99, '1.80.0'),
            'au.com.stan.and': ('/data/app/~~d==/au.com.stan.and-4==/base.apk', 7, '4.21'),
            'com.google.android.katniss': ('/system/priv-app/Katniss/Katniss.apk', 10, '3.1'),
            'com.google.android.tvlauncher': ('/system/priv-app/TVLauncher/TVLauncher.apk', 1, '1.0'),
            'com.nvidia.tegrazone3': ('/system/app/TegraZone/TegraZone.apk', 5, '5.0'),
            'com.android.vending': ('/system/priv-app/Phonesky/Phonesky.apk', 8, '38.0'),
        }
        self.awake = True
        self.home = 'com.google.android.tvlauncher'
        self.appops = {}
        self.files_sha = {}
        self.files_size = {}
        self.scrcpy = None
        self.launcher_assets = {}   # sha → bytes held by the launcher's asset provider (v2 only)
        self.launcher_cfg_json = None

    LAUNCHER = 'au.supercluster.screens.launcher'
    ASSETS = 'content://au.supercluster.screens.launcher.assets/'

    def launcher_version(self):
        p = self.packages.get(self.LAUNCHER)
        return p[2] if p else None

    def launcher_v2(self):
        v = self.launcher_version()
        return bool(v) and int(v.split('.')[0]) >= 2

    def launcher_missing(self):
        cfg = self.launcher_cfg_json or {}
        home = cfg.get('home') or {}
        refs = []
        if home.get('wallpaper'): refs.append(home['wallpaper'].get('asset'))
        refs += [t.get('asset') for t in (home.get('tiles') or {}).values() if t.get('asset')]
        return [r for r in dict.fromkeys(refs) if r and r not in self.launcher_assets]

    def shell(self, cmd):
        """Very small emulation of the commands the Screens Android driver sends."""
        out = []
        third = [p for p, v in self.packages.items() if v[0].startswith('/data/')]
        if '@@manufacturer' in cmd:
            out += ['@@manufacturer=NVIDIA', f'@@model=SHIELD Android TV', '@@release=11', '@@sdk=30', f'@@serial=SIM{self.n:04d}', '@@build=SR1.230125.001', f'@@device_name=Shield {self.n}',
                    '@@wm=Physical size: 1920x1080 ', f'@@wake=mWakefulness={"Awake" if self.awake else "Asleep"}', '@@resumed=  mResumedActivity: ActivityRecord{1a2b u0 com.netflix.ninja/.MainActivity t42}',
                    '@@pdns_mode=opportunistic', '@@pdns_host=null', f'@@mac=00:04:4b:00:00:{self.n:02x}', '@@uptime=123456']
        elif '@@3P' in cmd:
            out.append('@@3P'); out += [f'package:{p}' for p in third]
            out.append('@@ALL'); out += [f'package:{v[0]}={p} versionCode:{v[1]}' for p, v in self.packages.items()]
            out.append('@@DIS'); out += [f'package:{p}' for p in self.disabled]
            out.append('@@MIC'); out += ['com.google.android.katniss', 'com.spotify.tv.android']
            out.append('@@CAM')
            out.append('@@VER'); out += [f'{p} {self.packages[p][2]}' for p in third]
            out.append('@@END')
        elif cmd.startswith('content write --uri ' + self.ASSETS) or cmd.startswith('content query --uri ' + self.ASSETS) or cmd.startswith('content delete --uri ' + self.ASSETS):
            # The launcher's asset ContentProvider (2.x only; DUMP-protected, so only the adb shell gets here).
            if not self.launcher_v2():
                out.append(f'Error while accessing provider:{self.ASSETS[10:-1]}')
                out.append(f'java.lang.IllegalArgumentException: Unknown authority {self.ASSETS[10:-1]}')
                if 'echo "@@rc=$?"' in cmd: out.append('@@rc=1')
            elif cmd.startswith('content query'):
                rows = [f'Row: {i} sha256={sha}, bytes={n}' for i, (sha, n) in enumerate(self.launcher_assets.items())]
                out += rows or ['No result found.']
            elif cmd.startswith('content delete'):
                m = re.match(r'content delete --uri \S+/([0-9a-f]{64})\.(jpg|png|webp)', cmd)
                if m: self.launcher_assets.pop(m.group(1), None)
            else:
                m = re.match(r'content write --uri \S+/([0-9a-f]{64})\.(jpg|png|webp) < (\S+)(?: 2>&1)?(.*)$', cmd)
                rc = 1
                if not m:
                    out.append('java.lang.IllegalArgumentException: bad asset name')
                elif self.files_sha.get(m.group(3)) != m.group(1):
                    out.append(f'java.lang.SecurityException: sha256 mismatch for {m.group(1)}')
                else:
                    self.launcher_assets[m.group(1)] = self.files_size.get(m.group(3), 0); rc = 0
                log('android.content_write', ip=self.ip, sha=m.group(1) if m else None, ok=rc == 0)
                rest = m.group(4) if m else ''
                if '@@rc=$?' in rest: out.append(f'@@rc={rc}')
                rm = re.search(r'rm -f (\S+)', rest)
                if rm: self.files_sha.pop(rm.group(1), None)
        elif 'au.supercluster.screens.launcher.CONFIG' in cmd:
            m = re.search(r'--es config_b64 (\S+)', cmd)
            try:
                raw = base64.b64decode(m.group(1)); cfg = json.loads(raw)
                v = cfg.get('v')
                if len(raw) > 48 * 1024: raise ValueError(f'config too large (max {48 * 1024} bytes)')
                if v != 1 and not (self.launcher_v2() and v == 2): raise ValueError(f'v: unsupported config version {v}')
                self.launcher_cfg = hashlib.sha256(raw).hexdigest()
                self.launcher_cfg_json = cfg
                log('android.launcher_config', ip=self.ip, v=v, sha=self.launcher_cfg, rows=len((cfg.get('home') or {}).get('rows') or []))
                out.append(f'Broadcasting: Intent {{ act=au.supercluster.screens.launcher.CONFIG }}')
                out.append(f'Broadcast completed: result=1, data="ok:{self.launcher_cfg}"')
            except Exception as e:
                out.append(f'Broadcast completed: result=0, data="error:{e}"')
        elif 'au.supercluster.screens.launcher.STATUS' in cmd:
            if self.LAUNCHER in self.packages:
                st = {'version': self.launcher_version(), 'config_sha': getattr(self, 'launcher_cfg', None), 'is_home': self.home == self.LAUNCHER}
                if self.launcher_v2():
                    st.update({'version_code': self.packages[self.LAUNCHER][1], 'config_v': (self.launcher_cfg_json or {}).get('v'),
                               'assets': list(self.launcher_assets), 'missing_assets': self.launcher_missing(), 'last_error': None})
                st = json.dumps(st).replace('"', '\\"')
                out.append(f'Broadcast completed: result=1, data="status:{st}"')
            else:
                out.append('Broadcast completed: result=0')
        elif cmd.startswith('sha256sum /data/local/tmp/'):
            path = cmd.split()[1]
            out.append(self.files_sha.get(path, ''))
        elif 'com.genymobile.scrcpy.Server' in cmd:
            m = re.search(r'scid=([0-9a-f]{8})', cmd)
            jar = re.search(r'CLASSPATH=(\S+)', cmd).group(1)
            if m and jar in self.files_sha:
                self.scrcpy = {'scid': m.group(1), 'conns': 0, 'started': time.time()}
                log('android.scrcpy_start', ip=self.ip, scid=m.group(1), cmd=cmd[:200])
        elif cmd.startswith('dumpsys appops'):
            out += ['  Uid u0a12:', '    Package com.google.android.katniss:', '      RECORD_AUDIO (allow):', '        Access: [top-s] 2026-11-26 09:58:12.345 (-2m14s345ms) duration=+3s']
        else:
            for part in [p.strip() for p in re.split(r';|&&|\|\|', cmd) if p.strip()]:
                m = re.match(r'pm clear (\S+)', part)
                if m: self.cleared.append(m.group(1)); out.append('Success'); continue
                m = re.match(r'pm disable-user --user 0 (\S+)', part)
                if m: self.disabled.add(m.group(1)); out.append(f'Package {m.group(1)} new state: disabled-user'); continue
                m = re.match(r'pm (revoke|grant) (\S+) (\S+)', part)
                if m: continue
                m = re.match(r'cmd appops set (\S+) (\S+) (\S+)', part)
                if m: self.appops[(m.group(1), m.group(2))] = m.group(3); continue
                m = re.match(r'echo "@@mode=\$\(cmd appops get (\S+) (\S+).*', part)
                if m: out.append('@@mode=' + m.group(2) + ': ' + self.appops.get((m.group(1), m.group(2)), 'allow')); continue
                m = re.match(r'pm enable (\S+)', part)
                if m: self.disabled.discard(m.group(1)); out.append(f'Package {m.group(1)} new state: enabled'); continue
                if part.startswith('pm list packages'):
                    flt = part.split()[-1] if len(part.split()) > 3 and '.' in part.split()[-1] else None
                    lst = third if ' -3' in part else [p for p in self.packages if not (' -e' in part and p in self.disabled)]
                    out += [f'package:{p}' for p in lst if not flt or p == flt]; continue
                if part.startswith('cmd media_session volume') and '--get' in part: out.append('volume is 7 in range [0..15]'); continue
                if part.startswith('input keyevent'):
                    code = part.split()[-1]
                    if code == '223': self.awake = False
                    if code == '224': self.awake = True
                    continue
                if part.startswith('monkey'): out.append('Events injected: 1'); continue
                m = re.match(r'cmd package set-home-activity (\S+)/', part)
                if m: self.home = m.group(1); out.append('Success'); continue
                if part.startswith('am start'): out.append('Starting: Intent { cmp=' + part.split('-n ')[-1] + ' }'); continue
                if part.startswith('ping'): continue
                m = re.match(r'echo\s+"?([^"$]*)\$\?"?', part)
                if m: out.append(f'{m.group(1)}0'); continue
                m = re.match(r'echo\s+(.*)$', part)
                if m: out.append(m.group(1).strip('"\'')); continue
        log('android.shell', ip=self.ip, cmd=cmd[:300])
        return ('\n'.join(out) + ('\n' if out else '')).encode()

SAMPLE = None

def scrcpy_video(conn, lid, streams, send):
    """Serve scrcpy v5 framing over the adb stream, looping the H.264 sample at its frame rate."""
    global SAMPLE
    if SAMPLE is None:
        here = os.path.dirname(os.path.abspath(__file__))
        SAMPLE = (open(os.path.join(here, 'sample.h264'), 'rb').read(), json.load(open(os.path.join(here, 'sample.json'))))
    data, idx = SAMPLE
    st = streams.get(lid)
    def out(b):
        # respect adb flow control: one WRTE in flight, wait for OKAY
        for i in range(0, len(b), 200000):
            if st['closed']: return False
            st['acked'].wait(5)
            if st['closed']: return False
            st['acked'].clear()
            send(conn, A_WRTE, lid, st['remote'], b[i:i + 200000])
        return True
    name = b'SHIELD Android TV'.ljust(64, b'\0')
    if not out(b'\0' + name + struct.pack('>I', 0x68323634) + struct.pack('>III', 0x80000000, idx['width'], idx['height'])): return
    t0 = time.time(); loop = 0
    while not st['closed']:
        for p in idx['packets']:
            payload = data[p['start']:p['end']]
            if p['type'] == 'config':
                hdr = struct.pack('>QI', 1 << 62, len(payload))
            else:
                pts = p['pts_us'] + loop * 3_000_000
                hdr = struct.pack('>QI', pts | ((1 << 61) if p['type'] == 'key' else 0), len(payload))
                delay = t0 + pts / 1e6 - time.time()
                if delay > 0: time.sleep(delay)
            if not out(hdr + payload): return
        loop += 1

def adbd(ip, dev):
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind((ip, 5555)); srv.listen(8)
    send_lock = threading.Lock()
    def send(conn, cmd, a0, a1, data=b''):
        with send_lock:
            conn.sendall(struct.pack('<6I', cmd, a0, a1, len(data), sum(data) & 0xffffffff, cmd ^ 0xffffffff) + data)
    def recv(conn):
        h = recv_exact(conn, 24)
        cmd, a0, a1, n, _, _ = struct.unpack('<6I', h)
        return cmd, a0, a1, recv_exact(conn, n) if n else b''
    def client(conn):
        next_id = [100]
        streams = {}  # local id -> state
        try:
            while True:
                cmd, a0, a1, data = recv(conn)
                if cmd == A_CNXN:
                    send(conn, A_CNXN, 0x01000001, 256 * 1024, f'device::ro.product.name=foster;ro.product.model=SHIELD Android TV;ro.product.device=foster;features=cmd,stat_v2\0'.encode())
                elif cmd == A_OPEN:
                    svc = data.rstrip(b'\0').decode(errors='replace')
                    lid = next_id[0]; next_id[0] += 1
                    send(conn, A_OKAY, lid, a0)
                    m = re.match(r"exec:cmd package '?install'?(?: \S+)*? -S (\d+)", svc)
                    if m:
                        streams[lid] = {'remote': a0, 'need': int(m.group(1)), 'got': 0, 'kind': 'install'}
                        log('android.install_start', ip=ip, size=int(m.group(1)))
                        continue
                    if svc == 'sync:':
                        streams[lid] = {'remote': a0, 'kind': 'sync', 'buf': b'', 'file': None, 'data': bytearray()}
                        continue
                    m2 = re.match(r'localabstract:scrcpy_([0-9a-f]{8})$', svc)
                    if m2:
                        sc = dev.scrcpy
                        if not sc or sc['scid'] != m2.group(1):
                            send(conn, A_CLSE, lid, a0); streams.pop(lid, None); continue
                        sc['conns'] += 1
                        if sc['conns'] == 1:
                            streams[lid] = {'remote': a0, 'kind': 'video', 'acked': threading.Event(), 'closed': False}
                            streams[lid]['acked'].set()
                            threading.Thread(target=scrcpy_video, args=(conn, lid, streams, send), daemon=True).start()
                        else:
                            streams[lid] = {'remote': a0, 'kind': 'control', 'got': bytearray()}
                        continue
                    if svc.startswith('shell:') or svc.startswith('exec:'):
                        c = svc.split(':', 1)[1]
                        if c.startswith('screencap'):
                            global PNG
                            if PNG is None: PNG = png_bytes()
                            payload = PNG
                            log('android.screencap', ip=ip)
                        else:
                            payload = dev.shell(c)
                        streams[lid] = {'remote': a0, 'out': [payload[i:i + 200000] for i in range(0, len(payload), 200000)], 'kind': 'out'}
                        pump(conn, lid, streams)
                    else:
                        send(conn, A_CLSE, lid, a0)
                elif cmd == A_OKAY:
                    if a1 in streams and streams[a1]['kind'] == 'out': pump(conn, a1, streams)
                    elif a1 in streams and streams[a1]['kind'] == 'video': streams[a1]['acked'].set()
                elif cmd == A_WRTE:
                    s = streams.get(a1)
                    send(conn, A_OKAY, a1, a0)
                    if s and s['kind'] == 'control':
                        s['got'] += data
                        log('android.scrcpy_control', ip=ip, hex=data.hex())
                        continue
                    if s and s['kind'] == 'sync':
                        s['buf'] += data
                        while len(s['buf']) >= 8:
                            tag = s['buf'][:4]; n = struct.unpack('<I', s['buf'][4:8])[0]
                            WITH_BODY = (b'STAT', b'STA2', b'LST2', b'SEND', b'DATA')
                            if tag in WITH_BODY and len(s['buf']) < 8 + n: break
                            body = s['buf'][8:8 + n] if tag in WITH_BODY else b''
                            s['buf'] = s['buf'][8 + (n if tag in WITH_BODY else 0):]
                            if tag == b'STAT':
                                send(conn, A_WRTE, a1, a0, b'STAT' + struct.pack('<III', 0, 0, 0))
                            elif tag in (b'STA2', b'LST2'):
                                # stat_v2: error=ENOENT, everything else zero (72 bytes incl. id)
                                send(conn, A_WRTE, a1, a0, tag + struct.pack('<IQQIIIIQqqq', 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
                            elif tag == b'SEND':
                                s['file'] = body.decode().split(',')[0]; s['data'] = bytearray()
                            elif tag == b'DATA':
                                s['data'] += body
                            elif tag == b'DONE':
                                dev.files_sha[s['file']] = hashlib.sha256(bytes(s['data'])).hexdigest()
                                dev.files_size[s['file']] = len(s['data'])
                                log('android.push', ip=ip, path=s['file'], size=len(s['data']))
                                send(conn, A_WRTE, a1, a0, b'OKAY' + struct.pack('<I', 0))
                            elif tag == b'QUIT':
                                send(conn, A_CLSE, a1, a0); streams.pop(a1, None); break
                            else:
                                break
                        continue
                    if s and s['kind'] == 'install':
                        s['got'] += len(data)
                        if len(s.setdefault('head', b'')) < 65536: s['head'] += data[:65536]
                        if s['got'] >= s['need']:
                            # Any install also "installs" the Screens Launcher: 2.0.0, or 1.0.0 when the APK carries the v1 marker.
                            v1 = b'SCREENS_LAUNCHER_V1' in s['head']
                            log('android.install_done', ip=ip, size=s['got'], launcher='1.0.0' if v1 else '2.0.0')
                            dev.packages['au.supercluster.screens.launcher'] = ('/data/app/~~l==/au.supercluster.screens.launcher-1==/base.apk', 10000 if v1 else 20000, '1.0.0' if v1 else '2.0.0')
                            if v1: dev.launcher_assets.clear()
                            s['kind'] = 'out'; s['out'] = [b'Success\n']
                            pump(conn, a1, streams)
                elif cmd == A_CLSE:
                    st_ = streams.pop(a1, None)
                    if st_ and st_.get('kind') == 'video':
                        st_['closed'] = True; st_['acked'].set()
                        log('android.scrcpy_video_closed', ip=ip)
        except Exception:
            pass
        finally:
            conn.close()
    def pump(conn, lid, streams):
        s = streams.get(lid)
        if not s: return
        if s['out']:
            send(conn, A_WRTE, lid, s['remote'], s['out'].pop(0))
        else:
            send(conn, A_CLSE, lid, s['remote']); streams.pop(lid, None)
    def accept():
        while True:
            c, _ = srv.accept(); threading.Thread(target=client, args=(c,), daemon=True).start()
    threading.Thread(target=accept, daemon=True).start()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--samsung', default=''); ap.add_argument('--sonos', default=''); ap.add_argument('--android', default='')
    ap.add_argument('--samsung9', default='', help='Tizen 9 behaviour (register frame)'); ap.add_argument('--samsung-deny', default='', help='Access Notification off')
    a = ap.parse_args()
    tmp = tempfile.mkdtemp()
    cert, key = os.path.join(tmp, 'c.pem'), os.path.join(tmp, 'k.pem')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=SmartViewSDK', '-days', '30'], check=True, capture_output=True)
    for ip in filter(None, a.samsung.split(',')): samsung(ip, cert, key)
    for ip in filter(None, a.samsung9.split(',')): samsung(ip, cert, key, 'tizen9')
    for ip in filter(None, a.samsung_deny.split(',')): samsung(ip, cert, key, 'deny')
    if a.sonos: sonos([x for x in a.sonos.split(',') if x])
    for i, ip in enumerate(filter(None, a.android.split(','))): adbd(ip, FakeAndroid(ip, i + 1))
    print('simulators running', flush=True)
    while True: time.sleep(3600)

if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Device simulators for end-to-end testing of Screens without real hardware.

  Samsung TV  : HTTP :8001 /api/v2/, WSS :8002 remote channel, UPnP :9197
  Sonos       : HTTP :1400 device description + SOAP (AVTransport, RenderingControl, ZoneGroupTopology)
  Android/ADB : TCP :5555 minimal adbd (CNXN without auth, shell:, exec:, streaming install)

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

def samsung(ip, certfile, keyfile):
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
            log('samsung.ws_connect', ip=ip, path=path)
            ws_send(conn, json.dumps({'event': 'ms.channel.connect', 'data': {'id': 'abc', 'token': '12345678', 'clients': []}}))
            while True:
                m = ws_recv(conn)
                if m is None: continue
                msg = json.loads(m)
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
    uuids = {ip: f'RINCON_SIM{ip.split(".")[-1]:0>3}01400' for ip in ips}
    names = {ip: n for ip, n in zip(ips, ['Living Room', 'Kitchen', 'Office', 'Patio'])}
    st = {ip: {'state': 'PLAYING' if i == 0 else 'STOPPED', 'vol': 25, 'mute': 0, 'coord': uuids[ip], 'led': 'On'} for i, ip in enumerate(ips)}
    def topology():
        groups = {}
        for ip in ips: groups.setdefault(st[ip]['coord'], []).append(ip)
        x = '<ZoneGroupState><ZoneGroups>'
        for coord, members in groups.items():
            x += f'<ZoneGroup Coordinator="{coord}" ID="{coord}:1">' + ''.join(f'<ZoneGroupMember UUID="{uuids[m]}" Location="http://{m}:1400/xml/device_description.xml" ZoneName="{names[m]}"/>' for m in members) + '</ZoneGroup>'
        x += '</ZoneGroups></ZoneGroupState>'
        return x.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    def make(ip):
        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def reply(self, body, code=200, ctype='text/xml'):
                b = body.encode(); self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
            def do_GET(self):
                if self.path == '/xml/device_description.xml':
                    self.reply(f'<?xml version="1.0"?><root><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>{ip} - Sonos One</friendlyName><manufacturer>Sonos, Inc.</manufacturer><modelNumber>S18</modelNumber><modelName>Sonos One</modelName><softwareVersion>83.1-61240</softwareVersion><hardwareVersion>1.20.1.6-2.1</hardwareVersion><serialNum>48-A6-B8-00-00-{ip.split(".")[-1]}:A</serialNum><UDN>uuid:{uuids[ip]}</UDN><roomName>{names[ip]}</roomName><displayVersion>16.4</displayVersion><apiVersion>1.40.0</apiVersion></device></root>')
                else: self.reply('', 404)
            def do_POST(self):
                n = int(self.headers.get('content-length', 0)); body = self.rfile.read(n).decode()
                action = (self.headers.get('soapaction') or '').strip('"').split('#')[-1]
                log('sonos.soap', ip=ip, action=action)
                s = st[ip]
                def resp(inner=''):
                    svc = re.search(r'service:(\w+):1', self.headers.get('soapaction') or '').group(1)
                    return self.reply(f'<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:{action}Response xmlns:u="urn:schemas-upnp-org:service:{svc}:1">{inner}</u:{action}Response></s:Body></s:Envelope>')
                val = lambda tag: (re.search(f'<{tag}>(.*?)</{tag}>', body) or [None, ''])[1]
                if action == 'GetZoneGroupState': return resp(f'<ZoneGroupState>{topology()}</ZoneGroupState>')
                if action == 'GetTransportInfo': return resp(f'<CurrentTransportState>{s["state"]}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>')
                if action == 'GetPositionInfo':
                    didl = '&lt;DIDL-Lite&gt;&lt;item&gt;&lt;dc:title&gt;Weightless&lt;/dc:title&gt;&lt;dc:creator&gt;Marconi Union&lt;/dc:creator&gt;&lt;upnp:album&gt;Ambient&lt;/upnp:album&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;'
                    return resp(f'<Track>1</Track><TrackDuration>0:08:00</TrackDuration><TrackMetaData>{didl}</TrackMetaData><RelTime>0:01:23</RelTime>')
                if action == 'GetVolume': return resp(f'<CurrentVolume>{s["vol"]}</CurrentVolume>')
                if action == 'SetVolume': s['vol'] = int(val('DesiredVolume') or 0); return resp()
                if action == 'GetMute': return resp(f'<CurrentMute>{s["mute"]}</CurrentMute>')
                if action == 'SetMute': s['mute'] = int(val('DesiredMute') or 0); return resp()
                if action in ('Play', 'Pause', 'Stop', 'Next', 'Previous'):
                    s['state'] = {'Play': 'PLAYING', 'Pause': 'PAUSED_PLAYBACK', 'Stop': 'STOPPED'}.get(action, s['state']); return resp()
                if action == 'SetAVTransportURI':
                    uri = val('CurrentURI');
                    if uri.startswith('x-rincon:'): s['coord'] = uri.split(':', 1)[1]
                    return resp()
                if action == 'BecomeCoordinatorOfStandaloneGroup': s['coord'] = uuids[ip]; return resp()
                if action == 'SetLEDState': s['led'] = val('DesiredLEDState'); return resp()
                return self.reply('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>401</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>', 500)
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
        elif 'au.supercluster.screens.launcher.CONFIG' in cmd:
            m = re.search(r'--es config_b64 (\S+)', cmd)
            try:
                cfg = base64.b64decode(m.group(1)); json.loads(cfg)
                self.launcher_cfg = hashlib.sha256(cfg).hexdigest()
                out.append(f'Broadcasting: Intent {{ act=au.supercluster.screens.launcher.CONFIG }}')
                out.append(f'Broadcast completed: result=1, data="ok:{self.launcher_cfg}"')
            except Exception as e:
                out.append(f'Broadcast completed: result=0, data="error:{e}"')
        elif 'au.supercluster.screens.launcher.STATUS' in cmd:
            if 'au.supercluster.screens.launcher' in self.packages:
                st = json.dumps({'version': '1.0.0', 'config_sha': getattr(self, 'launcher_cfg', None), 'is_home': self.home == 'au.supercluster.screens.launcher'}).replace('"', '\\"')
                out.append(f'Broadcast completed: result=1, data="status:{st}"')
            else:
                out.append('Broadcast completed: result=0')
        elif cmd.startswith('dumpsys appops'):
            out += ['  Uid u0a12:', '    Package com.google.android.katniss:', '      RECORD_AUDIO (allow):', '        Access: [top-s] 2026-11-26 09:58:12.345 (-2m14s345ms) duration=+3s']
        else:
            for part in [p.strip() for p in re.split(r';|&&|\|\|', cmd) if p.strip()]:
                m = re.match(r'pm clear (\S+)', part)
                if m: self.cleared.append(m.group(1)); out.append('Success'); continue
                m = re.match(r'pm disable-user --user 0 (\S+)', part)
                if m: self.disabled.add(m.group(1)); out.append(f'Package {m.group(1)} new state: disabled-user'); continue
                m = re.match(r'pm enable (\S+)', part)
                if m: self.disabled.discard(m.group(1)); out.append(f'Package {m.group(1)} new state: enabled'); continue
                if part.startswith('pm list packages'):
                    flt = part.split()[-1] if len(part.split()) > 3 and '.' in part.split()[-1] else None
                    lst = third if ' -3' in part else list(self.packages)
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

def adbd(ip, dev):
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind((ip, 5555)); srv.listen(8)
    def send(conn, cmd, a0, a1, data=b''):
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
                    m = re.match(r"exec:cmd package 'install' -S (\d+)", svc) or re.match(r'exec:cmd package install -S (\d+)', svc)
                    if m:
                        streams[lid] = {'remote': a0, 'need': int(m.group(1)), 'got': 0, 'kind': 'install'}
                        log('android.install_start', ip=ip, size=int(m.group(1)))
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
                elif cmd == A_WRTE:
                    s = streams.get(a1)
                    send(conn, A_OKAY, a1, a0)
                    if s and s['kind'] == 'install':
                        s['got'] += len(data)
                        if s['got'] >= s['need']:
                            log('android.install_done', ip=ip, size=s['got'])
                            dev.packages.setdefault('au.supercluster.screens.launcher', ('/data/app/~~l==/au.supercluster.screens.launcher-1==/base.apk', 1, '1.0.0'))
                            s['kind'] = 'out'; s['out'] = [b'Success\n']
                            pump(conn, a1, streams)
                elif cmd == A_CLSE:
                    streams.pop(a1, None)
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
    a = ap.parse_args()
    tmp = tempfile.mkdtemp()
    cert, key = os.path.join(tmp, 'c.pem'), os.path.join(tmp, 'k.pem')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=SmartViewSDK', '-days', '30'], check=True, capture_output=True)
    for ip in filter(None, a.samsung.split(',')): samsung(ip, cert, key)
    if a.sonos: sonos([x for x in a.sonos.split(',') if x])
    for i, ip in enumerate(filter(None, a.android.split(','))): adbd(ip, FakeAndroid(ip, i + 1))
    print('simulators running', flush=True)
    while True: time.sleep(3600)

if __name__ == '__main__':
    main()

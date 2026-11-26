#!/usr/bin/env python3
"""
End-to-end test: local central (wrangler dev) + real gateway binary + device simulators.

Prereqs (see README):
  - wrangler dev on http://127.0.0.1:8787 (central/wrangler.e2e.jsonc, DEV_AUTH=1)
  - tools/sim/sim.py running with --samsung 10.99.0.20 --sonos 10.99.0.30,10.99.0.31 --android 10.99.0.10,10.99.0.11
  - gateway binary built (gateway/dist/screens-gateway-linux-amd64)
Run as root (DNS port 53, raw multicast).
"""
import hashlib, http.server, json, os, random, shutil, signal, socket, struct, subprocess, sys, tempfile, threading, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BASE = os.environ.get('CENTRAL', 'http://127.0.0.1:8787')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SIM_LOG = os.path.join(ROOT, 'tools', 'sim', 'sim.log')
BIN = os.path.join(ROOT, 'gateway', 'dist', 'screens-gateway-linux-amd64')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
results = []

def api(method, path, body=None, raw=False, timeout=120):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json'})
    try:
        with opener.open(req, timeout=timeout) as r:
            data = r.read()
            return data if raw else json.loads(data or b'null')
    except urllib.error.HTTPError as e:
        raise AssertionError(f'{method} {path} -> {e.code}: {e.read().decode()[:400]}')

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('  PASS ' if cond else '  FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''), flush=True)

def wait(fn, timeout=30, every=1.0):
    t = time.time()
    while time.time() - t < timeout:
        try:
            v = fn()
            if v: return v
        except Exception:
            pass
        time.sleep(every)
    return None

def sim_events(kind, since):
    out = []
    if not os.path.exists(SIM_LOG): return out
    for line in open(SIM_LOG):
        e = json.loads(line)
        if e['kind'] == kind and e['ts'] >= since: out.append(e)
    return out

NETNS = os.environ.get('SIM_NETNS', 'simlan')

def dns_query(name, src_ip, server, qtype=1, ns=None):
    """Send a DNS query from a simulated device's IP (inside the sim network namespace)."""
    code = (
        "import random,socket,struct,sys,json\n"
        "name,src,server=sys.argv[1:4]\n"
        "q=struct.pack('>HHHHHH',random.randint(0,65535),0x0100,1,0,0,0)+b''.join(bytes([len(p)])+p.encode() for p in name.split('.'))+b'\\0'+struct.pack('>HH',1,1)\n"
        "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(4);s.bind((src,0));s.sendto(q,(server,53))\n"
        "d,_=s.recvfrom(4096);an=struct.unpack('>H',d[6:8])[0]\n"
        "ips=[socket.inet_ntoa(d[-4:])] if an and d[-6:-4]==b'\\x00\\x04' else []\n"
        "print(json.dumps([d[3]&15,ips]))\n"
    )
    out = subprocess.run(['ip', 'netns', 'exec', ns or NETNS, 'python3', '-c', code, name, src_ip, server], capture_output=True, text=True, timeout=10)
    if out.returncode != 0: raise RuntimeError(out.stderr[-300:])
    rcode, ips = json.loads(out.stdout)
    return rcode, ips

def live_ws(path):
    """Minimal WebSocket client for the dashboard live feed (server frames are unmasked)."""
    import base64 as _b64
    host, port = BASE.split('//')[1].split(':')
    sock = socket.create_connection((host, int(port)), timeout=10)
    key = _b64.b64encode(os.urandom(16)).decode()
    sock.sendall(f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())
    head = b''
    while b'\r\n\r\n' not in head: head += sock.recv(1)
    if b' 101 ' not in head.split(b'\r\n')[0]: raise AssertionError(head[:200])
    buf = b''
    def recv_msg(timeout=10):
        nonlocal buf
        sock.settimeout(timeout)
        def need(n):
            nonlocal buf
            while len(buf) < n: buf += sock.recv(65536)
        need(2); b1, b2 = buf[0], buf[1]; n = b2 & 0x7f; off = 2
        if n == 126: need(4); n = struct.unpack('>H', buf[2:4])[0]; off = 4
        elif n == 127: need(10); n = struct.unpack('>Q', buf[2:10])[0]; off = 10
        need(off + n); data = buf[off:off + n]; buf = buf[off + n:]
        return data.decode()
    return sock, recv_msg

MDNS_PY = r"""
import socket, struct, sys, time, json
def name(n): return b''.join(bytes([len(p)]) + p.encode() for p in n.rstrip('.').split('.')) + b'\0'
def rr(owner, typ, rdata, ttl=120): return name(owner) + struct.pack('>HHIH', typ, 0x8001, ttl, len(rdata)) + rdata
mode = sys.argv[1]
if mode == 'listen':
    ip, secs = sys.argv[2], float(sys.argv[3])
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('', 5353)); s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, socket.inet_aton('224.0.0.251') + socket.inet_aton(ip))
    s.settimeout(0.5); seen = []; end = time.time() + secs
    while time.time() < end:
        try: d, a = s.recvfrom(9000); seen.append({'from': a[0], 'hex': d.hex()})
        except socket.timeout: pass
    print(json.dumps(seen))
else:
    ip, svc, inst, host, port = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], int(sys.argv[6])
    full = f'{inst}.{svc}.local'
    ans = rr(f'{svc}.local', 12, name(full)) + rr(full, 33, struct.pack('>HHH', 0, 0, port) + name(host)) + rr(host, 1, socket.inet_aton(ip))
    pkt = struct.pack('>HHHHHH', 0, 0x8400, 0, 3, 0, 0) + ans
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(ip))
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255); s.bind((ip, 5353))
    for _ in range(3): s.sendto(pkt, ('224.0.0.251', 5353)); time.sleep(0.3)
"""

def ws_client(path):
    """Tiny WebSocket client: returns (recv() -> (opcode, bytes), send(bytes|str), close())."""
    import base64 as _b64
    host, port = BASE.split('//')[1].split(':')
    sock = socket.create_connection((host, int(port)), timeout=10)
    key = _b64.b64encode(os.urandom(16)).decode()
    sock.sendall(f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())
    head = b''
    while b'\r\n\r\n' not in head: head += sock.recv(1)
    if b' 101 ' not in head.split(b'\r\n')[0]: raise AssertionError(head[:300])
    buf = bytearray()
    def need(n):
        while len(buf) < n:
            c = sock.recv(65536)
            if not c: raise ConnectionError('closed')
            buf.extend(c)
    def recv(timeout=10):
        sock.settimeout(timeout)
        need(2); op = buf[0] & 0x0f; n = buf[1] & 0x7f; off = 2
        if n == 126: need(4); n = struct.unpack('>H', bytes(buf[2:4]))[0]; off = 4
        elif n == 127: need(10); n = struct.unpack('>Q', bytes(buf[2:10]))[0]; off = 10
        need(off + n); data = bytes(buf[off:off + n]); del buf[:off + n]
        return op, data
    def send(payload):
        op = 0x1 if isinstance(payload, str) else 0x2
        data = payload.encode() if isinstance(payload, str) else payload
        mask = os.urandom(4); n = len(data)
        hdr = bytes([0x80 | op]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack('>H', n))
        sock.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
    def close():
        try: sock.sendall(bytes([0x88, 0x82]) + b'\0\0\0\0' + struct.pack('>H', 1000))
        except Exception: pass
        sock.close()
    return recv, send, close

# --------------------------------------------------------------------------- app updates: a stand-in for GitHub
# central/wrangler.e2e.jsonc points GITHUB_API_BASE here, so update sources never touch the real GitHub in tests.
GH_PORT = 8791
UPD_FIX = os.path.join(ROOT, 'central', 'test', 'fixtures', 'updates')
GH = {'release': None, 'if_none_match': [], 'hits': []}

def fx(name):
    with open(os.path.join(UPD_FIX, name), 'rb') as f: return f.read()

def sha256(b): return hashlib.sha256(b).hexdigest()

class FakeGitHub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        GH['hits'].append(self.path)
        rel = GH['release']
        if self.path == '/repos/acme/fixture/releases/latest':
            if not rel: return self.send_error(404)
            etag = f'"{rel["tag"]}"'
            GH['if_none_match'].append(self.headers.get('If-None-Match'))
            if self.headers.get('If-None-Match') == etag:
                self.send_response(304); self.end_headers(); return
            body = json.dumps({'id': 1, 'tag_name': rel['tag'], 'draft': False, 'prerelease': False, 'published_at': '2026-11-20T00:00:00Z', 'assets': [
                {'id': i, 'name': n, 'size': len(fx(f)) if f else 64, 'state': 'uploaded', 'browser_download_url': f'http://127.0.0.1:{GH_PORT}/dl/{i}'} for i, n, f in rel['assets']]}).encode()
            self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('etag', etag)
            self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.path.startswith('/dl/'):  # like github.com → objects.githubusercontent.com
            self.send_response(302); self.send_header('location', '/obj/' + self.path[4:]); self.end_headers(); return
        if self.path.startswith('/obj/') and rel:
            f = next((f for i, n, f in rel['assets'] if str(i) == self.path[5:]), None)
            b = fx(f) if f else b'0' * 64
            self.send_response(200); self.send_header('content-type', 'application/octet-stream'); self.send_header('content-length', str(len(b)))
            self.end_headers(); self.wfile.write(b); return
        self.send_error(404)

def start_fake_github():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', GH_PORT), FakeGitHub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

def upload_apk(data, filename):
    boundary = '----screensupd'
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/vnd.android.package-archive\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(BASE + '/api/apks', method='POST', data=body, headers={'content-type': f'multipart/form-data; boundary={boundary}'})
    return json.loads(opener.open(req, timeout=30).read())

def main():
    print('== setup')
    cl = api('POST', '/api/clients', {'name': 'E2E Client'})
    site = api('POST', '/api/sites', {'client_id': cl['id'], 'name': f'E2E Site {int(time.time())}', 'kind': 'rental', 'timezone': 'Australia/Sydney'})
    sid = site['id']
    api('PATCH', f'/api/sites/{sid}', {'settings': {'scan_cidrs': ['10.99.0.0/26']}})
    enr = api('POST', f'/api/sites/{sid}/enroll')
    check('enroll token issued', enr['token'].startswith('enr_'))
    script = api('GET', f'/install/{enr["token"]}', raw=True).decode()
    check('install script served', 'docker compose up' in script and enr['token'] in script)

    data = tempfile.mkdtemp(prefix='screens-gw-')
    env = dict(os.environ, SCREENS_CENTRAL_URL=BASE, SCREENS_ENROLL_TOKEN=enr['token'], SCREENS_DATA=data, SCREENS_LOG_LEVEL='debug', NO_PROXY='*', no_proxy='*')
    log = open(os.path.join(data, 'gateway.log'), 'w')
    gw = subprocess.Popen([BIN], env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        print('== gateway link')
        ok = wait(lambda: api('GET', f'/api/sites/{sid}')['gateway_status'] == 'online', 30)
        check('gateway enrolled and online', ok)
        if not ok:
            print(open(os.path.join(data, 'gateway.log')).read()[-3000:]); return
        g = api('GET', f'/api/sites/{sid}/gateway')
        check('gateway reports version + interfaces', g.get('version') and g.get('interfaces'), json.dumps(g)[:300])
        check('identity file written', os.path.exists(os.path.join(data, 'identity.json')))
        try:
            api('POST', f'/api/sites/{sid}/enroll')  # new token is fine; re-use of old must fail
            req = urllib.request.Request(BASE + '/agent/v1/enroll', method='POST', data=json.dumps({'token': enr['token'], 'public_key': 'A' * 43}).encode(), headers={'content-type': 'application/json'})
            opener.open(req, timeout=10); check('used token rejected', False)
        except urllib.error.HTTPError as e:
            check('used token rejected', e.code == 410, str(e.code))

        print('== discovery')
        try:
            found = api('POST', f'/api/sites/{sid}/discover', timeout=180)
            kinds = {d['ip']: d['kind_guess'] for d in found}
            check('samsung discovered', kinds.get('10.99.0.20') == 'samsung', str(kinds))
            check('sonos discovered', kinds.get('10.99.0.30') == 'sonos' and kinds.get('10.99.0.31') == 'sonos', str(kinds))
            check('android discovered', kinds.get('10.99.0.10') == 'android', str(kinds))
            sam = next((d for d in found if d['ip'] == '10.99.0.20'), {})
            check('samsung name/model fingerprinted', sam.get('model') == 'QA65Q80BAWXXY', json.dumps(sam))

        except Exception as e:
            check('section discovery completed', False, str(e)[:300])
        print('== adopt')
        try:
            t0 = time.time()
            devs = {}
            for ip, kind, name in [('10.99.0.10', 'android', 'Lounge Shield'), ('10.99.0.20', 'samsung', 'Lounge TV'), ('10.99.0.30', 'sonos', 'Living Room'), ('10.99.0.31', 'sonos', 'Kitchen')]:
                devs[kind if kind != 'sonos' or 'sonos' not in devs else 'sonos2'] = api('POST', f'/api/sites/{sid}/adopt', {'ip': ip, 'kind': kind, 'name': name})
            sh, tv, s1, s2 = devs['android']['id'], devs['samsung']['id'], devs['sonos']['id'], devs['sonos2']['id']
            ok = wait(lambda: api('GET', f'/api/devices/{sh}')['model'] == 'SHIELD Android TV', 40)
            check('android paired + refreshed (model read over adb)', ok)
            d = api('GET', f'/api/devices/{sh}')
            check('android facts: screen + current app', d['facts'].get('screen') == {'width': 1920, 'height': 1080} and d['current_app'] == 'com.netflix.ninja', json.dumps(d)[:400])
            ok = wait(lambda: api('GET', f'/api/devices/{tv}')['model'] == 'QA65Q80BAWXXY', 40)
            check('samsung paired + refreshed', ok)
            check('samsung token captured (ws connect)', bool(sim_events('samsung.ws_connect', t0)))

        except Exception as e:
            check('section adopt completed', False, str(e)[:300])
        print('== android control')
        try:
            t1 = time.time()
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'key', 'args': {'key': 'HOME'}})
            check('android key HOME', r['ok'] and any('input keyevent 3' in e['cmd'] for e in sim_events('android.shell', t1)))
            apps = api('POST', f'/api/devices/{sh}/command', {'command': 'apps'})['data']
            pk = {a['package']: a for a in apps}
            check('android app inventory', 'com.netflix.ninja' in pk and pk['com.netflix.ninja']['version_name'] == '8.120.0' and pk['com.google.android.katniss']['system'], str(list(pk)[:5]))
            stored = api('GET', f'/api/devices/{sh}/apps')
            check('apps persisted with catalog labels', any(a['package'] == 'com.netflix.ninja' and a['label'] == 'Netflix' for a in stored))
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'screenshot'})
            img = api('GET', f'/api/devices/{sh}/screenshot', raw=True)
            check('android screenshot → R2 → dashboard (jpeg)', r['ok'] and img[:2] == b'\xff\xd8', f'{len(img)} bytes')
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'tap', 'args': {'x': 0.5, 'y': 0.5}})
            check('android tap maps to screen coords', r['data'].get('x') == 960 and r['data'].get('y') == 540, json.dumps(r))
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'disable', 'args': {'package': 'com.nvidia.tegrazone3'}})
            check('android disable app', r['ok'], json.dumps(r))
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'revoke_permission', 'args': {'package': 'com.spotify.tv.android', 'permission': 'microphone'}})
            check('android revoke microphone for an app', r['ok'] and 'ignore' in r['data'].get('mode', ''), json.dumps(r)[:300])
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'debloat'})
            check('android debloat disables catalogued bloat only', r['ok'] and 'com.nvidia.tegrazone3' in r['data'].get('disabled', []) + r['data'].get('skipped', []) and 'com.netflix.ninja' not in r['data'].get('disabled', []), json.dumps(r)[:300])
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'shell', 'args': {'cmd': 'echo hello'}})
            check('android shell console', 'hello' in r['data'].get('stdout', ''), json.dumps(r))
            try:
                api('POST', f'/api/devices/{sh}/command', {'command': 'launch', 'args': {'package': 'x; reboot'}})
                check('shell injection blocked', False)
            except AssertionError as e:
                check('shell injection blocked', '400' in str(e))
            # install from library
            apk_path = os.path.join(data, 'test.apk')
            with open(apk_path, 'wb') as f: f.write(b'PK\x03\x04' + os.urandom(2000))
            boundary = '----screens'
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="package"\r\n\r\ncom.example.test\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.apk"\r\nContent-Type: application/vnd.android.package-archive\r\n\r\n').encode() + open(apk_path, 'rb').read() + f'\r\n--{boundary}--\r\n'.encode()
            req = urllib.request.Request(BASE + '/api/apks', method='POST', data=body, headers={'content-type': f'multipart/form-data; boundary={boundary}'})
            apk = json.loads(opener.open(req, timeout=30).read())
            t2 = time.time()
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'install', 'args': {'apk_id': apk['id']}}, timeout=180)
            check('install APK from library (streamed over adb)', r['ok'] and sim_events('android.install_done', t2), json.dumps(r)[:300])
        except Exception as e:
            check('section android control completed', False, str(e)[:300])
        print('== screens launcher (kiosk + welcome)')
        try:
            api('PATCH', f'/api/sites/{sid}', {'settings': {'guest': {
                'welcome': {'enabled': True, 'show_on_boot': True, 'title': 'Welcome to the Beach House', 'message': 'Enjoy!', 'wifi': {'ssid': 'Beach-Guest', 'password': 'sunny', 'security': 'WPA'}, 'sections': [{'title': 'Checkout', 'body': '10am'}], 'contact': 'Text Nik', 'accent': '#4F8EF7'},
                'kiosk': {'enabled': True, 'allowed': ['com.netflix.ninja', 'au.com.stan.and', 'bad pkg!'], 'pinned': ['com.netflix.ninja'], 'force_home': False, 'pin': '2468'}}}})
            st = api('GET', f'/api/sites/{sid}')['settings']['guest']
            check('kiosk PIN stored as hash only (pin_set, no pin)', st['kiosk'].get('pin_set') is True and 'pin' not in st['kiosk'] and 'pin_sha256' not in st['kiosk'], json.dumps(st['kiosk']))
            check('kiosk package list validated', st['kiosk']['allowed'] == ['com.netflix.ninja', 'au.com.stan.and'], json.dumps(st['kiosk']))
            boundary = '----screens2'
            body2 = (f'--{boundary}\r\nContent-Disposition: form-data; name="package"\r\n\r\nau.supercluster.screens.launcher\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="launcher.apk"\r\n\r\n').encode() + b'PK\x03\x04' + os.urandom(3000) + f'\r\n--{boundary}--\r\n'.encode()
            opener.open(urllib.request.Request(BASE + '/api/apks', method='POST', data=body2, headers={'content-type': f'multipart/form-data; boundary={boundary}'}), timeout=30).read()
            t_l = time.time()
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'launcher_install'}, timeout=180)
            sent = [e['cmd'] for e in sim_events('android.shell', t_l)]
            check('launcher installed, configured and set as home', r['ok'] and r['data']['status'].get('is_home') is True and any('set-home-activity' in c for c in sent), json.dumps(r)[:400])
            cfgcmd = next((c for c in sent if 'launcher.CONFIG' in c), '')
            check('launcher config broadcast sent', bool(cfgcmd))
            d = api('GET', f'/api/devices/{sh}')
            check('launcher state stored on device', d['facts'].get('launcher', {}).get('installed') is True, json.dumps(d['facts'].get('launcher')))

            t3 = time.time()
            r = api('POST', f'/api/sites/{sid}/guest-reset', {})
            cleared = [e['cmd'] for e in sim_events('android.shell', t3) if 'pm clear' in e['cmd']]
            check('guest reset clears streaming apps', any('com.netflix.ninja' in c for c in cleared) and any('au.com.stan.and' in c for c in cleared), json.dumps(r)[:300])
            check('guest reset re-opens the welcome screen', any('WelcomeActivity' in e['cmd'] for e in sim_events('android.shell', t3)))
            r = api('POST', '/api/devices/bulk', {'device_ids': [sh, tv], 'command': 'key', 'args': {'key': 'HOME'}})
            check('bulk command across device kinds', len(r['results']) == 2 and all(x['ok'] for x in r['results']), json.dumps(r)[:300])

        except Exception as e:
            check('section screens launcher (kiosk + welcome) completed', False, str(e)[:300])
        print('== screens launcher v2 (home screen layouts)')
        try:
            # docs/LAUNCHER-V2.md: layout → assets pushed only when missing → config v2 with a matching sha; 1.x boxes get v1.
            d = api('GET', f'/api/devices/{sh}')
            l0 = d['facts'].get('launcher', {})
            check('sim launcher reports v2 STATUS (version 2.0.0, assets list)', l0.get('version') == '2.0.0' and l0.get('version_code') == 20000 and isinstance(l0.get('assets'), list), json.dumps(l0)[:300])
            check('no layout yet → the 2.x box was sent config v1', l0.get('pushed_v') == 1 and l0.get('config_v') == 1, json.dumps(l0)[:300])

            def multipart(path, name, data, ctype):
                b = '----screensv2'
                body = f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + data + f'\r\n--{b}--\r\n'.encode()
                return json.loads(opener.open(urllib.request.Request(BASE + path, method='POST', data=body, headers={'content-type': f'multipart/form-data; boundary={b}'}), timeout=30).read())
            # Minimal JPEG / PNG headers (the server sniffs magic bytes + size; it never decodes).
            jpg = b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00' + b'\xff\xc0\x00\x11\x08\x04\x38\x07\x80\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01' + os.urandom(20000) + b'\xff\xd9'
            png = b'\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR' + struct.pack('>II', 640, 360) + b'\x08\x06\x00\x00\x00' + os.urandom(4000)
            wall = multipart('/api/launcher/assets', 'wall.jpg', jpg, 'image/jpeg')
            tile = multipart('/api/launcher/assets', 'plex.png', png, 'image/png')
            check('wallpaper + card picture uploaded (sha256, sniffed size)', wall['sha256'] == hashlib.sha256(jpg).hexdigest() and wall['width'] == 1920 and tile['ext'] == 'png', json.dumps([wall, tile])[:300])
            try:
                multipart('/api/launcher/assets', 'x.gif', b'GIF89a' + os.urandom(100), 'image/gif')
                check('non-image upload rejected', False)
            except urllib.error.HTTPError as e:
                check('non-image upload rejected', e.code == 415, str(e.code))

            home = {
                'wallpaper': {'asset': wall['sha256'], 'ext': 'jpg', 'dim': 0.25},
                'top_bar': {'clock': True, 'clock_24h': False, 'date': False, 'network': True, 'settings': True},
                'rows': [
                    {'id': 'featured', 'title': 'InterNik', 'icon': 'bookmark', 'card': 'banner', 'size': 'large', 'apps': ['com.netflix.ninja']},
                    {'id': 'media', 'title': 'Media', 'icon': 'media', 'card': 'banner', 'size': 'medium', 'apps': ['au.com.stan.and', 'com.google.android.youtube.tv', 'com.spotify.tv.android']},
                ],
                'all_apps': {'enabled': True, 'title': 'All apps'}, 'hidden': ['com.android.vending'],
                'tiles': {'au.com.stan.and': {'label': 'Stan', 'asset': tile['sha256'], 'ext': 'png'}},
                'focus': {'scale': 1.12, 'label': 'focused'},
            }
            try:
                api('POST', '/api/launcher/layouts', {'site_id': sid, 'name': 'Bad', 'home': {**home, 'rows': [{**home['rows'][0], 'icon': 'rocket'}]}})
                check('invalid layout rejected', False)
            except AssertionError as e:
                check('invalid layout rejected', '400' in str(e) and 'icon' in str(e), str(e)[:200])
            t5 = time.time()
            lay = api('POST', '/api/launcher/layouts', {'site_id': sid, 'name': 'Living room', 'home': home, 'make_default': True})
            check('layout saved and made the site default', lay['home'] == home and lay['used_by']['sites'] == [sid], json.dumps(lay)[:300])

            def rollout(dev_id):
                return next(x for x in api('GET', f'/api/sites/{sid}/launcher')['devices'] if x['device_id'] == dev_id)
            r = wait(lambda: (lambda x: x if x['in_sync'] and x['expected_v'] == 2 else None)(rollout(sh)), 90, 2)
            check('saving pushed config v2 and the box reports the matching sha', bool(r), json.dumps(rollout(sh))[:400])
            pushes = [e for e in sim_events('android.push', t5) if e['ip'] == '10.99.0.10' and '/screens-asset-' in e['path']]
            writes = [e for e in sim_events('android.content_write', t5) if e['ip'] == '10.99.0.10' and e['ok']]
            check('both pictures pushed to /data/local/tmp then handed over with content write', sorted(p['path'] for p in pushes) == sorted([f'/data/local/tmp/screens-asset-{wall["sha256"]}.jpg', f'/data/local/tmp/screens-asset-{tile["sha256"]}.png']) and len(writes) == 2, json.dumps([pushes, writes])[:400])
            cfgs = [e for e in sim_events('android.launcher_config', t5) if e['ip'] == '10.99.0.10']
            check('config broadcast was v2 with both rows', cfgs and cfgs[-1]['v'] == 2 and cfgs[-1]['rows'] == 2, json.dumps(cfgs)[:300])
            l = api('GET', f'/api/devices/{sh}')['facts']['launcher']
            check('device facts: version, config sha, assets, pushed_at, layout', l['version'] == '2.0.0' and l['config_v'] == 2 and l['config_sha'] == r['expected_sha'] and set(l['assets']) >= {wall['sha256'], tile['sha256']}
                  and l['missing_assets'] == [] and l['pushed_v'] == 2 and l['pushed_at'] and l['push_error'] is None and l['layout_id'] == lay['id'], json.dumps(l)[:400])

            t6 = time.time()
            res = api('POST', f'/api/sites/{sid}/launcher/push', {'device_ids': [sh]})
            check('push now: ok, and no picture re-sent when nothing is missing', res['results'] and all(x['ok'] for x in res['results']) and not [e for e in sim_events('android.push', t6) if '/screens-asset-' in e['path']], json.dumps(res)[:300])
            # Remove one picture on the box: the next push copies only that one.
            api('POST', f'/api/devices/{sh}/command', {'command': 'shell', 'args': {'cmd': f'content delete --uri content://au.supercluster.screens.launcher.assets/{tile["sha256"]}.png'}})
            t7 = time.time()
            api('POST', f'/api/sites/{sid}/launcher/push', {'device_ids': [sh]})
            again = [e['path'] for e in sim_events('android.push', t7) if '/screens-asset-' in e['path']]
            check('only the missing picture is pushed again', again == [f'/data/local/tmp/screens-asset-{tile["sha256"]}.png'], json.dumps(again))

            # Editing the layout re-pushes automatically (new sha, no pictures needed).
            t8 = time.time()
            home2 = {**home, 'rows': [home['rows'][1], home['rows'][0]]}
            api('PUT', f'/api/launcher/layouts/{lay["id"]}', {'home': home2})
            r2 = wait(lambda: (lambda x: x if x['in_sync'] and x['expected_sha'] != r['expected_sha'] else None)(rollout(sh)), 90, 2)
            check('layout edit pushed automatically, box in sync with the new sha', bool(r2) and not [e for e in sim_events('android.push', t8) if '/screens-asset-' in e['path']], json.dumps(rollout(sh))[:300])

            # A box still on launcher 1.0.0 gets the v1 config and no pictures.
            body_v1 = b'PK\x03\x04SCREENS_LAUNCHER_V1' + os.urandom(3000)
            b = '----screensv1'
            form = (f'--{b}\r\nContent-Disposition: form-data; name="package"\r\n\r\nau.supercluster.screens.launcher\r\n--{b}\r\nContent-Disposition: form-data; name="file"; filename="launcher-1.0.0.apk"\r\n\r\n').encode() + body_v1 + f'\r\n--{b}--\r\n'.encode()
            apk1 = json.loads(opener.open(urllib.request.Request(BASE + '/api/apks', method='POST', data=form, headers={'content-type': f'multipart/form-data; boundary={b}'}), timeout=30).read())
            sh2 = api('POST', f'/api/sites/{sid}/adopt', {'ip': '10.99.0.11', 'kind': 'android', 'name': 'Bedroom Shield'})['id']
            wait(lambda: api('GET', f'/api/devices/{sh2}')['model'] == 'SHIELD Android TV', 40)
            t9 = time.time()
            # "Install launcher" always picks the newest launcher in the library, so put this exact old build on the box.
            api('POST', f'/api/devices/{sh2}/command', {'command': 'install', 'args': {'apk_id': apk1['id']}}, timeout=180)
            r = api('POST', f'/api/devices/{sh2}/command', {'command': 'launcher_config'}, timeout=180)
            cfg2 = [e for e in sim_events('android.launcher_config', t9) if e['ip'] == '10.99.0.11']
            check('1.0.0 box: installed, sent config v1 (no home)', r['ok'] and r['data']['status'].get('version') == '1.0.0' and cfg2 and all(e['v'] == 1 for e in cfg2), json.dumps([r, cfg2])[:400])
            check('1.0.0 box: no pictures pushed, no content provider calls', not [e for e in sim_events('android.push', t9) if e['ip'] == '10.99.0.11'] and not [e for e in sim_events('android.shell', t9) if e['ip'] == '10.99.0.11' and e['cmd'].startswith('content ')])
            x = rollout(sh2)
            check('1.0.0 box: rollout expects v1 and is in sync', x['expected_v'] == 1 and x['in_sync'] and not x['supports_v2'] and x['layout_id'] == lay['id'], json.dumps(x)[:300])
            # Per-box override → only that box changes.
            tpl = api('POST', f'/api/launcher/layouts/{lay["id"]}/copy', {'site_id': sid, 'name': 'Kids'})
            api('PUT', f'/api/devices/{sh}/launcher', {'layout_id': tpl['id']})
            x = wait(lambda: (lambda y: y if y['in_sync'] and y['layout_id'] == tpl['id'] else None)(rollout(sh)), 90, 2)
            check('per-box override pushed to that box', bool(x), json.dumps(rollout(sh))[:300])
            api('DELETE', f'/api/devices/{sh2}')
            api('DELETE', f'/api/apks/{apk1["id"]}')
        except Exception as e:
            check('section screens launcher v2 completed', False, str(e)[:300])
        print('== app updates')
        try:
            gh_srv = start_fake_github()
            PKG = 'au.supercluster.screens.fixture'
            exp = json.load(open(os.path.join(UPD_FIX, 'expected.json')))
            def updates(): return api('GET', '/api/updates')
            def box(pkg, o=None):
                p = next((x for x in (o or updates())['packages'] if x['package'] == pkg), None)
                return next((b for b in (p or {}).get('boxes', []) if b['device_id'] == sh), None)
            # The owner sideloaded v1 (signed with key 1) from the library at some point.
            v1 = upload_apk(fx('v1-k1.apk'), 'fixture-1.0.apk')
            check('updates: library reads package + version from the APK', v1['package'] == PKG and v1['version_code'] == 1, json.dumps(v1))
            r = api('POST', f'/api/devices/{sh}/command', {'command': 'install', 'args': {'apk_id': v1['id']}}, timeout=180)
            check('updates: v1 sideloaded', r['ok'], json.dumps(r)[:300])
            api('POST', f'/api/devices/{sh}/command', {'command': 'apps'}, timeout=180)
            api('POST', '/api/updates/probe', {'site_id': sid})
            ok = wait(lambda: (box('com.netflix.ninja') or {}).get('state') == 'store', 120, 3)
            check('updates: Play-installed app shown as kept current by Play', ok, json.dumps(box('com.netflix.ninja')))

            # A build signed with a different key is flagged and never installed.
            k2 = upload_apk(fx('v2-k2.apk'), 'fixture-1.1-otherkey.apk')
            st = wait(lambda: (box(PKG) or {}).get('state') == 'signer_mismatch', 60, 2)
            check('updates: build with another signing key flagged', st, json.dumps(box(PKG))[:300])
            try:
                api('POST', '/api/updates/run', {'package': PKG, 'device_id': sh}); check('updates: build with another key refused', False)
            except AssertionError as e:
                check('updates: build with another key refused', '409' in str(e) and 'key' in str(e), str(e)[:300])
            api('DELETE', f'/api/apks/{k2["id"]}')

            # GitHub source: per-ABI + general asset through a redirect, signing key learnt, then ETag.
            GH['release'] = {'tag': 'v1.1', 'assets': [(101, 'fixture-1.1-arm64-v8a.apk', 'v2-k1-arm64.apk'), (102, 'fixture-1.1-universal.apk', 'v2-k1-universal.apk'), (103, 'fixture-1.1.apk.sha256', None)]}
            r = api('POST', '/api/updates/sources', {'package': PKG, 'repo': 'acme/fixture', 'asset_pattern': '*universal*.apk', 'abi_patterns': {'arm64-v8a': '*arm64*.apk'}}, timeout=120)
            imported = [i for i in r['check']['imported'] if i['status'] == 'imported']
            check('updates: GitHub release imported (arm64 + universal, via redirect)', r['check']['status'] == 'ok' and len(imported) == 2, json.dumps(r['check'])[:400])
            check('updates: trusted signing key learnt from the release', r['source']['signer_sha256'] == exp['k1']['sha256'], json.dumps(r['source'])[:300])
            check('updates: imported APKs stored with their SHA-256', {sha256(fx('v2-k1-arm64.apk')), sha256(fx('v2-k1-universal.apk'))} <= {a['sha256'] for a in api('GET', '/api/apks')})
            r = api('POST', '/api/updates/check', {'package': PKG})
            check('updates: unchanged release answered by ETag (304)', r['results'][0]['status'] == 'not_modified' and GH['if_none_match'][-1] == '"v1.1"', json.dumps(r)[:300])
            GH['release'] = {'tag': 'v9', 'assets': [(109, 'fixture-9-universal.apk', 'v2-k2.apk')]}
            r = api('POST', '/api/updates/check', {'package': PKG})
            check('updates: release signed by another key not imported', r['results'][0]['status'] == 'error' and 'different key' in r['results'][0]['detail'], json.dumps(r)[:300])

            # Update now: this box is the canary; the arm64 build goes on, the version is verified and the app opened.
            st = wait(lambda: (lambda b: b if b and b['state'] == 'update' else None)(box(PKG)), 60, 2)
            check('updates: box offered the arm64 build', st and st['candidate']['abis'] == ['arm64-v8a'], json.dumps(st)[:300])
            t7 = time.time()
            r = api('POST', '/api/updates/run', {'package': PKG, 'device_id': sh})
            rid = r['rollouts'][0]['id']
            def rollout(): return next((x for x in updates()['rollouts'] if x['id'] == rid), None)
            done = wait(lambda: (lambda x: x if x and x['status'] in ('done', 'failed', 'cancelled') else None)(rollout()), 240, 3)
            check('updates: rollout finished on the box', done and done['status'] == 'done' and done['devices'][0]['status'] == 'ok', json.dumps(done)[:500])
            inst = [e for e in sim_events('android.install_done', t7) if e.get('package') == PKG]
            check('updates: arm64 build installed (-r only), app opened as canary check', inst and inst[-1].get('sha256') == sha256(fx('v2-k1-arm64.apk')) and sim_events('android.launch_check', t7), json.dumps(inst)[:300])
            apps = api('GET', f'/api/devices/{sh}/apps')
            check('updates: inventory shows the new version', any(a['package'] == PKG and a['version_code'] == 2 for a in apps))
            check('updates: install recorded as a job', any(j['kind'] == 'app_update' and j['status'] == 'ok' for j in api('GET', f'/api/jobs?device_id={sh}&limit=30')))
            try:
                api('POST', '/api/updates/run', {'package': PKG, 'device_id': sh}); check('updates: nothing to install once current (no downgrade)', False)
            except AssertionError as e:
                check('updates: nothing to install once current (no downgrade)', '409' in str(e), str(e)[:300])

            # Auto policy inside the site's maintenance window: a key-rotated release rolls out by itself.
            here = datetime.now(ZoneInfo('Australia/Sydney'))
            api('PUT', f'/api/updates/sites/{sid}', {'window_start': (here - timedelta(minutes=5)).strftime('%H:%M'), 'window_end': (here + timedelta(minutes=55)).strftime('%H:%M'), 'canary_device_id': sh})
            api('PUT', '/api/updates/policies', {'package': PKG, 'scope_type': 'fleet', 'mode': 'auto'})
            GH['release'] = {'tag': 'v1.2', 'assets': [(120, 'fixture-1.2-universal.apk', 'v3-rotated.apk')]}
            r = api('POST', '/api/updates/check', {'package': PKG})
            check('updates: key-rotated release accepted (proof of rotation)', r['results'][0]['status'] == 'ok', json.dumps(r)[:300])
            api('POST', '/api/updates/probe', {'site_id': sid})
            auto = wait(lambda: next((x for x in updates()['rollouts'] if x['trigger'] == 'auto' and x['version_code'] == 3 and x['status'] in ('done', 'failed')), None), 300, 4)
            check('updates: automatic update ran in the maintenance window', auto and auto['status'] == 'done', json.dumps(auto)[:500])
            api('PUT', '/api/updates/policies', {'package': PKG, 'scope_type': 'fleet', 'mode': None})
            gh_srv.shutdown()
        except Exception as e:
            check('section app updates completed', False, str(e)[:300])
        print('== samsung control')
        try:
            t4 = time.time()
            r = api('POST', f'/api/devices/{tv}/command', {'command': 'key', 'args': {'key': 'VOL_UP'}})
            ok = wait(lambda: any(e['key'] == 'KEY_VOLUP' for e in sim_events('samsung.key', t4)), 5, 0.3)
            check('samsung key over relayed WSS', r['ok'] and ok)
            apps = api('POST', f'/api/devices/{tv}/command', {'command': 'apps'})['data']
            check('samsung installed apps', any(a['label'] == 'Netflix' for a in apps), json.dumps(apps)[:200])
            r = api('POST', f'/api/devices/{tv}/command', {'command': 'launch', 'args': {'app_id': '3201907018807'}})
            ok = wait(lambda: any(e['event'] == 'ed.apps.launch' for e in sim_events('samsung.emit', t4)), 5, 0.3)
            check('samsung launch app', ok)
            r = api('POST', f'/api/devices/{tv}/command', {'command': 'input', 'args': {'source': 'HDMI2'}})
            ok = wait(lambda: any(e['key'] == 'KEY_HDMI2' for e in sim_events('samsung.key', t4)), 5, 0.3)
            check('samsung input switch', r['ok'] and ok)
            r = api('POST', f'/api/devices/{tv}/command', {'command': 'volume', 'args': {'level': 30}})
            check('samsung absolute volume (UPnP)', r['ok'] and sim_events('samsung.upnp', t4))

        except Exception as e:
            check('section samsung control completed', False, str(e)[:300])
        print('== samsung pairing variants')
        try:
            t_p = time.time()
            d9 = api('POST', f'/api/sites/{sid}/adopt', {'ip': '10.99.0.21', 'kind': 'samsung', 'name': 'Bedroom QLED (Tizen 9)'})
            ok = wait(lambda: any(e for e in sim_events('samsung.register', t_p)), 20, 0.5)
            check('samsung tizen9: register frame sent when the TV stays silent', ok)
            r = wait(lambda: (lambda x: x if x['ok'] else None)(api('POST', f'/api/devices/{d9["id"]}/command', {'command': 'key', 'args': {'key': 'HOME'}})), 30, 2)
            check('samsung tizen9: token issued after Allow; remote works', bool(r), json.dumps(r)[:200] if r else 'no success')
            dd = api('POST', f'/api/sites/{sid}/adopt', {'ip': '10.99.0.22', 'kind': 'samsung', 'name': 'Office TV (notifications off)'})
            dev = wait(lambda: (lambda x: x if x['facts'].get('pairing_event') else None)(api('GET', f'/api/devices/{dd["id"]}')), 30, 1)
            check('samsung refused: exact reason recorded with the right menu path', bool(dev) and dev['facts']['pairing_event'] == 'unauthorized' and 'Connection → External Device Manager' in dev['facts'].get('pairing_detail', ''), json.dumps((dev or {}).get('facts', {}))[:300])
        except Exception as e:
            check('section samsung pairing variants completed', False, str(e)[:300])

        print('== sonos control')
        try:
            t5 = time.time()
            d = api('POST', f'/api/devices/{s1}/command', {'command': 'refresh'})['data']
            check('sonos refresh: room/model/now playing', d['model'] == 'Sonos One' and d['facts']['now_playing'].get('title') == 'Weightless', json.dumps(d['facts'])[:300])
            r = api('POST', f'/api/devices/{s1}/command', {'command': 'volume', 'args': {'level': 33}})
            check('sonos volume', r['data'].get('level') == 33)
            api('POST', f'/api/devices/{s2}/command', {'command': 'refresh'})
            r = api('POST', f'/api/devices/{s2}/command', {'command': 'group', 'args': {'coordinator_id': s1}})
            d2 = api('POST', f'/api/devices/{s2}/command', {'command': 'refresh'})['data']
            check('sonos group join', d2['facts']['group']['coordinator'].endswith('01400') and not d2['facts']['group']['is_coordinator'], json.dumps(d2['facts'].get('group')))
            favs = api('POST', f'/api/devices/{s1}/command', {'command': 'favorites'})['data']
            check('sonos favourites listed', [f['title'] for f in favs] == ['Triple J', 'Chill Mix'] and favs[0]['kind'] == 'radio', json.dumps(favs)[:300])
            r = api('POST', f'/api/devices/{s1}/command', {'command': 'play_favorite', 'args': {'uri': favs[1]['uri'], 'meta': favs[1]['meta']}})
            check('sonos play favourite playlist (queued)', r['ok'] and any(e['action'] == 'AddURIToQueue' for e in sim_events('sonos.soap', t5)))
            r = api('POST', f'/api/devices/{s1}/command', {'command': 'eq', 'args': {'bass': 4, 'treble': -2, 'loudness': False}})
            check('sonos EQ set + read back', r['data']['eq']['bass'] == 4 and r['data']['eq']['treble'] == -2 and r['data']['eq']['loudness'] is False, json.dumps(r)[:300])
            r = api('POST', f'/api/devices/{s1}/command', {'command': 'sleep_timer', 'args': {'minutes': 45}})
            check('sonos sleep timer', r['ok'] and r['data']['minutes'] == 45)
            r = api('POST', f'/api/devices/{s2}/command', {'command': 'media', 'args': {'action': 'pause'}})
            acts = [(e['ip'], e['action']) for e in sim_events('sonos.soap', t5)]
            check('sonos transport goes to group coordinator', ('10.99.0.30', 'Pause') in acts, str(acts[-5:]))
            st = api('POST', f'/api/devices/{s2}/command', {'command': 'status'})['data']
            check('sonos status: live group with member volumes', [m['name'] for m in st['group']['members']] == ['Living Room', 'Kitchen'] and st['group']['volume'] is not None and all(m.get('volume') is not None for m in st['group']['members']), json.dumps(st.get('group'))[:300])
            r = api('POST', f'/api/devices/{s2}/command', {'command': 'group_volume', 'args': {'level': 30}})
            check('sonos group volume', r['ok'] and r['data']['level'] == 30 and any(e['action'] == 'SetGroupVolume' and e['ip'] == '10.99.0.30' for e in sim_events('sonos.soap', t5)))
            ov = api('GET', f'/api/sites/{sid}/sonos')
            check('sonos site overview: one group, both rooms adopted', len(ov['groups']) == 1 and {m['device_id'] for m in ov['groups'][0]['members']} == {s1, s2}, json.dumps(ov)[:300])
            # The field bug: Kitchen's last source is an app session that has ended (sim answers Play with UPnP 701).
            api('POST', f'/api/devices/{s2}/command', {'command': 'ungroup'})
            t6 = time.time()
            r = api('POST', f'/api/devices/{s2}/command', {'command': 'media', 'args': {'action': 'play'}})
            acts = [(e['ip'], e['action']) for e in sim_events('sonos.soap', t6)]
            faults = [(e['action'], e['code']) for e in sim_events('sonos.fault', t6)]
            check('sonos play recovers from an ended app session via the queue', r['ok'] and r['data'].get('state') == 'PLAYING' and ('Play', 701) in faults and ('10.99.0.31', 'SetAVTransportURI') in acts and 'session had ended' in (r['data'].get('detail') or ''), json.dumps(r)[:300])
            d2 = api('GET', f'/api/devices/{s2}')
            check('sonos play: facts updated straight away (no stale STOPPED)', d2['facts']['now_playing'].get('state') == 'PLAYING', json.dumps(d2['facts'].get('now_playing'))[:200])
            art = d2['facts']['now_playing'].get('art') or ''
            png = api('GET', f'/api/devices/{s2}/sonos/art?path={urllib.parse.quote(art, safe="")}', raw=True) if art.startswith('/getaa?') else b''
            check('sonos album art proxied through the gateway', png[:4] == b'\x89PNG', art[:80])
            q = api('POST', f'/api/devices/{s1}/command', {'command': 'queue'})['data']
            check('sonos queue listed', q['total'] >= 3 and q['items'][0]['index'] == 1 and q['items'][0]['title'], json.dumps(q)[:300])
            r = api('POST', f'/api/devices/{s1}/command', {'command': 'play_queue', 'args': {'index': 2}})
            check('sonos play queue position', r['ok'] and r['data'].get('position', {}).get('track') == 2, json.dumps(r)[:300])
            r = api('POST', f'/api/devices/{s1}/command', {'command': 'play_mode', 'args': {'shuffle': True, 'repeat': 'all'}})
            check('sonos shuffle + repeat', r['data']['play_mode'] == {'shuffle': True, 'repeat': 'all'} and any(e['action'] == 'SetPlayMode' for e in sim_events('sonos.soap', t6)))
            pls = api('POST', f'/api/devices/{s1}/command', {'command': 'playlists'})['data']
            check('sonos playlists listed', [p['title'] for p in pls] == ['Dinner & Drinks', 'Sunday'], json.dumps(pls)[:200])
            al = api('POST', f'/api/devices/{s1}/command', {'command': 'alarms'})['data']
            r = api('POST', f'/api/devices/{s1}/command', {'command': 'alarm_enable', 'args': {'id': al[0]['id'], 'enabled': False}})
            check('sonos alarms listed and disabled', al[0]['days'] == 'Weekdays' and r['data']['alarm']['enabled'] is False, json.dumps(al)[:200])
            api('POST', f'/api/devices/{s1}/command', {'command': 'clear_queue'})
            api('POST', f'/api/devices/{s1}/command', {'command': 'media', 'args': {'action': 'stop'}})
            try:
                api('POST', f'/api/devices/{s1}/command', {'command': 'media', 'args': {'action': 'play'}}); msg = ''
            except AssertionError as e:
                msg = str(e)
            d1 = api('GET', f'/api/devices/{s1}')
            check('sonos play failure explained in plain English and recorded on the device', 'queue is empty' in msg and (d1['facts'].get('last_error') or {}).get('command') == 'media', msg[:200])
            r = api('POST', f'/api/devices/{s1}/command', {'command': 'pause_all'})
            check('sonos pause all', r['ok'], json.dumps(r)[:200])

        except Exception as e:
            check('section sonos control completed', False, str(e)[:300])
        print('== DNS filter')
        try:
            gwinfo = wait(lambda: (lambda g: g if g.get('dns_listening') else None)(api('GET', f'/api/sites/{sid}/gateway')), 30) or api('GET', f'/api/sites/{sid}/gateway')
            listen = [a.rsplit(':', 1)[0] for a in gwinfo.get('dns_listening') or []]
            server = next((a for a in listen if a.startswith('10.99.0.')), listen[0] if listen else None)
            check('gateway DNS listening on LAN addresses', bool(server), str(gwinfo.get('dns_listening')))
            if server:
                ok = wait(lambda: dns_query('log-config.samsungacr.com', '10.99.0.20', server)[0] in (0, 2, 3), 20)
                rc, ips = dns_query('log-config.samsungacr.com', '10.99.0.20', server)
                check('monitor mode: ACR domain not blocked yet', ips != ['0.0.0.0'], f'rc={rc} ips={ips}')
                api('PATCH', f'/api/devices/{tv}', {'dns_mode': 'enforce'})
                ok = wait(lambda: dns_query('log-config.samsungacr.com', '10.99.0.20', server)[1] == ['0.0.0.0'], 20)
                check('enforce mode: ACR domain blocked (0.0.0.0)', ok)
                api('PATCH', f'/api/devices/{tv}', {'dns_allow': ['samsungacr.com']})
                ok = wait(lambda: dns_query('log-config.samsungacr.com', '10.99.0.20', server)[1] != ['0.0.0.0'], 20)
                check('per-device allow overrides policy', ok)
                api('PATCH', f'/api/devices/{tv}', {'dns_allow': [], 'dns_block': ['example.org']})
                ok = wait(lambda: dns_query('www.example.org', '10.99.0.20', server)[1] == ['0.0.0.0'], 20)
                check('per-device block list', ok)
                ok = wait(lambda: any(e['action'] == 'block' and e['qname'] == 'log-config.samsungacr.com' and e['device_id'] == tv for e in api('GET', f'/api/sites/{sid}/dns/log?limit=100')), 20)
                check('query log reaches the hub with device attribution', ok)
                log_ = api('GET', f'/api/sites/{sid}/dns/log?limit=200')
                check('ACR categorised', any(e['cat'] == 'acr' for e in log_))
                summ = api('GET', f'/api/sites/{sid}/dns/summary?hours=24')
                check('site DNS summary', summ['queries'] > 0 and summ['blocked'] > 0 and summ['by_category'].get('acr', 0) > 0, json.dumps({k: summ[k] for k in ('queries', 'blocked', 'would_block', 'by_category')}))
                sock, recv = live_ws(f'/api/sites/{sid}/live')
                time.sleep(0.5)
                dns_query('telemetry-check.samsungacr.com', '10.99.0.20', server)
                got = None
                t_end = time.time() + 15
                while time.time() < t_end and not got:
                    try:
                        ev = json.loads(recv(max(0.5, t_end - time.time())))
                        if ev.get('type') == 'dns' and any(e['qname'] == 'telemetry-check.samsungacr.com' for e in ev['entries']): got = ev
                    except socket.timeout:
                        break
                sock.close()
                check('live dashboard feed streams DNS queries', got is not None and any(e.get('device_name') == 'Lounge TV' for e in got['entries']), json.dumps(got)[:200] if got else 'no event')
                priv = api('GET', f'/api/devices/{tv}/privacy')
                check('privacy score computed', 0 <= priv['score'] <= 100 and priv['checklist'], f"score={priv['score']} grade={priv['grade']}")

        except Exception as e:
            check('section DNS filter completed', False, str(e)[:300])
        print('== mDNS reflector')
        try:
            have_main = subprocess.run(['ip', 'netns', 'exec', 'simmain', 'true']).returncode == 0
            cfg = {'enabled': True, 'interfaces': ['lan0', 'lan1'], 'rules': [
                {'from': 'lan0', 'to': ['lan1'], 'allow': ['_sonos._tcp', '_spotify-connect._tcp'], 'deny': []},
                {'from': 'lan1', 'to': ['lan0'], 'allow': ['*'], 'deny': []}],
                'ssdp': {'enabled': True, 'rules': [{'from': 'lan1', 'to': ['lan0']}]}, 'rate_limit_pps': 200, 'track_services': True}
            r = api('PUT', f'/api/sites/{sid}/mdns', cfg)
            check('mDNS config pushed to gateway', r.get('pushed') is True, json.dumps(r))
            if have_main:
                time.sleep(1.5)
                lst = subprocess.Popen(['ip', 'netns', 'exec', 'simmain', 'python3', '-c', MDNS_PY, 'listen', '10.88.0.50', '5'], stdout=subprocess.PIPE, text=True)
                time.sleep(1)
                subprocess.run(['ip', 'netns', 'exec', 'simlan', 'python3', '-c', MDNS_PY, 'announce', '10.99.0.30', '_sonos._tcp', 'Kitchen', 'sonos-kitchen.local', '1443'], timeout=10)
                subprocess.run(['ip', 'netns', 'exec', 'simlan', 'python3', '-c', MDNS_PY, 'announce', '10.99.0.31', '_hap._tcp', 'Bridge', 'hap-bridge.local', '51826'], timeout=10)
                got = json.loads(lst.communicate(timeout=15)[0] or '[]')
                blob = ''.join(g['hex'] for g in got)
                sonos_hex = bytes([7]).hex() + b'Kitchen'.hex()
                hap_hex = bytes([6]).hex() + b'Bridge'.hex()
                check('mDNS: Sonos announcement reflected IoT VLAN -> main VLAN (real multicast)', sonos_hex in blob and any(g['from'] == '10.88.0.1' for g in got), f'{len(got)} packets')
                check('mDNS: non-allowed service (_hap) not reflected', hap_hex not in blob)
                st = wait(lambda: (lambda x: x if x.get('status') and any(sv['service'] == '_sonos._tcp' for sv in x['status'].get('services', [])) else None)(api('GET', f'/api/sites/{sid}/mdns')), 10)
                check('mDNS: service tracker lists the Sonos', bool(st), json.dumps((st or {}).get('status', {}))[:200])
                if st: check('mDNS: reflected counter increments', st['status']['counters']['reflected'] > 0, json.dumps(st['status']['counters']))
            else:
                st = api('GET', f'/api/sites/{sid}/mdns')
                check('mDNS status readable', st['status'] is not None, json.dumps(st)[:300])
        except Exception as e:
            check('section mDNS reflector completed', False, str(e)[:300])

        print('== live screen mirroring')
        try:
            t_m = time.time()
            recv, send, close = ws_client(f'/api/devices/{sh}/mirror?max_size=1280&max_fps=30')
            statuses, meta, kinds, units = [], None, [], 0
            end = time.time() + 25
            while time.time() < end and (units < 40 or meta is None):
                op, frame = recv(max(0.5, end - time.time()))
                if op == 1:
                    m = json.loads(frame)
                    if m['type'] == 'status': statuses.append(m['state'])
                    if m['type'] == 'meta': meta = m
                elif op == 2:
                    units += 1
                    if len(frame) == 12 and frame[0] & 0x80: kinds.append('session')
                    else:
                        hi = struct.unpack('>I', frame[:4])[0]
                        kinds.append('config' if hi & 0x40000000 else 'key' if hi & 0x20000000 else 'delta')
                elif op == 8: break
            check('mirror: scrcpy server present on the device (pushed + sha-verified when missing) and started', bool(sim_events('android.scrcpy_start', t_m)), 'no start seen')
            check('mirror: status starting -> streaming', statuses[:2] == ['starting', 'streaming'], str(statuses))
            check('mirror: meta from the device stream', bool(meta) and meta['codec'] == 'h264' and meta['width'] == 1280 and meta['height'] == 720 and meta['device_name'] == 'SHIELD Android TV', json.dumps(meta))
            check('mirror: aligned units, config + keyframe first', kinds[:3] == ['session', 'config', 'key'] and kinds.count('delta') >= 30, str(kinds[:6]) + f' total={len(kinds)}')
            touch = struct.pack('>BBqiiHHHii', 2, 0, -1, 640, 360, 1280, 720, 0xffff, 1, 1)
            send(touch); send(bytes([16, 0]))  # second one (START_APP) must be dropped
            ok = wait(lambda: any(e['hex'].startswith('0200ffffffffffffffff00000280') for e in sim_events('android.scrcpy_control', t_m)), 8, 0.3)
            check('mirror: touch input reaches the device control socket', ok)
            check('mirror: disallowed control type is not forwarded', not any(e['hex'].startswith('10') for e in sim_events('android.scrcpy_control', t_m)))
            # second viewer: gets meta + config straight away and triggers RESET_VIDEO
            t_v2 = time.time()
            recv2, send2, close2 = ws_client(f'/api/devices/{sh}/mirror')
            got2 = []
            end = time.time() + 5
            while time.time() < end and len(got2) < 4:
                op, frame = recv2(max(0.5, end - time.time()))
                got2.append((op, frame[:80]))
            check('mirror: late joiner gets status, meta and the cached config packet', got2[0][0] == 1 and b'streaming' in got2[0][1] and got2[1][0] == 1 and b'meta' in got2[1][1] and got2[2][0] == 2, str([(o, d[:40]) for o, d in got2[:3]]))
            ok = wait(lambda: any(e['hex'] == '11' for e in sim_events('android.scrcpy_control', t_v2)), 5, 0.3)
            check('mirror: late joiner triggers RESET_VIDEO (fresh keyframe)', ok)
            close2(); close()
            ok = wait(lambda: sim_events('android.scrcpy_video_closed', t_m), 10, 0.3)
            check('mirror: session torn down when the last viewer leaves', bool(ok))
            # Real browser: decode the stream with WebCodecs (headless Chromium)
            web = subprocess.Popen([sys.executable, '-m', 'http.server', '8932', '--bind', '127.0.0.1', '--directory', os.path.join(ROOT, 'tools', 'e2e', 'web')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                time.sleep(1)
                js = (
                    "const { chromium } = require('playwright');"
                    "(async () => { const b = await chromium.launch(); const p = await b.newPage();"
                    f"await p.goto('http://127.0.0.1:8932/decode.html?ws=' + encodeURIComponent('ws://127.0.0.1:8787/api/devices/{sh}/mirror'));"
                    "await p.waitForTimeout(9000); console.log(JSON.stringify(await p.evaluate(() => window.result))); await b.close(); })();"
                )
                npm_root = subprocess.run(['npm', 'root', '-g'], capture_output=True, text=True).stdout.strip()
                out = subprocess.run(['node', '-e', js], capture_output=True, text=True, timeout=60, env=dict(os.environ, NODE_PATH=npm_root))
                res = json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {'error': out.stderr[-300:]}
                check('mirror: real browser decodes the live stream with WebCodecs', res.get('frames', 0) >= 60 and not res.get('error'), json.dumps(res)[:300])
            finally:
                web.terminate()
        except Exception as e:
            check('section live screen mirroring completed', False, str(e)[:300])

        print('== network legs (dashboard-managed interfaces)')
        try:
            if not os.path.exists('/sys/class/net/lan2'):
                check('network legs: spare port lan2 present (run.sh creates it)', False, 'lan2 missing')
            else:
                st = api('GET', f'/api/sites/{sid}/network')
                check('network: gateway supports managed interfaces', st['supported'] and st['gateway_online'], json.dumps(st)[:300])
                lan2 = next((h for h in st['host'] if h['name'] == 'lan2'), None)
                check('network: spare port listed without an address', lan2 is not None and not [a for a in lan2['addrs'] if '.' in a], json.dumps(lan2))
                try:
                    api('PUT', f'/api/sites/{sid}/network', {'interfaces': [{'kind': 'existing', 'name': 'lan2', 'mode': 'static', 'address': '8.8.8.8/24'}]})
                    check('network: public static address rejected', False)
                except AssertionError as e:
                    check('network: public static address rejected', '400' in str(e), str(e)[:200])
                api('PUT', f'/api/sites/{sid}/network', {'interfaces': [{'kind': 'existing', 'name': 'lan2', 'mode': 'dhcp', 'label': 'E2E IoT'}]})
                up = wait(lambda: (lambda x: x if any(i['name'] == 'lan2' and i['state'] == 'up' and any(a.startswith('10.98.0.') for a in i['addrs']) for i in x['status']) else None)(api('GET', f'/api/sites/{sid}/network')), 30)
                leg = next((i for i in (up or {}).get('status', []) if i['name'] == 'lan2'), {})
                check('network: DHCP lease acquired on the spare port', bool(up), json.dumps(api('GET', f'/api/sites/{sid}/network'))[:400])
                addr = next((a.split('/')[0] for a in leg.get('addrs', []) if a.startswith('10.98.0.')), None)
                check('network: lease has an expiry (renewed automatically)', bool(leg.get('expires')), json.dumps(leg))
                host = next((h for h in (up or {}).get('host', []) if h['name'] == 'lan2'), {})
                check('network: interface list refreshed for the dashboard / mDNS picker', addr is not None and any(a.startswith(addr) for a in host.get('addrs', [])), json.dumps(host))
                if addr:
                    ok = wait(lambda: any(a.startswith(addr + ':') for a in api('GET', f'/api/sites/{sid}/gateway').get('dns_listening') or []), 20)
                    check('network: DNS filter re-bound to the new leg', ok, str(api('GET', f'/api/sites/{sid}/gateway').get('dns_listening')))
                    rc, ips = dns_query('example.com', '10.98.0.1', addr, ns='simvlan') if ok else (None, None)
                    check('network: devices on the new VLAN get answers from the gateway', rc in (0, 2, 3), f'rc={rc} ips={ips}')
                r = api('PUT', f'/api/sites/{sid}/network', {'interfaces': [{'kind': 'existing', 'name': 'lan2', 'mode': 'dhcp'}, {'kind': 'vlan', 'parent': 'lan0', 'vlan': 77, 'mode': 'dhcp'}]})
                bad = next((i for i in r['status'] if i['name'] == 'scr77'), None) or {}
                errs = (bad.get('error') or '') + ' '.join(r.get('errors') or [])
                still = any(i['name'] == 'lan2' and i['state'] == 'up' for i in r['status'])
                if os.path.exists('/proc/net/vlan/config'):
                    check('network: VLAN sub-interface created', bad.get('state') in ('up', 'acquiring'), json.dumps(r)[:400])
                else:  # this kernel has no 802.1Q: the failure must be explained and must not disturb the working leg
                    check('network: VLAN failure explained, other legs untouched', bool(errs.strip()) and still, json.dumps(r)[:400])
                r = api('PUT', f'/api/sites/{sid}/network', {'interfaces': []})
                gone = wait(lambda: not subprocess.run(['ip', '-4', '-o', 'addr', 'show', 'dev', 'lan2'], capture_output=True, text=True).stdout.strip(), 10)
                check('network: removing a leg releases its address', bool(gone), subprocess.run(['ip', '-4', '-o', 'addr', 'show', 'dev', 'lan2'], capture_output=True, text=True).stdout)
                check('network: no stray scr* links left', not [n for n in os.listdir('/sys/class/net') if n.startswith('scr')], str(os.listdir('/sys/class/net')))
        except Exception as e:
            check('section network legs completed', False, str(e)[:300])
        print('== devices that change IP (DHCP)')
        movers = []
        mv = None
        def ns(*cmd): subprocess.run(['ip', 'netns', 'exec', NETNS, *cmd], capture_output=True)
        def box(ip):  # one simulated Shield (serial SIM0041) answering on `ip`
            ns('ip', 'addr', 'add', f'{ip}/24', 'dev', 'simeth0')
            p = subprocess.Popen(['ip', 'netns', 'exec', NETNS, 'python3', os.path.join(ROOT, 'tools', 'sim', 'sim.py'), '--android', ip, '--android-base', '40'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            movers.append((p, ip))
            wait(lambda: socket.create_connection((ip, 5555), 1).close() is None, 15, 0.3)
        def unplug():
            p, ip = movers.pop()
            p.terminate(); p.wait(5)
            ns('ip', 'addr', 'del', f'{ip}/24', 'dev', 'simeth0')
        try:
            box('10.99.0.40')
            mv = api('POST', f'/api/sites/{sid}/adopt', {'ip': '10.99.0.40', 'kind': 'android', 'name': 'Mover Shield'})['id']
            ok = wait(lambda: (lambda d: d if d['status'] == 'online' and d.get('serial') == 'SIM0041' else None)(api('GET', f'/api/devices/{mv}')), 40)
            check('dhcp: box adopted (serial SIM0041)', ok)
            # 1. It gets a new lease and goes quiet: a refresh finds it gone, sweeps the subnet and proves it by serial.
            unplug(); box('10.99.0.41')
            try: api('POST', f'/api/devices/{mv}/command', {'command': 'refresh'}, timeout=120)
            except AssertionError: pass
            ok = wait(lambda: api('GET', f'/api/devices/{mv}')['ip'] == '10.99.0.41', 90, 2)
            check('dhcp: device followed to its new IP after it stopped answering', ok, str(api('GET', f'/api/devices/{mv}').get('ip')))
            d = api('GET', f'/api/devices/{mv}')
            check('dhcp: address history recorded', (d['facts'].get('ip_history') or [{}])[0].get('from') == '10.99.0.40', json.dumps(d['facts'].get('ip_history')))
            others = {x['id']: x['ip'] for x in api('GET', f'/api/sites/{sid}')['devices']}
            check('dhcp: shared MAC did not pull other boxes onto the new address', list(others.values()).count('10.99.0.41') == 1, str(others))
            aud = api('GET', f'/api/audit?site_id={sid}&limit=50')
            check('dhcp: move written to the audit log', any(a['action'] == 'device.moved' and a.get('target_id') == mv for a in aud), str([a['action'] for a in aud][:10]))
            # 2. It moves again while someone presses a button: the command finds it and succeeds.
            unplug(); box('10.99.0.42')
            try: socket.create_connection(('10.99.0.42', 5555), 2).close()  # the gateway's kernel learns the new neighbour (same netns)
            except OSError: pass
            time.sleep(16)
            r = api('POST', f'/api/devices/{mv}/command', {'command': 'key', 'args': {'key': 'home'}}, timeout=150)
            check('dhcp: a command after a move finds the box and succeeds', r.get('ok') is not False and api('GET', f'/api/devices/{mv}')['ip'] == '10.99.0.42', json.dumps(r)[:300])
        except Exception as e:
            check('section dhcp moves completed', False, str(e)[:300])
        finally:
            while movers:
                try: unplug()
                except Exception: pass
            try: api('DELETE', f'/api/devices/{mv}')  # don't leave an unreachable box for later sections
            except Exception: pass
        print('== automations')
        try:
            a = api('POST', '/api/automations', {'name': 'E2E: home key', 'scope_type': 'site', 'scope_id': sid, 'trigger': {'type': 'schedule', 'cron': '0 3 * * *'}, 'target': {'kinds': ['android']}, 'actions': [{'type': 'command', 'command': 'key', 'args': {'key': 'HOME'}}]})
            t6 = time.time()
            r = api('POST', f'/api/automations/{a["id"]}/run')
            check('automation run-now executes on target devices', r['ok'] and any('input keyevent 3' in e['cmd'] for e in sim_events('android.shell', t6)), json.dumps(r)[:300])
            try:
                api('POST', '/api/automations', {'name': 'bad', 'trigger': {'type': 'schedule', 'cron': '99 * * *'}, 'actions': [{'type': 'alert', 'severity': 'info', 'title': 'x'}]})
                check('bad cron rejected', False)
            except AssertionError as e:
                check('bad cron rejected', '400' in str(e))

        except Exception as e:
            check('section automations completed', False, str(e)[:300])
        print('== overview + audit')
        try:
            ov = api('GET', '/api/overview')
            check('overview counts', ov['counts']['devices_total'] >= 4 and ov['counts']['gateways_online'] >= 1)
            au = api('GET', '/api/audit?limit=300')  # the launcher v2 section adds ~20 audited actions
            check('audit log records actions', any(x['action'] == 'device.install' for x in au) and any(x['action'] == 'site.guest_reset' for x in au))

        except Exception as e:
            check('section overview + audit completed', False, str(e)[:300])
        print('== gateway self-update')
        try:
            rel = subprocess.run([os.path.join(ROOT, 'tools', 'release-gateway.sh'), '0.0.99-e2e', '--local'], capture_output=True, text=True, timeout=300)
            check('release published to local R2/D1', rel.returncode == 0, (rel.stdout + rel.stderr)[-300:])
            api('POST', f'/api/sites/{sid}/gateway/update', timeout=300)
            try: gw.wait(30); exited = gw.returncode
            except subprocess.TimeoutExpired: exited = None
            newbin = os.path.join(data, 'bin', 'screens-gateway')
            check('gateway downloaded + verified update and exited for restart', exited == 0 and os.path.exists(newbin), f'exit={exited} bin={os.path.exists(newbin)}')
            gw = subprocess.Popen([newbin], env=env, stdout=log, stderr=subprocess.STDOUT)
            ok = wait(lambda: api('GET', f'/api/sites/{sid}/gateway').get('version') == '0.0.99-e2e' and api('GET', f'/api/sites/{sid}')['gateway_status'] == 'online', 40)
            check('gateway back online on the new version (same identity)', ok)
        except Exception as e:
            check('section gateway self-update completed', False, str(e)[:300])

        print('== revoke')
        try:
            api('POST', f'/api/sites/{sid}/gateway/revoke')
            ok = wait(lambda: api('GET', f'/api/sites/{sid}')['gateway_status'] in ('none', 'revoked'), 15)
            check('revoked gateway disconnected and cannot reconnect', ok and wait(lambda: 'revoked' in open(os.path.join(data, 'gateway.log')).read().lower() or '403' in open(os.path.join(data, 'gateway.log')).read(), 20))
        except Exception as e:
            check('section revoke completed', False, str(e)[:300])
    finally:
        gw.send_signal(signal.SIGTERM)
        try: gw.wait(5)
        except Exception: gw.kill()
        log.close()
        print('gateway log:', os.path.join(data, 'gateway.log'))
    passed = sum(1 for r in results if r[1])
    print(f'\n{passed}/{len(results)} checks passed')
    sys.exit(0 if passed == len(results) else 1)

if __name__ == '__main__':
    main()

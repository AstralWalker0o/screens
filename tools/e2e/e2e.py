#!/usr/bin/env python3
"""
End-to-end test: local central (wrangler dev) + real gateway binary + device simulators.

Prereqs (see README):
  - wrangler dev on http://127.0.0.1:8787 (central/wrangler.e2e.jsonc, DEV_AUTH=1)
  - tools/sim/sim.py running with --samsung 10.99.0.20 --sonos 10.99.0.30,10.99.0.31 --android 10.99.0.10,10.99.0.11
  - gateway binary built (gateway/dist/screens-gateway-linux-amd64)
Run as root (DNS port 53, raw multicast).
"""
import json, os, random, shutil, signal, socket, struct, subprocess, sys, tempfile, time, urllib.request

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

def dns_query(name, src_ip, server, qtype=1):
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
    out = subprocess.run(['ip', 'netns', 'exec', NETNS, 'python3', '-c', code, name, src_ip, server], capture_output=True, text=True, timeout=10)
    if out.returncode != 0: raise RuntimeError(out.stderr[-300:])
    rcode, ips = json.loads(out.stdout)
    return rcode, ips

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
            r = api('POST', f'/api/devices/{tv}/command', {'command': 'volume', 'args': {'level': 30}})
            check('samsung absolute volume (UPnP)', r['ok'] and sim_events('samsung.upnp', t4))

        except Exception as e:
            check('section samsung control completed', False, str(e)[:300])
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
            r = api('POST', f'/api/devices/{s2}/command', {'command': 'media', 'args': {'action': 'pause'}})
            acts = [(e['ip'], e['action']) for e in sim_events('sonos.soap', t5)]
            check('sonos transport goes to group coordinator', ('10.99.0.30', 'Pause') in acts, str(acts[-5:]))

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
                priv = api('GET', f'/api/devices/{tv}/privacy')
                check('privacy score computed', 0 <= priv['score'] <= 100 and priv['checklist'], f"score={priv['score']} grade={priv['grade']}")

        except Exception as e:
            check('section DNS filter completed', False, str(e)[:300])
        print('== mDNS reflector')
        try:
            ifaces = [i['name'] for i in gwinfo.get('interfaces') or []]
            cfg = {'enabled': True, 'interfaces': ifaces[:2], 'rules': [{'from': ifaces[0], 'to': ifaces[1:2] or [ifaces[0]], 'allow': ['_sonos._tcp'], 'deny': []}] if ifaces else [], 'ssdp': {'enabled': False, 'rules': []}, 'rate_limit_pps': 100, 'track_services': True}
            r = api('PUT', f'/api/sites/{sid}/mdns', cfg)
            check('mDNS config pushed to gateway', r.get('pushed') is True, json.dumps(r))
            st = api('GET', f'/api/sites/{sid}/mdns')
            check('mDNS status readable', st['status'] is not None, json.dumps(st)[:300])

        except Exception as e:
            check('section mDNS reflector completed', False, str(e)[:300])
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
            au = api('GET', '/api/audit?limit=50')
            check('audit log records actions', any(x['action'] == 'device.install' for x in au) and any(x['action'] == 'site.guest_reset' for x in au))

        except Exception as e:
            check('section overview + audit completed', False, str(e)[:300])
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

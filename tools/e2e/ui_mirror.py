#!/usr/bin/env python3
"""Drive the real dashboard's live mirror player against a real gateway + simulated Shield (needs sims + wrangler dev)."""
import json, os, subprocess, sys, tempfile, time, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
import e2e  # reuse helpers
api, wait, ROOT, BASE = e2e.api, e2e.wait, e2e.ROOT, e2e.BASE
SHOTS = os.environ.get('SHOTS', tempfile.mkdtemp())

cl = api('POST', '/api/clients', {'name': 'UI Mirror'})
site = api('POST', '/api/sites', {'client_id': cl['id'], 'name': f'UI Mirror {int(time.time())}', 'kind': 'residential'})
sid = site['id']
enr = api('POST', f'/api/sites/{sid}/enroll')
data = tempfile.mkdtemp(prefix='screens-gw-ui-')
env = dict(os.environ, SCREENS_CENTRAL_URL=BASE, SCREENS_ENROLL_TOKEN=enr['token'], SCREENS_DATA=data, NO_PROXY='*', no_proxy='*')
gw = subprocess.Popen([e2e.BIN], env=env, stdout=open(os.path.join(data, 'gw.log'), 'w'), stderr=subprocess.STDOUT)
proxy = subprocess.Popen(['node', os.path.join(ROOT, 'tools', 'e2e', 'ui-proxy.mjs'), '8933'], stdout=subprocess.DEVNULL)
try:
    assert wait(lambda: api('GET', f'/api/sites/{sid}')['gateway_status'] == 'online', 30), 'gateway did not come online'
    dev = api('POST', f'/api/sites/{sid}/adopt', {'ip': '10.99.0.11', 'kind': 'android', 'name': 'Lounge Shield'})
    assert wait(lambda: api('GET', f'/api/devices/{dev["id"]}')['status'] == 'online', 40), 'shield not online'
    js = r"""
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.addInitScript(() => { try { localStorage.setItem('theme', 'dark'); localStorage.removeItem('mock'); } catch (e) {} });
  await p.goto('http://127.0.0.1:8933/devices/DEV');
  await p.waitForTimeout(12000);
  const stats = await p.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { canvas: false };
    const x = document.createElement('canvas'); x.width = 64; x.height = 36;
    x.getContext('2d').drawImage(c, 0, 0, 64, 36);
    const d = x.getContext('2d').getImageData(0, 0, 64, 36).data;
    let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return { canvas: true, w: c.width, h: c.height, litPixels: lit, text: document.body.innerText.match(/\d+\s*fps/)?.[0] ?? null, live: /Live/.test(document.body.innerText) };
  });
  // click the middle of the picture: must send a touch to the device
  const box = await (await p.$('canvas')).boundingBox();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: 'SHOT' });
  console.log(JSON.stringify({ stats, errors }));
  await b.close();
})();
""".replace('DEV', dev['id']).replace('SHOT', os.path.join(SHOTS, 'ui-mirror-real-dark-1440.png'))
    t0 = time.time()
    npm_root = subprocess.run(['npm', 'root', '-g'], capture_output=True, text=True).stdout.strip()
    out = subprocess.run(['node', '-e', js], capture_output=True, text=True, timeout=120, env=dict(os.environ, NODE_PATH=npm_root))
    res = json.loads(out.stdout.strip().splitlines()[-1])
    touches = [e for e in e2e.sim_events('android.scrcpy_control', t0) if e['hex'].startswith('02')]
    print(json.dumps({'player': res, 'touch_messages_seen_by_device': len(touches), 'screenshot': os.path.join(SHOTS, 'ui-mirror-real-dark-1440.png')}, indent=1))
    ok = res['stats'].get('canvas') and res['stats'].get('litPixels', 0) > 500 and len(touches) >= 1 and not res['errors']
    print('UI MIRROR', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)
finally:
    gw.terminate(); proxy.terminate()

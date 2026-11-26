import { signAgentUrl } from '../lib/crypto';
import { parseJson, assertPackage, shellQuote, sleep } from '../lib/util';
import type { Adapter, AdapterCtx, KeyName } from './types';
import { AdapterError, requireKey } from './types';

export const ANDROID_KEYCODES: Record<KeyName, number> = {
  UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, OK: 23, BACK: 4, HOME: 3, MENU: 82, PLAY_PAUSE: 85, PLAY: 126, PAUSE: 127,
  STOP: 86, NEXT: 87, PREV: 88, REWIND: 89, FF: 90, VOL_UP: 24, VOL_DOWN: 25, MUTE: 164, POWER: 26, CH_UP: 166,
  CH_DOWN: 167, SETTINGS: 176, SEARCH: 84, INFO: 165, INPUT: 178, GUIDE: 172,
  '0': 7, '1': 8, '2': 9, '3': 10, '4': 11, '5': 12, '6': 13, '7': 14, '8': 15, '9': 16,
};

const serialOf = (ctx: AdapterCtx) => `${ctx.device.ip}:${ctx.device.port || 5555}`;

async function sh(ctx: AdapterCtx, cmd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  if (!ctx.device.ip) throw new AdapterError('bad_device', 'Device has no IP address');
  return ctx.gw('adb.shell', { serial: serialOf(ctx), cmd, timeout_ms: timeoutMs }, timeoutMs + 5_000);
}

/** Parse "@@key=value" marker lines. */
export function parseMarkers(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^@@([a-z_]+)=(.*)$/);
    if (m) r[m[1]] = m[2].trim();
  }
  return r;
}

const INFO_CMD = [
  'echo "@@manufacturer=$(getprop ro.product.manufacturer)"',
  'echo "@@model=$(getprop ro.product.model)"',
  'echo "@@release=$(getprop ro.build.version.release)"',
  'echo "@@sdk=$(getprop ro.build.version.sdk)"',
  'echo "@@serial=$(getprop ro.serialno)"',
  'echo "@@build=$(getprop ro.build.display.id)"',
  'echo "@@device_name=$(settings get global device_name)"',
  'echo "@@wm=$(wm size | tr \'\\n\' \' \')"',
  'echo "@@wake=$(dumpsys power | grep -m1 -o \'mWakefulness=[A-Za-z]*\')"',
  'echo "@@resumed=$(dumpsys activity activities | grep -m1 -E \'mResumedActivity|topResumedActivity\')"',
  'echo "@@pdns_mode=$(settings get global private_dns_mode)"',
  'echo "@@pdns_host=$(settings get global private_dns_specifier)"',
  'echo "@@mac=$(cat /sys/class/net/eth0/address 2>/dev/null || cat /sys/class/net/wlan0/address 2>/dev/null)"',
  'echo "@@uptime=$(cut -d. -f1 /proc/uptime)"',
].join('; ');

export function parseScreen(wm: string): { width: number; height: number } | null {
  const ov = wm.match(/Override size:\s*(\d+)x(\d+)/);
  const ph = wm.match(/Physical size:\s*(\d+)x(\d+)/);
  const m = ov ?? ph;
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export function parseResumed(line: string): string | null {
  const m = line.match(/\s(?:u\d+\s)?([a-zA-Z][\w.]+)\/[\w.$]+/);
  return m ? m[1] : null;
}

/** Parse the multi-section package listing produced by APPS_CMD. */
export function parsePackages(out: string) {
  const sections: Record<string, string[]> = {};
  let cur = '';
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    const sec = line.match(/^@@([A-Z0-9]+)$/);
    if (sec) { cur = sec[1]; sections[cur] = []; continue; }
    if (cur && line) sections[cur].push(line);
  }
  const third = new Set((sections['3P'] ?? []).map((l) => l.replace(/^package:/, '').split(' ')[0]));
  const disabled = new Set((sections['DIS'] ?? []).map((l) => l.replace(/^package:/, '').trim()));
  const mic = new Set((sections['MIC'] ?? []).map((l) => l.trim()).filter((l) => /^[\w.]+$/.test(l)));
  const cam = new Set((sections['CAM'] ?? []).map((l) => l.trim()).filter((l) => /^[\w.]+$/.test(l)));
  const versions: Record<string, string> = {};
  for (const l of sections['VER'] ?? []) {
    const m = l.match(/^(\S+)\s+(.*)$/);
    if (m) versions[m[1]] = m[2].trim();
  }
  const apps: { package: string; path: string; version_code: number | null; system: boolean; enabled: boolean; permissions: string[]; version_name: string | null }[] = [];
  for (const l of sections['ALL'] ?? []) {
    // package:/data/app/~~x==/com.foo-y==/base.apk=com.foo versionCode:123
    const body = l.replace(/^package:/, '');
    const vc = body.match(/\sversionCode:(\d+)/);
    const left = vc ? body.slice(0, vc.index) : body;
    const eq = left.lastIndexOf('=');
    if (eq < 0) continue;
    const path = left.slice(0, eq);
    const pkg = left.slice(eq + 1).trim();
    if (!pkg) continue;
    const perms: string[] = [];
    if (mic.has(pkg)) perms.push('RECORD_AUDIO');
    if (cam.has(pkg)) perms.push('CAMERA');
    apps.push({
      package: pkg, path, version_code: vc ? Number(vc[1]) : null,
      system: !third.has(pkg), enabled: !disabled.has(pkg), permissions: perms, version_name: versions[pkg] || null,
    });
  }
  return apps;
}

const APPS_CMD = [
  'echo @@3P', 'pm list packages -3',
  'echo @@ALL', 'pm list packages -f --show-versioncode',
  'echo @@DIS', 'pm list packages -d',
  'echo @@MIC', 'cmd appops query-op --user 0 RECORD_AUDIO allow 2>/dev/null',
  'echo @@CAM', 'cmd appops query-op --user 0 CAMERA allow 2>/dev/null',
  'echo @@VER', 'for p in $(pm list packages -3 | cut -d: -f2); do echo "$p $(dumpsys package $p | grep -m1 versionName | sed \'s/.*versionName=//\')"; done',
  'echo @@END',
].join('; ');

/** Parse `dumpsys appops --op RECORD_AUDIO` for last-access times. */
export function parseMicUsage(out: string): { package: string; last_access: string | null }[] {
  const res: { package: string; last_access: string | null }[] = [];
  let pkg: string | null = null;
  for (const raw of out.split('\n')) {
    const p = raw.match(/^\s*Package\s+([\w.]+):/);
    if (p) { pkg = p[1]; res.push({ package: pkg, last_access: null }); continue; }
    if (!pkg) continue;
    const a = raw.match(/Access:.*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)?\s*\(([^)]*)\)/) ?? raw.match(/time=\+?([\w\d]+ ago|[^\s]+)/);
    if (a) { const entry = res[res.length - 1]; if (!entry.last_access) entry.last_access = a[2] ? `${a[1]} (${a[2]})` : a[1]; }
  }
  return res;
}

function textArg(s: string): string {
  // `input text` treats %s as space; strip characters it cannot type.
  const cleaned = s.replace(/[^\x20-\x7e]/g, '').slice(0, 500).replace(/%/g, '%%').replace(/ /g, '%s');
  return shellQuote(cleaned);
}

export const android: Adapter = {
  async refresh(ctx) {
    const c = await ctx.gw<{ state: string; output: string }>('adb.connect', { serial: serialOf(ctx) }, 20_000);
    if (c.state === 'unauthorized') return { status: 'unauthorized' };
    if (c.state !== 'device') return { status: 'offline' };
    const r = await sh(ctx, INFO_CMD, 25_000);
    const m = parseMarkers(r.stdout);
    const screen = parseScreen(m.wm ?? '');
    const wake = (m.wake ?? '').replace('mWakefulness=', '');
    const facts: Record<string, unknown> = {
      sdk: Number(m.sdk) || null, build: m.build || null, screen, uptime_s: Number(m.uptime) || null,
      private_dns_mode: m.pdns_mode || null, private_dns_host: m.pdns_host && m.pdns_host !== 'null' ? m.pdns_host : null,
      device_name: m.device_name && m.device_name !== 'null' ? m.device_name : null,
      reported_mac: m.mac || null, // informational: the active-interface MAC comes from the gateway's ARP table
    };
    return {
      status: 'online',
      power: wake === 'Awake' ? 'on' : wake ? 'standby' : 'unknown',
      manufacturer: m.manufacturer || null, model: m.model || null,
      os_version: m.release ? `Android ${m.release}` : null, serial: m.serial || null, firmware: m.build || null,
      current_app: parseResumed(m.resumed ?? ''),
      private_dns: facts.private_dns_mode === 'hostname' ? facts.private_dns_host : null,
      facts,
    };
  },

  async pair(ctx) {
    const c = await ctx.gw<{ state: string; output: string }>('adb.connect', { serial: serialOf(ctx) }, 20_000);
    if (c.state === 'device') return { ok: true, detail: 'Connected. ADB debugging is authorised.' };
    if (c.state === 'unauthorized') return { ok: false, detail: 'Waiting for approval: on the TV, tick "Always allow from this computer" and choose Allow.' };
    return { ok: false, detail: `Could not connect (${c.state}). Check that Network debugging is enabled in Developer options. ${c.output ?? ''}`.trim() };
  },

  async command(ctx, command, args) {
    switch (command) {
      case 'key': {
        const k = requireKey(args.key);
        await sh(ctx, `input keyevent ${ANDROID_KEYCODES[k]}`);
        return { ok: true };
      }
      case 'text': {
        if (typeof args.text !== 'string') throw new AdapterError('bad_args', 'text required');
        await sh(ctx, `input text ${textArg(args.text)}`);
        return { ok: true };
      }
      case 'tap': {
        const facts = parseJson<any>(ctx.device.facts, {});
        const screen = facts.screen ?? { width: 1920, height: 1080 };
        const x = Math.round(Math.min(1, Math.max(0, Number(args.x))) * screen.width);
        const y = Math.round(Math.min(1, Math.max(0, Number(args.y))) * screen.height);
        await sh(ctx, `input tap ${x} ${y}`);
        return { ok: true, x, y };
      }
      case 'power_on': await sh(ctx, 'input keyevent 224'); await ctx.update({ power: 'on' }); return { ok: true };
      case 'power_off': await sh(ctx, 'input keyevent 223'); await ctx.update({ power: 'standby' }); return { ok: true };
      case 'reboot': await sh(ctx, 'svc power reboot 2>/dev/null || reboot', 15_000).catch(() => undefined); return { ok: true };
      case 'volume': {
        if (typeof args.delta === 'number') {
          const code = args.delta > 0 ? 24 : 25;
          const n = Math.min(15, Math.abs(Math.round(args.delta)));
          await sh(ctx, Array.from({ length: n }, () => `input keyevent ${code}`).join('; '));
          return { ok: true };
        }
        const level = Math.min(100, Math.max(0, Number(args.level)));
        const g = await sh(ctx, 'cmd media_session volume --stream 3 --get 2>&1');
        const range = g.stdout.match(/range \[(\d+)\.\.(\d+)\]/);
        const max = range ? Number(range[2]) : 15;
        await sh(ctx, `cmd media_session volume --stream 3 --set ${Math.round((level / 100) * max)} 2>&1`);
        return { ok: true };
      }
      case 'mute': await sh(ctx, 'input keyevent 164'); return { ok: true };
      case 'media': {
        const map: Record<string, number> = { play: 126, pause: 127, next: 87, prev: 88, stop: 86, toggle: 85 };
        const code = map[String(args.action)];
        if (!code) throw new AdapterError('bad_args', 'action must be play|pause|next|prev|stop|toggle');
        await sh(ctx, `input keyevent ${code}`);
        return { ok: true };
      }
      case 'apps': return listApps(ctx);
      case 'launch': {
        const p = assertPackage(args.package);
        const r = await sh(ctx, `monkey -p ${p} -c android.intent.category.LEANBACK_LAUNCHER 1 2>&1 | grep -q 'No activities' && monkey -p ${p} -c android.intent.category.LAUNCHER 1 2>&1; echo done`);
        return { ok: true, output: r.stdout.slice(-500) };
      }
      case 'stop': await sh(ctx, `am force-stop ${assertPackage(args.package)}`); return { ok: true };
      case 'clear': {
        const r = await sh(ctx, `pm clear ${assertPackage(args.package)}`);
        return { ok: /Success/.test(r.stdout), output: r.stdout.trim() };
      }
      case 'disable': {
        const r = await sh(ctx, `pm disable-user --user 0 ${assertPackage(args.package)}`);
        return { ok: /disabled/.test(r.stdout), output: r.stdout.trim() };
      }
      case 'enable': {
        const r = await sh(ctx, `pm enable ${assertPackage(args.package)}`);
        return { ok: /enabled/.test(r.stdout), output: r.stdout.trim() };
      }
      case 'uninstall': {
        const p = assertPackage(args.package);
        const isSystem = (await sh(ctx, `pm list packages -3 ${p}`)).stdout.split('\n').every((l) => l.trim() !== `package:${p}`);
        if (isSystem) {
          // System apps can only be removed for the user; restorable with `cmd package install-existing`.
          const r = await sh(ctx, `pm uninstall -k --user 0 ${p}`);
          return { ok: /Success/.test(r.stdout), output: r.stdout.trim(), system: true };
        }
        const r = await ctx.gw('adb.uninstall', { serial: serialOf(ctx), package: p, keep_data: !!args.keep_data }, 60_000);
        return { ok: /Success/i.test(r.output ?? ''), output: r.output };
      }
      case 'restore': {
        const r = await sh(ctx, `cmd package install-existing ${assertPackage(args.package)}`);
        return { ok: /installed/i.test(r.stdout), output: r.stdout.trim() };
      }
      case 'install': {
        const apk = await ctx.env.DB.prepare('SELECT * FROM apks WHERE id = ?').bind(String(args.apk_id)).first<any>();
        if (!apk) throw new AdapterError('not_found', 'APK not found in library');
        const url = await signAgentUrl(ctx.env.SIGNING_SECRET, ctx.origin, 'GET', apk.r2_key, 30 * 60_000);
        const r = await ctx.gw('adb.install', { serial: serialOf(ctx), url, sha256: apk.sha256, flags: ['-r', '-g'] }, 600_000);
        return { ok: /Success/i.test(r.output ?? ''), output: r.output };
      }
      case 'play_store': {
        await sh(ctx, `am start -a android.intent.action.VIEW -d ${shellQuote(`market://details?id=${assertPackage(args.package)}`)}`);
        return { ok: true };
      }
      case 'screenshot': {
        const ts = Date.now();
        const key = `shots/${ctx.device.id}/${ts}.jpg`;
        const upload_url = await signAgentUrl(ctx.env.SIGNING_SECRET, ctx.origin, 'PUT', key, 5 * 60_000);
        const r = await ctx.gw<{ bytes: number; width: number; height: number }>('adb.screencap', { serial: serialOf(ctx), upload_url, max_width: 1280, quality: 70 }, 45_000);
        const facts = parseJson<any>(ctx.device.facts, {});
        const prev = facts.last_screenshot as string | undefined;
        await ctx.update({ facts: { last_screenshot: key, last_screenshot_at: ts, screenshot_size: { width: r.width, height: r.height } } });
        if (prev && prev !== key) ctx.env.FILES.delete(prev).catch(() => undefined);
        return { ok: true, url: `/api/devices/${ctx.device.id}/screenshot?ts=${ts}`, width: r.width, height: r.height, at: ts };
      }
      case 'shell': {
        if (typeof args.cmd !== 'string' || !args.cmd.trim()) throw new AdapterError('bad_args', 'cmd required');
        return sh(ctx, args.cmd, Math.min(Number(args.timeout_ms) || 30_000, 120_000));
      }
      case 'toast': {
        const msg = String(args.message ?? '').slice(0, 200);
        await sh(ctx, `cmd notification post -S bigtext -t Screens screens ${shellQuote(msg)}`);
        return { ok: true };
      }
      case 'adb_pair': {
        // Android 11+ "Wireless debugging": Developer options → Wireless debugging → Pair device with pairing code.
        const code = String(args.code ?? '');
        const port = Number(args.port);
        if (!/^\d{6}$/.test(code) || !(port > 0 && port < 65536)) throw new AdapterError('bad_args', 'Enter the 6-digit pairing code and the pairing port shown on the TV');
        const r = await ctx.gw<{ ok: boolean; output: string }>('adb.pair', { host: ctx.device.ip, port, code }, 30_000);
        if (!r.ok) return { ok: false, detail: `Pairing failed: ${String(r.output ?? '').slice(-200)}` };
        if (args.connect_port && Number(args.connect_port) > 0) await ctx.update({ facts: { adb_tls: true } });
        return { ok: true, detail: 'Paired. Screens will now connect using the wireless debugging port.' };
      }
      case 'private_dns': return setPrivateDns(ctx, !!args.enabled, String(args.hostname ?? ''));
      case 'revoke_permission':
      case 'grant_permission': {
        const p = assertPackage(args.package);
        const perm = PRIVACY_PERMISSIONS[String(args.permission)];
        if (!perm) throw new AdapterError('bad_args', `permission must be one of ${Object.keys(PRIVACY_PERMISSIONS).join(', ')}`);
        const revoke = command === 'revoke_permission';
        // pm revoke works for runtime permissions; appops covers apps (incl. system ones) where revoke is refused.
        const r = await sh(ctx, `pm ${revoke ? 'revoke' : 'grant'} ${p} ${perm.permission} 2>&1; cmd appops set ${p} ${perm.op} ${revoke ? 'ignore' : 'allow'} 2>&1; echo "@@mode=$(cmd appops get ${p} ${perm.op} 2>&1 | head -1)"`);
        const mode = parseMarkers(r.stdout).mode ?? '';
        const ok = revoke ? /ignore|deny/.test(mode) || !/allow/.test(mode) : /allow|default/.test(mode);
        return { ok, permission: args.permission, mode, output: r.stdout.replace(/@@mode=.*\n?/, '').trim().slice(0, 300) };
      }
      case 'debloat': {
        // Disable (never uninstall) the packages Screens' catalog marks as bloat/telemetry. Reversible with "enable".
        const targets = ((args.packages as string[]) ?? []).map(assertPackage);
        const installed = new Set((await sh(ctx, 'pm list packages -e')).stdout.split('\n').map((l) => l.replace('package:', '').trim()));
        const done: string[] = []; const failed: string[] = [];
        for (const p of targets.filter((x) => installed.has(x))) {
          const r = await sh(ctx, `pm disable-user --user 0 ${p} 2>&1`);
          (/disabled/.test(r.stdout) ? done : failed).push(p);
        }
        return { ok: failed.length === 0, disabled: done, failed, skipped: targets.filter((x) => !installed.has(x)) };
      }
      case 'mic_usage': {
        const r = await sh(ctx, 'dumpsys appops --op RECORD_AUDIO 2>/dev/null | head -400', 30_000);
        return parseMicUsage(r.stdout);
      }
      case 'guest_reset': {
        const r = await guestReset(ctx, (args.packages as string[]) ?? [], !!args.go_home && !args.show_welcome, !!args.reboot);
        if (args.show_welcome && !args.reboot) {
          await sh(ctx, `am start -n ${LAUNCHER_PKG}/.WelcomeActivity`).catch(() => undefined);
          (r as any).welcome = true;
        }
        return r;
      }
      case 'launcher_install': {
        const apk = args.apk as { r2_key: string; sha256: string; version_name?: string } | undefined;
        if (!apk) throw new AdapterError('not_found', 'The Screens Launcher APK has not been published to the library yet');
        const url = await signAgentUrl(ctx.env.SIGNING_SECRET, ctx.origin, 'GET', apk.r2_key, 30 * 60_000);
        const inst = await ctx.gw('adb.install', { serial: serialOf(ctx), url, sha256: apk.sha256, flags: ['-r'] }, 600_000);
        if (!/Success/i.test(inst.output ?? '')) return { ok: false, detail: `Install failed: ${String(inst.output ?? '').slice(-300)}` };
        const cfg = await launcherConfigure(ctx, String(args.config_b64 ?? ''));
        await sh(ctx, `cmd package set-home-activity ${LAUNCHER_PKG}/.LauncherActivity 2>&1`).catch(() => undefined);
        if (args.force_home) await sh(ctx, STOCK_LAUNCHERS.map((p) => `pm disable-user --user 0 ${p} 2>/dev/null`).join('; ')).catch(() => undefined);
        await sh(ctx, 'input keyevent 3').catch(() => undefined);
        const st = await launcherStatus(ctx);
        await ctx.update({ facts: { launcher: st } });
        return { ok: true, config: cfg, status: st };
      }
      case 'launcher_config': {
        const cfg = await launcherConfigure(ctx, String(args.config_b64 ?? ''));
        const st = await launcherStatus(ctx);
        await ctx.update({ facts: { launcher: st } });
        return { ok: cfg.ok, detail: cfg.detail, status: st };
      }
      case 'launcher_status': {
        const st = await launcherStatus(ctx);
        await ctx.update({ facts: { launcher: st } });
        return { ok: true, status: st };
      }
      case 'launcher_remove': {
        await sh(ctx, STOCK_LAUNCHERS.map((p) => `pm enable ${p} 2>/dev/null`).join('; ')).catch(() => undefined);
        const r = await ctx.gw('adb.uninstall', { serial: serialOf(ctx), package: LAUNCHER_PKG }, 60_000).catch((e: any) => ({ output: e.message }));
        await sh(ctx, 'input keyevent 3').catch(() => undefined);
        await ctx.update({ facts: { launcher: { installed: false, checked_at: Date.now() } } });
        return { ok: /Success|not installed|Unknown package/i.test(r.output ?? ''), output: r.output };
      }
      case 'welcome_show': {
        await sh(ctx, `am start -n ${LAUNCHER_PKG}/.WelcomeActivity`);
        return { ok: true };
      }
      default: throw new AdapterError('not_supported', `Android devices don't support "${command}"`);
    }
  },
};

export const LAUNCHER_PKG = 'au.supercluster.screens.launcher';

/** Privacy-sensitive permissions the dashboard can revoke per app. */
export const PRIVACY_PERMISSIONS: Record<string, { permission: string; op: string }> = {
  microphone: { permission: 'android.permission.RECORD_AUDIO', op: 'RECORD_AUDIO' },
  camera: { permission: 'android.permission.CAMERA', op: 'CAMERA' },
  location: { permission: 'android.permission.ACCESS_FINE_LOCATION', op: 'FINE_LOCATION' },
  contacts: { permission: 'android.permission.READ_CONTACTS', op: 'READ_CONTACTS' },
};
const STOCK_LAUNCHERS = ['com.google.android.tvlauncher', 'com.google.android.apps.tv.launcherx'];

/** Parse `am broadcast` output: Broadcast completed: result=1, data="ok:..." */
export function parseBroadcast(out: string): { result: number | null; data: string | null } {
  const m = out.match(/Broadcast completed: result=(-?\d+)(?:, data="((?:[^"\\]|\\.)*)")?/);
  return { result: m ? Number(m[1]) : null, data: m?.[2] != null ? m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null };
}

async function launcherConfigure(ctx: AdapterCtx, configB64: string) {
  if (!/^[A-Za-z0-9+/=]+$/.test(configB64) || configB64.length > 90_000) throw new AdapterError('bad_args', 'Invalid launcher config');
  const r = await sh(ctx, `am broadcast -a ${LAUNCHER_PKG}.CONFIG -n ${LAUNCHER_PKG}/.ConfigReceiver --es config_b64 ${configB64}`);
  const b = parseBroadcast(r.stdout);
  if (b.result === 1 && b.data?.startsWith('ok:')) return { ok: true, sha: b.data.slice(3) };
  return { ok: false, detail: b.data ?? (r.stdout.trim().slice(-200) || 'No answer from the Screens Launcher (is it installed?)') };
}

async function launcherStatus(ctx: AdapterCtx) {
  const r = await sh(ctx, `am broadcast -a ${LAUNCHER_PKG}.STATUS -n ${LAUNCHER_PKG}/.ConfigReceiver`);
  const b = parseBroadcast(r.stdout);
  if (b.result === 1 && b.data?.startsWith('status:')) {
    const st = parseJson<any>(b.data.slice(7), {});
    return { installed: true, version: st.version ?? null, config_sha: st.config_sha ?? null, is_home: !!st.is_home, checked_at: Date.now() };
  }
  return { installed: false, checked_at: Date.now() };
}

async function listApps(ctx: AdapterCtx) {
  const r = await sh(ctx, APPS_CMD, 90_000);
  return parsePackages(r.stdout);
}

async function guestReset(ctx: AdapterCtx, packages: string[], goHome: boolean, reboot: boolean) {
  const installed = new Set((await sh(ctx, 'pm list packages')).stdout.split('\n').map((l) => l.replace('package:', '').trim()));
  const targets = packages.filter((p) => installed.has(p)).map(assertPackage);
  const cleared: string[] = []; const failed: string[] = [];
  for (const p of targets) {
    const r = await sh(ctx, `am force-stop ${p}; pm clear ${p}`, 30_000);
    (/Success/.test(r.stdout) ? cleared : failed).push(p);
  }
  if (goHome) await sh(ctx, 'input keyevent 3').catch(() => undefined);
  if (reboot) await sh(ctx, 'svc power reboot 2>/dev/null || reboot', 10_000).catch(() => undefined);
  return { ok: failed.length === 0, cleared, failed, skipped: packages.filter((p) => !installed.has(p)) };
}

/**
 * Point Android's Private DNS (DNS-over-TLS) at this site's gateway.
 * Safety: we verify that the device still resolves names afterwards and revert automatically if it doesn't.
 */
async function setPrivateDns(ctx: AdapterCtx, enabled: boolean, hostname: string) {
  const before = parseMarkers((await sh(ctx, 'echo "@@mode=$(settings get global private_dns_mode)"; echo "@@host=$(settings get global private_dns_specifier)"')).stdout);
  if (!enabled) {
    await sh(ctx, 'settings put global private_dns_mode opportunistic');
    await ctx.update({ private_dns: null });
    return { ok: true, mode: 'opportunistic' };
  }
  if (!/^[a-z0-9.-]+$/.test(hostname)) throw new AdapterError('bad_args', 'Private DNS hostname not configured for this site');
  // Can the device resolve + reach the DoT hostname at all?
  const pre = await sh(ctx, `ping -c 1 -W 3 ${hostname} >/dev/null 2>&1 && echo OK || echo FAIL`, 15_000);
  if (!pre.stdout.includes('OK')) {
    return { ok: false, detail: `The TV can't reach ${hostname}. Check the gateway's DNS-over-TLS status first. Nothing was changed.` };
  }
  await sh(ctx, `settings put global private_dns_specifier ${hostname}; settings put global private_dns_mode hostname`);
  await sleep(4000);
  const check = await sh(ctx, 'ping -c 1 -W 4 connectivitycheck.gstatic.com >/dev/null 2>&1 && echo OK || echo FAIL', 15_000);
  if (!check.stdout.includes('OK')) {
    const mode = before.mode && before.mode !== 'null' ? before.mode : 'opportunistic';
    await sh(ctx, `settings put global private_dns_mode ${shellQuote(mode)}`);
    return { ok: false, reverted: true, detail: 'The device lost DNS after switching, so it was switched back automatically.' };
  }
  await ctx.update({ private_dns: hostname });
  return { ok: true, mode: 'hostname', hostname };
}

import { b64Encode } from '../lib/crypto';
import { parseJson, sleep } from '../lib/util';
import type { Adapter, AdapterCtx, HubStream, KeyName } from './types';
import { AdapterError, requireKey, xmlEscape } from './types';

/**
 * Samsung Tizen TVs (2016+) — local WebSocket remote API.
 *   info:   GET  http://ip:8001/api/v2/
 *   remote: wss://ip:8002/api/v2/channels/samsung.remote.control?name=<b64>&token=<t>
 * First connection shows an "Allow" prompt on the TV; the TV then issues a token we keep (encrypted).
 * Power-on needs "Power On with Mobile" / network standby enabled on the TV (we send Wake-on-LAN + KEY_POWER).
 */
export const SAMSUNG_KEYS: Record<KeyName, string> = {
  UP: 'KEY_UP', DOWN: 'KEY_DOWN', LEFT: 'KEY_LEFT', RIGHT: 'KEY_RIGHT', OK: 'KEY_ENTER', BACK: 'KEY_RETURN',
  HOME: 'KEY_HOME', MENU: 'KEY_MENU', PLAY_PAUSE: 'KEY_PLAY', PLAY: 'KEY_PLAY', PAUSE: 'KEY_PAUSE', STOP: 'KEY_STOP',
  NEXT: 'KEY_FF', PREV: 'KEY_REWIND', REWIND: 'KEY_REWIND', FF: 'KEY_FF', VOL_UP: 'KEY_VOLUP', VOL_DOWN: 'KEY_VOLDOWN',
  MUTE: 'KEY_MUTE', POWER: 'KEY_POWER', CH_UP: 'KEY_CHUP', CH_DOWN: 'KEY_CHDOWN', SETTINGS: 'KEY_MENU',
  SEARCH: 'KEY_HOME', INFO: 'KEY_INFO', INPUT: 'KEY_SOURCE', GUIDE: 'KEY_GUIDE',
  '0': 'KEY_0', '1': 'KEY_1', '2': 'KEY_2', '3': 'KEY_3', '4': 'KEY_4', '5': 'KEY_5', '6': 'KEY_6', '7': 'KEY_7', '8': 'KEY_8', '9': 'KEY_9',
};

const CLIENT_NAME = b64Encode(new TextEncoder().encode('Screens'));

/** The `event` field of a TV message (parsed, so formatting/whitespace never matters). */
export function eventOf(m: string): string {
  try { return String(JSON.parse(m)?.event ?? ''); } catch { return ''; }
}

interface SamsungSecrets { token?: string }

async function deviceInfo(ctx: AdapterCtx): Promise<any | null> {
  try {
    const r = await ctx.gw('http.request', { url: `http://${ctx.device.ip}:8001/api/v2/`, timeout_ms: 4000 }, 8000);
    if (r.status !== 200 || !r.body) return null;
    return JSON.parse(r.body);
  } catch {
    return null;
  }
}

/** Per-isolate cache of open remote-control sessions, keyed by device id. */
const sessions = new Map<string, { stream: HubStream; at: number }>();

const MENU = 'Settings → All Settings → Connection → External Device Manager → Device Connection Manager (older TVs: Settings → General → External Device Manager → Device Connection Manager)';
export const SAMSUNG_HELP = {
  refused: `The TV refused the connection without asking. On the TV open ${MENU}: set "Access Notification" to "First Time Only" (or "Always On"), and in "Device List" delete or allow "Screens" if it's there. Then press Pair and choose Allow on the TV.`,
  timeout: 'The TV asked "Allow Screens to connect?" but nobody answered in time. Press Pair again and choose Allow with the TV remote within about 30 seconds.',
  waiting: 'Waiting for approval: choose Allow on the TV when it asks to let "Screens" connect, then press Pair again.',
  silent: `The TV did not respond to the pairing request. Check ${MENU} → "Access Notification" is "First Time Only" or "Always On", make sure the TV is fully on (not in standby), then press Pair again.`,
};

/**
 * Open the remote-control channel. Handles both behaviours seen in the wild:
 *  - classic Tizen: the TV sends ms.channel.connect (or unauthorized/timeOut) right after the handshake;
 *  - Tizen 9 (2024+): the TV stays silent until the client sends a register frame, answers ms.error "No Authorized"
 *    while the Allow prompt is shown, then sends ms.channel.connect with the token once accepted.
 */
async function remote(ctx: AdapterCtx, waitForApprovalMs = 8000): Promise<HubStream> {
  const cached = sessions.get(ctx.device.id);
  if (cached && !cached.stream.closed && Date.now() - cached.at < 120_000) { cached.at = Date.now(); return cached.stream; }
  cached?.stream.close();
  const facts = parseJson<any>(ctx.device.facts, {});
  const secrets = await ctx.getSecrets<SamsungSecrets>();
  const secure = facts.token_auth !== false;
  const url = secure
    ? `wss://${ctx.device.ip}:8002/api/v2/channels/samsung.remote.control?name=${encodeURIComponent(CLIENT_NAME)}${secrets.token ? `&token=${secrets.token}` : ''}`
    : `ws://${ctx.device.ip}:8001/api/v2/channels/samsung.remote.control?name=${encodeURIComponent(CLIENT_NAME)}`;
  const stream = await ctx.openWs(url, { insecure_tls: true });
  const deadline = Date.now() + waitForApprovalMs;
  let registered = false, promptShown = false;
  const fail = async (event: string, code: string, message: string): Promise<never> => {
    stream.close();
    await ctx.update({ facts: { pairing_event: event, pairing_detail: message, pairing_at: Date.now() } });
    throw new AdapterError(code, message);
  };
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return fail(promptShown ? 'waiting' : 'silent', 'pairing', promptShown ? SAMSUNG_HELP.waiting : SAMSUNG_HELP.silent);
    // Give classic firmware ~2.5 s to speak first; then send the Tizen 9 register frame once.
    const raw = await stream.next(() => true, registered ? left : Math.min(left, 2500)).catch((e: any) => (e?.code === 'closed' ? 'CLOSED' : null));
    if (raw === 'CLOSED') return fail('closed', 'unauthorized', SAMSUNG_HELP.refused);
    if (raw === null) {
      if (!registered) {
        registered = true;
        stream.send(JSON.stringify({ method: 'ms.channel.connect', params: { deviceName: 'Screens', id: ctx.device.id, type: 'native', token: secrets.token ?? '' } }));
      }
      continue;
    }
    const msg = parseJson<any>(raw, {});
    const ev = String(msg.event ?? '');
    if (ev === 'ms.channel.connect') {
      const token = msg.data?.token;
      if (token && token !== secrets.token) await ctx.setSecrets({ ...secrets, token: String(token) });
      if (facts.pairing_event) await ctx.update({ facts: { pairing_event: 'connected', pairing_detail: null, pairing_at: Date.now() } });
      sessions.set(ctx.device.id, { stream, at: Date.now() });
      return stream;
    }
    if (ev === 'ms.channel.unauthorized') return fail('unauthorized', 'unauthorized', SAMSUNG_HELP.refused);
    if (ev === 'ms.channel.timeOut') return fail('timeOut', 'pairing', SAMSUNG_HELP.timeout);
    if (ev === 'ms.error') {
      if (/no authori[sz]ed/i.test(String(msg.data?.message ?? ''))) { promptShown = true; continue; } // Tizen 9: prompt is on screen
      return fail('error', 'failed', `The TV reported an error: ${String(msg.data?.message ?? 'unknown')}`);
    }
    // other events (ms.channel.clientConnect, ready, …) are informational
  }
}

async function sendKey(ctx: AdapterCtx, key: string) {
  const s = await remote(ctx);
  s.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } }));
}

async function soapVolume(ctx: AdapterCtx, level: number) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${xmlEscape(String(level))}</DesiredVolume></u:SetVolume></s:Body></s:Envelope>`;
  const r = await ctx.gw('http.request', {
    url: `http://${ctx.device.ip}:9197/upnp/control/RenderingControl1`, method: 'POST', body,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: '"urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"' }, timeout_ms: 4000,
  }, 8000);
  return r.status === 200;
}

export const samsung: Adapter = {
  async refresh(ctx) {
    const info = await deviceInfo(ctx);
    if (!info) {
      return { status: 'offline', power: 'off' };
    }
    const d = info.device ?? {};
    const power = d.PowerState === 'standby' ? 'standby' : 'on';
    return {
      status: power === 'standby' ? 'standby' : 'online', power,
      manufacturer: 'Samsung', model: d.modelName ?? d.model ?? null, os_version: d.OS ? `${d.OS}` : 'Tizen',
      firmware: d.firmwareVersion ?? d.version ?? null,
      facts: {
        token_auth: String(d.TokenAuthSupport ?? 'true') === 'true', frame_tv: String(d.FrameTVSupport) === 'true',
        resolution: d.resolution ?? null, network_type: d.networkType ?? null, tv_name: htmlUnescape(d.name ?? info.name ?? null),
        model_code: d.model ?? null, voice_support: d.VoiceSupport ?? null, developer_mode: d.developerMode ?? null,
        wifi_mac: d.wifiMac ?? null, // the TV reports its Wi-Fi MAC even when wired; WoL uses the ARP-learned MAC
      },
    };
  },

  async pair(ctx) {
    try {
      await remote(ctx, 45_000);
      return { ok: true, detail: 'Paired. The TV accepted the Screens remote.' };
    } catch (e: any) {
      return { ok: false, detail: e.message };
    }
  },

  async command(ctx, command, args) {
    switch (command) {
      case 'key': await sendKey(ctx, SAMSUNG_KEYS[requireKey(args.key)]); return { ok: true };
      case 'text': {
        const s = await remote(ctx);
        s.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: b64Encode(new TextEncoder().encode(String(args.text ?? ''))), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' } }));
        return { ok: true };
      }
      case 'power_on': {
        const mac = ctx.device.mac ?? parseJson<any>(ctx.device.facts, {}).wifi_mac ?? null;
        if (mac) await ctx.gw('net.wol', { mac }, 5000).catch(() => undefined);
        await sleep(1500);
        const info = await deviceInfo(ctx);
        if (info?.device?.PowerState === 'standby') await sendKey(ctx, 'KEY_POWER');
        await ctx.update({ power: 'on' });
        return { ok: true, detail: mac ? 'Wake-on-LAN sent' : 'No MAC address known; tried KEY_POWER only' };
      }
      case 'power_off': {
        const info = await deviceInfo(ctx);
        if (info && info.device?.PowerState !== 'standby') await sendKey(ctx, 'KEY_POWER');
        await ctx.update({ power: 'standby', status: 'standby' });
        return { ok: true };
      }
      case 'volume': {
        if (typeof args.delta === 'number') {
          const key = args.delta > 0 ? 'KEY_VOLUP' : 'KEY_VOLDOWN';
          for (let i = 0; i < Math.min(15, Math.abs(Math.round(args.delta))); i++) await sendKey(ctx, key);
          return { ok: true };
        }
        const ok = await soapVolume(ctx, Math.round(Math.min(100, Math.max(0, Number(args.level)))));
        return { ok, detail: ok ? undefined : 'This TV does not accept absolute volume; use + / −' };
      }
      case 'mute': await sendKey(ctx, 'KEY_MUTE'); return { ok: true };
      case 'media': {
        const map: Record<string, string> = { play: 'KEY_PLAY', pause: 'KEY_PAUSE', stop: 'KEY_STOP', next: 'KEY_FF', prev: 'KEY_REWIND', toggle: 'KEY_PLAY' };
        await sendKey(ctx, map[String(args.action)] ?? 'KEY_PLAY');
        return { ok: true };
      }
      case 'apps': {
        const s = await remote(ctx);
        s.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } }));
        const msg = JSON.parse(await s.next((m) => eventOf(m) === 'ed.installedApp.get', 10_000));
        const list: any[] = msg.data?.data ?? [];
        return list.map((a) => ({
          package: String(a.appId), app_id: String(a.appId), label: a.name ?? null, system: false, enabled: true,
          permissions: [], version_name: null, version_code: null, icon: a.icon ? `http://${ctx.device.ip}:8001${a.icon}` : null,
          app_type: a.app_type,
        }));
      }
      case 'launch': {
        const appId = String(args.app_id ?? args.package ?? '');
        if (!/^[\w.]+$/.test(appId)) throw new AdapterError('bad_args', 'app_id required');
        const s = await remote(ctx);
        const type = Number(args.app_type ?? 2);
        s.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId, action_type: type === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH' } } }));
        return { ok: true };
      }
      case 'input': {
        const map: Record<string, string> = { TV: 'KEY_TV', HDMI1: 'KEY_HDMI1', HDMI2: 'KEY_HDMI2', HDMI3: 'KEY_HDMI3', HDMI4: 'KEY_HDMI4', SOURCE: 'KEY_SOURCE' };
        const key = map[String(args.source ?? '').toUpperCase()];
        if (!key) throw new AdapterError('bad_args', 'source must be TV, HDMI1–HDMI4 or SOURCE');
        await sendKey(ctx, key);
        return { ok: true };
      }
      case 'guest_reset': {
        // Tizen has no local API for clearing app data; return to Home as a best effort.
        await sendKey(ctx, 'KEY_HOME');
        return { ok: true, detail: 'Samsung TVs do not allow remote sign-out of apps. Returned to Home.' };
      }
      default: throw new AdapterError('not_supported', `Samsung TVs don't support "${command}"`);
    }
  },
};

/** Samsung's REST API HTML-escapes names ("75&quot; QLED"). */
export function htmlUnescape(s: string | null): string | null {
  if (s == null) return s;
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

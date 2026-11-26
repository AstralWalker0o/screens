import { parseJson, sleep } from '../lib/util';
import type { Adapter, AdapterCtx, HubStream, KeyName } from './types';
import { AdapterError, requireKey } from './types';

/**
 * LG webOS TVs — SSAP over WebSocket (wss://ip:3001, self-signed).
 * BETA: written against the public SSAP API but not yet tested on a real LG set.
 * Registration payload adapted from the open-source aiowebostv library (Apache-2.0).
 */
const SIGNATURE =
  'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR' +
  '+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4' +
  'RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM' +
  '2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==';

function registration(clientKey?: string) {
  return {
    type: 'register', id: 'register_0',
    payload: {
      forcePairing: false, pairingType: 'PROMPT', ...(clientKey ? { 'client-key': clientKey } : {}),
      manifest: {
        appVersion: '1.1', manifestVersion: 1,
        permissions: ['LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED', 'CONTROL_AUDIO', 'CONTROL_DISPLAY',
          'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER',
          'CONTROL_TV_SCREEN', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_RUNNING_APPS',
          'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE', 'READ_COUNTRY_INFO', 'CONTROL_INPUT_TEXT',
          'CONTROL_MOUSE_AND_KEYBOARD', 'READ_INSTALLED_APPS', 'READ_SETTINGS'],
        signatures: [{ signature: SIGNATURE, signatureVersion: 1 }],
        signed: {
          appId: 'com.lge.test', created: '20140509',
          localizedAppNames: { '': 'LG Remote App', 'ko-KR': '리모컨 앱', 'zxx-XX': 'ЛГ Rэмotэ AПП' },
          localizedVendorNames: { '': 'LG Electronics' },
          permissions: ['TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD', 'READ_INSTALLED_APPS', 'READ_LGE_SDX',
            'READ_NOTIFICATIONS', 'SEARCH', 'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER', 'READ_CURRENT_CHANNEL',
            'READ_RUNNING_APPS', 'READ_UPDATE_INFO', 'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME'],
          serial: '2f930e2d2cfe083771f68e4fe7bb07', vendorId: 'com.lge',
        },
      },
    },
  };
}

const LG_BUTTONS: Record<KeyName, string> = {
  UP: 'UP', DOWN: 'DOWN', LEFT: 'LEFT', RIGHT: 'RIGHT', OK: 'ENTER', BACK: 'BACK', HOME: 'HOME', MENU: 'MENU',
  PLAY_PAUSE: 'PLAY', PLAY: 'PLAY', PAUSE: 'PAUSE', STOP: 'STOP', NEXT: 'FASTFORWARD', PREV: 'REWIND', REWIND: 'REWIND',
  FF: 'FASTFORWARD', VOL_UP: 'VOLUMEUP', VOL_DOWN: 'VOLUMEDOWN', MUTE: 'MUTE', POWER: 'POWER', CH_UP: 'CHANNELUP',
  CH_DOWN: 'CHANNELDOWN', SETTINGS: 'QMENU', SEARCH: 'HOME', INFO: 'INFO', INPUT: 'INPUT_HUB', GUIDE: 'GUIDE',
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
};

interface LgSecrets { client_key?: string }
const sessions = new Map<string, { stream: HubStream; at: number; seq: number; input?: HubStream }>();

async function session(ctx: AdapterCtx, approvalMs = 8000) {
  const s = sessions.get(ctx.device.id);
  if (s && !s.stream.closed && Date.now() - s.at < 120_000) { s.at = Date.now(); return s; }
  s?.stream.close(); s?.input?.close();
  const secrets = await ctx.getSecrets<LgSecrets>();
  const stream = await ctx.openWs(`wss://${ctx.device.ip}:3001/`, { insecure_tls: true });
  stream.send(JSON.stringify(registration(secrets.client_key)));
  const deadline = Date.now() + approvalMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) { stream.close(); throw new AdapterError('pairing', 'Waiting for approval: accept the connection prompt on the LG TV, then try again.'); }
    const raw = await stream.next(undefined, left).catch(() => null);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (msg.type === 'registered') {
      const key = msg.payload?.['client-key'];
      if (key && key !== secrets.client_key) await ctx.setSecrets({ ...secrets, client_key: key });
      break;
    }
    if (msg.type === 'error') { stream.close(); throw new AdapterError('unauthorized', `LG TV refused pairing: ${msg.error ?? 'unknown error'}`); }
  }
  const entry = { stream, at: Date.now(), seq: 1 } as { stream: HubStream; at: number; seq: number; input?: HubStream };
  sessions.set(ctx.device.id, entry);
  return entry;
}

async function request(ctx: AdapterCtx, uri: string, payload?: unknown, timeoutMs = 8000): Promise<any> {
  const s = await session(ctx);
  const id = `req_${s.seq++}`;
  s.stream.send(JSON.stringify({ type: 'request', id, uri: `ssap://${uri}`, ...(payload ? { payload } : {}) }));
  const raw = await s.stream.next((m) => m.includes(`"${id}"`), timeoutMs);
  const msg = JSON.parse(raw);
  if (msg.type === 'error' || msg.payload?.returnValue === false) throw new AdapterError('failed', `LG ${uri}: ${msg.error ?? msg.payload?.errorText ?? 'failed'}`);
  return msg.payload ?? {};
}

async function button(ctx: AdapterCtx, name: string) {
  const s = await session(ctx);
  if (!s.input || s.input.closed) {
    const r = await request(ctx, 'com.webos.service.networkinput/getPointerInputSocket');
    if (!r.socketPath) throw new AdapterError('failed', 'TV did not provide an input socket');
    s.input = await ctx.openWs(String(r.socketPath).replace(/^ws:\/\/[^/]+/, `wss://${ctx.device.ip}:3001`).replace(/^wss:\/\/[^/]+/, `wss://${ctx.device.ip}:3001`), { insecure_tls: true });
  }
  s.input.send(`type:button\nname:${name}\n\n`);
}

export const lg: Adapter = {
  async refresh(ctx) {
    const probe = await ctx.gw('net.probe', { targets: [{ id: 'ssap', ip: ctx.device.ip, port: 3001, kind: 'tcp', timeout_ms: 1500 }] }, 5000).catch(() => null);
    if (!probe?.results?.[0]?.ok) return { status: 'offline', power: 'off' };
    const secrets = await ctx.getSecrets<LgSecrets>();
    if (!secrets.client_key) return { status: 'pairing', power: 'on', manufacturer: 'LG' };
    try {
      const [sys, sw, fg] = await Promise.all([
        request(ctx, 'system/getSystemInfo'),
        request(ctx, 'com.webos.service.update/getCurrentSWInformation'),
        request(ctx, 'com.webos.applicationManager/getForegroundAppInfo').catch(() => ({})),
      ]);
      return {
        status: 'online', power: 'on', manufacturer: 'LG', model: sys.modelName ?? null,
        os_version: sw.product_name ? `${sw.product_name} ${sw.major_ver ?? ''}.${sw.minor_ver ?? ''}`.trim() : 'webOS',
        firmware: sw.firmware_revision ?? null, mac: sw.device_id ?? undefined, current_app: fg.appId ?? null,
        facts: { receiver_type: sys.receiverType ?? null, sw },
      };
    } catch (e: any) {
      return { status: e.code === 'pairing' ? 'pairing' : 'online' };
    }
  },

  async pair(ctx) {
    try { await session(ctx, 30_000); return { ok: true, detail: 'Paired with the LG TV.' }; }
    catch (e: any) { return { ok: false, detail: e.message }; }
  },

  async command(ctx, command, args) {
    switch (command) {
      case 'key': await button(ctx, LG_BUTTONS[requireKey(args.key)]); return { ok: true };
      case 'text': await request(ctx, 'com.webos.service.ime/insertText', { text: String(args.text ?? ''), replace: 0 }); return { ok: true };
      case 'power_off': await request(ctx, 'system/turnOff'); await ctx.update({ power: 'off', status: 'offline' }); return { ok: true };
      case 'power_on': {
        if (!ctx.device.mac) throw new AdapterError('failed', 'MAC address unknown; LG TVs can only be woken with Wake-on-LAN.');
        await ctx.gw('net.wol', { mac: ctx.device.mac }, 5000);
        await sleep(1000);
        return { ok: true, detail: 'Wake-on-LAN sent. Requires "Turn on via Wi-Fi/Mobile" enabled on the TV.' };
      }
      case 'volume':
        if (typeof args.delta === 'number') { await request(ctx, args.delta > 0 ? 'audio/volumeUp' : 'audio/volumeDown'); return { ok: true }; }
        await request(ctx, 'audio/setVolume', { volume: Math.round(Math.min(100, Math.max(0, Number(args.level)))) });
        return { ok: true };
      case 'mute': await request(ctx, 'audio/setMute', { mute: args.mute !== false }); return { ok: true };
      case 'media': {
        const map: Record<string, string> = { play: 'media.controls/play', pause: 'media.controls/pause', stop: 'media.controls/stop', next: 'media.controls/fastForward', prev: 'media.controls/rewind', toggle: 'media.controls/play' };
        await request(ctx, map[String(args.action)] ?? 'media.controls/play');
        return { ok: true };
      }
      case 'toast': await request(ctx, 'system.notifications/createToast', { message: String(args.message ?? '').slice(0, 200) }); return { ok: true };
      case 'apps': {
        const r = await request(ctx, 'com.webos.applicationManager/listApps', undefined, 15_000);
        return (r.apps ?? []).filter((a: any) => a.visible !== false).map((a: any) => ({
          package: a.id, app_id: a.id, label: a.title ?? a.id, system: !!a.systemApp, enabled: true, permissions: [],
          version_name: a.version ?? null, version_code: null, icon: null,
        }));
      }
      case 'launch': {
        const id = String(args.app_id ?? args.package ?? '');
        if (!/^[\w.-]+$/.test(id)) throw new AdapterError('bad_args', 'app_id required');
        await request(ctx, 'system.launcher/launch', { id });
        return { ok: true };
      }
      default:
        void parseJson;
        throw new AdapterError('not_supported', `LG TVs don't support "${command}"`);
    }
  },
};

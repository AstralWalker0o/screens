import { parseJson } from '../lib/util';
import type { Adapter, AdapterCtx } from './types';
import { AdapterError, xmlAttrs, xmlEscape, xmlTag, xmlUnescape } from './types';

/** Sonos — local UPnP/SOAP on port 1400 (works with S1 and S2). */
const SERVICES = {
  AVTransport: '/MediaRenderer/AVTransport/Control',
  RenderingControl: '/MediaRenderer/RenderingControl/Control',
  ZoneGroupTopology: '/ZoneGroupTopology/Control',
  DeviceProperties: '/DeviceProperties/Control',
} as const;
type Service = keyof typeof SERVICES;

export function soapEnvelope(service: Service, action: string, args: Record<string, string | number>): string {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${inner}</u:${action}></s:Body></s:Envelope>`;
}

async function soap(ctx: AdapterCtx, ip: string, service: Service, action: string, args: Record<string, string | number> = {}): Promise<string> {
  const r = await ctx.gw('http.request', {
    url: `http://${ip}:1400${SERVICES[service]}`, method: 'POST', body: soapEnvelope(service, action, args),
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"` },
    timeout_ms: 5000,
  }, 9000);
  if (r.status !== 200) {
    const code = r.body ? xmlTag(r.body, 'errorCode') : null;
    throw new AdapterError('failed', `Sonos ${action} failed (HTTP ${r.status}${code ? `, UPnP error ${code}` : ''})`);
  }
  return r.body ?? '';
}

export interface ZoneMember { uuid: string; name: string; ip: string | null; coordinator: string; invisible: boolean }

export function parseZoneGroups(stateXml: string): ZoneMember[] {
  const xml = stateXml.includes('&lt;') ? xmlUnescape(stateXml) : stateXml;
  const out: ZoneMember[] = [];
  for (const g of xml.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const coordinator = xmlAttrs(g[1]).Coordinator ?? '';
    for (const m of g[2].matchAll(/<ZoneGroupMember\s([^>]*?)\/?>/g)) {
      const a = xmlAttrs(m[1]);
      const ip = a.Location?.match(/\/\/([\d.]+):/)?.[1] ?? null;
      out.push({ uuid: a.UUID, name: a.ZoneName, ip, coordinator, invisible: a.Invisible === '1' });
    }
  }
  return out;
}

export function parseDidl(meta: string | null): { title?: string; artist?: string; album?: string; art?: string } {
  if (!meta || meta === 'NOT_IMPLEMENTED') return {};
  const x = meta.includes('&lt;') ? xmlUnescape(meta) : meta;
  return {
    title: xmlTag(x, 'title') ?? undefined, artist: xmlTag(x, 'creator') ?? undefined,
    album: xmlTag(x, 'album') ?? undefined, art: xmlTag(x, 'albumArtURI') ?? undefined,
  };
}

async function topology(ctx: AdapterCtx): Promise<ZoneMember[]> {
  const body = await soap(ctx, ctx.device.ip, 'ZoneGroupTopology', 'GetZoneGroupState');
  return parseZoneGroups(xmlTag(body, 'ZoneGroupState') ?? '');
}

/** Transport commands must go to the group coordinator. */
async function coordinatorIp(ctx: AdapterCtx): Promise<string> {
  const facts = parseJson<any>(ctx.device.facts, {});
  try {
    const members = await topology(ctx);
    const me = members.find((m) => m.uuid === facts.uuid) ?? members.find((m) => m.ip === ctx.device.ip);
    if (me) {
      const coord = members.find((m) => m.uuid === me.coordinator);
      if (coord?.ip) return coord.ip;
    }
  } catch { /* fall through */ }
  return ctx.device.ip;
}

export const sonos: Adapter = {
  async refresh(ctx) {
    const r = await ctx.gw('http.request', { url: `http://${ctx.device.ip}:1400/xml/device_description.xml`, timeout_ms: 4000 }, 8000).catch(() => null);
    if (!r || r.status !== 200 || !r.body) return { status: 'offline' };
    const x = r.body as string;
    const uuid = (xmlTag(x, 'UDN') ?? '').replace(/^uuid:/, '');
    const facts: Record<string, unknown> = {
      uuid, room: xmlTag(x, 'roomName'), model_number: xmlTag(x, 'modelNumber'), hardware: xmlTag(x, 'hardwareVersion'),
      display_version: xmlTag(x, 'displayVersion'), api_version: xmlTag(x, 'apiVersion'),
    };
    let nowPlaying: Record<string, unknown> = {};
    try {
      const ip = await coordinatorIp(ctx);
      const [ti, pi, vol, mute, members] = await Promise.all([
        soap(ctx, ip, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 }),
        soap(ctx, ip, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }),
        soap(ctx, ctx.device.ip, 'RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' }),
        soap(ctx, ctx.device.ip, 'RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' }),
        topology(ctx),
      ]);
      const me = members.find((m) => m.uuid === uuid);
      nowPlaying = {
        state: xmlTag(ti, 'CurrentTransportState'), ...parseDidl(xmlTag(pi, 'TrackMetaData')),
        volume: Number(xmlTag(vol, 'CurrentVolume')), muted: xmlTag(mute, 'CurrentMute') === '1',
      };
      facts.group = { coordinator: me?.coordinator ?? uuid, is_coordinator: !me || me.coordinator === uuid, members: members.filter((m) => m.coordinator === (me?.coordinator ?? uuid) && !m.invisible).map((m) => ({ uuid: m.uuid, name: m.name, ip: m.ip })) };
      facts.zones = members.filter((m) => !m.invisible);
    } catch { /* speaker reachable but transport info failed */ }
    facts.now_playing = nowPlaying;
    const state = String(nowPlaying.state ?? '');
    return {
      status: 'online', power: 'on', manufacturer: 'Sonos', model: xmlTag(x, 'modelName'),
      serial: xmlTag(x, 'serialNum'), firmware: xmlTag(x, 'softwareVersion'), os_version: facts.display_version ? `Sonos ${facts.display_version}` : null,
      current_app: state === 'PLAYING' ? ((nowPlaying.title as string) ?? 'Playing') : null, facts,
    };
  },

  async pair() {
    return { ok: true, detail: 'Sonos needs no pairing on the local network.' };
  },

  async command(ctx, command, args) {
    const facts = parseJson<any>(ctx.device.facts, {});
    switch (command) {
      case 'media': {
        const ip = await coordinatorIp(ctx);
        const action = String(args.action);
        const map: Record<string, [string, Record<string, string | number>]> = {
          play: ['Play', { InstanceID: 0, Speed: 1 }], pause: ['Pause', { InstanceID: 0 }], stop: ['Stop', { InstanceID: 0 }],
          next: ['Next', { InstanceID: 0 }], prev: ['Previous', { InstanceID: 0 }],
        };
        if (action === 'toggle') {
          const ti = await soap(ctx, ip, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 });
          const playing = xmlTag(ti, 'CurrentTransportState') === 'PLAYING';
          await soap(ctx, ip, 'AVTransport', playing ? 'Pause' : 'Play', playing ? { InstanceID: 0 } : { InstanceID: 0, Speed: 1 });
          return { ok: true, state: playing ? 'PAUSED_PLAYBACK' : 'PLAYING' };
        }
        const m = map[action];
        if (!m) throw new AdapterError('bad_args', 'action must be play|pause|stop|next|prev|toggle');
        await soap(ctx, ip, 'AVTransport', m[0], m[1]);
        return { ok: true };
      }
      case 'volume': {
        let level: number;
        if (typeof args.delta === 'number') {
          const v = await soap(ctx, ctx.device.ip, 'RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' });
          level = Number(xmlTag(v, 'CurrentVolume')) + args.delta;
        } else level = Number(args.level);
        level = Math.round(Math.min(100, Math.max(0, level)));
        await soap(ctx, ctx.device.ip, 'RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: level });
        return { ok: true, level };
      }
      case 'mute': {
        await soap(ctx, ctx.device.ip, 'RenderingControl', 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: args.mute === false ? 0 : 1 });
        return { ok: true };
      }
      case 'group': {
        const coord = await ctx.env.DB.prepare('SELECT facts FROM devices WHERE id = ? AND site_id = ?').bind(String(args.coordinator_id), ctx.device.site_id).first<any>();
        const uuid = parseJson<any>(coord?.facts, {}).uuid;
        if (!uuid) throw new AdapterError('bad_args', 'Unknown coordinator speaker (refresh it first)');
        await soap(ctx, ctx.device.ip, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: `x-rincon:${uuid}`, CurrentURIMetaData: '' });
        return { ok: true };
      }
      case 'ungroup': {
        await soap(ctx, ctx.device.ip, 'AVTransport', 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 });
        return { ok: true };
      }
      case 'led': {
        await soap(ctx, ctx.device.ip, 'DeviceProperties', 'SetLEDState', { DesiredLEDState: args.on === false ? 'Off' : 'On' });
        return { ok: true };
      }
      case 'power_off': {
        const ip = await coordinatorIp(ctx);
        await soap(ctx, ip, 'AVTransport', 'Pause', { InstanceID: 0 }).catch(() => undefined);
        return { ok: true, detail: 'Sonos speakers cannot be switched off remotely; playback paused.' };
      }
      case 'topology': return topology(ctx);
      default:
        void facts;
        throw new AdapterError('not_supported', `Sonos speakers don't support "${command}"`);
    }
  },
};

import type { DeviceKind } from '../../shared/types';
import { android } from './android';
import { lg } from './lg';
import { samsung } from './samsung';
import { sonos } from './sonos';
import type { Adapter } from './types';
import { AdapterError, xmlTag } from './types';

export function adapterFor(kind: DeviceKind): Adapter {
  switch (kind) {
    case 'android': return android;
    case 'samsung': return samsung;
    case 'lg': return lg;
    case 'sonos': return sonos;
    default: throw new AdapterError('not_supported', `No driver for device kind "${kind}"`);
  }
}

/** Status probe target for each kind (sent in one batched net.probe per minute). */
export function probeTarget(kind: DeviceKind, ip: string, port?: number | null) {
  switch (kind) {
    case 'android': return { ip, port: port || 5555, kind: 'tcp' as const };
    case 'samsung': return { ip, port: 8001, kind: 'http' as const, path: '/api/v2/' };
    case 'lg': return { ip, port: 3001, kind: 'tcp' as const };
    case 'sonos': return { ip, port: 1400, kind: 'tcp' as const };
    default: return { ip, port: port || 80, kind: 'tcp' as const };
  }
}

export const DISCOVERY_PORTS = [5555, 8001, 8002, 3000, 3001, 1400, 8008, 8009, 9197, 7000];
export const DISCOVERY_MDNS = ['_googlecast._tcp', '_androidtvremote2._tcp', '_adb._tcp', '_adb-tls-connect._tcp', '_sonos._tcp', '_airplay._tcp', '_spotify-connect._tcp'];

export interface RawHost {
  ip: string; mac?: string | null; ports: number[]; mdns: { service: string; instance: string; txt?: Record<string, string> }[];
  ssdp: { server?: string; st?: string; location?: string; usn?: string }[];
}

export interface Fingerprint { kind: DeviceKind | null; name?: string | null; model?: string | null; manufacturer?: string | null; probe?: 'samsung' | 'sonos' | 'lg-ssdp' }

/** First-pass guess from ports, mDNS and SSDP alone (no extra requests). */
export function fingerprint(h: RawHost): Fingerprint {
  const services = new Set(h.mdns.map((m) => m.service));
  const cast = h.mdns.find((m) => m.service === '_googlecast._tcp');
  const servers = h.ssdp.map((s) => `${s.server ?? ''} ${s.st ?? ''} ${s.usn ?? ''}`).join(' ');
  if (h.ports.includes(1400) || services.has('_sonos._tcp') || /Sonos/i.test(servers)) {
    return { kind: 'sonos', manufacturer: 'Sonos', name: h.mdns.find((m) => m.service === '_sonos._tcp')?.instance ?? null, probe: 'sonos' };
  }
  if (h.ports.includes(8001) || h.ports.includes(8002) || /Samsung|Tizen/i.test(servers)) {
    return { kind: 'samsung', manufacturer: 'Samsung', probe: 'samsung' };
  }
  if (h.ports.includes(3000) || h.ports.includes(3001) || /webos|LGE|lge-com/i.test(servers)) {
    return { kind: 'lg', manufacturer: 'LG', probe: 'lg-ssdp' };
  }
  if (h.ports.includes(5555) || services.has('_androidtvremote2._tcp') || services.has('_adb._tcp') || services.has('_adb-tls-connect._tcp')) {
    const md = cast?.txt?.md ?? null;
    return {
      kind: 'android', name: cast?.txt?.fn ?? h.mdns.find((m) => m.service === '_androidtvremote2._tcp')?.instance ?? null, model: md,
      manufacturer: md && /shield/i.test(md) ? 'NVIDIA' : null,
    };
  }
  if (cast) return { kind: 'other', name: cast.txt?.fn ?? cast.instance, model: cast.txt?.md ?? null };
  return { kind: null };
}

export function parseSonosDescription(xml: string) {
  return { name: xmlTag(xml, 'roomName'), model: xmlTag(xml, 'modelName'), manufacturer: 'Sonos' };
}

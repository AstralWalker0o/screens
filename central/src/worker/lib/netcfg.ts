import type { NetConfig, NetIfaceConfig } from '../../shared/types';
import { HttpError, isPrivateIPv4 } from './util';

/** Interface name of a VLAN leg on the gateway (mirrors gateway/internal/netcfg: "scr" + VLAN id). */
export const vlanIfaceName = (vlan: number) => `scr${vlan}`;

const IFNAME = /^[a-zA-Z0-9._-]{1,15}$/;
const RESERVED = /^(lo|docker|br-|veth|cni|flannel|tailscale|wg|tun|tap|virbr|zt)/;

/**
 * Validate and normalise a network-legs config from the dashboard. The gateway re-validates; this gives
 * the operator a clear error before anything is pushed.
 */
export function sanitizeNetConfig(raw: unknown): NetConfig {
  const list = (raw as any)?.interfaces;
  if (!Array.isArray(list)) throw new HttpError(400, 'bad_request', 'interfaces must be a list');
  if (list.length > 32) throw new HttpError(400, 'bad_request', 'At most 32 interfaces');
  const out: NetIfaceConfig[] = [];
  const seen = new Set<string>();
  list.forEach((r: any, i: number) => {
    const where = `Interface ${i + 1}`;
    const kind = r?.kind;
    if (kind !== 'vlan' && kind !== 'existing') throw new HttpError(400, 'bad_request', `${where}: kind must be "vlan" or "existing"`);
    const mode = r.mode === 'static' ? 'static' : r.mode === 'dhcp' || r.mode === undefined ? 'dhcp' : null;
    if (!mode) throw new HttpError(400, 'bad_request', `${where}: mode must be "dhcp" or "static"`);
    const item: NetIfaceConfig = { kind, mode };
    let key: string;
    if (kind === 'vlan') {
      const vlan = Number(r.vlan);
      if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw new HttpError(400, 'bad_request', `${where}: VLAN ID must be 1–4094`);
      const parent = String(r.parent ?? '').trim();
      if (!IFNAME.test(parent) || RESERVED.test(parent)) throw new HttpError(400, 'bad_request', `${where}: pick the gateway network port that carries the VLAN`);
      item.vlan = vlan; item.parent = parent; key = vlanIfaceName(vlan);
    } else {
      const name = String(r.name ?? '').trim();
      if (!IFNAME.test(name) || RESERVED.test(name) || name.startsWith('scr')) throw new HttpError(400, 'bad_request', `${where}: pick a network port`);
      item.name = name; key = name;
    }
    if (seen.has(key)) throw new HttpError(400, 'bad_request', `${where}: ${key} is listed twice`);
    seen.add(key);
    if (mode === 'static') {
      const addr = String(r.address ?? '').trim();
      const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(addr);
      const bits = m ? Number(m[2]) : 0;
      if (!m || m[1].split('.').some((o) => Number(o) > 255) || bits < 8 || bits > 30) throw new HttpError(400, 'bad_request', `${where}: address must look like 10.10.50.5/24`);
      if (!isPrivateIPv4(m[1])) throw new HttpError(400, 'bad_request', `${where}: address must be a private (LAN) address`);
      item.address = addr;
    }
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 40) : '';
    if (label) item.label = label;
    out.push(item);
  });
  return { interfaces: out };
}

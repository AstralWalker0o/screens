import type { DnsMode, DnsPolicyName } from '../../shared/types';
import type { Env } from '../env';
import { signAgentUrl } from '../lib/crypto';
import { type Row, siteSettings } from '../lib/db';
import { parseJson } from '../lib/util';

export interface DnsConfigure {
  enabled: boolean;
  listen: string[];
  dot: { enabled: boolean; listen: string[]; hostname: string | null };
  upstreams: string[];
  block_response: 'null' | 'nxdomain';
  cache: { enabled: boolean; max_entries: number; min_ttl_s: number; max_ttl_s: number };
  default: { policy: string; mode: DnsMode };
  clients: Record<string, { device_id: string; policy: string; mode: DnsMode; allow: string[]; block: string[] }>;
  policies: Record<string, { version: string; url: string; sha256: string }>;
  log: { enabled: boolean };
}

const policyKey = (p: DnsPolicyName) => (p === 'strict' ? 'strict' : 'balanced');

export async function buildDnsConfig(env: Env, siteId: string, origin: string): Promise<DnsConfigure> {
  const site = await env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(siteId).first<Row>();
  if (!site) throw new Error('site not found');
  const settings = siteSettings(site);
  const [devices, builds, rules, dot] = await Promise.all([
    env.DB.prepare("SELECT id, ip, dns_mode, dns_policy, dns_allow, dns_block FROM devices WHERE site_id = ? AND ip IS NOT NULL AND ip != ''").bind(siteId).all<Row>(),
    env.DB.prepare('SELECT * FROM dns_policy_builds').all<Row>(),
    env.DB.prepare("SELECT domain, action, scope_type, scope_id FROM dns_rules WHERE (scope_type = 'site' AND scope_id = ?) OR (scope_type = 'client' AND scope_id = ?)").bind(siteId, site.client_id).all<Row>(),
    env.DB.prepare('SELECT * FROM dot_certs WHERE site_id = ?').bind(siteId).first<Row>(),
  ]);
  const scopedAllow = rules.results.filter((r) => r.action === 'allow').map((r) => r.domain);
  const scopedBlock = rules.results.filter((r) => r.action === 'block').map((r) => r.domain);

  const clients: DnsConfigure['clients'] = {};
  for (const d of devices.results) {
    clients[d.ip] = {
      device_id: d.id,
      policy: policyKey(d.dns_policy),
      mode: d.dns_mode,
      allow: [...scopedAllow, ...parseJson<string[]>(d.dns_allow, [])],
      block: [...scopedBlock, ...parseJson<string[]>(d.dns_block, [])],
    };
  }
  const policies: DnsConfigure['policies'] = {};
  for (const b of builds.results) {
    policies[b.policy] = { version: b.sha256, sha256: b.sha256, url: await signAgentUrl(env.SIGNING_SECRET, origin, 'GET', b.r2_key, 7 * 24 * 3_600_000) };
  }
  return {
    enabled: true,
    listen: ['0.0.0.0:53'],
    dot: { enabled: !!(settings.dot_enabled && dot && dot.status === 'issued'), listen: ['0.0.0.0:853'], hostname: dot?.hostname ?? null },
    upstreams: ['https://1.1.1.1/dns-query', 'https://1.0.0.1/dns-query'],
    block_response: 'null',
    cache: { enabled: true, max_entries: 20000, min_ttl_s: 0, max_ttl_s: 86400 },
    default: { policy: policyKey(settings.default_policy), mode: settings.unknown_clients },
    clients,
    policies,
    log: { enabled: true },
  };
}

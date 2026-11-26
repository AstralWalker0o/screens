import type { Context } from 'hono';
import type { DnsCategory, DnsSummary, SiteSummary } from '../../shared/types';
import type { Env } from '../env';
import type { Actor } from '../lib/auth';
import type { Row } from '../lib/db';
import { parseJson } from '../lib/util';

export type AppEnv = { Bindings: Env; Variables: { actor: Actor } };
export type Ctx = Context<AppEnv>;

export const actorOf = (c: Ctx) => c.get('actor').email;

export async function body<T = any>(c: Ctx): Promise<T> {
  return (await c.req.json().catch(() => ({}))) as T;
}

/** Fleet-wide (or one site) DNS summary from D1 rollups. */
export async function fleetDnsSummary(env: Env, opts: { site_id?: string; hours?: number } = {}): Promise<DnsSummary> {
  const hours = opts.hours ?? 24;
  const since = Math.floor((Date.now() - hours * 3_600_000) / 3_600_000) * 3_600_000;
  const siteF = opts.site_id ? ' AND site_id = ?' : '';
  const args = opts.site_id ? [since, opts.site_id] : [since];
  const dayFrom = new Date(Date.now() - Math.max(hours, 24) * 3_600_000).toISOString().slice(0, 10);
  const dargs = opts.site_id ? [dayFrom, opts.site_id] : [dayFrom];
  const [series, cats, top, topB, byDev] = await Promise.all([
    env.DB.prepare(`SELECT hour t, sum(queries) q, sum(blocked) b, sum(would_block) w FROM dns_hourly WHERE hour >= ?${siteF} GROUP BY hour ORDER BY hour`).bind(...args).all<Row>(),
    env.DB.prepare(`SELECT cats FROM dns_hourly WHERE hour >= ?${siteF}`).bind(...args).all<Row>(),
    env.DB.prepare(`SELECT domain, max(category) category, sum(queries) q, sum(blocked) b, sum(would_block) w, count(DISTINCT device_id) d FROM dns_daily WHERE day >= ?${siteF} GROUP BY domain ORDER BY q DESC LIMIT 15`).bind(...dargs).all<Row>(),
    env.DB.prepare(`SELECT domain, max(category) category, sum(queries) q, sum(blocked) b, sum(would_block) w, count(DISTINCT device_id) d FROM dns_daily WHERE day >= ?${siteF} AND (blocked > 0 OR would_block > 0) GROUP BY domain ORDER BY (sum(blocked) + sum(would_block)) DESC LIMIT 15`).bind(...dargs).all<Row>(),
    env.DB.prepare(`SELECT h.device_id, d.name, d.kind, sum(h.queries) q, sum(h.blocked) b, sum(h.would_block) w FROM dns_hourly h LEFT JOIN devices d ON d.id = h.device_id WHERE h.hour >= ?${siteF.replace('site_id', 'h.site_id')} GROUP BY h.device_id ORDER BY q DESC LIMIT 50`).bind(...args).all<Row>(),
  ]);
  const by_category: Partial<Record<DnsCategory, number>> = {};
  for (const r of cats.results) for (const [k, v] of Object.entries(parseJson<Record<string, number>>(r.cats, {}))) by_category[k as DnsCategory] = (by_category[k as DnsCategory] ?? 0) + v;
  const pts = new Map(series.results.map((r) => [r.t as number, r]));
  const s = [];
  for (let t = since; t <= Date.now(); t += 3_600_000) { const r = pts.get(t); s.push({ t, queries: r?.q ?? 0, blocked: r?.b ?? 0, would_block: r?.w ?? 0 }); }
  const stat = (r: Row) => ({ domain: r.domain, category: r.category, queries: r.q, blocked: r.b, would_block: r.w, devices: r.d });
  return {
    hours, queries: s.reduce((a, p) => a + p.queries, 0), blocked: s.reduce((a, p) => a + p.blocked, 0), would_block: s.reduce((a, p) => a + p.would_block, 0),
    by_category, series: s, top_domains: top.results.map(stat), top_blocked: topB.results.map(stat),
    by_device: byDev.results.map((r) => ({ device_id: r.device_id, name: r.name ?? String(r.device_id).replace(/^ip:/, 'Unknown '), kind: r.kind ?? 'other', queries: r.q, blocked: r.b, would_block: r.w })),
  };
}

export async function siteSummaries(env: Env, where = '', args: unknown[] = []): Promise<SiteSummary[]> {
  const since = Date.now() - 24 * 3_600_000;
  const rows = await env.DB.prepare(`
    SELECT s.*, c.name client_name,
      (SELECT status FROM gateways g WHERE g.site_id = s.id AND g.status != 'revoked' ORDER BY g.created_at DESC LIMIT 1) gw_status,
      (SELECT last_seen FROM gateways g WHERE g.site_id = s.id AND g.status != 'revoked' ORDER BY g.created_at DESC LIMIT 1) gw_last_seen,
      (SELECT count(*) FROM devices d WHERE d.site_id = s.id) dev_total,
      (SELECT count(*) FROM devices d WHERE d.site_id = s.id AND d.status IN ('online','standby')) dev_online,
      (SELECT coalesce(sum(queries),0) FROM dns_hourly h WHERE h.site_id = s.id AND h.hour >= ?) q24,
      (SELECT coalesce(sum(blocked),0) FROM dns_hourly h WHERE h.site_id = s.id AND h.hour >= ?) b24,
      (SELECT count(*) FROM alerts a WHERE a.site_id = s.id AND a.resolved_at IS NULL AND a.acknowledged_at IS NULL) alerts_open
    FROM sites s JOIN clients c ON c.id = s.client_id ${where} ORDER BY c.name, s.name`).bind(since, since, ...args).all<Row>();
  return rows.results.map((r) => ({
    id: r.id, client_id: r.client_id, client_name: r.client_name, name: r.name, slug: r.slug, kind: r.kind, timezone: r.timezone, address: r.address,
    gateway_status: r.gw_status ?? 'none', gateway_last_seen: r.gw_last_seen, devices_total: r.dev_total, devices_online: r.dev_online,
    dns_queries_24h: r.q24, dns_blocked_24h: r.b24, alerts_open: r.alerts_open, created_at: r.created_at,
  }));
}

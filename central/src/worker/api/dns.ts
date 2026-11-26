import { Hono } from 'hono';
import type { DnsCategory, DnsPolicyName, PrivacyOverview } from '../../shared/types';
import { classify, compilePolicies, refreshLists, ensureListSources, POLICIES } from '../dns/compile';
import { audit, type Row } from '../lib/db';
import { originOf, pushDnsAll } from '../lib/hub';
import { domainValid, HttpError, now, parseJson } from '../lib/util';
import { grade } from '../privacy/score';
import { actorOf, type AppEnv, body, fleetDnsSummary } from './shared';

export const dnsRoutes = new Hono<AppEnv>();

dnsRoutes.get('/privacy', async (c) => {
  const env = c.env;
  const since = Date.now() - 24 * 3_600_000;
  const [devices, acr, bypass, fresh] = await Promise.all([
    env.DB.prepare("SELECT d.id, d.name, d.site_id, s.name site_name, d.kind, d.privacy_score FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.kind != 'other' ORDER BY coalesce(d.privacy_score, 101) ASC").all<Row>(),
    env.DB.prepare('SELECT device_id, cats FROM dns_hourly WHERE hour >= ?').bind(since).all<Row>(),
    env.DB.prepare("SELECT device_id FROM alerts WHERE type = 'dns.bypass' AND resolved_at IS NULL").all<Row>(),
    env.DB.prepare('SELECT * FROM domains WHERE first_seen >= ? ORDER BY queries DESC LIMIT 100').bind(Date.now() - 7 * 86_400_000).all<Row>(),
  ]);
  const acrBy = new Map<string, number>();
  for (const r of acr.results) acrBy.set(r.device_id, (acrBy.get(r.device_id) ?? 0) + (parseJson<any>(r.cats, {}).acr ?? 0));
  const bypassSet = new Set(bypass.results.map((r) => r.device_id));
  const rules = new Map((await env.DB.prepare("SELECT domain, action FROM dns_rules WHERE scope_type = 'global'").all<Row>()).results.map((r) => [r.domain, r.action]));
  const acrRows = (await env.DB.prepare("SELECT domain, sum(queries) q, sum(blocked) b, count(DISTINCT device_id) d FROM dns_daily WHERE category = 'acr' AND day >= ? GROUP BY domain").bind(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)).all<Row>()).results;
  const byVendor = new Map<string, { vendor: string; attempts: number; blocked: number; devices: number }>();
  for (const r of acrRows) {
    const vendor = classify(r.domain).vendor ?? vendorFromDomain(r.domain);
    const v = byVendor.get(vendor) ?? { vendor, attempts: 0, blocked: 0, devices: 0 };
    v.attempts += r.q; v.blocked += r.b; v.devices = Math.max(v.devices, r.d);
    byVendor.set(vendor, v);
  }
  const out: PrivacyOverview = {
    devices: devices.results.map((d) => ({ device_id: d.id, name: d.name, site_id: d.site_id, site_name: d.site_name, kind: d.kind, score: d.privacy_score ?? 0, grade: d.privacy_score == null ? '?' : grade(d.privacy_score), bypass_suspected: bypassSet.has(d.id), acr_24h: acrBy.get(d.id) ?? 0 })),
    fleet: await fleetDnsSummary(env, { hours: 24 }),
    new_domains: fresh.results.map((r) => ({ domain: r.domain, category: r.category, vendor: r.vendor, queries: r.queries, blocked: r.blocked, would_block: r.would_block, first_seen: r.first_seen, last_seen: r.last_seen, rule: (rules.get(r.domain) as any) ?? null })),
    acr_by_vendor: [...byVendor.values()].sort((a, b) => b.attempts - a.attempts),
  };
  return c.json(out);
});

dnsRoutes.get('/dns/domains', async (c) => {
  const q = c.req.query();
  const limit = Math.min(Number(q.limit) || 200, 1000);
  const rules = new Map((await c.env.DB.prepare("SELECT domain, action FROM dns_rules WHERE scope_type = 'global'").all<Row>()).results.map((r) => [r.domain, r.action]));
  let rows: Row[];
  if (q.site_id) {
    const days = Math.min(Number(q.days) || 7, 90);
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const where = ['site_id = ?', 'day >= ?']; const args: unknown[] = [q.site_id, from];
    if (q.q) { where.push('domain LIKE ?'); args.push(`%${q.q.toLowerCase()}%`); }
    if (q.category) { where.push('category = ?'); args.push(q.category); }
    rows = (await c.env.DB.prepare(`SELECT domain, max(category) category, sum(queries) queries, sum(blocked) blocked, sum(would_block) would_block, count(DISTINCT device_id) devices, min(day) first_day FROM dns_daily WHERE ${where.join(' AND ')} GROUP BY domain ORDER BY queries DESC LIMIT ${limit}`).bind(...args).all<Row>()).results;
  } else {
    const where: string[] = []; const args: unknown[] = [];
    if (q.q) { where.push('domain LIKE ?'); args.push(`%${q.q.toLowerCase()}%`); }
    if (q.category) { where.push('category = ?'); args.push(q.category); }
    rows = (await c.env.DB.prepare(`SELECT * FROM domains ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY queries DESC LIMIT ${limit}`).bind(...args).all<Row>()).results;
  }
  return c.json(rows.map((r) => ({ domain: r.domain, category: r.category, vendor: r.vendor ?? null, queries: r.queries, blocked: r.blocked, would_block: r.would_block, devices: r.devices, first_seen: r.first_seen, last_seen: r.last_seen, rule: rules.get(r.domain) ?? null })));
});

dnsRoutes.get('/dns/rules', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM dns_rules ORDER BY created_at DESC').all<Row>();
  return c.json(r.results.map((x) => ({ ...x, policies: parseJson(x.policies, POLICIES) })));
});

async function afterRuleChange(c: any, scope_type: string, scope_id: string) {
  const origin = originOf(c.req.raw, c.env);
  if (scope_type === 'global') {
    c.executionCtx.waitUntil((async () => { const b = await compilePolicies(c.env); if (b.some((x) => x.changed)) await pushDnsAll(c.env, origin); })());
  } else {
    const sites = scope_type === 'site' ? [scope_id] : (await c.env.DB.prepare('SELECT id FROM sites WHERE client_id = ?').bind(scope_id).all()).results.map((r: any) => r.id);
    c.executionCtx.waitUntil(pushDnsAll(c.env, origin, sites));
  }
}

dnsRoutes.post('/dns/rules', async (c) => {
  const b = await body(c);
  const domain = String(b.domain ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!domainValid(domain)) throw new HttpError(400, 'bad_request', 'Enter a valid domain, e.g. ads.example.com');
  if (!['block', 'allow'].includes(b.action)) throw new HttpError(400, 'bad_request', 'action must be block or allow');
  const scope_type = ['global', 'client', 'site'].includes(b.scope_type) ? b.scope_type : 'global';
  const scope_id = scope_type === 'global' ? '' : String(b.scope_id ?? '');
  const policies: DnsPolicyName[] = Array.isArray(b.policies) && b.policies.length ? b.policies.filter((p: string) => POLICIES.includes(p as DnsPolicyName)) : POLICIES;
  await c.env.DB.prepare(`INSERT INTO dns_rules (domain, action, category, vendor, policies, scope_type, scope_id, source, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(domain, scope_type, scope_id) DO UPDATE SET action = excluded.action, category = excluded.category, policies = excluded.policies, notes = excluded.notes`)
    .bind(domain, b.action, (b.category as DnsCategory) ?? null, b.vendor ?? null, JSON.stringify(policies), scope_type, scope_id, 'user', b.notes ?? null, now()).run();
  await audit(c.env, actorOf(c), `dns.rule.${b.action}`, { target_type: 'domain', target_id: domain, details: { scope_type, scope_id } });
  await afterRuleChange(c, scope_type, scope_id);
  return c.json(await c.env.DB.prepare('SELECT * FROM dns_rules WHERE domain = ? AND scope_type = ? AND scope_id = ?').bind(domain, scope_type, scope_id).first(), 201);
});

dnsRoutes.delete('/dns/rules', async (c) => {
  const domain = c.req.query('domain') ?? '';
  const scope_type = c.req.query('scope_type') ?? 'global';
  const scope_id = c.req.query('scope_id') ?? '';
  await c.env.DB.prepare('DELETE FROM dns_rules WHERE domain = ? AND scope_type = ? AND scope_id = ?').bind(domain, scope_type, scope_id).run();
  await audit(c.env, actorOf(c), 'dns.rule.delete', { target_type: 'domain', target_id: domain, details: { scope_type, scope_id } });
  await afterRuleChange(c, scope_type, scope_id);
  return c.json({ ok: true });
});

dnsRoutes.get('/dns/lists', async (c) => {
  await ensureListSources(c.env);
  const [lists, builds] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM dns_lists ORDER BY name').all<Row>(),
    c.env.DB.prepare('SELECT policy, sha256, rules, built_at FROM dns_policy_builds').all<Row>(),
  ]);
  return c.json({ lists: lists.results.map((l) => ({ ...l, enabled: !!l.enabled, policies: parseJson(l.policies, POLICIES) })), builds: builds.results });
});

dnsRoutes.patch('/dns/lists/:id', async (c) => {
  const b = await body(c);
  const l = await c.env.DB.prepare('SELECT * FROM dns_lists WHERE id = ?').bind(c.req.param('id')).first<Row>();
  if (!l) throw new HttpError(404, 'not_found', 'List not found');
  const policies = Array.isArray(b.policies) ? b.policies.filter((p: string) => POLICIES.includes(p as DnsPolicyName)) : parseJson(l.policies, POLICIES);
  await c.env.DB.prepare('UPDATE dns_lists SET enabled = ?, policies = ? WHERE id = ?').bind(b.enabled === undefined ? l.enabled : b.enabled ? 1 : 0, JSON.stringify(policies), l.id).run();
  await audit(c.env, actorOf(c), 'dns.list.update', { target_type: 'list', target_id: l.id, details: b });
  const r = await c.env.DB.prepare('SELECT * FROM dns_lists WHERE id = ?').bind(l.id).first<Row>();
  return c.json({ ...r, enabled: !!r!.enabled, policies: parseJson(r!.policies, POLICIES) });
});

dnsRoutes.post('/dns/rebuild', async (c) => {
  await refreshLists(c.env, true);
  const builds = await compilePolicies(c.env);
  await pushDnsAll(c.env, originOf(c.req.raw, c.env));
  await audit(c.env, actorOf(c), 'dns.rebuild', { details: builds });
  const rows = await c.env.DB.prepare('SELECT policy, sha256, rules, built_at FROM dns_policy_builds').all<Row>();
  return c.json({ builds: rows.results });
});

/** Best-effort vendor name for an uncatalogued ACR domain: its registrable-ish name. */
function vendorFromDomain(d: string): string {
  const parts = d.split('.');
  const base = parts.length >= 3 && /^(com|net|org|co)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? d;
  if (/samsung/.test(d)) return 'Samsung';
  if (/lg(e|smartad|tvsdp)|alphonso/.test(d)) return 'LG';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

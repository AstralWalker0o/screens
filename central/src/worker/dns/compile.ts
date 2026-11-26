import type { DnsCategory, DnsPolicyName } from '../../shared/types';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { type Row } from '../lib/db';
import { now, parseJson } from '../lib/util';
import { CATALOG, DEFAULT_LISTS } from './catalog';

export const POLICIES: DnsPolicyName[] = ['balanced', 'strict'];

/** Parse a blocklist in domains / hosts / adblock format into bare domains. */
export function parseList(text: string, format: string): string[] {
  const out: string[] = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || line.startsWith('[')) continue;
    const hashIdx = line.indexOf(' #');
    if (hashIdx > 0) line = line.slice(0, hashIdx).trim();
    let d: string | undefined;
    if (format === 'hosts') {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && /^(0\.0\.0\.0|127\.0\.0\.1|::1?|::)$/.test(parts[0])) d = parts[1];
    } else if (format === 'adblock') {
      const m = line.match(/^\|\|([^\^\/$]+)\^(\$.*)?$/);
      if (m && !(m[2] ?? '').includes('important') && !line.startsWith('@@')) d = m[1];
    } else {
      d = line.split(/\s+/)[0];
    }
    if (!d) continue;
    d = d.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (d === 'localhost' || d.endsWith('.local') || !d.includes('.') || !/^[a-z0-9._-]+$/.test(d)) continue;
    out.push(d);
  }
  return out;
}

/** Category heuristic for list entries without a curated category. */
export function guessCategory(domain: string, fallback: DnsCategory): DnsCategory {
  const labels = domain.split('.');
  if (labels.some((l) => /^acr\d*$|^acr-|-acr$|samsungacr|alphonso|samba|tvinteractive|inscape/.test(l))) return 'acr';
  if (/(^|[.-])(ads?|adserver|adservice|advert\w*|doubleclick|adsystem|adnxs|smartad|lgad|samsungads)([.-]|$)/.test(domain)) return 'ads';
  if (/(^|[.-])(telemetry|metrics?|analytics|stats|log|logs|logging|crashlytics|tracking|tracker|beacon|events?|diagnostics?|measurement|omtrdc|demdex)([.-]|\d|$)/.test(domain)) return 'telemetry';
  return fallback;
}

export interface PolicyRule { action: 'b' | 'a'; domain: string; cat: DnsCategory }

/** Build the rule set for one policy (pure: inputs are already-fetched lists + rules). */
export function buildRules(policy: DnsPolicyName, lists: { domains: string[]; category: DnsCategory; policies: DnsPolicyName[] }[], userRules: Row[]): PolicyRule[] {
  const rules = new Map<string, PolicyRule>();
  const curated = new Map(CATALOG.map((c) => [c.domain, c]));
  for (const l of lists) {
    if (!l.policies.includes(policy)) continue;
    for (const d of l.domains) {
      if (rules.has(d)) continue;
      const c = curated.get(d);
      rules.set(d, { action: 'b', domain: d, cat: c && c.action !== 'allow' ? c.category : guessCategory(d, l.category) });
    }
  }
  for (const c of CATALOG) {
    if (c.action === 'label' || !(c.policies ?? []).includes(policy)) continue;
    rules.set(c.domain, { action: c.action === 'allow' ? 'a' : 'b', domain: c.domain, cat: c.category });
  }
  for (const r of userRules) {
    if (r.scope_type !== 'global') continue;
    const pols = parseJson<DnsPolicyName[]>(r.policies, POLICIES);
    if (!pols.includes(policy)) continue;
    rules.set(r.domain, { action: r.action === 'allow' ? 'a' : 'b', domain: r.domain, cat: (r.category as DnsCategory) || (r.action === 'allow' ? 'essential' : guessCategory(r.domain, 'tracking')) });
  }
  return [...rules.values()].sort((a, b) => (a.domain < b.domain ? -1 : 1));
}

export function serializeRules(policy: string, rules: PolicyRule[]): string {
  const lines = [`# screens-policy v1 id=${policy} built=${new Date().toISOString()} rules=${rules.length}`];
  for (const r of rules) lines.push(`${r.action} ${r.domain} ${r.cat}`);
  return lines.join('\n') + '\n';
}

async function gzip(text: string): Promise<Uint8Array> {
  const cs = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(cs).arrayBuffer());
}

/** Seed the list sources table from DEFAULT_LISTS (idempotent). */
export async function ensureListSources(env: Env) {
  const stmts = DEFAULT_LISTS.map((l) => env.DB.prepare(
    'INSERT INTO dns_lists (id, name, url, format, category, enabled, policies) VALUES (?,?,?,?,?,1,?) ON CONFLICT(id) DO NOTHING',
  ).bind(l.id, l.name, l.url, l.format, l.category, JSON.stringify(l.policies)));
  await env.DB.batch(stmts);
}

/** Fetch every enabled list into R2 (keeps the previous copy if a fetch fails). */
export async function refreshLists(env: Env, force = false) {
  await ensureListSources(env);
  const lists = (await env.DB.prepare('SELECT * FROM dns_lists WHERE enabled = 1').all<Row>()).results;
  for (const l of lists) {
    if (!force && l.last_fetched && now() - l.last_fetched < 20 * 3_600_000 && l.r2_key) continue;
    try {
      const res = await fetch(l.url, { headers: { 'User-Agent': 'Screens/0.1 (+blocklist sync)' }, cf: { cacheTtl: 3600 } } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const domains = parseList(text, l.format);
      if (domains.length === 0) throw new Error('list parsed to 0 domains');
      const key = `lists/${l.id}.txt`;
      await env.FILES.put(key, domains.join('\n'));
      await env.DB.prepare('UPDATE dns_lists SET last_fetched = ?, last_count = ?, last_error = NULL, r2_key = ?, sha256 = ? WHERE id = ?')
        .bind(now(), domains.length, key, await sha256Hex(text), l.id).run();
    } catch (e: any) {
      await env.DB.prepare('UPDATE dns_lists SET last_error = ?, last_fetched = ? WHERE id = ?').bind(String(e.message ?? e).slice(0, 300), now(), l.id).run();
    }
  }
}

/** Compile policies from stored lists + curated + user rules into gzip files in R2. Returns builds that changed. */
export async function compilePolicies(env: Env): Promise<{ policy: string; sha256: string; rules: number; changed: boolean }[]> {
  const lists = (await env.DB.prepare('SELECT * FROM dns_lists WHERE enabled = 1 AND r2_key IS NOT NULL').all<Row>()).results;
  const loaded: { domains: string[]; category: DnsCategory; policies: DnsPolicyName[] }[] = [];
  for (const l of lists) {
    const obj = await env.FILES.get(l.r2_key);
    if (!obj) continue;
    loaded.push({ domains: (await obj.text()).split('\n').filter(Boolean), category: l.category, policies: parseJson(l.policies, POLICIES) });
  }
  const userRules = (await env.DB.prepare('SELECT * FROM dns_rules').all<Row>()).results;
  const out = [];
  for (const policy of POLICIES) {
    const rules = buildRules(policy, loaded, userRules);
    const text = serializeRules(policy, rules);
    const gz = await gzip(text);
    const sha = await sha256Hex(gz);
    const prev = await env.DB.prepare('SELECT sha256, r2_key FROM dns_policy_builds WHERE policy = ?').bind(policy).first<Row>();
    // The content hash ignores the build timestamp header so unchanged rule sets don't trigger re-downloads.
    const contentSha = await sha256Hex(text.slice(text.indexOf('\n') + 1));
    const prevContent = prev ? await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`policy_content_${policy}`).first<Row>() : null;
    if (prev && prevContent && JSON.parse(prevContent.value) === contentSha && (await env.FILES.head(prev.r2_key))) {
      out.push({ policy, sha256: prev.sha256, rules: rules.length, changed: false });
      continue;
    }
    const key = `policies/${policy}/${sha}.gz`;
    await env.FILES.put(key, gz, { httpMetadata: { contentType: 'application/gzip' } });
    await env.DB.batch([
      env.DB.prepare('INSERT INTO dns_policy_builds (policy, sha256, r2_key, rules, built_at) VALUES (?,?,?,?,?) ON CONFLICT(policy) DO UPDATE SET sha256=excluded.sha256, r2_key=excluded.r2_key, rules=excluded.rules, built_at=excluded.built_at')
        .bind(policy, sha, key, rules.length, now()),
      env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(`policy_content_${policy}`, JSON.stringify(contentSha)),
    ]);
    out.push({ policy, sha256: sha, rules: rules.length, changed: true });
  }
  return out;
}

/** Classify a domain using the curated catalog (most specific suffix). */
const CATALOG_MAP = new Map(CATALOG.map((c) => [c.domain, c]));
export function classify(domain: string): { category: DnsCategory | null; vendor: string | null } {
  const labels = domain.toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const c = CATALOG_MAP.get(labels.slice(i).join('.'));
    if (c) return { category: c.category, vendor: c.vendor };
  }
  return { category: null, vendor: null };
}

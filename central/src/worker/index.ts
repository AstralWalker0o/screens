import { Hono } from 'hono';
import { AdapterError } from './adapters/types';
import { agentRoutes, installRoutes } from './agent/routes';
import { deviceRoutes } from './api/devices';
import { dnsRoutes } from './api/dns';
import { automationSites, opsRoutes } from './api/ops';
import type { AppEnv } from './api/shared';
import { siteRoutes } from './api/sites';
import { cronMatches } from './automations/cron';
import { APP_CATALOG } from './dns/catalog';
import { compilePolicies, refreshLists } from './dns/compile';
import type { Env } from './env';
import { requireAccess } from './lib/auth';
import { type Row, toAutomation } from './lib/db';
import { hub, pushDnsAll } from './lib/hub';
import { HttpError } from './lib/util';
import { statusForCode } from './hub/SiteHub';

export { SiteHub } from './hub/SiteHub';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status as any);
  if (err instanceof AdapterError) return c.json({ error: err.code, message: err.message }, statusForCode(err.code) as any);
  console.error('unhandled', err);
  return c.json({ error: 'internal', message: 'Something went wrong on the server' }, 500);
});

app.get('/healthz', (c) => c.json({ ok: true }));

// Gateway-facing endpoints authenticate themselves (signed requests / one-time tokens).
app.route('/agent/v1', agentRoutes as any);
app.route('/install', installRoutes as any);

// Everything else is the dashboard API behind Cloudflare Access.
app.use('/api/*', async (c, next) => {
  c.set('actor', await requireAccess(c.req.raw, c.env));
  // Basic CSRF defence for state-changing requests: require same-origin.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) throw new HttpError(403, 'bad_origin', 'Cross-origin request blocked');
  }
  await next();
  c.header('Cache-Control', 'no-store');
});
app.route('/api', siteRoutes);
app.route('/api', deviceRoutes);
app.route('/api', dnsRoutes);
app.route('/api', opsRoutes);
app.all('/api/*', (c) => c.json({ error: 'not_found', message: 'No such API endpoint' }, 404));

async function seed(env: Env) {
  const has = await env.DB.prepare("SELECT value FROM settings WHERE key = 'seeded_v1'").first<Row>();
  if (has) return;
  await env.DB.batch(APP_CATALOG.map((a) => env.DB.prepare(
    'INSERT INTO app_catalog (package, label, vendor, category, risk, notes, guest_clear) VALUES (?,?,?,?,?,?,?) ON CONFLICT(package) DO UPDATE SET label = excluded.label, vendor = excluded.vendor, category = excluded.category, risk = excluded.risk, notes = excluded.notes, guest_clear = excluded.guest_clear',
  ).bind(a.package, a.label, a.vendor ?? null, a.category, a.risk ?? null, a.notes ?? null, a.guest_clear ? 1 : 0)));
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('seeded_v1', 'true') ON CONFLICT(key) DO NOTHING").run();
}

async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
  const t = controller.scheduledTime;
  const d = new Date(t);
  await seed(env);

  // Blocklists: daily at 17:07 UTC (early morning in Australia), or immediately if never built.
  const builds = await env.DB.prepare('SELECT count(*) n FROM dns_policy_builds').first<Row>();
  if (!builds?.n || (d.getUTCHours() === 17 && d.getUTCMinutes() === 7)) {
    ctx.waitUntil((async () => {
      await refreshLists(env, !builds?.n);
      const b = await compilePolicies(env);
      if (b.some((x) => x.changed)) await pushDnsAll(env, null);
    })());
  }

  // Scheduled automations, evaluated in each site's timezone unless the automation sets one.
  const autos = (await env.DB.prepare("SELECT * FROM automations WHERE enabled = 1 AND json_extract(trigger, '$.type') = 'schedule'").all<Row>()).results.map(toAutomation);
  for (const a of autos) {
    if (a.trigger.type !== 'schedule') continue;
    const sites = await automationSites(env, a);
    for (const s of sites) {
      let match = false;
      try { match = cronMatches(a.trigger.cron, t, a.trigger.timezone || s.timezone || 'UTC'); } catch { continue; }
      if (match) ctx.waitUntil(hub(env, s.id, null, 'runAutomation', a.id).catch((e) => console.error('automation failed', a.id, s.id, e)));
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;

import { APP_CATALOG } from '../dns/catalog';
import type { Env } from '../env';
import type { Row } from './db';

/** One-time catalogue seeding (idempotent; guarded by the seeded_v1 flag). */
export async function seed(env: Env) {
  const has = await env.DB.prepare("SELECT value FROM settings WHERE key = 'seeded_v1'").first<Row>();
  if (has) return;
  await env.DB.batch(APP_CATALOG.map((a) => env.DB.prepare(
    'INSERT INTO app_catalog (package, label, vendor, category, risk, notes, guest_clear) VALUES (?,?,?,?,?,?,?) ON CONFLICT(package) DO UPDATE SET label = excluded.label, vendor = excluded.vendor, category = excluded.category, risk = excluded.risk, notes = excluded.notes, guest_clear = excluded.guest_clear',
  ).bind(a.package, a.label, a.vendor ?? null, a.category, a.risk ?? null, a.notes ?? null, a.guest_clear ? 1 : 0)));
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('seeded_v1', 'true') ON CONFLICT(key) DO NOTHING").run();
}

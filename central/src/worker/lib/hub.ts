import type { Env } from '../env';
import { HttpError } from './util';

export function originOf(req: Request, env: Env): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, '');
  return new URL(req.url).origin;
}

export function hubStub(env: Env, siteId: string) {
  return env.SITE_HUB.get(env.SITE_HUB.idFromName(siteId));
}

/** Call a SiteHub method; converts the hub's error envelope into an HttpError. */
export async function hub<T = any>(env: Env, siteId: string, origin: string | null, method: string, ...args: unknown[]): Promise<T> {
  const r = (await hubStub(env, siteId).rpc(siteId, origin, method, args)) as
    | { ok: true; data: unknown } | { ok: false; status: number; code: string; message: string };
  if (r.ok === false) throw new HttpError(r.status, r.code, r.message);
  return r.data as T;
}

/** Push DNS config to every site's gateway (after global rule/policy changes). */
export async function pushDnsAll(env: Env, origin: string | null, siteIds?: string[]) {
  const ids = siteIds ?? (await env.DB.prepare("SELECT DISTINCT site_id FROM gateways WHERE status = 'online'").all<{ site_id: string }>()).results.map((r) => r.site_id);
  await Promise.all(ids.map((id) => hub(env, id, origin, 'pushDnsConfig').catch(() => undefined)));
}

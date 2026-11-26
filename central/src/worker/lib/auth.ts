import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../env';
import { HttpError } from './util';

export interface Actor { email: string; name?: string; dev?: boolean }

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Verify the Cloudflare Access JWT on a request. Access is the sole login (one super-admin). */
export async function requireAccess(req: Request, env: Env): Promise<Actor> {
  if (env.DEV_AUTH === '1') {
    const host = new URL(req.url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return { email: 'dev@localhost', name: 'Developer', dev: true };
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(503, 'access_not_configured', 'Cloudflare Access is not configured for this app');
  const token = req.headers.get('cf-access-jwt-assertion') ?? getCookie(req, 'CF_Authorization');
  if (!token) throw new HttpError(401, 'unauthenticated', 'Missing Cloudflare Access token');
  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  let jwks = jwksCache.get(team);
  if (!jwks) { jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`)); jwksCache.set(team, jwks); }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: team, audience: env.ACCESS_AUD });
    // People sign in with an email; Access service tokens (automation, support access) carry only common_name
    // (the token's Client ID) and show up in the audit log as "service-token:<client id>".
    if (payload.email) return { email: payload.email as string, name: (payload.name as string) || undefined };
    const cn = (payload.common_name as string) || 'unknown';
    return { email: `service-token:${cn}`, name: 'Service token' };
  } catch {
    throw new HttpError(401, 'unauthenticated', 'Invalid Cloudflare Access token');
  }
}

function getCookie(req: Request, name: string): string | null {
  const c = req.headers.get('cookie');
  if (!c) return null;
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

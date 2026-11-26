import { Hono } from 'hono';
import type { Env } from '../env';
import { sha256Hex, verifyAgentUrl, verifyEd25519 } from '../lib/crypto';
import { audit, type Row } from '../lib/db';
import { hubStub, originOf } from '../lib/hub';
import { HttpError, now, rid } from '../lib/util';
import { installScript } from './install';

export const agentRoutes = new Hono<{ Bindings: Env }>();

/** First boot of a gateway: exchange a one-time token for a gateway identity. */
agentRoutes.post('/enroll', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const { token, public_key, hostname, version, os, arch } = body ?? {};
  if (typeof token !== 'string' || typeof public_key !== 'string' || public_key.length < 40 || public_key.length > 60) throw new HttpError(400, 'bad_request', 'token and public_key are required');
  const hash = await sha256Hex(token);
  const t = await c.env.DB.prepare('SELECT * FROM enrollment_tokens WHERE token_hash = ?').bind(hash).first<Row>();
  if (!t) throw new HttpError(410, 'invalid_token', 'Enrollment token not recognised');
  if (t.used_at) throw new HttpError(410, 'token_used', 'This enrollment token was already used. Create a new one in the dashboard.');
  if (t.expires_at < now()) throw new HttpError(410, 'token_expired', 'This enrollment token expired. Create a new one in the dashboard.');
  const site = await c.env.DB.prepare('SELECT id, name FROM sites WHERE id = ?').bind(t.site_id).first<Row>();
  if (!site) throw new HttpError(410, 'site_deleted', 'The site for this token no longer exists');
  // One active gateway per site: a new enrollment replaces the previous one.
  const old = (await c.env.DB.prepare("SELECT id FROM gateways WHERE site_id = ? AND status != 'revoked'").bind(site.id).all<Row>()).results;
  const id = rid('gw');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE gateways SET status = 'revoked', revoked_at = ? WHERE site_id = ? AND status != 'revoked'").bind(now(), site.id),
    c.env.DB.prepare('INSERT INTO gateways (id, site_id, public_key, hostname, version, os, arch, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, site.id, public_key, String(hostname ?? '').slice(0, 100), String(version ?? '').slice(0, 40), String(os ?? '').slice(0, 20), String(arch ?? '').slice(0, 20), 'offline', now()),
    c.env.DB.prepare('UPDATE enrollment_tokens SET used_at = ?, gateway_id = ? WHERE token_hash = ?').bind(now(), id, hash),
  ]);
  if (old.length) await hubStub(c.env, site.id).rpc(site.id, originOf(c.req.raw, c.env), 'disconnectAgent', ['replaced by a new gateway']);
  await audit(c.env, `gateway:${id}`, 'gateway.enroll', { target_type: 'gateway', target_id: id, site_id: site.id, details: { hostname, version, arch } });
  return c.json({ site_id: site.id, site_name: site.name, gateway_id: id });
});

/** Signed WebSocket connect → hand the socket to the site's hub. */
agentRoutes.get('/connect', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') throw new HttpError(426, 'upgrade_required', 'WebSocket upgrade required');
  const gwId = c.req.header('x-screens-gateway') ?? '';
  const ts = c.req.header('x-screens-ts') ?? '';
  const nonce = c.req.header('x-screens-nonce') ?? '';
  const sig = c.req.header('x-screens-sig') ?? '';
  if (!gwId || !ts || !nonce || !sig) throw new HttpError(401, 'unauthenticated', 'Missing signature headers');
  if (Math.abs(now() - Number(ts)) > 300_000) throw new HttpError(401, 'clock_skew', 'Timestamp outside the allowed window; check the gateway clock');
  const g = await c.env.DB.prepare('SELECT * FROM gateways WHERE id = ?').bind(gwId).first<Row>();
  if (!g) throw new HttpError(401, 'unauthenticated', 'Unknown gateway');
  if (g.status === 'revoked') throw new HttpError(403, 'revoked', 'This gateway has been revoked');
  if (!(await verifyEd25519(g.public_key, `screens-agent-v1\n${gwId}\n${ts}\n${nonce}`, sig))) throw new HttpError(401, 'bad_signature', 'Signature check failed');
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-site-id', g.site_id);
  headers.set('x-gateway-id', gwId);
  headers.set('x-nonce', nonce);
  headers.set('x-origin', originOf(c.req.raw, c.env));
  return hubStub(c.env, g.site_id).fetch(new Request('https://hub/agent', { headers }));
});

/** Signed download (policies, APKs, agent binaries). */
agentRoutes.get('/files/*', async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^.*?\/agent\/v1\/files\//, ''));
  if (!(await verifyAgentUrl(c.env.SIGNING_SECRET, 'GET', key, c.req.query('exp') ?? null, c.req.query('sig') ?? null))) throw new HttpError(403, 'bad_signature', 'Invalid or expired link');
  const obj = await c.env.FILES.get(key);
  if (!obj) throw new HttpError(404, 'not_found', 'File not found');
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'Content-Length': String(obj.size), 'Cache-Control': 'no-store' } });
});

/** Signed upload (screenshots only). */
agentRoutes.put('/upload/*', async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^.*?\/agent\/v1\/upload\//, ''));
  if (!key.startsWith('shots/')) throw new HttpError(403, 'forbidden', 'Uploads are limited to screenshots');
  if (!(await verifyAgentUrl(c.env.SIGNING_SECRET, 'PUT', key, c.req.query('exp') ?? null, c.req.query('sig') ?? null))) throw new HttpError(403, 'bad_signature', 'Invalid or expired link');
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > 10 * 1024 * 1024) throw new HttpError(413, 'too_large', 'Upload too large');
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 10 * 1024 * 1024) throw new HttpError(413, 'too_large', 'Upload too large');
  await c.env.FILES.put(key, body, { httpMetadata: { contentType: c.req.header('content-type') ?? 'image/jpeg' } });
  return c.json({ ok: true, bytes: body.byteLength });
});

/** Latest gateway binary (public: it's open source; integrity is checked against the .sha256). */
agentRoutes.get('/dist/latest/:file', async (c) => {
  const file = c.req.param('file');
  const m = file.match(/^(amd64|arm64)(\.sha256)?$/);
  if (!m) throw new HttpError(404, 'not_found', 'Unknown architecture');
  const rel = await c.env.DB.prepare('SELECT * FROM agent_releases ORDER BY created_at DESC LIMIT 1').first<Row>();
  if (!rel) throw new HttpError(404, 'no_release', 'No gateway release has been published yet');
  const key = m[1] === 'arm64' ? rel.arm64_key : rel.amd64_key;
  const sha = m[1] === 'arm64' ? rel.arm64_sha256 : rel.amd64_sha256;
  if (!key) throw new HttpError(404, 'no_release', `No ${m[1]} build`);
  if (m[2]) return c.text(`${sha}\n`);
  const obj = await c.env.FILES.get(key);
  if (!obj) throw new HttpError(404, 'not_found', 'Release file missing');
  return new Response(obj.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(obj.size), 'X-Screens-Version': rel.version } });
});

export const installRoutes = new Hono<{ Bindings: Env }>();

/** One-line installer: curl -fsSL <origin>/install/<token> | sudo bash */
installRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!/^enr_[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(404, 'not_found', 'Unknown install link');
  const t = await c.env.DB.prepare('SELECT used_at, expires_at FROM enrollment_tokens WHERE token_hash = ?').bind(await sha256Hex(token)).first<Row>();
  if (!t || t.used_at || t.expires_at < now()) {
    return c.text('#!/bin/sh\necho "This Screens install link has expired or was already used. Create a new one from the site\'s Gateway tab." >&2\nexit 1\n', 410);
  }
  return c.text(installScript(originOf(c.req.raw, c.env), token), 200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' });
});

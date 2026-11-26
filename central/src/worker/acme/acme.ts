import type { Env } from '../env';
import { b64Decode, b64urlEncode, openJson, sealJson } from '../lib/crypto';
import { type Row, setAppSetting } from '../lib/db';
import { sleep } from '../lib/util';

/**
 * Minimal ACME (RFC 8555) client for Let's Encrypt using DNS-01 on a Cloudflare zone.
 * The CSR comes from the site gateway, so the certificate's private key never leaves the site.
 */
const LE = 'https://acme-v02.api.letsencrypt.org/directory';
const enc = new TextEncoder();

interface AcmeAccount { jwk: JsonWebKey; kid?: string; directory: string }

async function cf(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  if (!env.CF_API_TOKEN) throw new Error('CF_API_TOKEN secret is not set (needed to create DNS records for Private DNS)');
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init, headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(`Cloudflare API ${path}: ${JSON.stringify(j.errors ?? res.status)}`);
  return j.result;
}

export async function zoneId(env: Env, host: string): Promise<string> {
  if (env.CF_ZONE_ID) return env.CF_ZONE_ID;
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    const r = await cf(env, `/zones?name=${encodeURIComponent(name)}`);
    if (r?.length) return r[0].id;
  }
  throw new Error(`No Cloudflare zone found for ${host}`);
}

export async function upsertRecord(env: Env, zone: string, type: 'A' | 'TXT', name: string, content: string): Promise<string> {
  const existing = await cf(env, `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
  const body = JSON.stringify({ type, name, content, ttl: 60, proxied: false, comment: 'Managed by Screens' });
  if (existing?.length) return (await cf(env, `/zones/${zone}/dns_records/${existing[0].id}`, { method: 'PUT', body })).id;
  return (await cf(env, `/zones/${zone}/dns_records`, { method: 'POST', body })).id;
}

export async function deleteRecord(env: Env, zone: string, id: string) {
  await cf(env, `/zones/${zone}/dns_records/${id}`, { method: 'DELETE' }).catch(() => undefined);
}

// ---------------------------------------------------------------- JWS
async function importKey(jwk: JsonWebKey) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
function publicJwk(jwk: JsonWebKey) { return { crv: 'P-256', kty: 'EC', x: jwk.x!, y: jwk.y! }; }
async function thumbprint(jwk: JsonWebKey) {
  const p = publicJwk(jwk);
  return b64urlEncode(await crypto.subtle.digest('SHA-256', enc.encode(`{"crv":"${p.crv}","kty":"${p.kty}","x":"${p.x}","y":"${p.y}"}`)));
}

class Acme {
  private nonce: string | null = null;
  private dir: Record<string, string> = {};
  constructor(private acct: AcmeAccount) {}

  async init() {
    this.dir = await (await fetch(this.acct.directory)).json();
  }

  private async getNonce(): Promise<string> {
    if (this.nonce) { const n = this.nonce; this.nonce = null; return n; }
    const r = await fetch(this.dir.newNonce, { method: 'HEAD' });
    return r.headers.get('replay-nonce')!;
  }

  async post(url: string, payload: unknown | null, accept?: string): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const header: Record<string, unknown> = { alg: 'ES256', nonce: await this.getNonce(), url };
      if (this.acct.kid) header.kid = this.acct.kid; else header.jwk = publicJwk(this.acct.jwk);
      const protectedB64 = b64urlEncode(enc.encode(JSON.stringify(header)));
      const payloadB64 = payload === null ? '' : b64urlEncode(enc.encode(JSON.stringify(payload)));
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await importKey(this.acct.jwk), enc.encode(`${protectedB64}.${payloadB64}`));
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/jose+json', ...(accept ? { Accept: accept } : {}) },
        body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64urlEncode(sig) }),
      });
      this.nonce = res.headers.get('replay-nonce');
      if (res.status === 400) {
        const body: any = await res.clone().json().catch(() => ({}));
        if (body.type === 'urn:ietf:params:acme:error:badNonce') continue;
      }
      return res;
    }
    throw new Error('ACME: repeated bad nonce');
  }

  async json(url: string, payload: unknown | null): Promise<{ body: any; location: string | null }> {
    const res = await this.post(url, payload);
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ACME ${url}: ${body.detail ?? res.status}`);
    return { body, location: res.headers.get('location') };
  }

  async account(): Promise<string> {
    if (this.acct.kid) return this.acct.kid;
    const r = await this.json(this.dir.newAccount, { termsOfServiceAgreed: true });
    this.acct.kid = r.location!;
    return this.acct.kid;
  }

  get directory() { return this.dir; }
}

async function loadAccount(env: Env): Promise<AcmeAccount> {
  const directory = env.ACME_DIRECTORY || LE;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'acme_account'").first<Row>();
  const acct = row ? await openJson<AcmeAccount | null>(env.SECRETS_KEY, JSON.parse(row.value), null) : null;
  if (acct && acct.directory === directory) return acct;
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  return { jwk, directory };
}

async function saveAccount(env: Env, acct: AcmeAccount) {
  await setAppSetting(env, 'acme_account', await sealJson(env.SECRETS_KEY, acct));
}

function pemToDer(pem: string): Uint8Array {
  return b64Decode(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
}

/**
 * Issue a certificate for `hostname` using a CSR (PEM) produced by the gateway.
 * Returns the PEM certificate chain.
 */
export async function issueCertificate(env: Env, hostname: string, csrPem: string, log: (m: string) => void): Promise<string> {
  const acct = await loadAccount(env);
  const acme = new Acme(acct);
  await acme.init();
  await acme.account();
  await saveAccount(env, acct);
  const zone = await zoneId(env, hostname);

  log('Creating order');
  const order = await acme.json(acme.directory.newOrder, { identifiers: [{ type: 'dns', value: hostname }] });
  const orderUrl = order.location!;
  const txtIds: string[] = [];
  try {
    for (const authUrl of order.body.authorizations as string[]) {
      const auth = (await acme.json(authUrl, null)).body;
      if (auth.status === 'valid') continue;
      const ch = auth.challenges.find((c: any) => c.type === 'dns-01');
      if (!ch) throw new Error('No dns-01 challenge offered');
      const keyAuth = `${ch.token}.${await thumbprint(acct.jwk)}`;
      const txt = b64urlEncode(await crypto.subtle.digest('SHA-256', enc.encode(keyAuth)));
      log(`Publishing _acme-challenge TXT for ${auth.identifier.value}`);
      txtIds.push(await upsertRecord(env, zone, 'TXT', `_acme-challenge.${auth.identifier.value}`, `"${txt}"`));
      await sleep(15_000);
      await acme.json(ch.url, {});
      for (let i = 0; i < 30; i++) {
        await sleep(3000);
        const a = (await acme.json(authUrl, null)).body;
        if (a.status === 'valid') break;
        if (a.status === 'invalid') throw new Error(`Challenge failed: ${JSON.stringify(a.challenges?.find((c: any) => c.error)?.error ?? a)}`);
      }
    }
    log('Finalizing');
    let o = (await acme.json(order.body.finalize, { csr: b64urlEncode(pemToDer(csrPem)) })).body;
    for (let i = 0; i < 30 && o.status !== 'valid'; i++) {
      if (o.status === 'invalid') throw new Error('Order became invalid');
      await sleep(2000);
      o = (await acme.json(orderUrl, null)).body;
    }
    if (!o.certificate) throw new Error('No certificate URL in order');
    const res = await acme.post(o.certificate, null, 'application/pem-certificate-chain');
    if (!res.ok) throw new Error(`Certificate download failed: ${res.status}`);
    return await res.text();
  } finally {
    for (const id of txtIds) await deleteRecord(env, zone, id);
  }
}

/** Parse notAfter from the first certificate in a PEM chain (minimal DER walk). */
export function certNotAfter(pem: string): number | null {
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  if (!m) return null;
  const der = b64Decode(m[1].replace(/\s+/g, ''));
  // Find the validity SEQUENCE: two consecutive UTCTime/GeneralizedTime values.
  const times: number[] = [];
  for (let i = 0; i < der.length - 2 && times.length < 2; i++) {
    const tag = der[i], len = der[i + 1];
    if ((tag === 0x17 && len === 13) || (tag === 0x18 && len === 15)) {
      const s = new TextDecoder().decode(der.subarray(i + 2, i + 2 + len));
      const full = tag === 0x17 ? (Number(s.slice(0, 2)) >= 50 ? '19' : '20') + s : s;
      const t = Date.UTC(+full.slice(0, 4), +full.slice(4, 6) - 1, +full.slice(6, 8), +full.slice(8, 10), +full.slice(10, 12), +full.slice(12, 14));
      if (!Number.isNaN(t)) { times.push(t); i += 1 + len; }
    }
  }
  return times[1] ?? null;
}

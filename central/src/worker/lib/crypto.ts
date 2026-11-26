const enc = new TextEncoder();

export function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function hmacHex(secret: string, msg: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(msg)));
}
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Signed URL for agent file download/upload (PROTOCOL.md §7). */
export async function signAgentUrl(secret: string, origin: string, method: 'GET' | 'PUT', key: string, ttlMs = 15 * 60_000): Promise<string> {
  const exp = Date.now() + ttlMs;
  const sig = await hmacHex(secret, `${method}\n${key}\n${exp}`);
  const path = method === 'GET' ? 'files' : 'upload';
  return `${origin}/agent/v1/${path}/${key.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sig}`;
}
export async function verifyAgentUrl(secret: string, method: string, key: string, exp: string | null, sig: string | null): Promise<boolean> {
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const want = await hmacHex(secret, `${method}\n${key}\n${exp}`);
  return timingSafeEqual(want, sig);
}

/** Ed25519 verification for gateway connect signatures. */
export async function verifyEd25519(publicKeyB64url: string, message: string, sigB64url: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', b64urlDecode(publicKeyB64url), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, b64urlDecode(sigB64url), enc.encode(message));
  } catch {
    return false;
  }
}

/** AES-GCM encryption for device secrets at rest (Samsung tokens, LG client keys). */
async function aesKey(b64: string) {
  return crypto.subtle.importKey('raw', b64Decode(b64), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealJson(keyB64: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(JSON.stringify(value)));
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}
export async function openJson<T>(keyB64: string, sealed: string | null | undefined, fallback: T): Promise<T> {
  if (!sealed) return fallback;
  try {
    const [v, ivs, cts] = sealed.split('.');
    if (v !== 'v1') return fallback;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(ivs) }, await aesKey(keyB64), b64urlDecode(cts));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return fallback;
  }
}

export function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}_${b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)))}`;
}

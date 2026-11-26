export const now = () => Date.now();

const ALPHA = '0123456789abcdefghijkmnopqrstuvwxyz';
export function rid(prefix: string, len = 14): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += ALPHA[b % ALPHA.length];
  return `${prefix}_${s}`;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

export function normMac(mac?: string | null): string | null {
  if (!mac) return null;
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

export function dayKey(ts: number, tz = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
  return parts; // YYYY-MM-DD
}

export function hourKey(ts: number): number { return Math.floor(ts / 3_600_000) * 3_600_000; }

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
export function assertPackage(p: unknown): string {
  if (typeof p !== 'string' || !PACKAGE_RE.test(p) || p.length > 255) throw new HttpError(400, 'bad_package', 'Invalid package name');
  return p;
}

export function domainValid(d: string): boolean {
  return /^(?=.{1,253}$)(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/i.test(d);
}

const ipv4Int = (ip: string) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
/** True when `ip` falls inside `cidr` (IPv4 only, e.g. "10.10.50.7" in "10.10.50.1/24"). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(net ?? '') || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ipv4Int(ip) & mask) >>> 0) === ((ipv4Int(net) & mask) >>> 0);
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** Random DNS label for a site's DoT hostname (16 × base32 = 80 bits), so site names never reach public DNS or CT logs. */
export function randomDotLabel(): string {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(16))) s += B32[b & 31];
  return s;
}
export const isDotLabel = (l: string) => /^[a-z2-7]{16}$/.test(l);

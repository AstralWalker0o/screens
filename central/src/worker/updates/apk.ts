// APK inspection without loading the whole file: everything is read through a random-access reader,
// so the same code works on an in-memory buffer, an R2 object (range reads) or bytes pulled from a box over adb.
//   • ZIP end-of-central-directory + central directory → entries, native ABIs (lib/<abi>/*.so)
//   • AndroidManifest.xml (binary XML) → package, versionCode, versionName, minSdk
//   • APK Signing Block (v2, v3, v3.1 incl. proof-of-rotation lineage) and the JAR signature (PKCS#7) → certificates
// Certificates are identified by the SHA-256 of their DER encoding (what `apksigner --print-certs` shows) and by
// Java's Arrays.hashCode, which is what `dumpsys package` prints. Signatures are not verified here: Android does that
// at install time, and refuses any update whose signer doesn't match the installed app.

import { inflateSync } from 'fflate';
import type { ApkSigner, ApkSigning, CertRef } from '../../shared/updates';
import { parseManifest, type ManifestInfo } from './axml';

export interface RandomAccess {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class ApkError extends Error {}

export const bytesReader = (b: Uint8Array): RandomAccess => ({ size: b.length, read: async (o, l) => b.subarray(o, Math.min(b.length, o + l)) });

/** Serve reads from a cached tail (EOCD, central directory and signing block usually live there). */
export function tailCached(r: RandomAccess, tailBytes = 128 * 1024): RandomAccess {
  let tail: Promise<Uint8Array> | null = null;
  const start = Math.max(0, r.size - tailBytes);
  return {
    size: r.size,
    async read(o, l) {
      if (o >= start && o + l <= r.size) {
        tail ??= r.read(start, r.size - start);
        const t = await tail;
        return t.subarray(o - start, o - start + l);
      }
      return r.read(o, l);
    },
  };
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

// ---------------------------------------------------------------------------------------------- ZIP

export interface ZipEntry { name: string; method: number; compSize: number; size: number; localOffset: number }
export interface ZipDir { cdOffset: number; cdSize: number; count: number }

const MAX_CD = 16 * 1024 * 1024;

/** Locate the central directory from the end-of-central-directory record. */
export function findEocd(tail: Uint8Array, fileSize: number): ZipDir {
  for (let p = tail.length - 22; p >= Math.max(0, tail.length - 65557); p--) {
    if (u32(tail, p) !== 0x06054b50) continue;
    const commentLen = u16(tail, p + 20);
    if (p + 22 + commentLen !== tail.length) continue;
    const count = u16(tail, p + 10), cdSize = u32(tail, p + 12), cdOffset = u32(tail, p + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) throw new ApkError('ZIP64 archives are not supported');
    const eocdAt = fileSize - tail.length + p;
    if (cdOffset + cdSize > eocdAt) throw new ApkError('Corrupt ZIP: central directory overlaps its end record');
    return { cdOffset, cdSize, count };
  }
  throw new ApkError('Not a ZIP/APK file (no end-of-central-directory record)');
}

export async function readZip(r: RandomAccess): Promise<{ dir: ZipDir; entries: ZipEntry[] }> {
  if (r.size < 22) throw new ApkError('File is too small to be an APK');
  const tailLen = Math.min(r.size, 65557);
  const dir = findEocd(await r.read(r.size - tailLen, tailLen), r.size);
  if (dir.cdSize > MAX_CD) throw new ApkError('Central directory is too large');
  const cd = await r.read(dir.cdOffset, dir.cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && entries.length < 200_000) {
    if (u32(cd, p) !== 0x02014b50) break;
    const n = u16(cd, p + 28), e = u16(cd, p + 30), c = u16(cd, p + 32);
    if (p + 46 + n > cd.length) break;
    entries.push({
      name: new TextDecoder().decode(cd.subarray(p + 46, p + 46 + n)),
      method: u16(cd, p + 10), compSize: u32(cd, p + 20), size: u32(cd, p + 24), localOffset: u32(cd, p + 42),
    });
    p += 46 + n + e + c;
  }
  return { dir, entries };
}

export async function readEntry(r: RandomAccess, e: ZipEntry, maxSize = 8 * 1024 * 1024): Promise<Uint8Array> {
  if (e.size > maxSize || e.compSize > maxSize) throw new ApkError(`${e.name} is too large`);
  const h = await r.read(e.localOffset, 30);
  if (h.length < 30 || u32(h, 0) !== 0x04034b50) throw new ApkError(`Corrupt ZIP entry ${e.name}`);
  const data = await r.read(e.localOffset + 30 + u16(h, 26) + u16(h, 28), e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateSync(data, { out: new Uint8Array(e.size) });
  throw new ApkError(`Unsupported compression in ${e.name}`);
}

// ---------------------------------------------------------------------------------------------- certificates

export function javaHash(der: Uint8Array): string {
  let h = 1;
  for (let i = 0; i < der.length; i++) h = (Math.imul(31, h) + ((der[i] << 24) >> 24)) | 0;
  return (h >>> 0).toString(16);
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

interface Tlv { tag: number; at: number; start: number; end: number; next: number }
/** One DER TLV at `o` (definite lengths only). */
function tlv(b: Uint8Array, o: number, limit = b.length): Tlv | null {
  if (o + 2 > limit) return null;
  const tag = b[o];
  let len = b[o + 1], p = o + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > limit) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i];
    p += n;
  }
  if (p + len > limit) return null;
  return { tag, at: o, start: p, end: p + len, next: p + len };
}
function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = t.start; p < t.end && out.length < 10_000;) { const c = tlv(b, p, t.end); if (!c) break; out.push(c); p = c.next; }
  return out;
}

/** "CN=…, O=…" from an X.509 certificate, best effort. */
function subjectOf(der: Uint8Array): string | null {
  try {
    const cert = tlv(der, 0); if (!cert) return null;
    const tbs = children(der, cert)[0]; if (!tbs) return null;
    const f = children(der, tbs);
    const i = f[0]?.tag === 0xa0 ? 1 : 0;
    const subject = f[i + 4]; if (!subject) return null;
    const names: string[] = [];
    for (const set of children(der, subject)) for (const atv of children(der, set)) {
      const [oid, val] = children(der, atv);
      if (!oid || !val) continue;
      const o = [...der.subarray(oid.start, oid.end)].join('.');
      const key = o === '85.4.3' ? 'CN' : o === '85.4.10' ? 'O' : o === '85.4.11' ? 'OU' : null;
      if (key) names.push(`${key}=${new TextDecoder().decode(der.subarray(val.start, val.end))}`);
    }
    return names.join(', ').slice(0, 200) || null;
  } catch { return null; }
}
const serialOf = (der: Uint8Array): string | null => {
  const cert = tlv(der, 0); if (!cert) return null;
  const tbs = children(der, cert)[0]; if (!tbs) return null;
  const f = children(der, tbs);
  const s = f[f[0]?.tag === 0xa0 ? 1 : 0];
  return s?.tag === 0x02 ? [...der.subarray(s.start, s.end)].join(',') : null;
};

export async function certRef(der: Uint8Array): Promise<CertRef> {
  return { sha256: await sha256Hex(der), java_hash: javaHash(der), subject: subjectOf(der) };
}

/** Signer certificate(s) from a JAR signature block (META-INF/*.RSA|DSA|EC, PKCS#7 SignedData). */
export function pkcs7SignerCerts(b: Uint8Array): Uint8Array[] {
  const ci = tlv(b, 0); if (!ci || ci.tag !== 0x30) return [];
  const [, explicit] = children(b, ci); if (!explicit || explicit.tag !== 0xa0) return [];
  const sd = children(b, explicit)[0]; if (!sd || sd.tag !== 0x30) return [];
  const parts = children(b, sd);
  const certSet = parts.find((x) => x.tag === 0xa0);
  if (!certSet) return [];
  const certs = children(b, certSet).filter((c) => c.tag === 0x30).map((c) => b.subarray(c.at, c.end));
  if (certs.length <= 1) return certs;
  // Several certificates (a chain): keep the ones named by a SignerInfo (issuer + serial).
  const infos = parts[parts.length - 1];
  const serials = new Set<string>();
  if (infos?.tag === 0x31) for (const si of children(b, infos)) {
    const ias = children(b, si)[1];
    const serial = ias && children(b, ias)[1];
    if (serial?.tag === 0x02) serials.add([...b.subarray(serial.start, serial.end)].join(','));
  }
  const named = certs.filter((c) => serials.has(serialOf(c) ?? ''));
  return named.length ? named : certs.slice(0, 1);
}
// ---------------------------------------------------------------------------------------------- APK Signing Block

const SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const ID_V2 = 0x7109871a, ID_V3 = 0xf05368c0, ID_V31 = 0x1b93ad61;
const ATTR_ROTATION = 0x3ba06f8c;
const MAX_SIG_BLOCK = 4 * 1024 * 1024;

/** Length-prefixed (uint32 LE) slices. */
class Lp {
  constructor(public b: Uint8Array, public p = 0, public end = b.length) {}
  get left() { return this.end - this.p; }
  slice(): Lp {
    if (this.left < 4) throw new ApkError('Truncated signing block');
    const n = u32(this.b, this.p);
    if (n > this.left - 4) throw new ApkError('Corrupt signing block');
    const s = new Lp(this.b, this.p + 4, this.p + 4 + n);
    this.p += 4 + n;
    return s;
  }
  int(): number {
    if (this.left < 4) throw new ApkError('Truncated signing block');
    const v = u32(this.b, this.p); this.p += 4; return v;
  }
  bytes(): Uint8Array { return this.b.subarray(this.p, this.end); }
}

/** Where the signing block sits, from the 24 bytes just before the central directory. */
export function sigBlockFooter(footer: Uint8Array): number | null {
  if (footer.length < 24 || new TextDecoder().decode(footer.subarray(8, 24)) !== SIG_BLOCK_MAGIC) return null;
  return u64(footer, 0);
}

async function parseSigners(value: Uint8Array, v3: boolean): Promise<ApkSigner[]> {
  const out: ApkSigner[] = [];
  const seq = new Lp(value).slice();
  while (seq.left > 0 && out.length < 10) {
    const signer = seq.slice();
    const signed = signer.slice();
    let min = 0, max = 0x7fffffff;
    if (v3) { min = signer.int(); max = signer.int(); }
    const digests = signed.slice(); void digests;
    const certs = signed.slice();
    const ders: Uint8Array[] = [];
    while (certs.left > 0 && ders.length < 10) ders.push(certs.slice().bytes());
    const lineage: CertRef[] = [];
    if (v3) {
      signed.int(); signed.int(); // min/max SDK repeated inside the signed data
      const attrs = signed.slice();
      while (attrs.left > 0) {
        const a = attrs.slice();
        if (a.int() === ATTR_ROTATION) lineage.push(...(await parseLineage(a.bytes())));
      }
    }
    // Only the first certificate identifies the signer; the rest is chain.
    out.push({ min_sdk: min, max_sdk: max, certs: ders.length ? [await certRef(ders[0])] : [], lineage });
  }
  return out;
}

/** APK Signature Scheme v3 proof-of-rotation: every certificate the app has been signed with, oldest first. */
async function parseLineage(v: Uint8Array): Promise<CertRef[]> {
  const r = new Lp(v);
  if (r.int() !== 1) return [];
  const out: CertRef[] = [];
  while (r.left > 0 && out.length < 32) {
    const node = r.slice();
    const signed = node.slice();
    out.push(await certRef(signed.slice().bytes()));
  }
  return out;
}

/** Parse the APK Signing Block that ends at `cdOffset`. Null when the APK only has a JAR signature. */
export async function readSigningBlock(r: RandomAccess, cdOffset: number): Promise<Pick<ApkSigning, 'v31' | 'v3' | 'v2'> | null> {
  if (cdOffset < 32) return null;
  const size = sigBlockFooter(await r.read(cdOffset - 24, 24));
  if (size == null) return null;
  if (size < 24 || size > MAX_SIG_BLOCK || size + 8 > cdOffset) throw new ApkError('Corrupt APK signing block');
  const block = await r.read(cdOffset - size - 8, size + 8);
  if (u64(block, 0) !== size) throw new ApkError('Corrupt APK signing block (size mismatch)');
  const res = { v31: [] as ApkSigner[], v3: [] as ApkSigner[], v2: [] as ApkSigner[] };
  let p = 8;
  const end = block.length - 24;
  while (p + 12 <= end) {
    const len = u64(block, p);
    if (len < 4 || len > end - p - 8) throw new ApkError('Corrupt APK signing block entry');
    const id = u32(block, p + 8);
    const value = block.subarray(p + 12, p + 8 + len);
    if (id === ID_V2) res.v2 = await parseSigners(value, false);
    else if (id === ID_V3) res.v3 = await parseSigners(value, true);
    else if (id === ID_V31) res.v31 = await parseSigners(value, true);
    p += 8 + len;
  }
  return res;
}

async function readJarSigners(r: RandomAccess, entries: ZipEntry[]): Promise<ApkSigner[]> {
  const out: ApkSigner[] = [];
  for (const e of entries.filter((x) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(x.name)).slice(0, 4)) {
    try {
      const certs = pkcs7SignerCerts(await readEntry(r, e, 1024 * 1024));
      if (certs.length) out.push({ min_sdk: 0, max_sdk: 0x7fffffff, certs: [await certRef(certs[0])], lineage: [] });
    } catch { /* unreadable signature file: ignore */ }
  }
  return out;
}

export function schemesOf(s: Omit<ApkSigning, 'schemes'>): ApkSigning['schemes'] {
  return [s.v31.length && 'v3.1', s.v3.length && 'v3', s.v2.length && 'v2', s.v1.length && 'v1'].filter(Boolean) as ApkSigning['schemes'];
}

/** Every certificate an APK names (all schemes, all lineages), for "is this the key we trust?" checks. */
export function allCerts(s: ApkSigning | null | undefined): CertRef[] {
  if (!s) return [];
  const seen = new Map<string, CertRef>();
  for (const x of [...s.v31, ...s.v3, ...s.v2, ...s.v1]) for (const c of [...x.certs, ...x.lineage]) seen.set(c.sha256, c);
  return [...seen.values()];
}
/** The newest signer: v3.1, else v3, else v2, else v1 (first certificate). */
export function newestSignerCert(s: ApkSigning | null | undefined): CertRef | null {
  if (!s) return null;
  const pick = (l: ApkSigner[]) => [...l].sort((a, b) => b.min_sdk - a.min_sdk)[0]?.certs[0] ?? null;
  return pick(s.v31) ?? pick(s.v3) ?? pick(s.v2) ?? pick(s.v1);
}

// ---------------------------------------------------------------------------------------------- everything

export interface ApkInfo extends ManifestInfo {
  abis: string[];
  signing: ApkSigning;
  size: number;
}

const ABI_ORDER = ['arm64-v8a', 'armeabi-v7a', 'armeabi', 'x86_64', 'x86', 'riscv64', 'mips64', 'mips'];

export function abisOf(entries: ZipEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) { const m = e.name.match(/^lib\/([A-Za-z0-9_-]+)\/[^/]+\.so$/); if (m) set.add(m[1]); }
  return [...set].sort((a, b) => (ABI_ORDER.indexOf(a) + 1 || 99) - (ABI_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
}

export async function inspectApk(input: RandomAccess): Promise<ApkInfo> {
  const r = tailCached(input);
  const { dir, entries } = await readZip(r);
  const m = entries.find((e) => e.name === 'AndroidManifest.xml');
  if (!m) throw new ApkError('No AndroidManifest.xml: this is not an Android app');
  const manifest = parseManifest(await readEntry(r, m));
  if (!manifest) throw new ApkError('Could not read the app’s manifest (package name / version)');
  const block = await readSigningBlock(r, dir.cdOffset);
  const v1 = await readJarSigners(r, entries);
  const sig = { v31: block?.v31 ?? [], v3: block?.v3 ?? [], v2: block?.v2 ?? [], v1 };
  const signing: ApkSigning = { schemes: schemesOf(sig), ...sig };
  if (!signing.schemes.length) throw new ApkError('The APK is not signed');
  return { ...manifest, abis: abisOf(entries), signing, size: input.size };
}

/** Only the signing block of an APK, given its end-of-file bytes and a way to read more (used on boxes). */
export async function signingFromTail(r: RandomAccess): Promise<ApkSigning | null> {
  const c = tailCached(r);
  const tailLen = Math.min(c.size, 65557);
  const dir = findEocd(await c.read(c.size - tailLen, tailLen), c.size);
  const block = await readSigningBlock(c, dir.cdOffset);
  if (!block) return null;
  const sig = { ...block, v1: [] };
  return { schemes: schemesOf(sig), ...sig };
}

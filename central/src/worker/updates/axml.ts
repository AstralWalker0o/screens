// Minimal, defensive reader for Android's binary XML (AXML), enough to read AndroidManifest.xml:
// package, versionCode (+ versionCodeMajor), versionName, min/target SDK and a literal application label.
// Malformed input never throws: anything out of bounds just reads as missing.

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;

// android.R.attr ids
const ATTR = {
  label: 0x01010001,
  minSdkVersion: 0x0101020c,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  targetSdkVersion: 0x01010270,
  versionCodeMajor: 0x01010576,
} as const;

export interface ManifestInfo {
  package: string;
  version_code: number | null;
  version_name: string | null;
  min_sdk: number | null;
  target_sdk: number | null;
  label: string | null;
}

interface Attr { name: string; resId: number | null; str: string | null; type: number; data: number }

export function parseManifest(buf: Uint8Array): ManifestInfo | null {
  if (buf.length < 8) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => (o + 2 <= buf.length ? dv.getUint16(o, true) : 0);
  const u32 = (o: number) => (o + 4 <= buf.length ? dv.getUint32(o, true) : 0);
  if (u16(0) !== RES_XML_TYPE) return null;

  let pool: StringPool | null = null;
  let resIds: number[] = [];
  let depth = 0;
  let pkg: string | null = null;
  let vcode: number | null = null, vmajor = 0, vname: string | null = null;
  let minSdk: number | null = null, targetSdk: number | null = null, label: string | null = null;

  let off = u16(2) || 8;
  for (let guard = 0; off + 8 <= buf.length && guard < 200_000; guard++) {
    const type = u16(off), hsize = u16(off + 2), size = u32(off + 4);
    if (size < 8 || off + size > buf.length || hsize > size) break;
    if (type === RES_STRING_POOL_TYPE && !pool) pool = new StringPool(buf, dv, off, hsize, size);
    else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      resIds = [];
      for (let i = off + hsize; i + 4 <= off + size; i += 4) resIds.push(u32(i));
    } else if (type === RES_XML_START_ELEMENT_TYPE && pool) {
      depth++;
      const name = pool.get(u32(off + 20));
      const attrStart = u16(off + 24), attrSize = u16(off + 26), attrCount = u16(off + 28);
      const attrs: Attr[] = [];
      if (attrSize >= 20) {
        for (let i = 0; i < attrCount; i++) {
          const a = off + 16 + attrStart + i * attrSize;
          if (a + 20 > off + size) break;
          const nameIdx = u32(a + 4), raw = u32(a + 8), dataType = buf[a + 15], data = u32(a + 16);
          const str = raw !== 0xffffffff ? pool.get(raw) : dataType === TYPE_STRING ? pool.get(data) : null;
          attrs.push({ name: pool.get(nameIdx) ?? '', resId: nameIdx < resIds.length ? resIds[nameIdx] : null, str, type: dataType, data });
        }
      }
      const find = (id: number, n: string) => attrs.find((x) => x.resId === id) ?? attrs.find((x) => x.name === n && (x.resId == null || x.resId === 0));
      const int = (a?: Attr) => (!a ? null : a.type === TYPE_INT_DEC || a.type === TYPE_INT_HEX ? a.data : a.str && /^\d+$/.test(a.str) ? Number(a.str) : null);
      if (depth === 1 && name === 'manifest') {
        pkg = attrs.find((x) => x.name === 'package')?.str ?? null;
        vcode = int(find(ATTR.versionCode, 'versionCode'));
        vmajor = int(find(ATTR.versionCodeMajor, 'versionCodeMajor')) ?? 0;
        const vn = find(ATTR.versionName, 'versionName');
        vname = vn && vn.type !== TYPE_REFERENCE ? vn.str : null;
      } else if (depth === 2 && name === 'uses-sdk') {
        minSdk = int(find(ATTR.minSdkVersion, 'minSdkVersion'));
        targetSdk = int(find(ATTR.targetSdkVersion, 'targetSdkVersion'));
      } else if (depth === 2 && name === 'application') {
        const l = find(ATTR.label, 'label');
        label = l && l.type !== TYPE_REFERENCE && l.str ? l.str : null;
      }
    } else if (type === RES_XML_END_ELEMENT_TYPE) depth = Math.max(0, depth - 1);
    off += size;
  }
  if (!pkg || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg)) return null;
  const version_code = vcode == null ? null : vmajor ? vmajor * 2 ** 32 + vcode : vcode;
  return { package: pkg, version_code, version_name: vname, min_sdk: minSdk ?? 1, target_sdk: targetSdk, label };
}

class StringPool {
  private count: number;
  private utf8: boolean;
  private base: number;
  private offsets: number;
  private end: number;
  private cache = new Map<number, string>();
  constructor(private buf: Uint8Array, private dv: DataView, off: number, hsize: number, size: number) {
    this.count = dv.getUint32(off + 8, true);
    this.utf8 = (dv.getUint32(off + 16, true) & 0x100) !== 0;
    this.base = off + dv.getUint32(off + 20, true);
    this.offsets = off + hsize;
    this.end = off + size;
  }
  get(i: number): string | null {
    if (i >= this.count || i > 1_000_000) return null;
    const hit = this.cache.get(i);
    if (hit !== undefined) return hit;
    let s: string | null = null;
    try {
      const o = this.offsets + i * 4;
      if (o + 4 > this.end) return null;
      let p = this.base + this.dv.getUint32(o, true);
      if (this.utf8) {
        if (this.buf[p++] & 0x80) p++;                     // UTF-16 length (unused)
        let len = this.buf[p++];
        if (len & 0x80) len = ((len & 0x7f) << 8) | this.buf[p++];
        if (p + len <= this.end) s = new TextDecoder().decode(this.buf.subarray(p, p + len));
      } else {
        let len = this.dv.getUint16(p, true); p += 2;
        if (len & 0x8000) { len = ((len & 0x7fff) << 16) | this.dv.getUint16(p, true); p += 2; }
        if (len <= 32_768 && p + len * 2 <= this.end) {
          let out = '';
          for (let j = 0; j < len; j += 2048) {
            const codes: number[] = [];
            for (let k = j; k < Math.min(len, j + 2048); k++) codes.push(this.dv.getUint16(p + k * 2, true));
            out += String.fromCharCode(...codes);
          }
          s = out;
        }
      }
    } catch { s = null; }
    if (s !== null) this.cache.set(i, s);
    return s;
  }
}

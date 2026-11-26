import { unzipSync } from 'fflate';

/** Read package / versionCode / versionName from an APK's binary AndroidManifest.xml. */
export function parseApk(apk: Uint8Array): { package: string; version_code: number | null; version_name: string | null; label: string | null } | null {
  try {
    const files = unzipSync(apk, { filter: (f) => f.name === 'AndroidManifest.xml' });
    const m = files['AndroidManifest.xml'];
    return m ? parseAxmlManifest(m) : null;
  } catch {
    return null;
  }
}

const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;
const ATTR_LABEL = 0x01010001;

export function parseAxmlManifest(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  if (u16(0) !== 0x0003) return null;
  let strings: string[] = [];
  let resIds: number[] = [];
  let pkg: string | null = null, vcode: number | null = null, vname: string | null = null, label: string | null = null;
  let off = u16(2);
  while (off + 8 <= buf.length) {
    const type = u16(off), hsize = u16(off + 2), size = u32(off + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = readStringPool(dv, off);
    else if (type === 0x0180) { resIds = []; for (let i = off + hsize; i < off + size; i += 4) resIds.push(u32(i)); }
    else if (type === 0x0102) {
      const name = strings[u32(off + 20)];
      const attrStart = u16(off + 24), attrSize = u16(off + 26), attrCount = u16(off + 28);
      for (let i = 0; i < attrCount; i++) {
        const a = off + 16 + attrStart + i * attrSize;
        const nameIdx = u32(a + 4), raw = u32(a + 8), dataType = buf[a + 15], data = u32(a + 16);
        const attrName = strings[nameIdx] ?? '';
        const resId = resIds[nameIdx];
        const str = raw !== 0xffffffff ? strings[raw] : dataType === 0x03 ? strings[data] : null;
        if (name === 'manifest') {
          if (attrName === 'package') pkg = str;
          if (resId === ATTR_VERSION_CODE || attrName === 'versionCode') vcode = dataType === 0x10 || dataType === 0x11 ? data : Number(str) || null;
          if (resId === ATTR_VERSION_NAME || attrName === 'versionName') vname = str;
        } else if (name === 'application' && (resId === ATTR_LABEL || attrName === 'label') && str) label = str;
      }
      if (name === 'application') break;
    }
    off += size;
  }
  return pkg ? { package: pkg, version_code: vcode, version_name: vname, label } : null;
}

function readStringPool(dv: DataView, off: number): string[] {
  const count = dv.getUint32(off + 8, true);
  const flags = dv.getUint32(off + 16, true);
  const stringsStart = dv.getUint32(off + 20, true);
  const utf8 = (flags & 0x100) !== 0;
  const out: string[] = [];
  const base = off + stringsStart;
  for (let i = 0; i < count; i++) {
    let p = base + dv.getUint32(off + 28 + i * 4, true);
    if (utf8) {
      let n = dv.getUint8(p++); if (n & 0x80) p++; // utf16 length (unused)
      let len = dv.getUint8(p++); if (len & 0x80) len = ((len & 0x7f) << 8) | dv.getUint8(p++);
      out.push(new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + p, len)));
      void n;
    } else {
      let len = dv.getUint16(p, true); p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | dv.getUint16(p, true); p += 2; }
      let s = '';
      for (let j = 0; j < len; j++) s += String.fromCharCode(dv.getUint16(p + j * 2, true));
      out.push(s);
    }
  }
  return out;
}

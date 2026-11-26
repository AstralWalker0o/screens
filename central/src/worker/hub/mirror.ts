/**
 * Live screen mirroring (docs/MIRROR.md): scrcpy v5.0.1 stream framing and session plumbing.
 * The hub turns scrcpy's raw video socket into aligned units (one WebSocket message each) so viewers can join
 * mid-stream, and forwards viewer control messages (allow-listed types only) to the control socket.
 */

export const SCRCPY_VERSION = '5.0.1';
export const SCRCPY_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
export const SCRCPY_R2_KEY = `vendor/scrcpy-server-v${SCRCPY_VERSION}`;
export const SCRCPY_DEVICE_PATH = `/data/local/tmp/screens-scrcpy-${SCRCPY_VERSION}.jar`;

export interface MirrorOptions { max_size: number; max_fps: number; bitrate: number }

export function mirrorOptions(q: URLSearchParams): MirrorOptions {
  const num = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 ? Math.round(Math.min(hi, Math.max(lo, v))) : d;
  };
  return { max_size: num('max_size', 1280, 480, 1920), max_fps: num('max_fps', 30, 5, 60), bitrate: num('bitrate', 4_000_000, 500_000, 16_000_000) };
}

/** The adb shell command that starts the scrcpy server in the background. */
export function serverCommand(scid: string, o: MirrorOptions): string {
  if (!/^[0-9a-f]{8}$/.test(scid)) throw new Error('bad scid');
  const args = [
    SCRCPY_VERSION, `scid=${scid}`, 'log_level=info', 'audio=false', 'control=true', 'tunnel_forward=true', 'video_codec=h264',
    `max_size=${o.max_size}`, `max_fps=${o.max_fps}`, `video_bit_rate=${o.bitrate}`, 'cleanup=true', 'power_off_on_close=false',
    'clipboard_autosync=false', 'send_device_meta=true', 'send_frame_meta=true', 'send_dummy_byte=true', 'send_stream_meta=true',
  ].join(' ');
  return `CLASSPATH=${SCRCPY_DEVICE_PATH} nohup app_process / com.genymobile.scrcpy.Server ${args} >/dev/null 2>&1 &`;
}

export interface StreamMeta { device_name: string; codec: string; width: number; height: number }

/**
 * Incremental parser for the scrcpy video socket:
 *   dummy byte · 64-byte device name · u32 codec id · (session header | packet header + payload)*
 * Emits each session header (12 bytes) and each packet (12-byte header + payload) as one aligned unit.
 */
export class ScrcpyVideoParser {
  private buf = new Uint8Array(64 * 1024);
  private len = 0;
  private phase: 'dummy' | 'name' | 'codec' | 'units' = 'dummy';
  deviceName = '';
  codec = '';
  width = 0;
  height = 0;
  /** The most recent config packet (SPS/PPS), replayed to late joiners before a reset keyframe. */
  lastConfig: Uint8Array | null = null;

  constructor(private onUnit: (unit: Uint8Array, kind: 'session' | 'config' | 'key' | 'delta') => void, private onMeta: (m: StreamMeta) => void) {}

  push(chunk: Uint8Array) {
    if (this.len + chunk.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    let off = 0;
    for (;;) {
      const avail = this.len - off;
      if (this.phase === 'dummy') {
        if (avail < 1) break;
        off += 1; this.phase = 'name'; continue;
      }
      if (this.phase === 'name') {
        if (avail < 64) break;
        const raw = this.buf.subarray(off, off + 64);
        const end = raw.indexOf(0);
        this.deviceName = new TextDecoder().decode(raw.subarray(0, end < 0 ? 64 : end));
        off += 64; this.phase = 'codec'; continue;
      }
      if (this.phase === 'codec') {
        if (avail < 4) break;
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + off, 4);
        const id = dv.getUint32(0);
        if (id === 0 || id === 1) throw new Error(id === 1 ? 'device reported a configuration error' : 'video stream disabled by device');
        this.codec = String.fromCharCode((id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff);
        off += 4; this.phase = 'units'; continue;
      }
      if (avail < 12) break;
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset + off, 12);
      if (this.buf[off] & 0x80) {
        this.width = dv.getUint32(4);
        this.height = dv.getUint32(8);
        this.onUnit(this.buf.slice(off, off + 12), 'session');
        this.onMeta({ device_name: this.deviceName, codec: this.codec, width: this.width, height: this.height });
        off += 12; continue;
      }
      const size = dv.getUint32(8);
      if (size > 16 * 1024 * 1024) throw new Error(`implausible packet size ${size}`);
      if (avail < 12 + size) break;
      const hi = dv.getUint32(0);
      const kind = hi & 0x40000000 ? 'config' : hi & 0x20000000 ? 'key' : 'delta';
      const unit = this.buf.slice(off, off + 12 + size);
      if (kind === 'config') this.lastConfig = unit;
      this.onUnit(unit, kind);
      off += 12 + size;
    }
    if (off > 0) {
      this.buf.copyWithin(0, off, this.len);
      this.len -= off;
    }
  }
}

/** Control message types a viewer may send (see docs/MIRROR.md). Returns an error string or null. */
export function checkControl(b: Uint8Array): string | null {
  if (!b.length) return 'empty';
  const t = b[0];
  const fixed: Record<number, number> = { 0: 14, 2: 32, 3: 21, 4: 2, 10: 2, 17: 1 };
  if (t in fixed) return b.length === fixed[t] ? null : `type ${t} must be ${fixed[t]} bytes`;
  if (t === 1) {
    if (b.length < 5) return 'short text message';
    const n = new DataView(b.buffer, b.byteOffset + 1, 4).getUint32(0);
    return n <= 300 && b.length === 5 + n ? null : 'bad text length';
  }
  return `control type ${t} not allowed`;
}

export const RESET_VIDEO = new Uint8Array([17]);

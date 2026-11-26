// scrcpy v5 wire helpers for the browser mirror player (docs/MIRROR.md).
// Pure functions only (no DOM), so they can be unit-tested in Node.

// ---------------------------------------------------------------------------
// Server → browser packets

export const PTS_CONFIG = 1n << 62n;
export const PTS_KEYFRAME = 1n << 61n;
export const PTS_MASK = PTS_KEYFRAME - 1n;
export const HEADER_SIZE = 12;

export type ScrcpyPacket =
  | { kind: 'session'; resized: boolean; width: number; height: number }
  | { kind: 'media'; config: boolean; keyframe: boolean; pts: bigint | null; data: Uint8Array };

function asBytes(buf: ArrayBuffer | Uint8Array): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

/** Parse one aligned scrcpy unit: a 12-byte header, plus the payload for media packets. */
export function parsePacket(buf: ArrayBuffer | Uint8Array): ScrcpyPacket {
  const bytes = asBytes(buf);
  if (bytes.byteLength < HEADER_SIZE) throw new RangeError(`scrcpy packet too short (${bytes.byteLength} bytes)`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] & 0x80) {
    const flags = view.getUint32(0) & 0x7fffffff;
    return { kind: 'session', resized: (flags & 1) !== 0, width: view.getUint32(4), height: view.getUint32(8) };
  }
  const ptsFlags = view.getBigUint64(0);
  const len = view.getUint32(8);
  if (bytes.byteLength < HEADER_SIZE + len) throw new RangeError(`scrcpy packet truncated: header says ${len} bytes, got ${bytes.byteLength - HEADER_SIZE}`);
  const config = (ptsFlags & PTS_CONFIG) !== 0n;
  return {
    kind: 'media',
    config,
    keyframe: (ptsFlags & PTS_KEYFRAME) !== 0n,
    pts: config ? null : ptsFlags & PTS_MASK,
    data: bytes.subarray(HEADER_SIZE, HEADER_SIZE + len),
  };
}

/** Build a media packet (used by the mock stream and tests). */
export function encodeMediaPacket(p: { config?: boolean; keyframe?: boolean; pts?: bigint; data: Uint8Array }): ArrayBuffer {
  const out = new Uint8Array(HEADER_SIZE + p.data.byteLength);
  const view = new DataView(out.buffer);
  let flags = p.config ? PTS_CONFIG : (p.pts ?? 0n) & PTS_MASK;
  if (p.keyframe) flags |= PTS_KEYFRAME;
  view.setBigUint64(0, flags);
  view.setUint32(8, p.data.byteLength);
  out.set(p.data, HEADER_SIZE);
  return out.buffer;
}

/** Build a session packet (MSB of the first byte set). */
export function encodeSessionPacket(width: number, height: number, resized = false): ArrayBuffer {
  const out = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(out);
  view.setUint32(0, 0x80000000 | (resized ? 1 : 0));
  view.setUint32(4, width);
  view.setUint32(8, height);
  return out;
}

// ---------------------------------------------------------------------------
// H.264 Annex-B helpers

/** Split Annex-B data into NAL units (start codes removed). */
export function splitNalUnits(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; len: number }[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        starts.push({ at: i, len: 3 });
        i += 2;
      } else if (data[i + 2] === 0 && i + 3 < data.length && data[i + 3] === 1) {
        starts.push({ at: i, len: 4 });
        i += 3;
      }
    }
  }
  return starts.map((s, k) => data.subarray(s.at + s.len, k + 1 < starts.length ? starts[k + 1].at : data.length)).filter((n) => n.length > 0);
}

export const nalType = (nal: Uint8Array): number => nal[0] & 0x1f;
export const NAL = { SLICE: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9 } as const;

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/**
 * WebCodecs codec string `avc1.PPCCLL` from the first SPS in Annex-B data:
 * skip the start code and the NAL header byte, then read profile_idc, the constraint byte and level_idc.
 */
export function spsCodecString(data: Uint8Array): string | null {
  const sps = splitNalUnits(data).find((n) => nalType(n) === NAL.SPS);
  if (!sps || sps.length < 4) return null;
  return `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`;
}

/** Concatenate byte arrays (e.g. config packet + next media packet). */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Browser → server control messages (big-endian)

export const CONTROL = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  SET_DISPLAY_POWER: 10,
  RESET_VIDEO: 17,
} as const;

export const KEY_ACTION = { DOWN: 0, UP: 1 } as const;
export const TOUCH_ACTION = { DOWN: 0, UP: 1, MOVE: 2 } as const;
export const POINTER_MOUSE = -1n;
export const POINTER_FINGER = -2n;
export const BUTTON_PRIMARY = 1;
export const TEXT_MAX_BYTES = 300;

/** INJECT_KEYCODE: 14 bytes. */
export function encodeKeycode(action: number, keycode: number, repeat = 0, metaState = 0): ArrayBuffer {
  const buf = new ArrayBuffer(14);
  const v = new DataView(buf);
  v.setUint8(0, CONTROL.INJECT_KEYCODE);
  v.setUint8(1, action);
  v.setInt32(2, keycode);
  v.setInt32(6, repeat);
  v.setInt32(10, metaState);
  return buf;
}

/** UTF-8 encode, truncated to `max` bytes without splitting a character. */
export function utf8Truncate(text: string, max = TEXT_MAX_BYTES): Uint8Array {
  const enc = new TextEncoder();
  const full = enc.encode(text);
  if (full.byteLength <= max) return full;
  let out = new Uint8Array(0);
  let acc = '';
  for (const ch of text) {
    const next = enc.encode(acc + ch);
    if (next.byteLength > max) break;
    acc += ch;
    out = next;
  }
  return out;
}

/** INJECT_TEXT: type, u32 length, UTF-8 bytes (≤ 300). */
export function encodeText(text: string): ArrayBuffer {
  const bytes = utf8Truncate(text);
  const buf = new ArrayBuffer(5 + bytes.byteLength);
  const v = new DataView(buf);
  v.setUint8(0, CONTROL.INJECT_TEXT);
  v.setUint32(1, bytes.byteLength);
  new Uint8Array(buf, 5).set(bytes);
  return buf;
}

/** 0..1 → u16 fixed point (1.0 → 0xffff). */
export function toU16Fixed(f: number): number {
  if (!(f > 0)) return 0;
  if (f >= 1) return 0xffff;
  return Math.min(0xffff, Math.round(f * 0x10000));
}

/** −16..16 → i16 fixed point (value / 16 × 32767). */
export function toI16Scroll(v: number): number {
  const c = Math.max(-16, Math.min(16, v));
  return Math.round((c / 16) * 32767);
}

export interface TouchMessage {
  action: number; pointerId: bigint; x: number; y: number; width: number; height: number;
  pressure?: number; actionButton?: number; buttons?: number;
}

/** INJECT_TOUCH_EVENT: 32 bytes. x/y are video pixels; width/height must equal the session size. */
export function encodeTouch(m: TouchMessage): ArrayBuffer {
  const buf = new ArrayBuffer(32);
  const v = new DataView(buf);
  v.setUint8(0, CONTROL.INJECT_TOUCH_EVENT);
  v.setUint8(1, m.action);
  v.setBigInt64(2, m.pointerId);
  v.setInt32(10, Math.round(m.x));
  v.setInt32(14, Math.round(m.y));
  v.setUint16(18, m.width);
  v.setUint16(20, m.height);
  v.setUint16(22, toU16Fixed(m.pressure ?? (m.action === TOUCH_ACTION.UP ? 0 : 1)));
  v.setInt32(24, m.actionButton ?? 0);
  v.setInt32(28, m.buttons ?? 0);
  return buf;
}

export interface ScrollMessage { x: number; y: number; width: number; height: number; hscroll: number; vscroll: number; buttons?: number }

/** INJECT_SCROLL_EVENT: 21 bytes. hscroll/vscroll in −16..16 (positive vscroll = up). */
export function encodeScroll(m: ScrollMessage): ArrayBuffer {
  const buf = new ArrayBuffer(21);
  const v = new DataView(buf);
  v.setUint8(0, CONTROL.INJECT_SCROLL_EVENT);
  v.setInt32(1, Math.round(m.x));
  v.setInt32(5, Math.round(m.y));
  v.setUint16(9, m.width);
  v.setUint16(11, m.height);
  v.setInt16(13, toI16Scroll(m.hscroll));
  v.setInt16(15, toI16Scroll(m.vscroll));
  v.setInt32(17, m.buttons ?? 0);
  return buf;
}

/** BACK_OR_SCREEN_ON: 2 bytes. */
export function encodeBackOrScreenOn(action: number): ArrayBuffer {
  return new Uint8Array([CONTROL.BACK_OR_SCREEN_ON, action]).buffer;
}

/** SET_DISPLAY_POWER: 2 bytes. Turning the TV's panel off keeps the mirror running. */
export function encodeSetDisplayPower(on: boolean): ArrayBuffer {
  return new Uint8Array([CONTROL.SET_DISPLAY_POWER, on ? 1 : 0]).buffer;
}

/** RESET_VIDEO: 1 byte — asks the server for a fresh keyframe. */
export function encodeResetVideo(): ArrayBuffer {
  return new Uint8Array([CONTROL.RESET_VIDEO]).buffer;
}

/** Parse a control message back (for the mock server and tests). */
export function parseControl(buf: ArrayBuffer | Uint8Array):
  | { type: 'keycode'; action: number; keycode: number; repeat: number; metaState: number }
  | { type: 'text'; text: string }
  | { type: 'touch'; action: number; pointerId: bigint; x: number; y: number; width: number; height: number; pressure: number; actionButton: number; buttons: number }
  | { type: 'scroll'; x: number; y: number; width: number; height: number; hscroll: number; vscroll: number; buttons: number }
  | { type: 'back_or_screen_on'; action: number }
  | { type: 'display_power'; on: boolean }
  | { type: 'reset_video' }
  | { type: 'unknown'; code: number } {
  const b = asBytes(buf);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (b[0]) {
    case CONTROL.INJECT_KEYCODE: return { type: 'keycode', action: b[1], keycode: v.getInt32(2), repeat: v.getInt32(6), metaState: v.getInt32(10) };
    case CONTROL.INJECT_TEXT: return { type: 'text', text: new TextDecoder().decode(b.subarray(5, 5 + v.getUint32(1))) };
    case CONTROL.INJECT_TOUCH_EVENT:
      return { type: 'touch', action: b[1], pointerId: v.getBigInt64(2), x: v.getInt32(10), y: v.getInt32(14), width: v.getUint16(18), height: v.getUint16(20), pressure: v.getUint16(22), actionButton: v.getInt32(24), buttons: v.getInt32(28) };
    case CONTROL.INJECT_SCROLL_EVENT:
      return { type: 'scroll', x: v.getInt32(1), y: v.getInt32(5), width: v.getUint16(9), height: v.getUint16(11), hscroll: v.getInt16(13), vscroll: v.getInt16(15), buttons: v.getInt32(17) };
    case CONTROL.BACK_OR_SCREEN_ON: return { type: 'back_or_screen_on', action: b[1] };
    case CONTROL.SET_DISPLAY_POWER: return { type: 'display_power', on: b[1] !== 0 };
    case CONTROL.RESET_VIDEO: return { type: 'reset_video' };
    default: return { type: 'unknown', code: b[0] };
  }
}

// ---------------------------------------------------------------------------
// Android keycodes and DOM keyboard mapping

export const AKEYCODE = {
  HOME: 3, BACK: 4, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, DPAD_CENTER: 23,
  VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, TAB: 61, SPACE: 62, ENTER: 66, DEL: 67, MENU: 82,
  MEDIA_PLAY_PAUSE: 85, PAGE_UP: 92, PAGE_DOWN: 93, FORWARD_DEL: 112, MOVE_HOME: 122, MOVE_END: 123,
  VOLUME_MUTE: 164, APP_SWITCH: 187, A: 29, NUM_0: 7,
} as const;

/** DOM `KeyboardEvent.key` → Android keycode for non-printing keys. */
export const DOM_KEYCODES: Record<string, number> = {
  ArrowUp: AKEYCODE.DPAD_UP,
  ArrowDown: AKEYCODE.DPAD_DOWN,
  ArrowLeft: AKEYCODE.DPAD_LEFT,
  ArrowRight: AKEYCODE.DPAD_RIGHT,
  Enter: AKEYCODE.DPAD_CENTER,
  Backspace: AKEYCODE.DEL,
  Escape: AKEYCODE.BACK,
  Home: AKEYCODE.HOME,
  Tab: AKEYCODE.TAB,
  ' ': AKEYCODE.SPACE,
  PageUp: AKEYCODE.PAGE_UP,
  PageDown: AKEYCODE.PAGE_DOWN,
  MediaPlayPause: AKEYCODE.MEDIA_PLAY_PAUSE,
  AudioVolumeUp: AKEYCODE.VOLUME_UP,
  AudioVolumeDown: AKEYCODE.VOLUME_DOWN,
  AudioVolumeMute: AKEYCODE.VOLUME_MUTE,
  Delete: AKEYCODE.FORWARD_DEL,
  End: AKEYCODE.MOVE_END,
  ContextMenu: AKEYCODE.MENU,
};

/** Android meta state bits (left-hand variants, as scrcpy sends). */
export const AMETA = { SHIFT: 0x01 | 0x40, ALT: 0x02 | 0x10, CTRL: 0x1000 | 0x2000, META: 0x10000 | 0x20000 } as const;

export interface KeyLike { key: string; code?: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean; repeat?: boolean }

export function metaStateOf(e: KeyLike): number {
  return (e.shiftKey ? AMETA.SHIFT : 0) | (e.altKey ? AMETA.ALT : 0) | (e.ctrlKey ? AMETA.CTRL : 0) | (e.metaKey ? AMETA.META : 0);
}

/** Letters → 29–54, digits → 7–16 (by physical key, falling back to the character). */
export function letterOrDigitKeycode(e: KeyLike): number | null {
  const code = e.code ?? '';
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return AKEYCODE.A + (m[1].charCodeAt(0) - 65);
  m = /^Digit([0-9])$/.exec(code);
  if (m) return AKEYCODE.NUM_0 + Number(m[1]);
  if (e.key.length === 1) {
    const c = e.key.toLowerCase();
    if (c >= 'a' && c <= 'z') return AKEYCODE.A + (c.charCodeAt(0) - 97);
    if (c >= '0' && c <= '9') return AKEYCODE.NUM_0 + Number(c);
  }
  return null;
}

export type KeyControl = { kind: 'keycode'; keycode: number; metaState: number } | { kind: 'text'; text: string };

/**
 * Map a DOM key event to what to send. Special keys map to keycodes (sent on down and up);
 * printable characters are sent as INJECT_TEXT on key down, unless Ctrl/Alt/Meta is held,
 * in which case letters and digits go as keycodes with the meta state (e.g. Ctrl+A).
 */
export function keyEventToControl(e: KeyLike, phase: 'down' | 'up'): KeyControl | null {
  const special = DOM_KEYCODES[e.key];
  if (special !== undefined) return { kind: 'keycode', keycode: special, metaState: metaStateOf(e) };
  const modified = !!(e.ctrlKey || e.altKey || e.metaKey);
  if (modified) {
    const k = letterOrDigitKeycode(e);
    return k === null ? null : { kind: 'keycode', keycode: k, metaState: metaStateOf(e) };
  }
  if ([...e.key].length === 1) return phase === 'down' ? { kind: 'text', text: e.key } : null;
  return null;
}

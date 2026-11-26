import { describe, expect, it } from 'vitest';
import {
  AKEYCODE, AMETA, CONTROL, POINTER_MOUSE, PTS_CONFIG, PTS_KEYFRAME, concatBytes, encodeBackOrScreenOn, encodeKeycode, encodeMediaPacket,
  encodeResetVideo, encodeScroll, encodeSessionPacket, encodeSetDisplayPower, encodeText, encodeTouch, keyEventToControl, nalType,
  parseControl, parsePacket, splitNalUnits, spsCodecString, toI16Scroll, toU16Fixed, utf8Truncate,
} from './scrcpy';

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
// A real 720p High@3.1 SPS + PPS as produced by Android's encoder.
const SPS = [0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x10];
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];
const CONFIG = new Uint8Array([0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS]);

describe('packet headers', () => {
  it('parses a config packet (no PTS)', () => {
    const p = parsePacket(encodeMediaPacket({ config: true, data: CONFIG }));
    expect(p).toMatchObject({ kind: 'media', config: true, keyframe: false, pts: null });
    if (p.kind === 'media') expect(hex(p.data)).toBe(hex(CONFIG));
  });
  it('parses a keyframe with a 61-bit PTS', () => {
    const pts = (1n << 40n) + 123_456n;
    const p = parsePacket(encodeMediaPacket({ keyframe: true, pts, data: new Uint8Array([0, 0, 1, 0x65, 0x88]) }));
    expect(p).toMatchObject({ kind: 'media', config: false, keyframe: true, pts });
  });
  it('reads raw header bytes exactly', () => {
    const raw = new Uint8Array(12 + 2);
    const v = new DataView(raw.buffer);
    v.setBigUint64(0, PTS_KEYFRAME | 33_333n);
    v.setUint32(8, 2);
    const p = parsePacket(raw);
    expect(p).toMatchObject({ kind: 'media', keyframe: true, config: false, pts: 33_333n });
    expect((PTS_CONFIG & PTS_KEYFRAME) === 0n).toBe(true);
  });
  it('parses session packets (MSB set)', () => {
    expect(parsePacket(encodeSessionPacket(1920, 1080, true))).toEqual({ kind: 'session', resized: true, width: 1920, height: 1080 });
    expect(hex(encodeSessionPacket(1280, 720))).toBe('80000000' + '00000500' + '000002d0');
  });
  it('rejects truncated packets', () => {
    expect(() => parsePacket(new Uint8Array(5))).toThrow();
    const bad = new Uint8Array(encodeMediaPacket({ pts: 1n, data: new Uint8Array(10) })).subarray(0, 15);
    expect(() => parsePacket(bad)).toThrow();
  });
});

describe('H.264 helpers', () => {
  it('splits Annex-B with 3- and 4-byte start codes', () => {
    const nals = splitNalUnits(concatBytes(CONFIG, new Uint8Array([0, 0, 1, 0x65, 1, 2])));
    expect(nals.map(nalType)).toEqual([7, 8, 5]);
  });
  it('builds avc1.PPCCLL from the SPS', () => {
    expect(spsCodecString(CONFIG)).toBe('avc1.64001F');
    expect(spsCodecString(new Uint8Array([0, 0, 1, 0x67, 0x42, 0xc0, 0x28]))).toBe('avc1.42C028');
    expect(spsCodecString(new Uint8Array([0, 0, 1, 0x68, 1, 2, 3]))).toBeNull();
  });
});

describe('control messages', () => {
  it('INJECT_KEYCODE is 14 bytes', () => {
    const b = encodeKeycode(0, AKEYCODE.DPAD_CENTER, 2, AMETA.SHIFT);
    expect(b.byteLength).toBe(14);
    expect(hex(b)).toBe('00' + '00' + '00000017' + '00000002' + '00000041');
  });
  it('INJECT_TEXT has a u32 length and is capped at 300 bytes', () => {
    expect(hex(encodeText('hé'))).toBe('01' + '00000003' + '68c3a9');
    expect(encodeText('x'.repeat(400)).byteLength).toBe(5 + 300);
    expect(utf8Truncate('€'.repeat(101)).byteLength).toBe(300); // 3-byte chars never split
  });
  it('INJECT_TOUCH_EVENT is 32 bytes with exact layout', () => {
    const b = encodeTouch({ action: 0, pointerId: POINTER_MOUSE, x: 100, y: 200, width: 1280, height: 720, pressure: 1, actionButton: 1, buttons: 1 });
    expect(b.byteLength).toBe(32);
    expect(hex(b)).toBe('02' + '00' + 'ffffffffffffffff' + '00000064' + '000000c8' + '0500' + '02d0' + 'ffff' + '00000001' + '00000001');
    expect(parseControl(b)).toMatchObject({ type: 'touch', pointerId: -1n, x: 100, y: 200, width: 1280, height: 720, pressure: 0xffff });
  });
  it('INJECT_SCROLL_EVENT is 21 bytes with fixed-point scroll', () => {
    const b = encodeScroll({ x: 10, y: 20, width: 1280, height: 720, hscroll: 0, vscroll: -1 });
    expect(b.byteLength).toBe(21);
    expect(hex(b)).toBe('03' + '0000000a' + '00000014' + '0500' + '02d0' + '0000' + 'f800' + '00000000');
    expect(toI16Scroll(16)).toBe(32767);
    expect(toI16Scroll(-99)).toBe(-32767);
    expect(toU16Fixed(0.5)).toBe(0x8000);
  });
  it('small messages', () => {
    expect(hex(encodeBackOrScreenOn(1))).toBe('0401');
    expect(hex(encodeSetDisplayPower(false))).toBe('0a00');
    expect(hex(encodeResetVideo())).toBe('11');
    expect(CONTROL.RESET_VIDEO).toBe(17);
  });
});

describe('keyboard mapping', () => {
  it('maps navigation keys to keycodes', () => {
    expect(keyEventToControl({ key: 'ArrowUp' }, 'down')).toEqual({ kind: 'keycode', keycode: 19, metaState: 0 });
    expect(keyEventToControl({ key: 'ArrowRight' }, 'up')).toMatchObject({ keycode: 22 });
    expect(keyEventToControl({ key: 'Enter' }, 'down')).toMatchObject({ keycode: 23 });
    expect(keyEventToControl({ key: 'Backspace' }, 'down')).toMatchObject({ keycode: 67 });
    expect(keyEventToControl({ key: 'Escape' }, 'down')).toMatchObject({ keycode: 4 });
    expect(keyEventToControl({ key: 'Home' }, 'down')).toMatchObject({ keycode: 3 });
    expect(keyEventToControl({ key: 'Tab' }, 'down')).toMatchObject({ keycode: 61 });
    expect(keyEventToControl({ key: ' ' }, 'down')).toMatchObject({ keycode: 62 });
    expect(keyEventToControl({ key: 'PageDown' }, 'down')).toMatchObject({ keycode: 93 });
    expect(keyEventToControl({ key: 'MediaPlayPause' }, 'down')).toMatchObject({ keycode: 85 });
    expect(keyEventToControl({ key: 'AudioVolumeDown' }, 'down')).toMatchObject({ keycode: 25 });
  });
  it('sends printable characters as text on key down only', () => {
    expect(keyEventToControl({ key: 'a', code: 'KeyA' }, 'down')).toEqual({ kind: 'text', text: 'a' });
    expect(keyEventToControl({ key: 'A', code: 'KeyA', shiftKey: true }, 'down')).toEqual({ kind: 'text', text: 'A' });
    expect(keyEventToControl({ key: 'a', code: 'KeyA' }, 'up')).toBeNull();
    expect(keyEventToControl({ key: 'é' }, 'down')).toEqual({ kind: 'text', text: 'é' });
  });
  it('uses keycodes with meta state while modifiers are held', () => {
    expect(keyEventToControl({ key: 'a', code: 'KeyA', ctrlKey: true }, 'down')).toEqual({ kind: 'keycode', keycode: 29, metaState: AMETA.CTRL });
    expect(keyEventToControl({ key: 'z', code: 'KeyZ', altKey: true }, 'down')).toMatchObject({ keycode: 54 });
    expect(keyEventToControl({ key: '0', code: 'Digit0', metaKey: true }, 'down')).toMatchObject({ keycode: 7 });
    expect(keyEventToControl({ key: '9', code: 'Digit9', ctrlKey: true }, 'down')).toMatchObject({ keycode: 16 });
    expect(keyEventToControl({ key: 'Shift' }, 'down')).toBeNull();
  });
});

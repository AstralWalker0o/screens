// Mock scrcpy server for demo mode: renders the fake Android TV home screen into a canvas,
// encodes it with WebCodecs (H.264 Annex-B) and frames it exactly like the hub does —
// a session packet, config packets (SPS/PPS) split out of keyframes, PTS/flag headers.
// Control messages from the player move the focus, open apps and request keyframes.

import type { MirrorConnection, MirrorHandlers, MirrorParams } from '../api';
import { AKEYCODE, NAL, concatBytes, encodeMediaPacket, encodeSessionPacket, nalType, parseControl, splitNalUnits } from '../lib/scrcpy';
import { applyKey, applyTap, renderScreen, type ScreenState } from './screens';

const START = new Uint8Array([0, 0, 0, 1]);
const KEYS: Record<number, string> = {
  [AKEYCODE.DPAD_UP]: 'UP', [AKEYCODE.DPAD_DOWN]: 'DOWN', [AKEYCODE.DPAD_LEFT]: 'LEFT', [AKEYCODE.DPAD_RIGHT]: 'RIGHT',
  [AKEYCODE.DPAD_CENTER]: 'OK', [AKEYCODE.ENTER]: 'OK', [AKEYCODE.BACK]: 'BACK', [AKEYCODE.HOME]: 'HOME',
};

export function startMockMirror(o: {
  deviceName: string;
  params: MirrorParams;
  handlers: MirrorHandlers;
  getScreen: () => ScreenState;
  setScreen: (s: ScreenState) => void;
}): MirrorConnection {
  const { handlers: h } = o;
  const maxSize = Math.max(480, Math.min(1920, o.params.max_size ?? 1280));
  const width = maxSize & ~1;
  const height = Math.round((maxSize * 9) / 16) & ~1;
  const fps = Math.max(5, Math.min(30, o.params.max_fps ?? 30));
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let encoder: VideoEncoder | null = null;
  let forceKey = true;
  let frameNo = 0;
  let panelOff = false;
  const ripples: { x: number; y: number; t: number }[] = [];
  const later = (fn: () => void, ms = 0) => setTimeout(() => !closed && fn(), ms);
  const text = (m: Parameters<MirrorHandlers['onText']>[0]) => later(() => h.onText(m));

  let img: HTMLImageElement | null = null;
  const loadScreen = () => {
    const i = new Image();
    i.onload = () => (img = i);
    i.src = renderScreen(o.getScreen());
  };
  loadScreen();

  later(() => h.onOpen?.());
  text({ type: 'status', state: 'starting' });

  const start = async () => {
    if (typeof VideoEncoder === 'undefined') {
      text({ type: 'status', state: 'error', message: 'This browser can’t generate the demo stream (it needs WebCodecs).' });
      return;
    }
    const base = { width, height, bitrate: o.params.bitrate ?? 4_000_000, framerate: fps, latencyMode: 'realtime' as const, avc: { format: 'annexb' as const } };
    let config: VideoEncoderConfig | null = null;
    for (const codec of [maxSize > 1280 ? 'avc1.640028' : 'avc1.64001F', 'avc1.640028', 'avc1.4D401F']) {
      try {
        if ((await VideoEncoder.isConfigSupported({ ...base, codec })).supported) {
          config = { ...base, codec };
          break;
        }
      } catch {
        /* try the next profile */
      }
    }
    if (closed) return;
    if (!config) {
      text({ type: 'status', state: 'error', message: 'This browser can’t encode H.264, so the demo stream can’t run here.' });
      return;
    }
    encoder = new VideoEncoder({
      output: (chunk) => {
        if (closed) return;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const pts = BigInt(Math.max(0, Math.round(chunk.timestamp)));
        if (chunk.type === 'key') {
          // scrcpy sends SPS/PPS as a separate config packet before the keyframe.
          const nals = splitNalUnits(data);
          const params = nals.filter((n) => nalType(n) === NAL.SPS || nalType(n) === NAL.PPS);
          const rest = nals.filter((n) => nalType(n) !== NAL.SPS && nalType(n) !== NAL.PPS);
          if (params.length) h.onBinary(encodeMediaPacket({ config: true, data: concatBytes(...params.flatMap((n) => [START, n])) }));
          h.onBinary(encodeMediaPacket({ keyframe: true, pts, data: concatBytes(...rest.flatMap((n) => [START, n])) }));
        } else {
          h.onBinary(encodeMediaPacket({ pts, data }));
        }
      },
      error: (e) => text({ type: 'status', state: 'error', message: `Demo encoder failed: ${e.message}` }),
    });
    encoder.configure(config);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    h.onText({ type: 'meta', device_name: o.deviceName, codec: 'h264', width, height });
    h.onBinary(encodeSessionPacket(width, height));
    h.onText({ type: 'status', state: 'streaming' });

    const t0 = performance.now();
    timer = setInterval(() => {
      if (closed || !encoder || encoder.state !== 'configured') return;
      if (encoder.encodeQueueSize > 2) return; // drop frames rather than build latency
      ctx.fillStyle = '#0d0f14';
      ctx.fillRect(0, 0, width, height);
      if (img) ctx.drawImage(img, 0, 0, width, height);
      const now = performance.now();
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        const age = (now - r.t) / 500;
        if (age >= 1) {
          ripples.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(r.x, r.y, 14 + age * 40, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.35 * (1 - age)})`;
        ctx.fill();
      }
      // A small "live" tag that changes every frame, so motion is visible in the demo.
      const s = Math.round(height / 36);
      ctx.font = `600 ${s}px system-ui, sans-serif`;
      const label = `● LIVE DEMO  ${new Date().toLocaleTimeString('en-AU', { hour12: false })}${panelOff ? '  ·  TV panel off' : ''}`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(width - tw - s * 2.2, height - s * 2.6, tw + s * 1.4, s * 1.8);
      ctx.fillStyle = (Math.floor((now - t0) / 500) % 2 ? '#ffffff' : '#ff5a5a');
      ctx.fillText(label, width - tw - s * 1.5, height - s * 1.25);

      const frame = new VideoFrame(canvas, { timestamp: Math.round((now - t0) * 1000) });
      encoder.encode(frame, { keyFrame: forceKey || frameNo % (fps * 2) === 0 });
      frame.close();
      forceKey = false;
      frameNo++;
    }, 1000 / fps);
  };
  later(() => void start(), 650);

  return {
    send(data) {
      if (closed) return;
      if (typeof data === 'string') {
        try {
          if ((JSON.parse(data) as { type?: string }).type === 'ping') text({ type: 'pong' });
        } catch {
          /* ignore */
        }
        return;
      }
      const m = parseControl(data);
      if (m.type === 'keycode' && m.action === 0 && KEYS[m.keycode]) {
        o.setScreen(applyKey(o.getScreen(), KEYS[m.keycode]));
        loadScreen();
      } else if (m.type === 'back_or_screen_on' && m.action === 0) {
        o.setScreen(applyKey(o.getScreen(), 'BACK'));
        loadScreen();
      } else if (m.type === 'touch') {
        if (m.action === 0) ripples.push({ x: m.x, y: m.y, t: performance.now() });
        if (m.action === 1 && m.width && m.height) {
          o.setScreen(applyTap(o.getScreen(), m.x / m.width, m.y / m.height));
          loadScreen();
        }
      } else if (m.type === 'display_power') {
        panelOff = !m.on;
      } else if (m.type === 'reset_video') {
        forceKey = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      try {
        encoder?.close();
      } catch {
        /* already closed */
      }
      setTimeout(() => h.onClose({ code: 1000, reason: 'viewer left', clean: true }), 0);
    },
  };
}

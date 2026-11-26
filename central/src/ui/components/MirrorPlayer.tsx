import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Undo2, House, LayoutPanelTop, Volume1, Volume2, Power, MonitorOff, Monitor, RefreshCw, Maximize, Minimize, LoaderCircle, CirclePlay, TriangleAlert,
  Radio, Keyboard, MousePointerClick,
} from 'lucide-react';
import type { Device } from '../../shared/types';
import { openMirror, type MirrorConnection } from '../api';
import { useLocalStorage } from '../lib/hooks';
import {
  AKEYCODE, BUTTON_PRIMARY, KEY_ACTION, POINTER_FINGER, POINTER_MOUSE, TOUCH_ACTION, concatBytes, encodeBackOrScreenOn, encodeKeycode,
  encodeResetVideo, encodeScroll, encodeSetDisplayPower, encodeText, encodeTouch, keyEventToControl, parsePacket, spsCodecString,
} from '../lib/scrcpy';
import { Button, Callout, IconButton, Kbd, StatusText, cn } from './ui';
import { Select } from './forms';

const QUALITY = {
  '720': { label: '720p', max_size: 1280, bitrate: 4_000_000 },
  '1080': { label: '1080p', max_size: 1920, bitrate: 8_000_000 },
  '480': { label: '480p', max_size: 854, bitrate: 1_500_000 },
} as const;
type Quality = keyof typeof QUALITY;

type Status = { state: 'connecting' | 'starting' | 'streaming' | 'ended' | 'error'; message?: string };

export function mirrorSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof (window as { VideoDecoder?: unknown }).VideoDecoder === 'function';
}

/** Live screen of an Android device over scrcpy (docs/MIRROR.md), with touch, scroll and keyboard input. */
export function MirrorPlayer({ device, onUseScreenshots }: { device: Device; onUseScreenshots?: () => void }) {
  if (!mirrorSupported()) {
    return (
      <Callout
        kind="warn"
        title="Live view isn’t available in this browser"
        action={onUseScreenshots && <Button size="sm" onClick={onUseScreenshots}>Use screenshots instead</Button>}
      >
        The live view decodes video in the browser, which needs Chrome, Edge or Safari 17+ (or newer) on a secure https connection. Screenshots work everywhere.
      </Callout>
    );
  }
  return <Player device={device} onUseScreenshots={onUseScreenshots} />;
}

function Player({ device, onUseScreenshots }: { device: Device; onUseScreenshots?: () => void }) {
  const [quality, setQuality] = useLocalStorage<Quality>('mirror.quality', '720');
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>({ state: 'connecting' });
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [stats, setStats] = useState({ fps: 0, kbps: 0 });
  const [hasPicture, setHasPicture] = useState(false);
  const [panelOff, setPanelOff] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [focused, setFocused] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const connRef = useRef<MirrorConnection | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const st = useRef({
    width: 0, height: 0,                       // current session size (video pixels)
    config: null as Uint8Array | null,         // pending config to prepend to the next media packet
    lastConfig: null as Uint8Array | null,
    codec: null as string | null,
    needKey: true,
    frames: 0, bytes: 0, errors: 0,
    pressed: null as null | { id: number; pointer: bigint; mouse: boolean },
  });

  const send = useCallback((d: ArrayBuffer | string) => connRef.current?.send(d), []);
  const pressKey = (keycode: number) => {
    send(encodeKeycode(KEY_ACTION.DOWN, keycode));
    send(encodeKeycode(KEY_ACTION.UP, keycode));
  };

  // --- decoding -------------------------------------------------------------
  const closeDecoder = () => {
    const d = decoderRef.current;
    decoderRef.current = null;
    if (d && d.state !== 'closed') {
      try {
        d.close();
      } catch {
        /* ignore */
      }
    }
  };

  const configure = useCallback((codec: string) => {
    closeDecoder();
    const s = st.current;
    const dec = new VideoDecoder({
      output: (frame) => {
        const c = canvasRef.current;
        if (c) {
          if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
            c.width = frame.displayWidth;
            c.height = frame.displayHeight;
          }
          c.getContext('2d')?.drawImage(frame, 0, 0);
          s.frames++;
          if (s.frames === 1) setHasPicture(true);
        }
        frame.close();
      },
      error: (e) => {
        // Recover once by asking for a fresh keyframe; give up after repeated failures.
        s.errors++;
        decoderRef.current = null;
        s.codec = null;
        s.needKey = true;
        if (s.errors > 3) setStatus({ state: 'error', message: `The browser couldn’t decode the video (${e.message}).` });
        else connRef.current?.send(encodeResetVideo());
      },
    });
    try {
      dec.configure({ codec, optimizeForLatency: true });
    } catch (e) {
      setStatus({ state: 'error', message: `This browser can’t play ${codec} video (${(e as Error).message}).` });
      return;
    }
    decoderRef.current = dec;
    s.codec = codec;
    s.needKey = true;
  }, []);

  const onPacket = useCallback((buf: ArrayBuffer) => {
    const s = st.current;
    s.bytes += buf.byteLength;
    let p;
    try {
      p = parsePacket(buf);
    } catch {
      return;
    }
    if (p.kind === 'session') {
      // New session (resolution/rotation change): reconfigure from the next config packet.
      s.width = p.width;
      s.height = p.height;
      setSize({ w: p.width, h: p.height });
      closeDecoder();
      s.codec = null;
      s.needKey = true;
      return;
    }
    if (p.config) {
      const codec = spsCodecString(p.data);
      s.config = p.data.slice();
      s.lastConfig = s.config;
      if (codec && (codec !== s.codec || !decoderRef.current || decoderRef.current.state === 'closed')) configure(codec);
      return;
    }
    let dec = decoderRef.current;
    if ((!dec || dec.state === 'closed') && s.lastConfig && p.keyframe) {
      const codec = spsCodecString(s.lastConfig);
      if (codec) {
        configure(codec);
        s.config = s.lastConfig;
        dec = decoderRef.current;
      }
    }
    if (!dec || dec.state !== 'configured') return;
    if (s.needKey && !p.keyframe) return; // start at the first keyframe
    const data = s.config ? concatBytes(s.config, p.data) : p.data;
    s.config = null;
    try {
      dec.decode(new EncodedVideoChunk({ type: p.keyframe ? 'key' : 'delta', timestamp: Number(p.pts ?? 0n), data }));
      s.needKey = false;
    } catch {
      s.needKey = true;
    }
  }, [configure]);

  // --- connection -------------------------------------------------------------
  useEffect(() => {
    const s = st.current;
    Object.assign(s, { width: 0, height: 0, config: null, lastConfig: null, codec: null, needKey: true, frames: 0, bytes: 0, errors: 0, pressed: null });
    setStatus({ state: 'connecting' });
    setHasPicture(false);
    setSize(null);
    setPanelOff(false);
    let ours = false;
    const q = QUALITY[quality] ?? QUALITY['720'];
    const conn = openMirror(device.id, { max_size: q.max_size, max_fps: 30, bitrate: q.bitrate }, {
      onText: (m) => {
        if (m.type === 'status') setStatus({ state: m.state, message: m.message });
        else if (m.type === 'meta' && m.width && m.height) {
          s.width = m.width;
          s.height = m.height;
          setSize({ w: m.width, h: m.height });
        }
      },
      onBinary: onPacket,
      onClose: (info) => {
        if (ours) return;
        setStatus((cur) => (cur.state === 'error' ? cur : { state: 'ended', message: info.reason || (info.clean ? undefined : 'The connection dropped.') }));
      },
    });
    connRef.current = conn;
    const ping = setInterval(() => conn.send(JSON.stringify({ type: 'ping' })), 20_000);
    let lastFrames = 0;
    let lastBytes = 0;
    const meter = setInterval(() => {
      setStats({ fps: s.frames - lastFrames, kbps: Math.round(((s.bytes - lastBytes) * 8) / 1000) });
      lastFrames = s.frames;
      lastBytes = s.bytes;
    }, 1000);
    return () => {
      ours = true;
      clearInterval(ping);
      clearInterval(meter);
      conn.close();
      connRef.current = null;
      closeDecoder();
    };
  }, [device.id, quality, attempt, onPacket]);

  // --- input ------------------------------------------------------------------
  const toVideo = (clientX: number, clientY: number) => {
    const c = canvasRef.current;
    const s = st.current;
    const vw = s.width || c?.width || 0;
    const vh = s.height || c?.height || 0;
    if (!c || !vw || !vh) return null;
    const r = c.getBoundingClientRect();
    const scale = Math.min(r.width / vw, r.height / vh);
    const ox = (r.width - vw * scale) / 2;
    const oy = (r.height - vh * scale) / 2;
    const x = (clientX - r.left - ox) / scale;
    const y = (clientY - r.top - oy) / scale;
    return { x: Math.max(0, Math.min(vw - 1, x)), y: Math.max(0, Math.min(vh - 1, y)), inside: x >= 0 && y >= 0 && x < vw && y < vh, vw, vh };
  };

  const touch = (action: number, e: ReactPointerEvent, pointer: bigint, mouse: boolean) => {
    const p = toVideo(e.clientX, e.clientY);
    if (!p) return;
    send(encodeTouch({
      action, pointerId: pointer, x: p.x, y: p.y, width: p.vw, height: p.vh,
      pressure: action === TOUCH_ACTION.UP ? 0 : mouse ? 1 : e.pressure || 1,
      actionButton: mouse ? BUTTON_PRIMARY : 0,
      buttons: mouse && action !== TOUCH_ACTION.UP ? BUTTON_PRIMARY : 0,
    }));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const mouse = e.pointerType === 'mouse';
    if (mouse && e.button === 2) {
      // Right click = Back (or wake the screen), like scrcpy.
      e.preventDefault();
      send(encodeBackOrScreenOn(KEY_ACTION.DOWN));
      send(encodeBackOrScreenOn(KEY_ACTION.UP));
      return;
    }
    if (mouse && e.button !== 0) return;
    const p = toVideo(e.clientX, e.clientY);
    if (!p?.inside || st.current.pressed) return;
    shellRef.current?.querySelector<HTMLElement>('[data-mirror-surface]')?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    const pointer = mouse ? POINTER_MOUSE : POINTER_FINGER;
    st.current.pressed = { id: e.pointerId, pointer, mouse };
    touch(TOUCH_ACTION.DOWN, e, pointer, mouse);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const pr = st.current.pressed;
    if (pr && pr.id === e.pointerId) touch(TOUCH_ACTION.MOVE, e, pr.pointer, pr.mouse);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const pr = st.current.pressed;
    if (!pr || pr.id !== e.pointerId) return;
    touch(TOUCH_ACTION.UP, e, pr.pointer, pr.mouse);
    st.current.pressed = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // Wheel needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      const p = toVideo(e.clientX, e.clientY);
      if (!p?.inside) return;
      e.preventDefault();
      const f = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
      send(encodeScroll({ x: p.x, y: p.y, width: p.vw, height: p.vh, hscroll: e.deltaX * f, vscroll: -e.deltaY * f }));
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }); // re-bind each render: cheap, and always sees the current size

  const onKey = (e: KeyboardEvent<HTMLDivElement>, phase: 'down' | 'up') => {
    if (e.target !== e.currentTarget) return;
    const ctl = keyEventToControl(e, phase);
    if (!ctl) return;
    e.preventDefault();
    if (ctl.kind === 'text') send(encodeText(ctl.text));
    else send(encodeKeycode(phase === 'down' ? KEY_ACTION.DOWN : KEY_ACTION.UP, ctl.keycode, phase === 'down' && e.repeat ? 1 : 0, ctl.metaState));
  };

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shellRef.current?.requestFullscreen?.();
  };

  const streaming = status.state === 'streaming';
  const aspect = size ? `${size.w} / ${size.h}` : '16 / 9';

  return (
    <div ref={shellRef} className={cn('min-w-0', fullscreen && 'flex h-full flex-col bg-black p-3')}>
      <div
        data-mirror-surface
        tabIndex={0}
        role="application"
        aria-label={`Live screen of ${device.name}. Click to tap, scroll to scroll, and type while focused: arrows move, Enter selects, Escape goes back.`}
        onKeyDown={(e) => onKey(e, 'down')}
        onKeyUp={(e) => onKey(e, 'up')}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={cn(
          'relative w-full overflow-hidden rounded-xl border border-line bg-black outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          fullscreen ? 'min-h-0 flex-1 rounded-none border-0' : 'max-h-[72vh]',
        )}
        style={fullscreen ? undefined : { aspectRatio: aspect }}
      >
        <canvas
          ref={canvasRef}
          width={size?.w ?? 1280}
          height={size?.h ?? 720}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          className={cn('absolute inset-0 size-full touch-none object-contain select-none', streaming && hasPicture ? 'cursor-crosshair' : 'invisible')}
        />
        {!(streaming && hasPicture) && <Overlay status={status} streaming={streaming} onReconnect={() => setAttempt((a) => a + 1)} onUseScreenshots={onUseScreenshots} />}
        {streaming && hasPicture && (
          <span className="pointer-events-none absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
            <span className="size-1.5 animate-pulse-soft rounded-full bg-crit" aria-hidden /> LIVE
          </span>
        )}
      </div>

      <div className={cn('mt-2.5 flex flex-wrap items-center gap-1.5', fullscreen && 'text-white')}>
        <IconButton icon={Undo2} label="Back" variant="secondary" size="sm" onClick={() => pressKey(AKEYCODE.BACK)} disabled={!streaming} />
        <IconButton icon={House} label="Home" variant="secondary" size="sm" onClick={() => pressKey(AKEYCODE.HOME)} disabled={!streaming} />
        <IconButton icon={LayoutPanelTop} label="Recent apps" variant="secondary" size="sm" onClick={() => pressKey(AKEYCODE.APP_SWITCH)} disabled={!streaming} />
        <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
        <IconButton icon={Volume1} label="Volume down" variant="secondary" size="sm" onClick={() => pressKey(AKEYCODE.VOLUME_DOWN)} disabled={!streaming} />
        <IconButton icon={Volume2} label="Volume up" variant="secondary" size="sm" onClick={() => pressKey(AKEYCODE.VOLUME_UP)} disabled={!streaming} />
        <IconButton icon={Power} label="Power button" variant="secondary" size="sm" onClick={() => pressKey(AKEYCODE.POWER)} disabled={!streaming} />
        <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
        <Button
          size="sm"
          icon={panelOff ? Monitor : MonitorOff}
          aria-pressed={panelOff}
          disabled={!streaming}
          title={panelOff ? 'Turn the TV’s screen back on' : 'Turn the TV’s screen off and keep mirroring here'}
          onClick={() => {
            send(encodeSetDisplayPower(panelOff));
            setPanelOff(!panelOff);
          }}
        >
          {panelOff ? 'Screen on' : 'Screen off on TV'}
        </Button>
        <IconButton icon={RefreshCw} label="Request keyframe (fixes a smeared picture)" variant="ghost" size="sm" disabled={!streaming} onClick={() => send(encodeResetVideo())} />
        <div className="ml-auto flex items-center gap-1.5">
          <Select aria-label="Quality" value={quality} onChange={(e) => setQuality(e.target.value as Quality)} className="w-24">
            {(Object.keys(QUALITY) as Quality[]).map((k) => <option key={k} value={k}>{QUALITY[k].label}</option>)}
          </Select>
          <IconButton icon={fullscreen ? Minimize : Maximize} label={fullscreen ? 'Exit full screen' : 'Full screen'} variant="secondary" size="sm" onClick={toggleFullscreen} />
        </div>
      </div>

      <div className={cn('mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted', fullscreen && 'text-white/70')}>
        {streaming ? (
          <StatusText tone="ok" icon={Radio}>Live</StatusText>
        ) : status.state === 'error' ? (
          <StatusText tone="crit" icon={TriangleAlert}>Error</StatusText>
        ) : status.state === 'ended' ? (
          <StatusText tone="neutral" icon={CirclePlay}>Ended</StatusText>
        ) : (
          <StatusText tone="neutral" icon={LoaderCircle} className="[&>svg]:animate-spin">Starting…</StatusText>
        )}
        {size && <span className="tnum">{size.w}×{size.h}</span>}
        {streaming && <span className="tnum">{stats.fps} fps</span>}
        {streaming && <span className="tnum">{stats.kbps.toLocaleString('en-AU')} kb/s</span>}
        <span className="ml-auto hidden items-center gap-1.5 sm:inline-flex">
          {focused ? (
            <><Keyboard className="size-3.5" aria-hidden /> Typing goes to the TV · <Kbd>Esc</Kbd> back</>
          ) : (
            <><MousePointerClick className="size-3.5" aria-hidden /> Click to tap · right-click for Back · scroll to scroll</>
          )}
        </span>
      </div>
    </div>
  );
}

function Overlay({ status, streaming, onReconnect, onUseScreenshots }: { status: Status; streaming: boolean; onReconnect: () => void; onUseScreenshots?: () => void }) {
  const box = 'absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-white/80';
  if (status.state === 'error' || status.state === 'ended') {
    const err = status.state === 'error';
    return (
      <div className={box} role={err ? 'alert' : 'status'}>
        {err ? <TriangleAlert className="size-6 text-crit" aria-hidden /> : <CirclePlay className="size-6 text-white/70" aria-hidden />}
        <p className="font-semibold text-white">{err ? 'The live view stopped' : 'The live view ended'}</p>
        {status.message && <p className="max-w-md text-white/70">{status.message}</p>}
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button size="sm" variant="primary" icon={RefreshCw} onClick={onReconnect}>Reconnect</Button>
          {onUseScreenshots && <Button size="sm" onClick={onUseScreenshots}>Use screenshots</Button>}
        </div>
      </div>
    );
  }
  return (
    <div className={box} role="status">
      <LoaderCircle className="size-6 animate-spin text-white/70" aria-hidden />
      <p className="font-semibold text-white">{streaming ? 'Waiting for the first picture…' : status.state === 'starting' ? 'Starting the live view…' : 'Connecting…'}</p>
      <p className="max-w-sm text-white/60">{status.state === 'starting' ? 'Screens is starting the mirroring service on the box. This takes a few seconds.' : 'Talking to the site’s gateway.'}</p>
    </div>
  );
}

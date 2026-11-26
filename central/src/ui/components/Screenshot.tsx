import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Camera, ImageOff, MousePointerClick, RefreshCw } from 'lucide-react';
import type { Device } from '../../shared/types';
import { api } from '../api';
import { sendCommand } from '../lib/commands';
import { useInterval } from '../lib/hooks';
import { reportError } from '../lib/query';
import { Button, cn, RelTime } from './ui';
import { Select } from './forms';
import { Dialog } from './overlay';

function useScreenshot(device: Device) {
  const [src, setSrc] = useState<string | null>(null);
  const [taken, setTaken] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [initial, setInitial] = useState(true);
  const inflight = useRef(false);

  const replace = useCallback((next: string | null) => {
    setSrc((old) => {
      if (old?.startsWith('blob:') && old !== next) URL.revokeObjectURL(old);
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    api.devices
      .screenshot(device.id)
      .then((u) => {
        if (!alive) return;
        replace(u);
        if (u) setTaken(Date.now());
      })
      .catch(() => undefined)
      .finally(() => alive && setInitial(false));
    return () => {
      alive = false;
    };
  }, [device.id, replace]);

  const take = useCallback(
    async (quiet = false) => {
      if (inflight.current) return;
      inflight.current = true;
      setBusy(true);
      try {
        const r = await sendCommand(device.id, 'screenshot', undefined, { invalidate: false, error: 'Screenshot failed' });
        const url = (r?.data as { url?: string } | undefined)?.url;
        if (url) {
          const u = url.startsWith('data:') || url.startsWith('blob:') ? url : await api.devices.screenshot(device.id);
          replace(u);
          setTaken(Date.now());
        } else if (r && !quiet) {
          reportError(new Error('The device didn’t return an image.'), 'Screenshot failed');
        }
      } finally {
        inflight.current = false;
        setBusy(false);
      }
    },
    [device.id, replace],
  );

  return { src, taken, busy, take, initial };
}

const REFRESH = [
  { v: 0, label: 'Auto-refresh off' },
  { v: 2, label: 'Every 2 s' },
  { v: 5, label: 'Every 5 s' },
  { v: 10, label: 'Every 10 s' },
  { v: 30, label: 'Every 30 s' },
];

/** Live-ish view of an Android screen; clicking sends a tap at that point. */
export function ScreenshotPane({ device }: { device: Device }) {
  const { src, taken, busy, take, initial } = useScreenshot(device);
  const [every, setEvery] = useState(0);
  const [marks, setMarks] = useState<{ id: number; x: number; y: number }[]>([]);
  const canTap = device.capabilities.includes('tap');
  const offline = device.status === 'offline';

  useInterval(() => {
    if (!document.hidden && !offline) void take(true);
  }, every ? every * 1000 : null);

  const onClick = async (e: MouseEvent<HTMLDivElement>) => {
    if (!canTap || !src) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const id = Date.now();
    setMarks((m) => [...m, { id, x, y }]);
    setTimeout(() => setMarks((m) => m.filter((k) => k.id !== id)), 700);
    const ok = await sendCommand(device.id, 'tap', { x: +x.toFixed(4), y: +y.toFixed(4) }, { invalidate: false, error: 'Tap failed' });
    if (ok && !every) setTimeout(() => void take(true), 700);
  };

  return (
    <div>
      <div
        role={canTap && src ? 'button' : undefined}
        aria-label={canTap && src ? 'Device screen. Click anywhere to tap that spot on the TV.' : 'Device screen'}
        onClick={onClick}
        className={cn(
          'relative aspect-video w-full overflow-hidden rounded-xl border border-line bg-black',
          canTap && src && 'cursor-crosshair',
        )}
      >
        {src ? (
          <img src={src} alt={`Screenshot of ${device.name}`} className="absolute inset-0 size-full object-contain select-none" draggable={false} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-white/70">
            <ImageOff className="size-6" aria-hidden />
            {initial ? 'Loading the last screenshot…' : offline ? 'The device is offline.' : 'No screenshot yet. Take one to see what’s on the TV.'}
          </div>
        )}
        {marks.map((m) => (
          <span
            key={m.id}
            className="pointer-events-none absolute size-8 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-white bg-white/30"
            style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
            aria-hidden
          />
        ))}
        {busy && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
            <RefreshCw className="size-3 animate-spin" aria-hidden /> Capturing
          </span>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon={Camera} loading={busy && !every} onClick={() => take()} disabled={offline}>
          Take screenshot
        </Button>
        <Select aria-label="Auto-refresh" value={every} onChange={(e) => setEvery(Number(e.target.value))} className="w-40" disabled={offline}>
          {REFRESH.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
        </Select>
        <span className="ml-auto text-xs text-muted">
          {taken ? <>Captured <RelTime ts={taken} /></> : null}
        </span>
      </div>
      {canTap && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <MousePointerClick className="size-3.5 shrink-0" aria-hidden /> Click the picture to tap that spot on the TV — handy for buttons the remote can’t reach.
        </p>
      )}
    </div>
  );
}

export function ScreenshotDialog({ device, open, onClose }: { device: Device; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={`${device.name} screen`} size="lg">
      <ScreenshotPane device={device} />
    </Dialog>
  );
}

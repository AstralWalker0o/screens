import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Power, House, Undo2, Menu as MenuIcon, VolumeX, Play, Plus, Minus,
  Hash, Send, Keyboard, Settings, Search, Info, LogIn,
} from 'lucide-react';
import type { Device } from '../../shared/types';
import { api } from '../api';
import { invalidate, reportError } from '../lib/query';
import { KEY_LABELS } from '../lib/labels';
import { cn, Kbd, Button } from './ui';
import { Input } from './forms';
import { sendCommand } from '../lib/commands';

export const KEY_EVENT = 'screens:key';

function RKey({ k, label, children, onPress, pressed, className, title }: {
  k: string; label: string; children: ReactNode; onPress: (k: string) => void; pressed: string | null; className?: string; title?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={() => onPress(k)}
      tabIndex={-1}
      className={cn(
        'flex items-center justify-center rounded-full border border-line-strong bg-surface text-fg shadow-card transition-all select-none hover:bg-surface-2 active:scale-95',
        pressed === k && 'scale-95 border-accent bg-accent-soft text-accent-fg',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Remote({ device, className }: { device: Device; className?: string }) {
  const [pressed, setPressed] = useState<string | null>(null);
  const [numpad, setNumpad] = useState(false);
  const [text, setText] = useState('');
  const [last, setLast] = useState<{ label: string; ok: boolean; ms?: number } | null>(null);
  const [sendingText, setSendingText] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const failures = useRef(0);
  const offline = device.status === 'offline';

  const press = useCallback(
    (key: string) => {
      setPressed(key);
      setTimeout(() => setPressed((p) => (p === key ? null : p)), 160);
      const label = KEY_LABELS[key] ?? key;
      // Keys go out one at a time, in order, so a quick "down, down, OK" isn't reordered.
      queue.current = queue.current.then(async () => {
        const t0 = performance.now();
        try {
          if (key === 'POWER') {
            const cmd = device.power === 'on' ? 'power_off' : 'power_on';
            const r = await api.devices.command(device.id, cmd);
            if (!r.ok) throw new Error(r.error ?? 'Failed');
            invalidate(`device:${device.id}`);
          } else {
            const r = await api.devices.command(device.id, 'key', { key });
            if (!r.ok) throw new Error(r.error ?? 'Failed');
          }
          failures.current = 0;
          setLast({ label, ok: true, ms: Math.round(performance.now() - t0) });
          window.dispatchEvent(new CustomEvent(KEY_EVENT, { detail: device.id }));
        } catch (e) {
          setLast({ label, ok: false });
          if (failures.current++ === 0) reportError(e, `“${label}” didn’t reach ${device.name}`);
        }
      });
    },
    [device.id, device.name, device.power],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const map: Record<string, string> = {
      ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'OK', Backspace: 'BACK', Escape: 'BACK',
      h: 'HOME', H: 'HOME', '+': 'VOL_UP', '=': 'VOL_UP', '-': 'VOL_DOWN', _: 'VOL_DOWN', m: 'MUTE', M: 'MUTE', ' ': 'PLAY_PAUSE',
    };
    let k = map[e.key];
    if (!k && numpad && /^[0-9]$/.test(e.key)) k = e.key;
    if (!k) return;
    e.preventDefault();
    press(k);
  };

  const sendText = async () => {
    if (!text) return;
    setSendingText(true);
    const r = await sendCommand(device.id, 'text', { text }, { invalidate: false, error: 'Text wasn’t sent' });
    setSendingText(false);
    if (r) {
      setLast({ label: `Typed “${text.length > 16 ? `${text.slice(0, 16)}…` : text}”`, ok: true });
      setText('');
      window.dispatchEvent(new CustomEvent(KEY_EVENT, { detail: device.id }));
    }
  };

  const k = { onPress: press, pressed };
  const small = 'size-11';
  return (
    <div className={cn('w-full max-w-[300px]', className)}>
      <div
        tabIndex={0}
        role="application"
        aria-label={`Remote control for ${device.name}. Use arrow keys, Enter for OK, Backspace for Back, H for Home, plus and minus for volume, M for mute.`}
        onKeyDown={onKeyDown}
        className={cn(
          'rounded-[28px] border border-line bg-surface-2 p-5 shadow-card outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          offline && 'pointer-events-none opacity-50',
        )}
      >
        <div className="flex items-center justify-between">
          <RKey k="POWER" label={device.power === 'on' ? 'Turn off' : 'Turn on'} {...k} className={cn(small, 'text-crit-fg')}><Power className="size-5" /></RKey>
          <div className="flex gap-2">
            <RKey k="INPUT" label="Input / source" {...k} className={small}><LogIn className="size-4" /></RKey>
            <RKey k="SETTINGS" label="Settings" {...k} className={small}><Settings className="size-4" /></RKey>
          </div>
        </div>

        {/* D-pad */}
        <div className="relative mx-auto mt-5 size-[188px] rounded-full border border-line-strong bg-surface shadow-card">
          <button type="button" tabIndex={-1} aria-label="Up" title="Up (↑)" onClick={() => press('UP')} className={cn('absolute top-1 left-1/2 flex h-14 w-20 -translate-x-1/2 items-start justify-center rounded-t-full pt-2.5 text-muted hover:text-fg', pressed === 'UP' && 'text-accent-fg')}>
            <ChevronUp className="size-6" />
          </button>
          <button type="button" tabIndex={-1} aria-label="Down" title="Down (↓)" onClick={() => press('DOWN')} className={cn('absolute bottom-1 left-1/2 flex h-14 w-20 -translate-x-1/2 items-end justify-center rounded-b-full pb-2.5 text-muted hover:text-fg', pressed === 'DOWN' && 'text-accent-fg')}>
            <ChevronDown className="size-6" />
          </button>
          <button type="button" tabIndex={-1} aria-label="Left" title="Left (←)" onClick={() => press('LEFT')} className={cn('absolute top-1/2 left-1 flex h-20 w-14 -translate-y-1/2 items-center justify-start rounded-l-full pl-2.5 text-muted hover:text-fg', pressed === 'LEFT' && 'text-accent-fg')}>
            <ChevronLeft className="size-6" />
          </button>
          <button type="button" tabIndex={-1} aria-label="Right" title="Right (→)" onClick={() => press('RIGHT')} className={cn('absolute top-1/2 right-1 flex h-20 w-14 -translate-y-1/2 items-center justify-end rounded-r-full pr-2.5 text-muted hover:text-fg', pressed === 'RIGHT' && 'text-accent-fg')}>
            <ChevronRight className="size-6" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label="OK"
            title="OK (Enter)"
            onClick={() => press('OK')}
            className={cn('absolute top-1/2 left-1/2 flex size-[76px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-sm font-semibold text-fg transition-transform active:scale-95', pressed === 'OK' && 'scale-95 border-accent bg-accent-soft text-accent-fg')}
          >
            OK
          </button>
        </div>

        <div className="mt-5 grid grid-cols-3 justify-items-center gap-2">
          <RKey k="BACK" label="Back" title="Back (Backspace)" {...k} className={small}><Undo2 className="size-4" /></RKey>
          <RKey k="HOME" label="Home" title="Home (H)" {...k} className={small}><House className="size-4" /></RKey>
          <RKey k="MENU" label="Menu" {...k} className={small}><MenuIcon className="size-4" /></RKey>
        </div>

        <div className="mt-4 grid grid-cols-3 items-center justify-items-center gap-2">
          <div className="flex flex-col overflow-hidden rounded-full border border-line-strong bg-surface shadow-card">
            <button type="button" tabIndex={-1} aria-label="Volume up" title="Volume up (+)" onClick={() => press('VOL_UP')} className={cn('flex h-11 w-11 items-center justify-center text-fg hover:bg-surface-2', pressed === 'VOL_UP' && 'bg-accent-soft text-accent-fg')}><Plus className="size-4" /></button>
            <span className="py-0.5 text-center text-[10px] font-semibold tracking-wide text-subtle">VOL</span>
            <button type="button" tabIndex={-1} aria-label="Volume down" title="Volume down (−)" onClick={() => press('VOL_DOWN')} className={cn('flex h-11 w-11 items-center justify-center text-fg hover:bg-surface-2', pressed === 'VOL_DOWN' && 'bg-accent-soft text-accent-fg')}><Minus className="size-4" /></button>
          </div>
          <div className="flex flex-col items-center gap-2">
            <RKey k="MUTE" label="Mute" title="Mute (M)" {...k} className={small}><VolumeX className="size-4" /></RKey>
            <RKey k="PLAY_PAUSE" label="Play / pause" title="Play / pause (Space)" {...k} className={small}><Play className="size-4" /></RKey>
            <button
              type="button"
              tabIndex={-1}
              aria-pressed={numpad}
              aria-label="Number pad"
              title="Number pad"
              onClick={() => setNumpad((n) => !n)}
              className={cn('flex size-11 items-center justify-center rounded-full border shadow-card transition-colors', numpad ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong bg-surface text-fg hover:bg-surface-2')}
            >
              <Hash className="size-4" />
            </button>
          </div>
          <div className="flex flex-col overflow-hidden rounded-full border border-line-strong bg-surface shadow-card">
            <button type="button" tabIndex={-1} aria-label="Channel up" title="Channel up" onClick={() => press('CH_UP')} className={cn('flex h-11 w-11 items-center justify-center text-fg hover:bg-surface-2', pressed === 'CH_UP' && 'bg-accent-soft text-accent-fg')}><ChevronUp className="size-4" /></button>
            <span className="py-0.5 text-center text-[10px] font-semibold tracking-wide text-subtle">CH</span>
            <button type="button" tabIndex={-1} aria-label="Channel down" title="Channel down" onClick={() => press('CH_DOWN')} className={cn('flex h-11 w-11 items-center justify-center text-fg hover:bg-surface-2', pressed === 'CH_DOWN' && 'bg-accent-soft text-accent-fg')}><ChevronDown className="size-4" /></button>
          </div>
        </div>

        {numpad && (
          <div className="mt-4 grid grid-cols-3 justify-items-center gap-2" role="group" aria-label="Number pad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => (
              <RKey key={n} k={n} label={n} {...k} className="h-10 w-14 rounded-xl text-sm font-semibold">{n}</RKey>
            ))}
            <RKey k="INFO" label="Info" {...k} className="h-10 w-14 rounded-xl"><Info className="size-4" /></RKey>
            <RKey k="0" label="0" {...k} className="h-10 w-14 rounded-xl text-sm font-semibold">0</RKey>
            <RKey k="SEARCH" label="Search" {...k} className="h-10 w-14 rounded-xl"><Search className="size-4" /></RKey>
          </div>
        )}

        <p className="mt-4 h-4 text-center text-xs text-muted" aria-live="polite">
          {last ? (last.ok ? `Sent ${last.label}${last.ms != null ? ` · ${last.ms} ms` : ''}` : `${last.label} failed`) : offline ? 'Device is offline' : <><span className="sm:hidden">Tap a button to send it</span><span className="max-sm:hidden">Click here, then use your keyboard</span></>}
        </p>
      </div>

      <div className="mt-3 hidden flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-muted sm:flex">
        <Keyboard className="size-3.5" aria-hidden />
        <span><Kbd>←↑→↓</Kbd> move</span>
        <span><Kbd>Enter</Kbd> OK</span>
        <span><Kbd>⌫</Kbd> back</span>
        <span><Kbd>H</Kbd> home</span>
        <span><Kbd>+</Kbd><Kbd>−</Kbd> volume</span>
        <span><Kbd>M</Kbd> mute</span>
      </div>

      {device.capabilities.includes('text') && (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void sendText();
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type text on the TV…" aria-label="Text to type on the TV" disabled={offline} />
          <Button type="submit" icon={Send} loading={sendingText} disabled={!text || offline} aria-label="Send text">Send</Button>
        </form>
      )}
    </div>
  );
}


import { useEffect, useRef, useState } from 'react';
import { SlidersVertical } from 'lucide-react';
import type { Device, SonosEq } from '../../../shared/types';
import { Button } from '../ui';
import { Toggle } from '../forms';
import { Popover } from '../overlay';
import { sonosCommand } from './lib';

export const isSoundbar = (d: Device) => !!(d.facts as Record<string, unknown>).has_tv || /arc|beam|ray|playbar|playbase|amp/i.test(`${d.model ?? ''} ${String((d.facts as Record<string, unknown>).model_number ?? '')}`);

export function EqPopover({ device, eq, soundbar, disabled }: { device: Device; eq: SonosEq | null; soundbar: boolean; disabled?: boolean }) {
  const [local, setLocal] = useState<SonosEq>(eq ?? { bass: 0, treble: 0, loudness: true });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (eq) setLocal(eq);
  }, [eq]);
  const send = (patch: Partial<Record<'bass' | 'treble' | 'loudness' | 'night_mode' | 'speech', number | boolean>>, delay = 0) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const r = await sonosCommand(device, 'eq', patch, { error: 'Couldn’t change the sound settings', invalidate: false });
      const next = (r?.data as { eq?: SonosEq } | undefined)?.eq;
      if (next) setLocal(next);
    }, delay);
  };
  const slider = (k: 'bass' | 'treble', label: string) => (
    <div>
      <div className="mb-1 flex justify-between text-sm"><label htmlFor={`eq-${k}`} className="text-fg">{label}</label><span className="text-muted tnum">{local[k] > 0 ? `+${local[k]}` : local[k]}</span></div>
      <input
        id={`eq-${k}`}
        type="range"
        min={-10}
        max={10}
        step={1}
        value={local[k]}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal({ ...local, [k]: v });
          send({ [k]: v }, 300);
        }}
        className="w-full cursor-pointer accent-[var(--color-accent)]"
      />
      <div className="flex justify-between text-[10px] text-subtle"><span>−10</span><span>0</span><span>+10</span></div>
    </div>
  );
  const unsupported = (v: unknown) => v === 'not supported';
  return (
    <Popover
      width={300}
      label="Sound settings"
      trigger={({ toggle, ref, open }) => (
        <Button ref={ref} size="sm" icon={SlidersVertical} onClick={toggle} aria-expanded={open} disabled={disabled}>EQ</Button>
      )}
    >
      <div className="space-y-4 p-3">
        <p className="text-sm font-semibold text-fg">Sound settings</p>
        {slider('bass', 'Bass')}
        {slider('treble', 'Treble')}
        <Toggle size="sm" checked={!!local.loudness} onChange={(v) => { setLocal({ ...local, loudness: v }); send({ loudness: v }); }} label="Loudness" description="Boosts bass and treble at low volume." />
        {soundbar && (
          <>
            <Toggle
              size="sm"
              checked={local.night_mode === true}
              disabled={unsupported(local.night_mode)}
              onChange={(v) => { setLocal({ ...local, night_mode: v }); send({ night_mode: v }); }}
              label="Night sound"
              description={unsupported(local.night_mode) ? 'Not supported on this speaker.' : 'Quieter loud bits, clearer quiet bits — good late at night.'}
            />
            <Toggle
              size="sm"
              checked={local.speech === true}
              disabled={unsupported(local.speech)}
              onChange={(v) => { setLocal({ ...local, speech: v }); send({ speech: v }); }}
              label="Speech enhancement"
              description={unsupported(local.speech) ? 'Not supported on this speaker.' : 'Makes dialogue easier to hear.'}
            />
          </>
        )}
        {!eq && <p className="text-xs text-muted">Current values load after the first change.</p>}
      </div>
    </Popover>
  );
}

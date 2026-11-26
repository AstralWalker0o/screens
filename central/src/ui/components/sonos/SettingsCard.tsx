import { useEffect, useRef, useState } from 'react';
import { AlarmClock, Lightbulb, LightbulbOff, Lock, Settings2, Tv } from 'lucide-react';
import type { Device, SonosAlarm, SonosHtLevels, SonosSettings } from '../../../shared/types';
import { api } from '../../api';
import { errorMessage, setQueryData, useQuery } from '../../lib/query';
import { Card, CardBody, CardHeader, SectionLabel, Skeleton } from '../ui';
import { Toggle } from '../forms';
import { sonosCommand, sonosFacts } from './lib';

function Level({ id, label, value, min, max, unit, onCommit, disabled, hint }: {
  id: string; label: string; value: number; min: number; max: number; unit?: string; onCommit: (v: number) => void; disabled?: boolean; hint?: string;
}) {
  const [v, setV] = useState(value);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setV(value), [value]);
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <label htmlFor={id} className="text-fg">{label}</label>
        <span className="text-muted tnum">{v > 0 && min < 0 ? `+${v}` : v}{unit ?? ''}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={v}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          setV(n);
          clearTimeout(t.current);
          t.current = setTimeout(() => onCommit(n), 300);
        }}
        className="w-full cursor-pointer accent-[var(--color-accent)]"
      />
      {hint && <p className="text-[11px] text-subtle">{hint}</p>}
    </div>
  );
}

/** Status light, button lock, home-theatre levels and alarms (read on demand). */
export function SettingsCard({ device }: { device: Device }) {
  const s = sonosFacts(device);
  const caps = device.capabilities;
  const offline = device.status === 'offline';
  const key = `sonos-settings:${device.id}`;
  const settings = useQuery(offline ? null : key, async () => {
    const r = await api.devices.command(device.id, 'settings');
    if (!r.ok) throw new Error(r.error ?? 'Couldn’t read the settings');
    return r.data as SonosSettings;
  }, { staleMs: 60_000, silent: true });
  const alarmsKey = `sonos-alarms:${device.id}`;
  const alarms = useQuery(offline ? null : alarmsKey, async () => {
    const r = await api.devices.command(device.id, 'alarms');
    if (!r.ok) throw new Error(r.error ?? 'Couldn’t read the alarms');
    return (Array.isArray(r.data) ? r.data : []) as SonosAlarm[];
  }, { staleMs: 120_000, silent: true });

  const st = settings.data;
  const led = st?.led ?? s.led;
  const lock = st?.button_lock ?? s.f.button_lock ?? null;
  const ht = st?.ht ?? null;
  const patch = (p: Partial<SonosSettings>) => setQueryData<SonosSettings>(key, (old) => old && { ...old, ...p });
  const setHt = async (k: keyof SonosHtLevels, v: number | boolean) => {
    patch({ ht: { ...(ht ?? {}), [k]: v } });
    const r = await sonosCommand(device, 'eq', { [k]: v }, { error: 'Couldn’t change that setting', invalidate: false });
    const next = (r?.data as { ht?: SonosHtLevels } | undefined)?.ht;
    if (next) patch({ ht: next });
  };

  return (
    <Card>
      <CardHeader title="Speaker settings" icon={Settings2} />
      <CardBody className="space-y-4">
        {caps.includes('led') && (
          <Toggle
            checked={led ?? false}
            onChange={(v) => {
              patch({ led: v });
              void sonosCommand(device, 'led', { on: v }, { invalidate: false });
            }}
            disabled={offline}
            label={<span className="inline-flex items-center gap-1.5">{led === false ? <LightbulbOff className="size-4" aria-hidden /> : <Lightbulb className="size-4" aria-hidden />}Status light</span>}
            description={led == null ? 'The white light on the speaker. Its current state hasn’t been read yet.' : 'The white light on the speaker. Turn it off in bedrooms.'}
          />
        )}
        <Toggle
          checked={lock === true}
          onChange={(v) => {
            patch({ button_lock: v });
            void sonosCommand(device, 'button_lock', { on: v }, { success: v ? 'Buttons locked' : 'Buttons unlocked', error: 'Couldn’t change the button lock', invalidate: false });
          }}
          disabled={offline || (settings.loading && lock == null)}
          label={<span className="inline-flex items-center gap-1.5"><Lock className="size-4" aria-hidden />Lock the buttons</span>}
          description="Stops the touch controls on the speaker from working — handy for kids or guests. The app and Screens still work."
        />
        {settings.error ? <p className="text-xs text-crit-fg">{errorMessage(settings.error)}</p> : null}

        {ht && (
          <div className="border-t border-line pt-4">
            <SectionLabel className="flex items-center gap-1.5"><Tv className="size-3.5" aria-hidden />Home theatre</SectionLabel>
            <div className="space-y-3">
              {ht.sub_enabled != null && <Toggle size="sm" checked={!!ht.sub_enabled} disabled={offline} onChange={(v) => setHt('sub_enabled', v)} label="Sub" description="Turn the Sub on or off without unpairing it." />}
              {ht.sub_gain != null && <Level id={`sub-${device.id}`} label="Sub level" value={ht.sub_gain} min={-15} max={15} disabled={offline || ht.sub_enabled === false} onCommit={(v) => setHt('sub_gain', v)} />}
              {ht.surround_enabled != null && <Toggle size="sm" checked={!!ht.surround_enabled} disabled={offline} onChange={(v) => setHt('surround_enabled', v)} label="Surrounds" description="Turn the rear speakers on or off." />}
              {ht.surround_level != null && <Level id={`sur-${device.id}`} label="Surround level (TV)" value={ht.surround_level} min={-15} max={15} disabled={offline || ht.surround_enabled === false} onCommit={(v) => setHt('surround_level', v)} />}
              {ht.music_surround_level != null && <Level id={`msur-${device.id}`} label="Surround level (music)" value={ht.music_surround_level} min={-15} max={15} disabled={offline || ht.surround_enabled === false} onCommit={(v) => setHt('music_surround_level', v)} />}
              {ht.height_level != null && <Level id={`hgt-${device.id}`} label="Height level" value={ht.height_level} min={-10} max={10} disabled={offline} onCommit={(v) => setHt('height_level', v)} hint="Up-firing speakers (Arc, Era 300 surrounds)." />}
              {ht.audio_delay != null && <Level id={`lip-${device.id}`} label="Lip sync delay" value={ht.audio_delay} min={0} max={5} disabled={offline} onCommit={(v) => setHt('audio_delay', v)} hint="Raise it if voices arrive before lips move." />}
              {Object.values(ht).every((v) => v == null) && <p className="text-xs text-muted">This speaker doesn’t report any home-theatre levels.</p>}
            </div>
          </div>
        )}

        <div className="border-t border-line pt-4">
          <SectionLabel className="flex items-center gap-1.5"><AlarmClock className="size-3.5" aria-hidden />Alarms</SectionLabel>
          {alarms.loading ? (
            <Skeleton className="h-9" />
          ) : alarms.error ? (
            <p className="text-xs text-crit-fg">{errorMessage(alarms.error)}</p>
          ) : !alarms.data?.length ? (
            <p className="text-xs text-muted">No alarms. Set them up in the Sonos app (Settings → System → Alarms).</p>
          ) : (
            <ul className="space-y-2">
              {alarms.data.map((a) => (
                <li key={a.id}>
                  <Toggle
                    size="sm"
                    checked={a.enabled}
                    disabled={offline}
                    onChange={async (v) => {
                      setQueryData<SonosAlarm[]>(alarmsKey, (old) => old?.map((x) => (x.id === a.id ? { ...x, enabled: v } : x)));
                      const r = await sonosCommand(device, 'alarm_enable', { id: a.id, enabled: v }, { success: v ? `Alarm at ${a.time} turned on` : `Alarm at ${a.time} turned off`, error: 'Couldn’t change the alarm', invalidate: false });
                      if (!r) setQueryData<SonosAlarm[]>(alarmsKey, (old) => old?.map((x) => (x.id === a.id ? { ...x, enabled: !v } : x)));
                    }}
                    label={<span className="tnum">{a.time} <span className="font-normal text-muted">· {a.days}</span></span>}
                    description={`${a.room ?? 'Another room'} · ${a.program} · volume ${a.volume}${a.duration ? ` · plays for ${a.duration.replace(/^0/, '')} h` : ''}`}
                  />
                </li>
              ))}
            </ul>
          )}
          {!!alarms.data?.length && <p className="mt-2 text-[11px] text-subtle">Alarms belong to the whole Sonos system. Change times in the Sonos app.</p>}
        </div>
      </CardBody>
    </Card>
  );
}

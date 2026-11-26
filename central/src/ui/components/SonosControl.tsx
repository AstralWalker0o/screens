import { useEffect, useRef, useState } from 'react';
import {
  Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, Music, Lightbulb, LightbulbOff, Link2, Unlink, Speaker, SlidersVertical, Radio,
  ListMusic, Disc3, MoonStar, Star, RefreshCw,
} from 'lucide-react';
import type { Device, SonosFacts } from '../../shared/types';
import { api } from '../api';
import { sendCommand } from '../lib/commands';
import { errorMessage, setQueryData, useQuery } from '../lib/query';
import { Badge, Button, Card, CardBody, CardHeader, IconButton, Skeleton, cn } from './ui';
import { Select, Toggle } from './forms';
import { Popover } from './overlay';
import { DeviceStatusBadge } from './status';

type Eq = NonNullable<SonosFacts['eq']>;
interface Favorite { title: string; uri: string; meta: string; art?: string; kind: 'radio' | 'playlist' | 'track' }

/** Reads `device.facts` as the adapter's SonosFacts (uuid, now_playing, position, group, led, eq). */
function sonosFacts(d: Device) {
  const f = d.facts as unknown as Partial<SonosFacts>;
  const np = f.now_playing ?? null;
  const uuid = f.uuid ?? d.id;
  return {
    np,
    uuid,
    position: f.position ?? null,
    playing: np?.state === 'PLAYING' || np?.state === 'TRANSITIONING',
    volume: typeof np?.volume === 'number' ? np.volume : 0,
    muted: !!np?.muted,
    led: typeof f.led === 'boolean' ? f.led : null,
    eq: f.eq ?? null,
    coordinator: f.group?.coordinator ?? uuid,
    members: f.group?.members ?? [],
  };
}

const mmss = (s?: number | null) => (s == null ? '–:––' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const isSoundbar = (d: Device) => /arc|beam|ray|playbar|playbase|amp/i.test(`${d.model ?? ''} ${String((d.facts as Record<string, unknown>).model_number ?? '')}`);

export function SonosControl({ device }: { device: Device }) {
  const key = `device:${device.id}`;
  const s = sonosFacts(device);
  const caps = device.capabilities;
  const [vol, setVol] = useState(s.volume);
  const [sleep, setSleep] = useState(0);
  const dragging = useRef(false);
  const volTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!dragging.current) setVol(s.volume);
  }, [s.volume]);
  const siblings = useQuery(`devices:site:${device.site_id}`, () => api.devices.list({ site_id: device.site_id }));
  const others = (siblings.data ?? []).filter((x) => x.kind === 'sonos' && x.id !== device.id);
  // The group command wants the coordinator's device id; facts carry its Sonos UUID.
  const coordinatorId = [device, ...others].find((x) => sonosFacts(x).uuid === s.coordinator)?.id ?? device.id;
  const inMyGroup = (o: Device) => sonosFacts(o).coordinator === s.coordinator;
  const offline = device.status === 'offline';

  const patchFacts = (p: Record<string, unknown>) => setQueryData<Device>(key, (old) => old && { ...old, facts: { ...old.facts, ...p } });
  const patchNp = (p: Record<string, unknown>) => setQueryData<Device>(key, (old) => old && { ...old, facts: { ...old.facts, now_playing: { ...((old.facts.now_playing as object) ?? {}), ...p } } });
  const media = async (action: 'play' | 'pause' | 'next' | 'prev') => {
    if (action === 'play' || action === 'pause') patchNp({ state: action === 'play' ? 'PLAYING' : 'PAUSED_PLAYBACK' });
    await sendCommand(device.id, 'media', { action }, { invalidate: [key] });
  };
  const commitVolume = (level: number) => {
    clearTimeout(volTimer.current);
    volTimer.current = setTimeout(() => {
      patchNp({ volume: level });
      void sendCommand(device.id, 'volume', { level }, { invalidate: [key] });
    }, 250);
  };

  const np = s.np;
  const pos = s.position;
  const hasProgress = pos?.duration_s != null && pos.duration_s > 0 && pos.elapsed_s != null;
  const progress = hasProgress ? Math.min(100, (pos!.elapsed_s! / pos!.duration_s!) * 100) : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Now playing"
            icon={Music}
            actions={
              <>
                <DeviceStatusBadge status={device.status} />
                {caps.includes('eq') && <EqPopover device={device} eq={s.eq} soundbar={isSoundbar(device)} onEq={(eq) => patchFacts({ eq })} disabled={offline} />}
              </>
            }
          />
          <CardBody>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <div className="flex aspect-square w-full max-w-40 shrink-0 items-center justify-center self-center overflow-hidden rounded-xl bg-linear-to-br from-accent/80 to-s7/80 text-white shadow-card sm:w-40">
                {np?.art && /^https?:/.test(np.art) ? <img src={np.art} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : <Music className="size-12 opacity-80" aria-hidden />}
              </div>
              <div className="min-w-0 flex-1">
                {np?.title ? (
                  <>
                    <p className="truncate text-lg font-semibold text-fg">{np.title}</p>
                    <p className="truncate text-sm text-muted">{[np.artist, np.album].filter(Boolean).join(' · ') || ' '}</p>
                  </>
                ) : (
                  <p className="text-sm text-muted">Nothing is playing. Pick a favourite below, or start something from the Sonos or Spotify app.</p>
                )}
                {hasProgress && (
                  <div className="mt-4">
                    <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Track position" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
                      <div className="h-full rounded-full bg-fg/70" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="mt-1 flex justify-between text-[11px] text-subtle tnum"><span>{mmss(pos!.elapsed_s)}</span><span>{mmss(pos!.duration_s)}</span></div>
                  </div>
                )}
                {np?.title && !hasProgress && pos && <Badge className="mt-2" icon={Radio}>Live stream</Badge>}
                <div className="mt-4 flex items-center justify-center gap-3 sm:justify-start">
                  <IconButton icon={SkipBack} label="Previous track" variant="secondary" size="lg" onClick={() => media('prev')} disabled={offline} className="rounded-full" />
                  <button
                    type="button"
                    aria-label={s.playing ? 'Pause' : 'Play'}
                    onClick={() => media(s.playing ? 'pause' : 'play')}
                    disabled={offline}
                    className="flex size-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-card transition-colors hover:bg-accent-hover disabled:opacity-50"
                  >
                    {s.playing ? <Pause className="size-6" /> : <Play className="size-6 translate-x-0.5" />}
                  </button>
                  <IconButton icon={SkipForward} label="Next track" variant="secondary" size="lg" onClick={() => media('next')} disabled={offline} className="rounded-full" />
                </div>
              </div>
            </div>
            <div className="mt-6 flex items-center gap-3">
              {(caps.includes('mute') || caps.includes('volume')) && (
                <IconButton
                  icon={s.muted ? VolumeX : Volume2}
                  label={s.muted ? 'Unmute' : 'Mute'}
                  aria-pressed={s.muted}
                  variant={s.muted ? 'soft' : 'ghost'}
                  onClick={() => {
                    patchNp({ muted: !s.muted });
                    void sendCommand(device.id, 'mute', { mute: !s.muted }, { invalidate: [key] });
                  }}
                  disabled={offline}
                />
              )}
              <input
                type="range"
                min={0}
                max={100}
                value={vol}
                aria-label="Volume"
                disabled={offline || !caps.includes('volume')}
                onPointerDown={() => (dragging.current = true)}
                onPointerUp={() => (dragging.current = false)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVol(v);
                  commitVolume(v);
                }}
                className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--color-accent)]"
              />
              <span className="w-9 text-right text-sm font-medium text-fg tnum">{vol}</span>
            </div>
            {s.muted && <p className="mt-1 text-xs text-warn-fg">Muted</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <MoonStar className="size-4 text-muted" aria-hidden />
              <label htmlFor={`sleep-${device.id}`} className="text-sm text-fg">Sleep timer</label>
              <Select
                id={`sleep-${device.id}`}
                className="w-36"
                value={sleep}
                disabled={offline}
                onChange={async (e) => {
                  const minutes = Number(e.target.value);
                  const prev = sleep;
                  setSleep(minutes);
                  const r = await sendCommand(device.id, 'sleep_timer', { minutes }, { success: minutes ? `Music stops in ${minutes} minutes` : 'Sleep timer off', invalidate: false });
                  if (!r) setSleep(prev);
                }}
              >
                {[0, 15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m ? `${m} minutes` : 'Off'}</option>)}
              </Select>
              <span className="text-xs text-muted">Applies to the whole group.</span>
            </div>
          </CardBody>
        </Card>
        {caps.includes('favorites') && <Favorites device={device} />}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader title="Group" icon={Link2} subtitle="Grouped speakers play the same thing in sync." />
          <CardBody>
            {others.length === 0 ? (
              <p className="text-sm text-muted">This is the only Sonos speaker at the site.</p>
            ) : (
              <ul className="divide-y divide-line">
                {others.map((o) => {
                  const of = sonosFacts(o);
                  const together = inMyGroup(o);
                  return (
                    <li key={o.id} className="flex items-center gap-3 py-2.5">
                      <Speaker className="size-4 text-muted" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-fg">{o.name}</p>
                        <p className="text-xs text-muted">{together ? 'In this group' : of.np?.title ? `Playing ${of.np.title}` : 'Separate'}</p>
                      </div>
                      {caps.includes('group') && (together ? (
                        <Button size="sm" variant="ghost" icon={Unlink} onClick={() => sendCommand(o.id, 'ungroup', undefined, { success: `${o.name} left the group`, invalidate: [key, `devices:site:${device.site_id}`, `device:${o.id}`] })}>
                          Remove
                        </Button>
                      ) : (
                        <Button size="sm" icon={Link2} onClick={() => sendCommand(o.id, 'group', { coordinator_id: coordinatorId }, { success: `${o.name} joined ${device.name}`, invalidate: [key, `devices:site:${device.site_id}`, `device:${o.id}`] })}>
                          Add to group
                        </Button>
                      ))}
                    </li>
                  );
                })}
              </ul>
            )}
            {caps.includes('group') && s.members.length > 1 && s.coordinator !== s.uuid && (
              <Button className="mt-3" size="sm" variant="ghost" icon={Unlink} onClick={() => sendCommand(device.id, 'ungroup', undefined, { success: `${device.name} now plays on its own`, invalidate: [key, `devices:site:${device.site_id}`] })}>
                Play this speaker on its own
              </Button>
            )}
          </CardBody>
        </Card>
        {caps.includes('led') && (
          <Card>
            <CardBody className="pt-4">
              <Toggle
                checked={s.led ?? false}
                onChange={(v) => {
                  patchFacts({ led: v });
                  void sendCommand(device.id, 'led', { on: v }, { invalidate: [key] });
                }}
                disabled={offline}
                label={<span className="inline-flex items-center gap-1.5">{s.led === false ? <LightbulbOff className="size-4" aria-hidden /> : <Lightbulb className="size-4" aria-hidden />}Status light</span>}
                description={s.led == null ? 'The white light on the speaker. Its current state hasn’t been read yet — refresh the speaker to check.' : 'The white light on the speaker. Turn it off in bedrooms.'}
              />
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function Favorites({ device }: { device: Device }) {
  const q = useQuery(`sonos-favs:${device.id}`, async () => {
    const r = await api.devices.command(device.id, 'favorites');
    if (!r.ok) throw new Error(r.error ?? 'Couldn’t read favourites');
    return (Array.isArray(r.data) ? r.data : []) as Favorite[];
  }, { staleMs: 120_000, silent: true });
  const [busy, setBusy] = useState<string | null>(null);
  const icon = { radio: Radio, playlist: ListMusic, track: Disc3 } as const;
  return (
    <Card>
      <CardHeader
        title="Sonos favourites"
        icon={Star}
        subtitle="Saved in the Sonos app. Tap one to play it here."
        actions={<IconButton icon={RefreshCw} label="Reload favourites" size="sm" loading={q.fetching} onClick={() => q.refetch()} />}
      />
      <CardBody>
        {q.loading ? (
          <div className="grid gap-2 sm:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : q.error ? (
          <p className="text-sm text-crit-fg">{errorMessage(q.error)}</p>
        ) : !q.data?.length ? (
          <p className="text-sm text-muted">No favourites yet. Add some in the Sonos app with ♡ or “Add to My Sonos”.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {q.data.map((f) => {
              const Icon = icon[f.kind] ?? Music;
              return (
                <li key={f.uri}>
                  <button
                    type="button"
                    disabled={busy !== null || device.status === 'offline'}
                    onClick={async () => {
                      setBusy(f.uri);
                      await sendCommand(device.id, 'play_favorite', { uri: f.uri, meta: f.meta }, { success: `Playing ${f.title}`, invalidate: [`device:${device.id}`, `devices:site:${device.site_id}`] });
                      setBusy(null);
                    }}
                    className={cn('flex w-full items-center gap-3 rounded-lg border border-line p-2 text-left transition-colors hover:border-line-strong hover:bg-surface-2 disabled:opacity-60', busy === f.uri && 'border-accent')}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-3 text-muted">
                      {f.art && /^https?:/.test(f.art) ? <img src={f.art} alt="" className="size-full object-cover" referrerPolicy="no-referrer" loading="lazy" /> : <Icon className="size-4" aria-hidden />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{f.title}</span>
                      <span className="block text-xs text-muted capitalize">{busy === f.uri ? 'Starting…' : f.kind}</span>
                    </span>
                    <Play className="size-4 shrink-0 text-subtle" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function EqPopover({ device, eq, soundbar, onEq, disabled }: { device: Device; eq: Eq | null; soundbar: boolean; onEq: (eq: Eq) => void; disabled?: boolean }) {
  const [local, setLocal] = useState<Eq>(eq ?? { bass: 0, treble: 0, loudness: true });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (eq) setLocal(eq);
  }, [eq]);
  const send = (patch: Partial<Record<'bass' | 'treble' | 'loudness' | 'night_mode' | 'speech', number | boolean>>, delay = 0) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const r = await sendCommand(device.id, 'eq', patch, { error: 'Couldn’t change the sound settings', invalidate: false });
      const next = (r?.data as { eq?: Eq } | undefined)?.eq;
      if (next) {
        setLocal(next);
        onEq(next);
      }
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

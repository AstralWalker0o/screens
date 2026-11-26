import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, Music, Lightbulb, LightbulbOff, Link2, Unlink, Speaker } from 'lucide-react';
import type { Device } from '../../shared/types';
import { api } from '../api';
import { sendCommand } from '../lib/commands';
import { setQueryData, useQuery } from '../lib/query';
import { Badge, Button, Card, CardBody, CardHeader, IconButton, cn } from './ui';
import { Toggle } from './forms';
import { DeviceStatusBadge } from './status';

interface NowPlaying { state?: string; title?: string; artist?: string; album?: string; art?: string; volume?: number; muted?: boolean; source?: string; duration_s?: number; position_s?: number }
interface SonosGroup { coordinator?: string; is_coordinator?: boolean; members?: { uuid: string; name: string; ip?: string }[] }

/** Reads the Sonos adapter's facts: `uuid`, `now_playing`, `group` (coordinator is a Sonos UUID) and optional `led`. */
function sonosFacts(d: Device) {
  const f = d.facts as Record<string, unknown>;
  const np = (f.now_playing ?? null) as NowPlaying | null;
  const g = (f.group ?? {}) as SonosGroup;
  const uuid = (f.uuid as string | undefined) ?? d.id;
  return {
    np,
    uuid,
    playing: np?.state === 'PLAYING' || np?.state === 'TRANSITIONING',
    volume: typeof np?.volume === 'number' ? np.volume : 0,
    muted: !!np?.muted,
    led: f.led !== false,
    ledKnown: typeof f.led === 'boolean',
    coordinator: g.coordinator ?? uuid,
    members: g.members ?? [],
  };
}

const mmss = (s?: number) => (s == null ? '–:––' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

export function SonosControl({ device }: { device: Device }) {
  const key = `device:${device.id}`;
  const s = sonosFacts(device);
  const [vol, setVol] = useState(s.volume);
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
  const patchNp = (p: Partial<NowPlaying>) => setQueryData<Device>(key, (old) => old && { ...old, facts: { ...old.facts, now_playing: { ...((old.facts.now_playing as object) ?? {}), ...p } } });
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
  const progress = np?.duration_s ? Math.min(100, ((np.position_s ?? 0) / np.duration_s) * 100) : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <Card>
        <CardHeader title="Now playing" icon={Music} actions={<DeviceStatusBadge status={device.status} />} />
        <CardBody>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <div className="flex aspect-square w-full max-w-40 shrink-0 items-center justify-center self-center overflow-hidden rounded-xl bg-linear-to-br from-accent/80 to-s7/80 text-white shadow-card sm:w-40">
              {np?.art && /^https?:/.test(np.art) ? <img src={np.art} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : <Music className="size-12 opacity-80" aria-hidden />}
            </div>
            <div className="min-w-0 flex-1">
              {np?.title ? (
                <>
                  <p className="truncate text-lg font-semibold text-fg">{np.title}</p>
                  <p className="truncate text-sm text-muted">{[np.artist, np.album].filter(Boolean).join(' · ')}</p>
                  {np.source && <Badge className="mt-2">via {np.source}</Badge>}
                </>
              ) : (
                <p className="text-sm text-muted">Nothing is playing. Start something from the Sonos or Spotify app.</p>
              )}
              <div className={np?.duration_s ? 'mt-4' : 'hidden'}>
                <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Track position" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-fg/70" style={{ width: `${progress}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-subtle tnum"><span>{mmss(np?.position_s)}</span><span>{mmss(np?.duration_s)}</span></div>
              </div>
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
            <input
              type="range"
              min={0}
              max={100}
              value={vol}
              aria-label="Volume"
              disabled={offline}
              onPointerDown={() => (dragging.current = true)}
              onPointerUp={() => (dragging.current = false)}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVol(v);
                commitVolume(v);
              }}
              className="h-1.5 flex-1 cursor-pointer accent-[var(--color-accent)]"
            />
            <span className="w-9 text-right text-sm font-medium text-fg tnum">{vol}</span>
          </div>
          {s.muted && <p className="mt-1 text-xs text-warn-fg">Muted</p>}
        </CardBody>
      </Card>

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
                      {together ? (
                        <Button size="sm" variant="ghost" icon={Unlink} onClick={() => sendCommand(o.id, 'ungroup', undefined, { success: `${o.name} left the group`, invalidate: [key, `devices:site:${device.site_id}`, `device:${o.id}`] })}>
                          Remove
                        </Button>
                      ) : (
                        <Button size="sm" icon={Link2} onClick={() => sendCommand(o.id, 'group', { coordinator_id: coordinatorId }, { success: `${o.name} joined ${device.name}`, invalidate: [key, `devices:site:${device.site_id}`, `device:${o.id}`] })}>
                          Add to group
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {s.members.length > 1 && s.coordinator !== s.uuid && (
              <Button className="mt-3" size="sm" variant="ghost" icon={Unlink} onClick={() => sendCommand(device.id, 'ungroup', undefined, { success: `${device.name} now plays on its own`, invalidate: [key, `devices:site:${device.site_id}`] })}>
                Play this speaker on its own
              </Button>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardBody className="pt-4">
            <Toggle
              checked={s.led}
              onChange={(v) => {
                patchFacts({ led: v });
                void sendCommand(device.id, 'led', { on: v }, { invalidate: [key] });
              }}
              disabled={offline}
              label={<span className={cn('inline-flex items-center gap-1.5')}>{s.led ? <Lightbulb className="size-4" aria-hidden /> : <LightbulbOff className="size-4" aria-hidden />}Status light</span>}
              description={s.ledKnown ? 'The white light on the speaker. Turn it off in bedrooms.' : 'The white light on the speaker. Screens can switch it but can’t read its current state.'}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

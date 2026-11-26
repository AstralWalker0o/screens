import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, Music, Radio, MoonStar, Shuffle, Repeat, Repeat1, CircleAlert, Link2, LoaderCircle } from 'lucide-react';
import type { Device, SonosRepeat } from '../../../shared/types';
import { useInterval } from '../../lib/hooks';
import { relTime } from '../../lib/format';
import { Badge, Callout, Card, CardBody, CardHeader, IconButton, cn } from '../ui';
import { Select, Toggle } from '../forms';
import { DeviceStatusBadge } from '../status';
import { EqPopover, isSoundbar } from './EqPopover';
import { Art, mmss, sonosCommand, sonosFacts, sourceText } from './lib';

/** Commands whose failures are worth showing on the card (reads and sliders are noisy). */
const SHOW_ERRORS = new Set(['media', 'play_favorite', 'play_queue', 'seek', 'play_mode', 'play_input', 'sleep_timer', 'join', 'group', 'ungroup', 'party', 'clear_queue']);

export function NowPlaying({ device }: { device: Device }) {
  const s = sonosFacts(device);
  const f = s.f;
  const caps = device.capabilities;
  const offline = device.status === 'offline';
  const np = s.np;
  const [busy, setBusy] = useState<string | null>(null);

  // Volume slider: local while dragging, debounced send.
  const [vol, setVol] = useState(s.volume);
  const dragging = useRef(false);
  const volTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!dragging.current) setVol(s.volume);
  }, [s.volume]);

  // Track position, interpolated between status reads while playing.
  const pos = s.position;
  const [tick, setTick] = useState(Date.now());
  useInterval(() => setTick(Date.now()), s.playing && pos?.duration_s ? 1000 : null);
  const elapsed = pos?.elapsed_s != null ? Math.min(pos.duration_s ?? Infinity, pos.elapsed_s + (s.playing && pos.at ? Math.max(0, (tick - pos.at) / 1000) : 0)) : null;
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const hasProgress = pos?.duration_s != null && pos.duration_s > 0 && elapsed != null;
  const canSeek = hasProgress && (f.transport ? f.transport.can_seek : np?.source === 'music');
  const canSkip = f.transport ? f.transport.can_skip : true;
  const canShuffle = f.transport ? f.transport.can_shuffle : false;
  const mode = f.play_mode ?? null;

  const run = async (key: string, command: string, args: Record<string, unknown>, opts: { success?: string; error?: string } = {}) => {
    setBusy(key);
    try {
      return await sonosCommand(device, command, args, opts);
    } finally {
      setBusy(null);
    }
  };
  const media = (action: 'play' | 'pause' | 'next' | 'prev') =>
    run(action, 'media', { action }, { error: action === 'play' ? 'Couldn’t start playback' : action === 'pause' ? 'Couldn’t pause' : 'Couldn’t change track' });
  const commitVolume = (level: number) => {
    clearTimeout(volTimer.current);
    volTimer.current = setTimeout(() => void sonosCommand(device, 'volume', { level }, { invalidate: false }), 250);
  };
  const nextRepeat: Record<SonosRepeat, SonosRepeat> = { off: 'all', all: 'one', one: 'off' };
  const sleepLeft = f.sleep_timer ? Math.max(0, f.sleep_timer.remaining_s - (Date.now() - f.sleep_timer.at) / 1000) : 0;
  const [sleep, setSleep] = useState(0);
  const lastError = f.last_error && SHOW_ERRORS.has(f.last_error.command) && Date.now() - f.last_error.at < 24 * 3_600_000 ? f.last_error : null;
  const source = sourceText(np);
  const title = np?.title;

  return (
    <Card>
      <CardHeader
        title="Now playing"
        icon={Music}
        actions={
          <>
            <DeviceStatusBadge status={device.status} />
            {caps.includes('eq') && <EqPopover device={device} eq={s.eq} soundbar={isSoundbar(device)} disabled={offline} />}
          </>
        }
      />
      <CardBody>
        {f.bonded_to && (
          <Callout kind="info" className="mb-4" title={`This is the ${f.bonded_to.role.toLowerCase()} of ${f.bonded_to.name}`}>
            It always plays with {f.bonded_to.name}. The controls here act on {f.bonded_to.name}.
          </Callout>
        )}
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <Art
            deviceId={device.id}
            art={np?.art}
            className="aspect-square w-full max-w-40 self-center rounded-xl bg-linear-to-br from-accent/80 to-s7/80 text-white shadow-card sm:w-40"
            iconClassName="size-12"
          />
          <div className="min-w-0 flex-1">
            {title ? (
              <>
                <p className="truncate text-lg font-semibold text-fg" title={title}>{title}</p>
                <p className="truncate text-sm text-muted">{[np?.artist, np?.album].filter(Boolean).join(' · ') || np?.station || ' '}</p>
                {np?.station && (np?.artist || np?.album) && <p className="truncate text-xs text-subtle">{np.station}</p>}
              </>
            ) : (
              <p className="text-sm text-muted">Nothing is playing. Pick a favourite or playlist below, or start something from the Sonos or Spotify app.</p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {source && <Badge icon={np?.source === 'radio' ? Radio : undefined}>{source}</Badge>}
              {s.members.length > 1 && <Badge tone="accent" icon={Link2}>{s.members.length} rooms</Badge>}
              {title && !hasProgress && np?.source === 'radio' && <Badge>Live</Badge>}
            </div>
            {hasProgress && (
              <div className="mt-3">
                {canSeek ? (
                  <input
                    type="range"
                    min={0}
                    max={Math.round(pos!.duration_s!)}
                    value={Math.round(seekTo ?? elapsed!)}
                    aria-label="Track position"
                    disabled={offline}
                    onChange={(e) => setSeekTo(Number(e.target.value))}
                    onPointerUp={() => {
                      if (seekTo == null) return;
                      const target = seekTo;
                      void sonosCommand(device, 'seek', { position_s: target }, { error: 'Couldn’t jump to that position', invalidate: false }).finally(() => setSeekTo(null));
                    }}
                    onKeyUp={(e) => {
                      if (seekTo != null && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                        const target = seekTo;
                        void sonosCommand(device, 'seek', { position_s: target }, { invalidate: false }).finally(() => setSeekTo(null));
                      }
                    }}
                    className="h-1.5 w-full cursor-pointer accent-[var(--color-accent)]"
                  />
                ) : (
                  <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Track position" aria-valuenow={Math.round(elapsed!)} aria-valuemin={0} aria-valuemax={Math.round(pos!.duration_s!)}>
                    <div className="h-full rounded-full bg-fg/70" style={{ width: `${Math.min(100, (elapsed! / pos!.duration_s!) * 100)}%` }} />
                  </div>
                )}
                <div className="mt-1 flex justify-between text-[11px] text-subtle tnum"><span>{mmss(seekTo ?? elapsed)}</span><span>{mmss(pos!.duration_s)}</span></div>
              </div>
            )}
            <div className="mt-4 flex items-center justify-center gap-2 sm:justify-start">
              <IconButton
                icon={Shuffle}
                label={mode?.shuffle ? 'Shuffle is on' : 'Shuffle'}
                aria-pressed={!!mode?.shuffle}
                variant={mode?.shuffle ? 'soft' : 'ghost'}
                disabled={offline || !canShuffle}
                title={canShuffle ? undefined : 'Shuffle and repeat work when playing from the Sonos queue'}
                loading={busy === 'shuffle'}
                onClick={() => run('shuffle', 'play_mode', { shuffle: !mode?.shuffle }, { error: 'Couldn’t change shuffle' })}
              />
              <IconButton icon={SkipBack} label="Previous track" variant="secondary" size="lg" onClick={() => media('prev')} disabled={offline || !canSkip || busy !== null} loading={busy === 'prev'} className="rounded-full" />
              <button
                type="button"
                aria-label={s.playing ? 'Pause' : 'Play'}
                onClick={() => media(s.playing ? 'pause' : 'play')}
                disabled={offline || busy === 'play' || busy === 'pause'}
                className="flex size-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-card transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {busy === 'play' || busy === 'pause' ? <LoaderCircle className="size-6 animate-spin" aria-hidden /> : s.playing ? <Pause className="size-6" /> : <Play className="size-6 translate-x-0.5" />}
              </button>
              <IconButton icon={SkipForward} label="Next track" variant="secondary" size="lg" onClick={() => media('next')} disabled={offline || !canSkip || busy !== null} loading={busy === 'next'} className="rounded-full" />
              <IconButton
                icon={mode?.repeat === 'one' ? Repeat1 : Repeat}
                label={mode?.repeat === 'all' ? 'Repeat all' : mode?.repeat === 'one' ? 'Repeat one' : 'Repeat'}
                aria-pressed={!!mode && mode.repeat !== 'off'}
                variant={mode && mode.repeat !== 'off' ? 'soft' : 'ghost'}
                disabled={offline || !canShuffle}
                loading={busy === 'repeat'}
                onClick={() => run('repeat', 'play_mode', { repeat: nextRepeat[mode?.repeat ?? 'off'] }, { error: 'Couldn’t change repeat' })}
              />
            </div>
            {busy === 'play' && <p className="mt-2 text-center text-xs text-muted sm:text-left">Starting… if the last source has ended, Screens tries the queue.</p>}
          </div>
        </div>

        <div className="mt-6 flex items-center gap-3">
          {(caps.includes('mute') || caps.includes('volume')) && (
            <IconButton
              icon={s.muted ? VolumeX : Volume2}
              label={s.muted ? 'Unmute' : 'Mute'}
              aria-pressed={s.muted}
              variant={s.muted ? 'soft' : 'ghost'}
              onClick={() => void sonosCommand(device, 'mute', { mute: !s.muted }, { invalidate: false })}
              disabled={offline}
            />
          )}
          <input
            type="range"
            min={0}
            max={100}
            value={vol}
            aria-label={s.members.length > 1 ? `Volume of ${device.name}` : 'Volume'}
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

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
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
                const r = await sonosCommand(device, 'sleep_timer', { minutes }, { success: minutes ? `Music stops in ${minutes} minutes` : 'Sleep timer off', invalidate: false });
                if (!r) setSleep(prev);
              }}
            >
              {[0, 15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m ? `${m} minutes` : 'Off'}</option>)}
            </Select>
            {sleepLeft > 0 && <span className="text-xs text-muted">Stops in {Math.max(1, Math.round(sleepLeft / 60))} min</span>}
          </div>
          {f.crossfade != null && (
            <Toggle
              size="sm"
              checked={!!f.crossfade}
              disabled={offline}
              onChange={(v) => void sonosCommand(device, 'crossfade', { on: v }, { error: 'Couldn’t change crossfade', invalidate: false })}
              label="Crossfade"
              className="min-w-40"
            />
          )}
        </div>

        {lastError && (
          <div className={cn('mt-4 flex gap-2 rounded-lg border border-crit/30 bg-crit-soft px-3 py-2 text-xs')} role="status">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-crit-fg" aria-hidden />
            <p className="min-w-0 text-muted">
              <span className="font-medium text-fg">Last problem ({relTime(lastError.at)}):</span> {lastError.message}
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

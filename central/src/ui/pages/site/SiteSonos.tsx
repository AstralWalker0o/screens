import { useState } from 'react';
import { Link } from 'react-router';
import { Combine, LoaderCircle, Music, Pause, Play, RefreshCw, SkipForward, Speaker, Volume2, VolumeX } from 'lucide-react';
import type { SiteDetail, SonosSiteGroup, SonosSiteOverview } from '../../../shared/types';
import { api } from '../../api';
import { errorMessage, setQueryData, useQuery } from '../../lib/query';
import { Badge, Button, Callout, Card, CardBody, IconButton, Skeleton, cn } from '../../components/ui';
import { Select } from '../../components/forms';
import { bondedText, VolumeSlider } from '../../components/sonos/GroupCard';
import { Art, isPlaying, sonosCommand, sourceText } from '../../components/sonos/lib';
import { plural } from '../../lib/format';

const ALONE = '__alone__';

/** Every Sonos room and group at the site, live: play/pause, group and room volume, regrouping, pause all. */
export function SiteSonos({ site }: { site: SiteDetail }) {
  const key = `sonos-site:${site.id}`;
  const q = useQuery(key, () => api.sites.sonos(site.id), { refreshMs: 15_000, silent: true });
  const ov = q.data;
  const [busy, setBusy] = useState<string | null>(null);
  const rooms = ov?.groups.reduce((n, g) => n + g.members.length, 0) ?? 0;
  const playing = ov?.groups.filter((g) => isPlaying(g.state)).length ?? 0;
  const gatewayDown = site.gateway_status !== 'online';

  /** Commands go to an adopted speaker in the group, or through any adopted speaker with the room's uuid. */
  const send = async (busyKey: string, g: SonosSiteGroup | null, command: string, args: Record<string, unknown>, opts: { success?: string; error?: string } = {}, roomUuid?: string) => {
    if (!ov) return;
    // Group actions use an adopted speaker in the group; room actions the room's own device. Otherwise go
    // through any adopted speaker (the anchor) and name the room by uuid.
    const own = roomUuid ? g?.members.find((m) => m.uuid === roomUuid)?.device_id : g?.device_id;
    const deviceId = own ?? ov.anchor_device_id;
    const targetUuid = own ? undefined : roomUuid ?? g?.coordinator_uuid;
    setBusy(busyKey);
    const r = await sonosCommand({ id: deviceId, site_id: site.id }, command, { ...args, ...(targetUuid ? { uuid: targetUuid } : {}) }, { ...opts, invalidate: false });
    setBusy(null);
    setTimeout(() => void q.refetch(), 500);
    return r;
  };
  const patchGroup = (id: string, p: Partial<SonosSiteGroup>) => setQueryData<SonosSiteOverview>(key, (old) => old && { ...old, groups: old.groups.map((g) => (g.id === id ? { ...g, ...p } : g)) });

  if (q.loading) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-48" />)}</div>;
  if (q.error || !ov) {
    return (
      <Callout kind="warn" title="Couldn’t read the Sonos speakers" action={<Button size="sm" icon={RefreshCw} onClick={() => q.refetch()}>Try again</Button>}>
        {gatewayDown ? 'The site gateway is offline, so Screens can’t reach the speakers right now.' : errorMessage(q.error)}
      </Callout>
    );
  }

  const allGrouped = ov.groups.length <= 1;
  const partyFrom = ov.groups.find((g) => isPlaying(g.state) && g.device_id) ?? ov.groups.find((g) => g.device_id) ?? null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {plural(rooms, 'room')} in {plural(ov.groups.length, 'group')} · {playing ? `${playing} playing` : 'nothing playing'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <IconButton icon={RefreshCw} label="Refresh" variant="secondary" size="sm" loading={q.fetching} onClick={() => q.refetch()} />
          {!allGrouped && (
            <Button size="sm" icon={Combine} loading={busy === 'party'} disabled={busy !== null} onClick={() => send('party', partyFrom, 'party', {}, { success: 'All rooms are now playing together', error: 'Couldn’t group all rooms' })}>
              Group all rooms
            </Button>
          )}
          <Button size="sm" icon={Pause} loading={busy === 'pause_all'} disabled={busy !== null || !playing} onClick={() => send('pause_all', null, 'pause_all', {}, { error: 'Couldn’t pause everything' })}>
            Pause all
          </Button>
        </div>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ov.groups.map((g) => {
          const on = isPlaying(g.state);
          const artDevice = g.device_id ?? ov.anchor_device_id;
          const multi = g.members.length > 1;
          return (
            <li key={g.id}>
              <Card className={cn('h-full', on && 'ring-1 ring-accent/40')}>
                <CardBody className="pt-4">
                  <div className="flex items-start gap-3">
                    <Art deviceId={artDevice} art={g.art} className="size-16 rounded-lg bg-linear-to-br from-accent/80 to-s7/80 text-white" iconClassName="size-6" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-fg">
                        {g.device_id ? <Link to={`/devices/${g.device_id}`} className="hover:underline">{g.name}</Link> : g.name}
                      </p>
                      <p className="truncate text-sm text-fg" title={g.title}>{g.title ?? <span className="text-muted">Nothing playing</span>}</p>
                      <p className="truncate text-xs text-muted">{[g.artist, g.album].filter(Boolean).join(' · ') || g.station || ' '}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {sourceText(g) && <Badge>{sourceText(g)}</Badge>}
                        {g.state === 'PAUSED_PLAYBACK' && <Badge>Paused</Badge>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {on && <IconButton icon={SkipForward} label={`Next track in ${g.name}`} size="sm" disabled={busy !== null} onClick={() => send(`next:${g.id}`, g, 'media', { action: 'next' }, { error: 'Couldn’t skip' })} />}
                      <button
                        type="button"
                        aria-label={on ? `Pause ${g.name}` : `Play ${g.name}`}
                        disabled={busy !== null}
                        onClick={async () => {
                          const r = await send(`play:${g.id}`, g, 'media', { action: on ? 'pause' : 'play' }, { error: on ? `Couldn’t pause ${g.name}` : `Couldn’t start ${g.name}` });
                          if (r) patchGroup(g.id, { state: on ? 'PAUSED_PLAYBACK' : 'PLAYING' });
                        }}
                        className="flex size-10 items-center justify-center rounded-full bg-accent text-on-accent shadow-card transition-colors hover:bg-accent-hover disabled:opacity-60"
                      >
                        {busy === `play:${g.id}` ? <LoaderCircle className="size-5 animate-spin" aria-hidden /> : on ? <Pause className="size-5" aria-hidden /> : <Play className="size-5 translate-x-px" aria-hidden />}
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <IconButton
                      icon={g.muted ? VolumeX : Volume2}
                      label={g.muted ? `Unmute ${g.name}` : `Mute ${g.name}`}
                      size="sm"
                      variant={g.muted ? 'soft' : 'ghost'}
                      onClick={() => {
                        patchGroup(g.id, { muted: !g.muted });
                        void send(`mute:${g.id}`, g, multi ? 'group_mute' : 'mute', { mute: !g.muted });
                      }}
                    />
                    <span className="w-14 shrink-0 text-xs text-muted">{multi ? 'Group' : 'Volume'}</span>
                    <VolumeSlider
                      value={g.volume}
                      label={`${multi ? 'Group volume' : 'Volume'} of ${g.name}`}
                      onCommit={(level) => {
                        patchGroup(g.id, { volume: level });
                        void send(`vol:${g.id}`, g, multi ? 'group_volume' : 'volume', { level }, {}, multi ? undefined : g.members[0]?.uuid);
                      }}
                    />
                  </div>

                  <ul className="mt-3 space-y-2 border-t border-line pt-3">
                    {g.members.map((m) => (
                      <li key={m.uuid}>
                        <div className="flex items-center gap-2">
                          <Speaker className="size-3.5 shrink-0 text-muted" aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-sm text-fg" title={m.name}>
                            {m.device_id ? <Link to={`/devices/${m.device_id}`} className="hover:underline">{m.name}</Link> : m.name}
                            {bondedText(m) && <span className="ml-1 text-xs text-subtle">{bondedText(m)}</span>}
                          </span>
                          <Select
                            aria-label={`Group for ${m.name}`}
                            className="h-7 w-40 text-xs"
                            value={multi ? g.id : ALONE}
                            disabled={busy !== null}
                            onChange={(e) => {
                              const to = e.target.value;
                              if (to === ALONE) void send(`move:${m.uuid}`, g, 'ungroup', {}, { success: `${m.name} now plays on its own`, error: `Couldn’t move ${m.name}` }, m.uuid);
                              else if (to !== g.id) {
                                const target = ov.groups.find((x) => x.id === to)!;
                                void send(`move:${m.uuid}`, g, 'join', { coordinator_uuid: target.coordinator_uuid }, { success: `${m.name} joined ${target.name}`, error: `Couldn’t move ${m.name}` }, m.uuid);
                              }
                            }}
                          >
                            <option value={ALONE}>On its own</option>
                            {multi && <option value={g.id}>In this group</option>}
                            {ov.groups.filter((x) => x.id !== g.id).map((x) => <option key={x.id} value={x.id}>{`Join ${x.name}`}</option>)}
                          </Select>
                        </div>
                        {multi && (
                          <div className="mt-1 pl-5.5">
                            <VolumeSlider value={m.volume} label={`Volume of ${m.name}`} onCommit={(level) => void send(`mvol:${m.uuid}`, g, 'volume', { level }, {}, m.uuid)} />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  {!g.device_id && <p className="mt-2 text-[11px] text-subtle">Not adopted in Screens — controlled through another speaker.</p>}
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>
      {!ov.groups.length && (
        <Card>
          <CardBody className="py-8 text-center text-sm text-muted">
            <Music className="mx-auto mb-2 size-5" aria-hidden />
            No Sonos rooms found.
          </CardBody>
        </Card>
      )}
    </div>
  );
}

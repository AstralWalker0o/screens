import { useState } from 'react';
import { Cable, Disc3, ListMusic, Music, Play, Radio, RefreshCw, Star, Tv } from 'lucide-react';
import type { Device, SonosBrowseItem, SonosInput } from '../../../shared/types';
import { api } from '../../api';
import { errorMessage, useQuery } from '../../lib/query';
import { Card, CardBody, CardHeader, IconButton, Skeleton, cn } from '../ui';
import { Segmented } from '../forms';
import { Art, sonosCommand } from './lib';

type Tab = 'favorites' | 'playlists' | 'inputs';

function useList<T>(device: Device, command: string, enabled: boolean) {
  return useQuery(enabled ? `sonos-${command}:${device.id}` : null, async () => {
    const r = await api.devices.command(device.id, command);
    if (!r.ok) throw new Error(r.error ?? 'Couldn’t read the list');
    return (Array.isArray(r.data) ? r.data : []) as T[];
  }, { staleMs: 120_000, silent: true });
}

/** Sonos favourites, Sonos playlists and inputs (line-in / TV) — tap to play on this speaker's group. */
export function BrowseCard({ device }: { device: Device }) {
  const [tab, setTab] = useState<Tab>('favorites');
  const favs = useList<SonosBrowseItem>(device, 'favorites', tab === 'favorites');
  const lists = useList<SonosBrowseItem>(device, 'playlists', tab === 'playlists');
  const inputs = useList<SonosInput>(device, 'inputs', true);
  const [busy, setBusy] = useState<string | null>(null);
  const offline = device.status === 'offline';
  const q = tab === 'favorites' ? favs : tab === 'playlists' ? lists : inputs;
  const icon = { radio: Radio, playlist: ListMusic, track: Disc3 } as const;
  const hasInputs = !!inputs.data?.length;

  const play = async (id: string, command: string, args: Record<string, unknown>, title: string) => {
    setBusy(id);
    await sonosCommand(device, command, args, { success: `Playing ${title}`, error: `Couldn’t play ${title}`, invalidate: [`device:${device.id}`, `devices:site:${device.site_id}`, `sonos-queue:${device.id}`] });
    setBusy(null);
  };

  const items = (list: SonosBrowseItem[] | undefined, empty: string) =>
    !list?.length ? (
      <p className="text-sm text-muted">{empty}</p>
    ) : (
      <ul className="grid gap-2 sm:grid-cols-2">
        {list.map((f) => {
          const Icon = icon[f.kind] ?? Music;
          return (
            <li key={f.uri}>
              <button
                type="button"
                disabled={busy !== null || offline}
                onClick={() => play(f.uri, 'play_favorite', { uri: f.uri, meta: f.meta }, f.title)}
                className={cn('flex w-full items-center gap-3 rounded-lg border border-line p-2 text-left transition-colors hover:border-line-strong hover:bg-surface-2 disabled:opacity-60', busy === f.uri && 'border-accent')}
              >
                <Art deviceId={device.id} art={f.art} icon={Icon} className="size-9 rounded-md bg-surface-3 text-muted" iconClassName="size-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{f.title}</span>
                  <span className="block truncate text-xs text-muted">{busy === f.uri ? 'Starting…' : f.description ?? (f.kind === 'radio' ? 'Radio' : f.kind === 'playlist' ? 'Playlist' : 'Track')}</span>
                </span>
                <Play className="size-4 shrink-0 text-subtle" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    );

  return (
    <Card>
      <CardHeader
        title="Play something"
        icon={Star}
        subtitle={tab === 'favorites' ? 'Your Sonos favourites (♡ in the Sonos app).' : tab === 'playlists' ? 'Playlists saved in the Sonos app.' : 'Play from a connected TV or line-in.'}
        actions={<IconButton icon={RefreshCw} label="Reload" size="sm" loading={q.fetching} onClick={() => q.refetch()} />}
      />
      <CardBody>
        <Segmented<Tab>
          ariaLabel="What to browse"
          size="sm"
          className="mb-3"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'favorites', label: 'Favourites', icon: Star },
            { value: 'playlists', label: 'Playlists', icon: ListMusic },
            ...(hasInputs ? [{ value: 'inputs' as const, label: 'Inputs', icon: Cable }] : []),
          ]}
        />
        {q.loading ? (
          <div className="grid gap-2 sm:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : q.error ? (
          <p className="text-sm text-crit-fg">{errorMessage(q.error)}</p>
        ) : tab === 'favorites' ? (
          items(favs.data, 'No favourites yet. Add some in the Sonos app with ♡ or “Add to My Sonos”.')
        ) : tab === 'playlists' ? (
          items(lists.data, 'No Sonos playlists yet. In the Sonos app, save a queue as a playlist to see it here.')
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {(inputs.data ?? []).map((i) => {
              const id = `${i.kind}:${i.uuid}`;
              return (
                <li key={id}>
                  <button
                    type="button"
                    disabled={busy !== null || offline}
                    onClick={() => play(id, 'play_input', { kind: i.kind, uuid: i.uuid }, i.name)}
                    className={cn('flex w-full items-center gap-3 rounded-lg border border-line p-2 text-left transition-colors hover:border-line-strong hover:bg-surface-2 disabled:opacity-60', busy === id && 'border-accent')}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-3 text-muted">{i.kind === 'tv' ? <Tv className="size-4" aria-hidden /> : <Cable className="size-4" aria-hidden />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{i.name}</span>
                      <span className="block text-xs text-muted">{busy === id ? 'Switching…' : i.kind === 'tv' ? 'TV sound through this speaker' : 'Audio plugged into the speaker'}</span>
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

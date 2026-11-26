import { useState } from 'react';
import { ChevronDown, ChevronUp, Disc3, ListOrdered, Play, RefreshCw, Trash2, X } from 'lucide-react';
import type { Device, SonosQueue } from '../../../shared/types';
import { api } from '../../api';
import { errorMessage, invalidate, setQueryData, useQuery } from '../../lib/query';
import { Button, Card, CardBody, CardHeader, IconButton, Skeleton, cn } from '../ui';
import { ConfirmDialog } from '../overlay';
import { Art, mmss, sonosCommand } from './lib';

/** The group's Sonos queue, loaded on demand (Browse Q:0 can be large). */
export function QueueCard({ device }: { device: Device }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | 'clear' | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const key = `sonos-queue:${device.id}`;
  const q = useQuery(open ? key : null, async () => {
    const r = await api.devices.command(device.id, 'queue', { start: 0, count: 100 });
    if (!r.ok) throw new Error(r.error ?? 'Couldn’t read the queue');
    return r.data as SonosQueue;
  }, { staleMs: 30_000, silent: true });
  const data = q.data;
  const offline = device.status === 'offline';

  const playAt = async (index: number) => {
    setBusy(index);
    const r = await sonosCommand(device, 'play_queue', { index }, { error: 'Couldn’t play that track' });
    if (r) setQueryData<SonosQueue>(key, (old) => old && { ...old, current: index, active: true });
    setBusy(null);
  };
  const remove = async (index: number) => {
    setBusy(index);
    const r = await sonosCommand(device, 'remove_from_queue', { index }, { error: 'Couldn’t remove that track', invalidate: false });
    // Indexes shift after a removal: reload rather than patching.
    if (r) invalidate(key);
    setBusy(null);
  };

  return (
    <Card>
      <CardHeader
        title="Queue"
        icon={ListOrdered}
        subtitle={open && data ? (data.total ? `${data.total} ${data.total === 1 ? 'track' : 'tracks'}${data.active ? '' : ' · not playing from the queue right now'}` : 'The queue is empty') : 'Tracks lined up to play in this group.'}
        actions={
          <>
            {open && <IconButton icon={RefreshCw} label="Reload queue" size="sm" loading={q.fetching} onClick={() => q.refetch()} />}
            {open && !!data?.total && (
              <Button size="sm" variant="danger-ghost" icon={Trash2} disabled={offline} onClick={() => setConfirmClear(true)}>Clear</Button>
            )}
            <Button size="sm" iconRight={open ? ChevronUp : ChevronDown} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Show queue'}</Button>
          </>
        }
      />
      {open && (
        <CardBody>
          {q.loading ? (
            <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : q.error ? (
            <p className="text-sm text-crit-fg">{errorMessage(q.error)}</p>
          ) : !data?.items.length ? (
            <p className="text-sm text-muted">Nothing is queued. Playing a playlist or album favourite fills the queue.</p>
          ) : (
            <>
              <ol className="max-h-[28rem] divide-y divide-line overflow-y-auto">
                {data.items.map((t) => {
                  const current = data.active && data.current === t.index;
                  return (
                    <li key={t.index} className={cn('group flex items-center gap-3 py-1.5', current && 'bg-accent-soft/40')}>
                      <span className={cn('w-7 shrink-0 text-right text-xs tnum', current ? 'font-semibold text-accent-fg' : 'text-subtle')}>{t.index}</span>
                      <button
                        type="button"
                        disabled={offline || busy !== null}
                        onClick={() => playAt(t.index)}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left disabled:opacity-60"
                        aria-label={`Play ${t.title}`}
                      >
                        <Art deviceId={device.id} art={t.art} icon={Disc3} className="size-8 rounded bg-surface-3 text-muted" iconClassName="size-4" />
                        <span className="min-w-0 flex-1">
                          <span className={cn('block truncate text-sm', current ? 'font-semibold text-fg' : 'text-fg')}>{t.title}</span>
                          <span className="block truncate text-xs text-muted">{[t.artist, t.album].filter(Boolean).join(' · ') || ' '}</span>
                        </span>
                        <span className="shrink-0 text-xs text-subtle tnum">{t.duration_s ? mmss(t.duration_s) : ''}</span>
                        {busy === t.index ? <span className="text-xs text-muted">…</span> : <Play className="size-3.5 shrink-0 text-subtle opacity-0 group-hover:opacity-100" aria-hidden />}
                      </button>
                      <IconButton icon={X} label={`Remove ${t.title} from the queue`} size="xs" disabled={offline || busy !== null} onClick={() => remove(t.index)} />
                    </li>
                  );
                })}
              </ol>
              {data.total > data.items.length && <p className="mt-2 text-xs text-muted">Showing the first {data.items.length} of {data.total} tracks.</p>}
            </>
          )}
        </CardBody>
      )}
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        danger
        title="Clear the queue?"
        confirmLabel="Clear queue"
        onConfirm={async () => {
          setBusy('clear');
          const r = await sonosCommand(device, 'clear_queue', {}, { success: 'Queue cleared', error: 'Couldn’t clear the queue', invalidate: false });
          setBusy(null);
          setConfirmClear(false);
          if (r) setQueryData<SonosQueue>(key, (old) => old && { ...old, items: [], total: 0, current: null });
        }}
      >
        <p>This removes every track from the queue for {device.name} and its group. Favourites and playlists aren’t affected.</p>
      </ConfirmDialog>
    </Card>
  );
}

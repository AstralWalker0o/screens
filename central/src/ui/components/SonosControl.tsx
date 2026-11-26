import type { Device, SonosFacts } from '../../shared/types';
import { api } from '../api';
import { useQuery } from '../lib/query';
import { BrowseCard } from './sonos/BrowseCard';
import { GroupCard } from './sonos/GroupCard';
import { mergeFacts } from './sonos/lib';
import { NowPlaying } from './sonos/NowPlaying';
import { QueueCard } from './sonos/QueueCard';
import { SettingsCard } from './sonos/SettingsCard';

/**
 * Sonos speaker control. While this is on screen a light `status` read runs every 20 s, so what's
 * playing, the position, play mode, group and member volumes stay live (the hub's own refresh only
 * runs every few minutes).
 */
export function SonosControl({ device }: { device: Device }) {
  const caps = device.capabilities;
  useQuery(device.status === 'offline' ? null : `sonos-status:${device.id}`, async () => {
    const r = await api.devices.command(device.id, 'status');
    if (!r.ok) throw new Error(r.error ?? 'Couldn’t read the speaker');
    mergeFacts(device.id, r.data as Partial<SonosFacts> as Record<string, unknown>);
    return r.data;
  }, { refreshMs: 20_000, staleMs: 10_000, silent: true });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <div className="space-y-4">
        <NowPlaying device={device} />
        <QueueCard device={device} />
        {caps.includes('favorites') && <BrowseCard device={device} />}
      </div>
      <div className="space-y-4">
        <GroupCard device={device} />
        <SettingsCard device={device} />
      </div>
    </div>
  );
}

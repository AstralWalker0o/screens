import { useMemo, useState } from 'react';
import { CircleArrowUp, KeyRound, LoaderCircle, Pin, Store } from 'lucide-react';
import type { Device } from '../../../shared/types';
import type { DeviceUpdateItem } from '../../../shared/updates';
import { api } from '../../api';
import { act, useQuery } from '../../lib/query';
import { plural } from '../../lib/format';
import { AppIcon } from '../../components/AppLauncher';
import { Badge, Button, ButtonLink, Card, StatusText } from '../../components/ui';
import { runMessage } from './meta';

/** Update status of every sideloaded app on one Android box, by package. */
export function useDeviceUpdates(d: Device) {
  const q = useQuery(d.kind === 'android' ? `updates:device:${d.id}` : null, () => api.updates.device(d.id), { silent: true, refreshMs: 20_000 });
  return useMemo(() => new Map((q.data?.items ?? []).map((i) => [i.package, i])), [q.data]);
}

/** "2 app updates ready" with one-click updates, shown at the top of a box's Apps tab. */
export function DeviceUpdatesBanner({ device, items }: { device: Device; items: Map<string, DeviceUpdateItem> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const ready = [...items.values()].filter((i) => i.state === 'update');
  if (!ready.length) return null;
  const run = async (i: DeviceUpdateItem) => {
    setBusy(i.package);
    await act(() => api.updates.run({ package: i.package, device_id: device.id }), { success: (r) => runMessage(r, i.label), invalidate: ['updates', `apps:${device.id}`] });
    setBusy(null);
  };
  return (
    <Card className="border-accent/30">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <CircleArrowUp className="size-4 text-accent-fg" aria-hidden />
        <p className="flex-1 text-sm font-semibold text-fg">{ready.length === 1 ? '1 app update ready' : `${plural(ready.length, 'app update')} ready`}</p>
        <ButtonLink to="/updates" size="sm" variant="ghost">All updates</ButtonLink>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {ready.map((i) => (
          <li key={i.package} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
            <AppIcon app={{ label: i.label, package: i.package }} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{i.label}</p>
              <p className="truncate font-mono text-[11.5px] text-muted">{i.installed ?? '–'} → <span className="font-semibold text-accent-fg">{i.available}</span></p>
            </div>
            {i.busy ? (
              <StatusText tone="accent" icon={LoaderCircle} className="[&>svg]:animate-spin">Updating</StatusText>
            ) : (
              <Button size="sm" variant="primary" icon={CircleArrowUp} loading={busy === i.package} disabled={device.status === 'offline'} onClick={() => run(i)}
                title="Installs now, even if someone is using the box. The app restarts.">Update</Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Small per-app badge for the Apps list. */
export function UpdateBadge({ item }: { item?: DeviceUpdateItem }) {
  if (!item) return null;
  if (item.state === 'update') return <Badge tone="accent" icon={CircleArrowUp} title={item.detail}>Update {item.available}</Badge>;
  if (item.state === 'store') return <Badge icon={Store} title={item.detail}>Google Play</Badge>;
  if (item.state === 'signer_mismatch') return <Badge tone="crit" icon={KeyRound} title={item.detail}>Update blocked</Badge>;
  if (item.state === 'pinned') return <Badge icon={Pin} title={item.detail}>Pinned</Badge>;
  return null;
}

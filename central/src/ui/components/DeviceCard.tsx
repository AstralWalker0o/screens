import { useState } from 'react';
import { Link } from 'react-router';
import { Power, Gamepad2, Camera, AppWindow, MapPin } from 'lucide-react';
import type { Device } from '../../shared/types';
import { sendCommand } from '../lib/commands';
import { kindLabel } from '../lib/labels';
import { ButtonLink, Card, IconButton, cn } from './ui';
import { DeviceStatusBadge, DnsModeBadge, GradeBadge, KindIcon, PowerText } from './status';
import { ScreenshotDialog } from './Screenshot';

export function DeviceCard({ device: d }: { device: Device }) {
  const [shot, setShot] = useState(false);
  const [busy, setBusy] = useState(false);
  const canPower = d.capabilities.includes('power');
  const on = d.power === 'on';
  const hasRemote = d.capabilities.includes('remote') || d.kind === 'sonos';
  const togglePower = async () => {
    setBusy(true);
    await sendCommand(d.id, on ? 'power_off' : 'power_on', undefined, { success: on ? `${d.name} is turning off` : `Waking ${d.name}` });
    setBusy(false);
  };
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <KindIcon kind={d.kind} boxed />
        <div className="min-w-0 flex-1">
          <Link to={`/devices/${d.id}`} className="block truncate text-[15px] font-semibold text-fg hover:underline">{d.name}</Link>
          <p className="truncate text-xs text-muted">
            {kindLabel(d.kind, d.model)}
            {d.room && <> · <MapPin className="inline size-3 align-[-1px]" aria-hidden /> {d.room}</>}
          </p>
        </div>
        <GradeBadge score={d.privacy_score} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <DeviceStatusBadge status={d.status} />
        {d.kind !== 'sonos' && <PowerText device={d} />}
        <DnsModeBadge mode={d.dns_mode} />
      </div>
      <p className={cn('mt-2 flex min-h-5 items-center gap-1.5 truncate text-sm', d.current_app ? 'text-fg' : 'text-subtle')}>
        <AppWindow className="size-3.5 shrink-0 text-subtle" aria-hidden />
        {d.current_app ? <span className="truncate">{d.kind === 'sonos' ? 'Playing from ' : ''}{d.current_app}</span> : d.status === 'online' ? 'Home screen' : '—'}
      </p>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-3">
        {canPower && (
          <IconButton
            icon={Power}
            label={on ? `Turn ${d.name} off` : `Turn ${d.name} on`}
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={d.status === 'offline' && d.kind !== 'samsung'}
            onClick={togglePower}
            className={on ? 'text-ok-fg' : ''}
          />
        )}
        {d.capabilities.includes('screenshot') && (
          <IconButton icon={Camera} label="Screenshot" variant="secondary" size="sm" onClick={() => setShot(true)} disabled={d.status === 'offline'} />
        )}
        {hasRemote && (
          <ButtonLink to={`/devices/${d.id}`} size="sm" icon={Gamepad2} className="ml-auto">
            {d.kind === 'sonos' ? 'Controls' : 'Remote'}
          </ButtonLink>
        )}
      </div>
      {shot && <ScreenshotDialog device={d} open={shot} onClose={() => setShot(false)} />}
    </Card>
  );
}

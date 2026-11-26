import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Gamepad2, AppWindow, ShieldCheck, Network, Wrench, RefreshCw, Power, Link2, MapPin } from 'lucide-react';
import type { Device } from '../../../shared/types';
import { api, ApiError } from '../../api';
import { sendCommand } from '../../lib/commands';
import { useQuery } from '../../lib/query';
import { kindLabel } from '../../lib/labels';
import { Button, Callout, IconButton, PageHeader, RelTime, SkeletonRows, TabNav, type TabDef } from '../../components/ui';
import { DeviceStatusBadge, GradeBadge, KindIcon, PowerText } from '../../components/status';
import { NotFound } from '../NotFound';
import { ControlTab } from './ControlTab';
import { AppsTab } from './AppsTab';
import { PrivacyTab } from './PrivacyTab';
import { NetworkTab } from './NetworkTab';
import { AdvancedTab } from './AdvancedTab';

export default function DeviceDetail() {
  const { id = '', tab = 'control' } = useParams();
  const q = useQuery(`device:${id}`, () => api.devices.get(id), { refreshMs: 15_000 });
  const d = q.data;
  const [busy, setBusy] = useState<string | null>(null);

  if (q.error instanceof ApiError && q.error.status === 404) return <NotFound />;

  const tabs: TabDef[] = [
    { id: 'control', label: 'Control', icon: Gamepad2 },
    { id: 'apps', label: 'Apps', icon: AppWindow, hidden: !d || !d.capabilities.includes('apps') },
    { id: 'privacy', label: 'Privacy', icon: ShieldCheck },
    { id: 'network', label: 'Network', icon: Network },
    { id: 'advanced', label: 'Advanced', icon: Wrench },
  ];

  const run = async (cmd: string, success: string) => {
    if (!d) return;
    setBusy(cmd);
    await sendCommand(d.id, cmd, undefined, { success });
    setBusy(null);
  };

  return (
    <>
      <PageHeader
        back={d ? { to: `/sites/${d.site_id}`, label: d.site_name ?? 'Site' } : { to: '/devices', label: 'Devices' }}
        title={
          d ? (
            <span className="inline-flex items-center gap-3">
              <KindIcon kind={d.kind} boxed />
              <span className="min-w-0">{d.name}</span>
            </span>
          ) : '…'
        }
        meta={
          d && (
            <>
              <DeviceStatusBadge status={d.status} />
              {d.kind !== 'sonos' && <PowerText device={d} />}
              <span className="text-xs text-muted">{kindLabel(d.kind, d.model)}{d.model ? ` · ${d.model}` : ''}</span>
              {d.room && <span className="inline-flex items-center gap-1 text-xs text-muted"><MapPin className="size-3" aria-hidden />{d.room}</span>}
              {d.ip && <span className="font-mono text-xs text-muted">{d.ip}</span>}
              <span className="text-xs text-subtle">seen <RelTime ts={d.last_seen} /></span>
            </>
          )
        }
        actions={
          d && (
            <>
              <Link to={`/devices/${d.id}/privacy`} className="rounded-lg" aria-label="Privacy grade — open the privacy report">
                <GradeBadge score={d.privacy_score} size="lg" />
              </Link>
              <IconButton icon={RefreshCw} label="Refresh status" variant="secondary" loading={busy === 'refresh'} onClick={() => run('refresh', 'Status refreshed')} />
              {d.capabilities.includes('power') && (
                <Button
                  icon={Power}
                  loading={busy === 'power_on' || busy === 'power_off'}
                  disabled={d.status === 'pairing'}
                  onClick={() => (d.power === 'on' ? run('power_off', `${d.name} is turning off`) : run('power_on', `Waking ${d.name}`))}
                >
                  {d.power === 'on' ? 'Turn off' : 'Turn on'}
                </Button>
              )}
            </>
          )
        }
      />
      {d && <StatusBanner device={d} />}
      <TabNav tabs={tabs} base={`/devices/${id}`} active={tab} />
      {!d ? (
        <SkeletonRows rows={8} />
      ) : tab === 'apps' && d.capabilities.includes('apps') ? (
        <AppsTab device={d} />
      ) : tab === 'privacy' ? (
        <PrivacyTab device={d} />
      ) : tab === 'network' ? (
        <NetworkTab device={d} />
      ) : tab === 'advanced' ? (
        <AdvancedTab device={d} />
      ) : (
        <ControlTab device={d} />
      )}
    </>
  );
}

function StatusBanner({ device: d }: { device: Device }) {
  const [busy, setBusy] = useState(false);
  const repair = async () => {
    setBusy(true);
    await sendCommand(d.id, 'pair', undefined, { success: d.kind === 'android' ? 'Look at the TV: choose “Allow” on the USB debugging prompt.' : 'Look at the TV: choose “Allow” with its remote.' });
    setBusy(false);
  };
  if (d.status === 'pairing' || d.status === 'unauthorized') {
    const android = d.kind === 'android';
    return (
      <Callout
        kind="warn"
        className="mb-4"
        title={d.status === 'pairing' ? `Waiting for someone to press “Allow” on ${d.name}` : `${d.name} isn’t letting Screens in`}
        action={<Button size="sm" icon={Link2} loading={busy} onClick={repair}>Show the prompt again</Button>}
      >
        {typeof d.facts.pairing_detail === 'string' && d.facts.pairing_detail ? d.facts.pairing_detail : android
          ? 'The TV is showing “Allow USB debugging?”. Tick “Always allow from this computer” and choose OK with the remote.'
          : `The TV is showing a prompt asking whether to allow “Screens”. Choose Allow with the ${d.kind === 'lg' ? 'LG' : 'Samsung'} remote within 30 seconds. Remote control works once it’s accepted.`}
      </Callout>
    );
  }
  if (d.status === 'offline') {
    return (
      <Callout kind="crit" className="mb-4" title={`${d.name} is offline`}>
        Last seen <RelTime ts={d.last_seen} />. Check it has power and is connected to the network. {d.kind === 'samsung' || d.kind === 'lg' ? 'If it’s just in standby, “Turn on” may still wake it.' : ''}
      </Callout>
    );
  }
  return null;
}

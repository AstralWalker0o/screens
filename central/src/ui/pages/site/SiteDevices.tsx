import { Radar, Router, TvMinimalPlay } from 'lucide-react';
import type { SiteDetail } from '../../../shared/types';
import { DeviceCard } from '../../components/DeviceCard';
import { ButtonLink, Card, EmptyState } from '../../components/ui';
import { KIND_ORDER } from '../../lib/labels';

export function SiteDevices({ site }: { site: SiteDetail }) {
  const devices = [...site.devices].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
  if (!devices.length) {
    return (
      <Card>
        {site.gateway_status === 'none' ? (
          <EmptyState icon={Router} title="Add a gateway first" action={<ButtonLink to={`/sites/${site.id}/gateway`} variant="primary" icon={Router}>Add gateway</ButtonLink>}>
            Screens finds and controls devices through a small gateway at the site. Once it’s running you can scan the network and adopt your TVs and speakers.
          </EmptyState>
        ) : (
          <EmptyState icon={TvMinimalPlay} title="No devices yet" action={<ButtonLink to={`/sites/${site.id}/discover`} variant="primary" icon={Radar}>Find devices</ButtonLink>}>
            Scan the network to find TVs, streaming boxes and speakers, then adopt the ones you want Screens to look after.
          </EmptyState>
        )}
      </Card>
    );
  }
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {site.devices_online} of {site.devices_total} devices are reachable. Open one for its remote, apps and privacy report.
        </p>
        <ButtonLink to={`/sites/${site.id}/discover`} size="sm" icon={Radar}>Find more devices</ButtonLink>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {devices.map((d) => (
          <li key={d.id}>
            <DeviceCard device={d} />
          </li>
        ))}
      </ul>
    </div>
  );
}

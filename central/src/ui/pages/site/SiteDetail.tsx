import { useParams } from 'react-router';
import { TvMinimalPlay, Router, Radar, Globe, Share2, BedDouble, Settings2, Building2, MapPin, Clock } from 'lucide-react';
import { api } from '../../api';
import { useQuery } from '../../lib/query';
import { SITE_KIND } from '../../lib/labels';
import { Badge, PageHeader, SkeletonRows, TabNav, type TabDef } from '../../components/ui';
import { GatewayBadge } from '../../components/status';
import { NotFound } from '../NotFound';
import { ApiError } from '../../api';
import { SiteDevices } from './SiteDevices';
import { GatewayTab } from './GatewayTab';
import { DiscoverTab } from './DiscoverTab';
import { SiteDns } from './SiteDns';
import { MdnsTab } from './MdnsTab';
import { GuestTab } from './GuestTab';
import { SiteSettingsTab } from './SiteSettingsTab';

export default function SiteDetail() {
  const { id = '', tab = 'devices' } = useParams();
  const q = useQuery(`site:${id}`, () => api.sites.get(id), { refreshMs: 20_000 });
  const s = q.data;

  if (q.error instanceof ApiError && q.error.status === 404) return <NotFound />;

  const tabs: TabDef[] = [
    { id: 'devices', label: 'Devices', icon: TvMinimalPlay, count: s?.devices.length },
    { id: 'gateway', label: 'Gateway', icon: Router },
    { id: 'discover', label: 'Discover', icon: Radar },
    { id: 'dns', label: 'DNS', icon: Globe },
    { id: 'mdns', label: 'mDNS reflector', icon: Share2 },
    { id: 'guest', label: 'Guest', icon: BedDouble, hidden: s?.kind !== 'rental' },
    { id: 'settings', label: 'Settings', icon: Settings2 },
  ];

  return (
    <>
      <PageHeader
        back={{ to: '/sites', label: 'Sites' }}
        icon={Building2}
        title={s?.name ?? '…'}
        subtitle={s?.client_name ? `Client: ${s.client_name}` : ' '}
        meta={
          s && (
            <>
              <Badge tone={s.kind === 'rental' ? 'accent' : 'neutral'}>{SITE_KIND[s.kind].label}</Badge>
              <GatewayBadge status={s.gateway_status} />
              {s.address && <span className="inline-flex items-center gap-1 text-xs text-muted"><MapPin className="size-3" aria-hidden />{s.address}</span>}
              <span className="inline-flex items-center gap-1 text-xs text-muted"><Clock className="size-3" aria-hidden />{s.timezone.replace(/_/g, ' ')}</span>
            </>
          )
        }
      />
      <TabNav tabs={tabs} base={`/sites/${id}`} active={tab} />
      {!s ? (
        <SkeletonRows rows={6} />
      ) : tab === 'gateway' ? (
        <GatewayTab site={s} />
      ) : tab === 'discover' ? (
        <DiscoverTab site={s} />
      ) : tab === 'dns' ? (
        <SiteDns site={s} />
      ) : tab === 'mdns' ? (
        <MdnsTab site={s} />
      ) : tab === 'guest' && s.kind === 'rental' ? (
        <GuestTab site={s} />
      ) : tab === 'settings' ? (
        <SiteSettingsTab site={s} />
      ) : (
        <SiteDevices site={s} />
      )}
    </>
  );
}

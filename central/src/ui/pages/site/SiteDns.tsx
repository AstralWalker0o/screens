import { Globe, ShieldBan, Radio, TvMinimalPlay, Router } from 'lucide-react';
import type { SiteDetail } from '../../../shared/types';
import { api } from '../../api';
import { useQuery } from '../../lib/query';
import { fmtCompact, fmtNum, fmtPct } from '../../lib/format';
import { CATEGORY, DNS_MODE } from '../../lib/labels';
import { BarList, DnsChartCard } from '../../components/charts';
import { DnsLiveLog } from '../../components/DnsLog';
import { ButtonLink, Card, CardBody, CardHeader, EmptyState, Skeleton, SkeletonRows } from '../../components/ui';
import { KindIcon } from '../../components/status';

export function SiteDns({ site }: { site: SiteDetail }) {
  const sum = useQuery(`dns-summary:${site.id}`, () => api.sites.dnsSummary(site.id, 24), { refreshMs: 60_000 });
  const s = sum.data;
  if (site.gateway_status === 'none' || site.gateway_status === 'revoked') {
    return (
      <Card>
        <EmptyState icon={Router} title="No DNS traffic yet" action={<ButtonLink to={`/sites/${site.id}/gateway`} variant="primary" icon={Router}>Add gateway</ButtonLink>}>
          DNS filtering happens on the site’s gateway. Once it’s installed and your router hands it out as the DNS server, lookups show up here live.
        </EmptyState>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        {s ? (
          <DnsChartCard className="lg:col-span-2" series={s.series} height={220} />
        ) : (
          <Card className="p-4 lg:col-span-2"><Skeleton className="mb-3 h-4 w-48" /><Skeleton className="h-52" /></Card>
        )}
        <Card>
          <CardHeader title="Most blocked" icon={ShieldBan} subtitle="Blocked or would-be-blocked lookups, 24 h" />
          <CardBody>
            {s ? (
              <BarList
                max={7}
                format={fmtCompact}
                items={s.top_blocked.map((d) => ({
                  key: d.domain,
                  label: <span className="font-mono text-[12.5px]">{d.domain}</span>,
                  value: d.blocked + d.would_block,
                  sub: [d.category && CATEGORY[d.category]?.label, d.vendor, d.would_block && !d.blocked ? 'monitor only' : null].filter(Boolean).join(' · '),
                  href: `/dns/domains?q=${encodeURIComponent(d.domain)}`,
                }))}
                emptyText="Nothing blocked in the last 24 hours."
              />
            ) : <SkeletonRows rows={5} />}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Most looked-up domains" icon={Globe} subtitle="Everything, blocked or not, 24 h" />
          <CardBody>
            {s ? (
              <BarList
                max={8}
                items={s.top_domains.map((d) => ({
                  key: d.domain,
                  label: <span className="font-mono text-[12.5px]">{d.domain}</span>,
                  value: d.queries,
                  sub: [d.category && CATEGORY[d.category]?.label, d.vendor].filter(Boolean).join(' · '),
                  emphasis: d.blocked + d.would_block === 0 ? false : true,
                  href: `/dns/domains?q=${encodeURIComponent(d.domain)}`,
                }))}
              />
            ) : <SkeletonRows rows={6} />}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="By device" icon={TvMinimalPlay} subtitle="Who makes the most lookups, and how much gets blocked" />
          <CardBody>
            {s ? (
              <ul className="divide-y divide-line">
                {s.by_device.map((d) => {
                  const dev = site.devices.find((x) => x.id === d.device_id);
                  return (
                    <li key={d.device_id} className="flex items-center gap-3 py-2">
                      <KindIcon kind={d.kind} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-fg">{d.name}</p>
                        <p className="text-xs text-muted">{dev ? DNS_MODE[dev.dns_mode].label : ''}</p>
                      </div>
                      <div className="text-right text-xs text-muted tnum">
                        <p><span className="font-semibold text-fg">{fmtNum(d.queries)}</span> lookups</p>
                        <p>
                          {d.blocked ? `${fmtPct(d.blocked, d.queries)} blocked` : d.would_block ? `${fmtPct(d.would_block, d.queries)} would block` : 'nothing blocked'}
                        </p>
                      </div>
                    </li>
                  );
                })}
                {!s.by_device.length && <li className="py-6 text-center text-sm text-muted">No adopted devices have made lookups yet.</li>}
              </ul>
            ) : <SkeletonRows rows={5} />}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Live query log"
          icon={Radio}
          subtitle="Every lookup as it happens. Red was blocked, amber would be blocked once monitoring ends, grey was allowed."
        />
        <CardBody>
          <DnsLiveLog siteId={site.id} devices={site.devices} />
        </CardBody>
      </Card>
    </div>
  );
}

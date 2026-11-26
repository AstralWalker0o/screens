import { Link } from 'react-router';
import { Building2, Router, TvMinimalPlay, Globe, ShieldBan, ScanEye, RefreshCw, ShieldCheck, Activity, BellRing, CircleCheck, CircleX } from 'lucide-react';
import type { Alert, DnsCategory, Overview as OverviewT } from '../../shared/types';
import { api } from '../api';
import { act, setQueryData, useQuery } from '../lib/query';
import { fmtCompact, fmtNum, fmtPct, greeting } from '../lib/format';
import { CATEGORY, CATEGORY_ORDER } from '../lib/labels';
import { BarList, ChartFrame, DnsChartCard, KpiTile, LegendItem, toSpark } from '../components/charts';
import { AlertRow, JobRow, KindCounts, PrivacyRankRow, SiteHealthRow } from '../components/rows';
import { Card, CardBody, CardHeader, EmptyState, IconButton, PageHeader, RelTime, Skeleton, SkeletonRows, StatusText, ButtonLink, th, td, cn } from '../components/ui';

export default function Overview() {
  const q = useQuery('overview', api.overview, { refreshMs: 30_000 });
  const o = q.data;
  const loading = q.loading;

  const ack = async (a: Alert) => {
    setQueryData<OverviewT>('overview', (old) => old && { ...old, alerts: old.alerts.filter((x) => x.id !== a.id), counts: { ...old.counts, alerts_open: old.counts.alerts_open - 1 } });
    await act(() => api.ackAlert(a.id), { invalidate: ['alerts', 'overview'] });
  };

  const series = o?.dns.series ?? [];
  const blockedPct = series.map((p) => (p.queries ? p.blocked / p.queries : 0));
  const acr = o?.dns.by_category.acr ?? 0;
  const topAcr = o?.privacy_worst.slice().sort((a, b) => b.acr_24h - a.acr_24h)[0];
  const gwAll = o ? o.counts.gateways_online === o.counts.gateways_total : true;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={o ? `${greeting()}. Here’s how your ${o.counts.sites} sites are doing right now.` : 'Your fleet at a glance.'}
        actions={
          <div className="flex items-center gap-2 text-xs text-muted">
            {o && <span className="hidden sm:inline">Updated <RelTime ts={Date.now()} /></span>}
            <IconButton icon={RefreshCw} label="Refresh" loading={q.fetching} onClick={() => q.refetch()} variant="secondary" size="sm" />
          </div>
        }
      />

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiTile loading={loading} href="/sites" icon={Building2} label="Sites" value={o?.counts.sites} sub={o && `${o.counts.clients} clients`} />
        <KpiTile
          loading={loading}
          href="/sites"
          icon={Router}
          label="Gateways online"
          value={o && <>{o.counts.gateways_online}<span className="text-base font-medium text-subtle">/{o.counts.gateways_total}</span></>}
          sub={o && (gwAll ? <StatusText tone="ok" icon={CircleCheck}>All connected</StatusText> : <StatusText tone="crit" icon={CircleX}>{o.counts.gateways_total - o.counts.gateways_online} offline</StatusText>)}
        />
        <KpiTile
          loading={loading}
          href="/devices"
          icon={TvMinimalPlay}
          label="Devices online"
          value={o && <>{o.counts.devices_online}<span className="text-base font-medium text-subtle">/{o.counts.devices_total}</span></>}
          sub={o && <KindCounts counts={o.counts.devices_by_kind} />}
        />
        <KpiTile
          loading={loading}
          href="/dns"
          icon={Globe}
          label="DNS lookups · 24 h"
          value={o && fmtCompact(o.dns.queries)}
          spark={toSpark(series.map((p) => p.queries))}
          sub={o && `≈ ${fmtNum(o.dns.queries / 1440)} a minute`}
        />
        <KpiTile
          loading={loading}
          href="/dns"
          icon={ShieldBan}
          label="Blocked · 24 h"
          value={o && fmtPct(o.dns.blocked, o.dns.queries)}
          spark={toSpark(blockedPct).map((v) => v / 2)}
          sub={o && `${fmtCompact(o.dns.blocked)} lookups · +${fmtCompact(o.dns.would_block)} watched`}
        />
        <KpiTile
          loading={loading}
          href="/privacy"
          icon={ScanEye}
          label="ACR attempts · 24 h"
          value={o && fmtCompact(acr)}
          sub={o && (topAcr && topAcr.acr_24h > 0 ? `Top: ${topAcr.name}` : 'None today')}
        />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-3">
        {loading ? (
          <Card className="p-4 lg:col-span-2"><Skeleton className="mb-3 h-4 w-48" /><Skeleton className="h-56" /></Card>
        ) : (
          <DnsChartCard className="lg:col-span-2" series={series} height={300} />
        )}
        <CategoryCard by={o?.dns.by_category} loading={loading} />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Site health" icon={Building2} subtitle="Gateway, devices and alerts per site" actions={<ButtonLink to="/sites" size="sm" variant="ghost">All sites</ButtonLink>} />
          <CardBody>
            {loading ? <SkeletonRows rows={3} /> : o!.sites.length ? (
              <ul className="divide-y divide-line">{o!.sites.map((s) => <SiteHealthRow key={s.id} site={s} />)}</ul>
            ) : (
              <EmptyState icon={Building2} title="No sites yet" action={<ButtonLink to="/sites" variant="primary">Add a site</ButtonLink>}>
                A site is one place — a home, a rental, an office — with its own gateway.
              </EmptyState>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Least private devices"
            icon={ShieldCheck}
            subtitle="Privacy grade from A (very private) to F (spying freely)"
            actions={<ButtonLink to="/privacy" size="sm" variant="ghost">Privacy center</ButtonLink>}
          />
          <CardBody>
            {loading ? <SkeletonRows rows={4} /> : o!.privacy_worst.length ? (
              <ul className="divide-y divide-line">{o!.privacy_worst.map((r) => <PrivacyRankRow key={r.device_id} row={r} />)}</ul>
            ) : (
              <p className="py-6 text-center text-sm text-muted">Privacy grades appear once devices are adopted and have been watched for a while.</p>
            )}
          </CardBody>
        </Card>
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Open alerts"
            icon={BellRing}
            subtitle={o ? (o.counts.alerts_open ? `${o.counts.alerts_open} need a look` : 'Nothing needs your attention') : ' '}
            actions={<ButtonLink to="/activity/alerts" size="sm" variant="ghost">All alerts</ButtonLink>}
          />
          <CardBody>
            {loading ? <SkeletonRows rows={3} /> : o!.alerts.length ? (
              <ul className="-mt-1 divide-y divide-line">{o!.alerts.map((a) => <AlertRow key={a.id} alert={a} onAck={ack} compact />)}</ul>
            ) : (
              <EmptyState icon={CircleCheck} title="All clear">Every gateway is connected and no device needs attention.</EmptyState>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recent activity" icon={Activity} subtitle="Commands, automations and changes" actions={<ButtonLink to="/activity/jobs" size="sm" variant="ghost">All activity</ButtonLink>} />
          <CardBody>
            {loading ? <SkeletonRows rows={4} /> : o!.recent_jobs.length ? (
              <ul className="-mt-1 divide-y divide-line">{o!.recent_jobs.map((j) => <JobRow key={j.id} job={j} />)}</ul>
            ) : (
              <p className="py-6 text-center text-sm text-muted">Nothing has happened yet. Commands you send and automations that run show up here.</p>
            )}
          </CardBody>
        </Card>
      </section>
    </>
  );
}

function CategoryCard({ by, loading }: { by?: Partial<Record<DnsCategory, number>>; loading: boolean }) {
  const entries = CATEGORY_ORDER.map((c) => [c, by?.[c] ?? 0] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  return (
    <ChartFrame
      title="What devices are contacting"
      subtitle="Lookups by category, last 24 h"
      legend={
        <>
          <LegendItem color="var(--color-s1)" label="Privacy risk" />
          <LegendItem color="var(--color-other)" label="Everyday traffic" />
        </>
      }
      table={
        <table className="w-full text-sm">
          <thead className="bg-surface-2"><tr><th className={th}>Category</th><th className={cn(th, 'text-right')}>Lookups</th><th className={cn(th, 'text-right')}>Share</th></tr></thead>
          <tbody className="divide-y divide-line tnum">
            {entries.map(([c, n]) => (
              <tr key={c}><td className={cn(td, 'py-1.5')}>{CATEGORY[c].label}</td><td className={cn(td, 'py-1.5 text-right')}>{fmtNum(n)}</td><td className={cn(td, 'py-1.5 text-right')}>{fmtPct(n, total)}</td></tr>
            ))}
          </tbody>
        </table>
      }
    >
      {loading ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          <BarList
            total={total}
            showPct
            items={entries.map(([c, n]) => ({ key: c, label: CATEGORY[c].label, value: n, emphasis: CATEGORY[c].privacy, title: `${CATEGORY[c].label}: ${fmtNum(n)} lookups — ${CATEGORY[c].help}` }))}
          />
          <p className="mt-3 text-xs text-muted">
            <Link to="/privacy" className="font-medium text-accent-fg hover:underline">What is ACR?</Link> It’s how smart TVs report what you watch.
          </p>
        </>
      )}
    </ChartFrame>
  );
}

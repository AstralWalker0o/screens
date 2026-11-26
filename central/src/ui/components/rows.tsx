import { Link } from 'react-router';
import { Check, ChevronRight, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { Alert, Job, PrivacyOverview, SiteSummary } from '../../shared/types';
import { fmtCompact, fmtPct } from '../lib/format';
import { GRADE, gradeFor, jobLabel, KIND, SITE_KIND, type Grade } from '../lib/labels';
import { Badge, Button, RelTime, StatusText } from './ui';
import { GatewayBadge, GradeBadge, JobStatusBadge, KindIcon, SeverityBadge } from './status';
import { Meter } from './charts';

export function AlertRow({ alert: a, onAck, compact }: { alert: Alert; onAck?: (a: Alert) => void; compact?: boolean }) {
  const href = a.device_id ? `/devices/${a.device_id}` : a.site_id ? `/sites/${a.site_id}` : undefined;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <SeverityBadge severity={a.severity} iconOnly />
      <div className="min-w-0 flex-1">
        {href ? (
          <Link to={href} className="text-sm leading-snug font-medium text-fg hover:underline">{a.title}</Link>
        ) : (
          <p className="text-sm leading-snug font-medium text-fg">{a.title}</p>
        )}
        {!compact && a.details && <p className="mt-0.5 text-xs text-muted">{a.details}</p>}
        <p className="mt-0.5 text-xs text-subtle">
          {[a.site_name, a.device_name && a.device_name !== a.title ? a.device_name : null].filter(Boolean).join(' · ')}
          {(a.site_name || a.device_name) && ' · '}
          <RelTime ts={a.at} />
          {a.acknowledged_at && <> · acknowledged <RelTime ts={a.acknowledged_at} /></>}
        </p>
      </div>
      {onAck && !a.acknowledged_at && (
        <Button size="sm" variant="secondary" icon={Check} onClick={() => onAck(a)} aria-label={`Acknowledge: ${a.title}`}>
          Ack
        </Button>
      )}
    </li>
  );
}

export function JobRow({ job: j }: { job: Job }) {
  const target = [j.device_name, j.site_name].filter(Boolean).join(' · ');
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fg">
          <span className="font-medium">{jobLabel(j.kind)}</span>
          {target && <span className="text-muted"> — {target}</span>}
        </p>
        <p className="mt-0.5 truncate text-xs text-subtle">
          {j.actor === 'automation' ? 'by an automation' : j.actor ? `by ${j.actor}` : ''} · <RelTime ts={j.created_at} />
        </p>
      </div>
      <JobStatusBadge status={j.status} />
    </li>
  );
}

export function PrivacyRankRow({ row, rank }: { row: PrivacyOverview['devices'][number]; rank?: number }) {
  const g = (row.grade as Grade) ?? gradeFor(row.score);
  return (
    <li>
      <Link to={`/devices/${row.device_id}/privacy`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
        {rank != null && <span className="w-4 shrink-0 text-right text-xs text-subtle tnum">{rank}</span>}
        <GradeBadge score={row.score} grade={row.grade} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
            <KindIcon kind={row.kind} className="size-3.5" />
            <span className="truncate">{row.name}</span>
          </p>
          <p className="truncate text-xs text-muted">
            {row.site_name} · {GRADE[g]?.label ?? ''}
            {row.acr_24h > 0 && <> · {fmtCompact(row.acr_24h)} ACR lookups</>}
          </p>
        </div>
        {row.bypass_suspected && (
          <StatusText tone="crit" icon={ShieldAlert} className="hidden sm:inline-flex">Bypass?</StatusText>
        )}
        <div className="hidden w-24 shrink-0 sm:block">
          <Meter value={row.score} tone={GRADE[g]?.tone ?? 'neutral'} label={`${row.name} privacy score ${row.score} of 100`} thin />
          <p className="mt-1 text-right text-[11px] text-subtle tnum">{row.score}/100</p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-subtle" aria-hidden />
      </Link>
    </li>
  );
}

export function SiteHealthRow({ site: s }: { site: SiteSummary }) {
  const offline = s.devices_total - s.devices_online;
  return (
    <li>
      <Link to={`/sites/${s.id}`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-medium text-fg">
            <span className="truncate">{s.name}</span>
            {s.kind === 'rental' && <Badge tone="accent">{SITE_KIND.rental.label}</Badge>}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <GatewayBadge status={s.gateway_status} />
            <span className="text-xs text-muted">{s.client_name}</span>
          </div>
        </div>
        <div className="hidden text-right sm:block">
          <p className="text-sm font-medium text-fg tnum">
            {s.devices_online}/{s.devices_total}
          </p>
          <p className="text-xs text-muted">devices up</p>
        </div>
        <div className="hidden w-20 text-right md:block">
          <p className="text-sm font-medium text-fg tnum">{s.dns_queries_24h ? fmtPct(s.dns_blocked_24h, s.dns_queries_24h) : '–'}</p>
          <p className="text-xs text-muted">blocked</p>
        </div>
        <div className="w-24 shrink-0 text-right">
          {s.alerts_open > 0 ? (
            <StatusText tone="warn" icon={TriangleAlert}>{s.alerts_open} alert{s.alerts_open === 1 ? '' : 's'}</StatusText>
          ) : offline > 0 ? (
            <span className="text-xs text-muted">{offline} offline</span>
          ) : (
            <StatusText tone="ok" icon={Check}>All good</StatusText>
          )}
        </div>
        <ChevronRight className="size-4 shrink-0 text-subtle" aria-hidden />
      </Link>
    </li>
  );
}

export function KindCounts({ counts }: { counts: Partial<Record<keyof typeof KIND, number>> }) {
  const entries = (Object.keys(KIND) as (keyof typeof KIND)[]).filter((k) => counts[k]);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
      {entries.map((k) => (
        <span key={k} className="inline-flex items-center gap-1" title={`${counts[k]} ${KIND[k].label}${counts[k] === 1 ? '' : 's'}`}>
          <KindIcon kind={k} className="size-3" />
          <span className="tnum">{counts[k]}</span>
        </span>
      ))}
    </span>
  );
}

import { useState } from 'react';
import { Link } from 'react-router';
import { Bot, FlaskConical, History, ListChecks, User, X } from 'lucide-react';
import type { Job } from '../../../shared/types';
import type { UpdateRollout, UpdatesOverview } from '../../../shared/updates';
import { api } from '../../api';
import { act } from '../../lib/query';
import { actorLabel } from '../../lib/labels';
import { JobStatusBadge } from '../../components/status';
import { Badge, Button, Card, CardHeader, EmptyState, RelTime, SkeletonRows, StatusText, cn } from '../../components/ui';
import { BOX_STEP, ROLLOUT } from './meta';

const isActive = (r: UpdateRollout) => r.status === 'canary' || r.status === 'rolling';

export function ActivityTab({ o }: { o?: UpdatesOverview }) {
  if (!o) return <SkeletonRows rows={5} />;
  const active = o.rollouts.filter(isActive);
  const past = o.rollouts.filter((r) => !isActive(r));
  return (
    <div className="space-y-5">
      <section aria-labelledby="upd-now">
        <h2 id="upd-now" className="mb-2 text-sm font-semibold text-fg">In progress</h2>
        {active.length ? (
          <ul className="space-y-3">{active.map((r) => <li key={r.id}><RolloutCard r={r} /></li>)}</ul>
        ) : (
          <Card><p className="px-4 py-5 text-sm text-muted">Nothing is updating right now. Automatic updates run in each site’s maintenance window.</p></Card>
        )}
      </section>
      <section aria-labelledby="upd-past">
        <h2 id="upd-past" className="mb-2 text-sm font-semibold text-fg">Recent rollouts</h2>
        {past.length ? (
          <ul className="space-y-3">{past.slice(0, 12).map((r) => <li key={r.id}><RolloutCard r={r} /></li>)}</ul>
        ) : (
          <Card><EmptyState icon={History} title="No rollouts yet">Each time Screens updates an app at a site, the steps and results show up here.</EmptyState></Card>
        )}
      </section>
      <Card>
        <CardHeader title="Update jobs" icon={ListChecks} subtitle="One per box: what was installed, and how it went" actions={<Link to="/activity/jobs" className="text-xs font-medium text-accent-fg hover:underline">All jobs</Link>} />
        {o.jobs.length ? (
          <ul className="divide-y divide-line border-t border-line">{o.jobs.map((j) => <JobLine key={j.id} j={j} />)}</ul>
        ) : (
          <p className="border-t border-line px-4 py-5 text-sm text-muted">No app updates have run yet.</p>
        )}
      </Card>
    </div>
  );
}

function RolloutCard({ r }: { r: UpdateRollout }) {
  const [busy, setBusy] = useState(false);
  const meta = ROLLOUT[r.status];
  const n = r.devices.length;
  const done = r.devices.filter((d) => d.status === 'ok').length;
  const counts = (['ok', 'failed', 'skipped'] as const).map((s) => r.devices.filter((d) => d.status === s).length);
  const cancel = async () => {
    setBusy(true);
    await act(() => api.updates.cancel(r.id), { success: 'Cancelled. A box that is installing right now finishes first.', invalidate: ['updates'] });
    setBusy(false);
  };
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">
            {r.label ?? r.package} <span className="font-normal text-muted tnum">→ {r.version_name ?? r.version_code}</span>
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span>{r.site_name ?? 'Site'}</span>·
            {r.trigger === 'auto' ? <StatusText tone="neutral" icon={Bot}>Automatic</StatusText> : <StatusText tone="neutral" icon={User}>{actorLabel(r.actor) || 'Started by hand'}</StatusText>}·
            <RelTime ts={r.created_at} />
          </p>
        </div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {isActive(r) && <Button size="sm" variant="ghost" icon={X} loading={busy} onClick={cancel}>Cancel</Button>}
      </div>
      <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${done} of ${n} boxes updated`}>
        <span className="bg-ok" style={{ width: `${(counts[0] / n) * 100}%` }} />
        <span className="bg-crit" style={{ width: `${(counts[1] / n) * 100}%` }} />
        <span className="bg-subtle/50" style={{ width: `${(counts[2] / n) * 100}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted">{r.detail ?? `${done} of ${n} updated`}</p>
      <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
        {r.devices.map((d) => {
          const s = BOX_STEP[d.status];
          return (
            <li key={d.device_id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
              <Link to={`/devices/${d.device_id}/apps`} className="min-w-0 flex-1 truncate text-sm text-fg hover:underline">{d.name}</Link>
              {d.canary && <Badge tone="accent" icon={FlaskConical} title="Updated first and checked before the other boxes">Canary</Badge>}
              <StatusText tone={s.tone} icon={s.icon} className={cn(d.status === 'installing' || d.status === 'verifying' ? '[&>svg]:animate-pulse-soft' : undefined)}>{s.label}</StatusText>
              {d.detail && <p className={cn('w-full text-xs', d.status === 'failed' ? 'text-crit-fg' : 'text-muted')}>{d.detail}</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function JobLine({ j }: { j: Job }) {
  const p = j.params as { label?: string; package?: string; from?: string | null; to?: string; canary?: boolean };
  const detail = (j.result as { detail?: string } | null)?.detail;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">
          <span className="font-medium">{p.label ?? p.package}</span>
          <span className="text-muted tnum"> {p.from ? `${p.from} ` : ''}→ {p.to}</span>
          {p.canary && <Badge tone="accent" className="ml-2">Canary</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-subtle">
          {[j.device_name, j.site_name].filter(Boolean).join(' · ')}{j.actor ? ` · by ${actorLabel(j.actor)}` : ''} · <RelTime ts={j.created_at} />
        </p>
        {detail && <p className={cn('mt-0.5 text-xs', j.status === 'error' ? 'text-crit-fg' : 'text-muted')}>{detail}</p>}
      </div>
      <JobStatusBadge status={j.status} />
    </li>
  );
}

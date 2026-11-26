import { Fragment, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { BellRing, ListTodo, ScrollText, ChevronRight, CheckCheck, CircleCheck, CircleX, Bot, User } from 'lucide-react';
import type { Alert, Job } from '../../shared/types';
import { api } from '../api';
import { act, setQueryData, useQuery } from '../lib/query';
import { absTime, fmtDuration } from '../lib/format';
import { actorLabel, jobLabel } from '../lib/labels';
import { AlertRow } from '../components/rows';
import { JobStatusBadge } from '../components/status';
import { Button, Card, EmptyState, PageHeader, RelTime, SkeletonRows, StatusText, TabNav, TableWrap, cn, td, th } from '../components/ui';
import { Segmented, SearchInput } from '../components/forms';

export default function Activity() {
  const { tab = 'alerts' } = useParams();
  const open = useQuery('alerts:open', () => api.alerts(true), { refreshMs: 30_000 });
  return (
    <>
      <PageHeader title="Activity" subtitle="Alerts that need a look, everything Screens has done, and who changed what." />
      <TabNav
        base="/activity"
        active={tab}
        tabs={[
          { id: 'alerts', label: 'Alerts', icon: BellRing, count: open.data?.length },
          { id: 'jobs', label: 'Jobs', icon: ListTodo },
          { id: 'audit', label: 'Audit log', icon: ScrollText },
        ]}
      />
      {tab === 'jobs' ? <JobsTab /> : tab === 'audit' ? <AuditTab /> : <AlertsTab />}
    </>
  );
}

function AlertsTab() {
  const [view, setView] = useState<'open' | 'acked' | 'all'>('open');
  const all = useQuery('alerts:all', () => api.alerts(false), { refreshMs: 30_000 });
  const list = useMemo(() => {
    const a = all.data ?? [];
    if (view === 'open') return a.filter((x) => !x.acknowledged_at && !x.resolved_at);
    if (view === 'acked') return a.filter((x) => x.acknowledged_at || x.resolved_at);
    return a;
  }, [all.data, view]);
  const ack = async (a: Alert) => {
    setQueryData<Alert[]>('alerts:all', (old) => old?.map((x) => (x.id === a.id ? { ...x, acknowledged_at: Date.now() } : x)));
    await act(() => api.ackAlert(a.id), { invalidate: ['alerts', 'overview'] });
  };
  const ackAll = async () => {
    const open = (all.data ?? []).filter((x) => !x.acknowledged_at && !x.resolved_at);
    setQueryData<Alert[]>('alerts:all', (old) => old?.map((x) => (open.some((o) => o.id === x.id) ? { ...x, acknowledged_at: Date.now() } : x)));
    await act(() => Promise.all(open.map((a) => api.ackAlert(a.id))), { success: `Acknowledged ${open.length} alert${open.length === 1 ? '' : 's'}`, invalidate: ['alerts', 'overview'] });
  };
  const openCount = (all.data ?? []).filter((x) => !x.acknowledged_at && !x.resolved_at).length;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented<'open' | 'acked' | 'all'> ariaLabel="Which alerts" value={view} onChange={setView} options={[{ value: 'open', label: `Open (${openCount})` }, { value: 'acked', label: 'Acknowledged' }, { value: 'all', label: 'All' }]} />
        {view === 'open' && openCount > 1 && <Button size="sm" icon={CheckCheck} className="ml-auto" onClick={ackAll}>Acknowledge all</Button>}
      </div>
      <Card>
        {all.loading ? (
          <div className="p-4"><SkeletonRows rows={5} /></div>
        ) : list.length === 0 ? (
          <EmptyState icon={CircleCheck} title={view === 'open' ? 'All clear' : 'Nothing here'}>{view === 'open' ? 'No alerts need your attention.' : 'Acknowledged alerts show up here.'}</EmptyState>
        ) : (
          <ul className="divide-y divide-line px-4">{list.map((a) => <AlertRow key={a.id} alert={a} onAck={ack} />)}</ul>
        )}
      </Card>
      <p className="mt-2 text-xs text-muted">Acknowledging hides an alert from the bell. If the problem continues, Screens raises a new one.</p>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  if (value == null || (typeof value === 'object' && !Object.keys(value as object).length)) return <p className="text-xs text-subtle">–</p>;
  return <pre className="max-h-64 overflow-auto rounded-md border border-line bg-surface-2 p-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

function JobResult({ job: j }: { job: Job }) {
  const results = (j.result as { results?: { device_id: string; ok: boolean; detail?: string; error?: string; name?: string }[] } | null)?.results;
  if (Array.isArray(results)) {
    return (
      <ul className="space-y-1">
        {results.map((r) => (
          <li key={r.device_id} className="flex items-start gap-2 text-sm">
            {r.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-fg" aria-label="OK" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-crit-fg" aria-label="Failed" />}
            <span><span className="font-medium text-fg">{r.name ?? r.device_id}</span> <span className="text-muted">— {r.detail ?? r.error ?? (r.ok ? 'done' : 'failed')}</span></span>
          </li>
        ))}
      </ul>
    );
  }
  const url = (j.result as { url?: string } | null)?.url;
  if (url && url.startsWith('data:image')) return <img src={url} alt="Screenshot result" className="max-h-48 rounded-md border border-line" />;
  return <JsonBlock value={j.result} />;
}

function JobsTab() {
  const q = useQuery('jobs', () => api.jobs({ limit: 200 }), { refreshMs: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState<'all' | Job['status']>('all');
  const [search, setSearch] = useState('');
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((j) => (status === 'all' || j.status === status) && (!s || [jobLabel(j.kind, j.params), j.device_name, j.site_name, j.actor].some((v) => v?.toLowerCase().includes(s))));
  }, [q.data, status, search]);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search jobs" className="w-full sm:w-60" />
        <Segmented<'all' | Job['status']> ariaLabel="Status" size="sm" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'running', label: 'Running' }, { value: 'error', label: 'Failed' }, { value: 'ok', label: 'Done' }]} />
      </div>
      <Card>
        {q.loading ? (
          <div className="p-4"><SkeletonRows rows={6} /></div>
        ) : list.length === 0 ? (
          <EmptyState icon={ListTodo} title="No jobs">Commands you send and automations that run are recorded here.</EmptyState>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line bg-surface-2/60">
                <tr><th className={cn(th, 'w-8')} /><th className={th}>What</th><th className={th}>Where</th><th className={th}>Who</th><th className={th}>When</th><th className={th}>Took</th><th className={th}>Status</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((j) => {
                  const expanded = open === j.id;
                  return (
                    <Fragment key={j.id}>
                      <tr className={cn('cursor-pointer hover:bg-surface-2/50', expanded && 'bg-surface-2/50')} onClick={() => setOpen(expanded ? null : j.id)}>
                        <td className={td}>
                          <button type="button" aria-expanded={expanded} aria-label={expanded ? 'Hide details' : 'Show details'} onClick={(e) => { e.stopPropagation(); setOpen(expanded ? null : j.id); }} className="rounded p-0.5 text-muted hover:text-fg">
                            <ChevronRight className={cn('size-4 transition-transform', expanded && 'rotate-90')} />
                          </button>
                        </td>
                        <td className={cn(td, 'font-medium text-fg')}>{jobLabel(j.kind, j.params)}</td>
                        <td className={cn(td, 'text-muted')}>{[j.device_name, j.site_name].filter(Boolean).join(' · ') || '–'}</td>
                        <td className={cn(td, 'text-muted')}>
                          <span className="inline-flex max-w-48 items-center gap-1 truncate" title={j.actor ?? ''}>{j.actor?.startsWith('automation') ? <Bot className="size-3.5 shrink-0" aria-hidden /> : <User className="size-3.5 shrink-0" aria-hidden />}{j.actor ? actorLabel(j.actor).replace(/^an automation$/, 'Automation') : '–'}</span>
                        </td>
                        <td className={cn(td, 'text-xs whitespace-nowrap text-muted')}><RelTime ts={j.created_at} /></td>
                        <td className={cn(td, 'text-xs text-muted tnum')}>{j.finished_at ? fmtDuration((j.finished_at - j.created_at) / 1000) : '–'}</td>
                        <td className={td}><JobStatusBadge status={j.status} /></td>
                      </tr>
                      {expanded && (
                        <tr className="bg-surface-2/30">
                          <td />
                          <td colSpan={6} className="px-3 pt-1 pb-4">
                            <div className="grid gap-4 md:grid-cols-2">
                              <div><p className="mb-1 text-xs font-medium text-muted">Result</p><JobResult job={j} /></div>
                              <div>
                                <p className="mb-1 text-xs font-medium text-muted">Details</p>
                                <JsonBlock value={j.params} />
                                <p className="mt-2 text-xs text-subtle">Started {absTime(j.created_at)}{j.finished_at ? ` · finished ${absTime(j.finished_at)}` : ''} · id <span className="font-mono">{j.id}</span></p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

const AUDIT_LABELS: Record<string, string> = {
  'device.command': 'Sent a command', 'device.adopt': 'Adopted a device', 'device.update': 'Changed a device', 'device.delete': 'Removed a device',
  'site.create': 'Created a site', 'site.update': 'Changed a site', 'site.delete': 'Deleted a site', 'site.guest_reset': 'Guest reset',
  'dns.rebuild': 'Rebuilt DNS policies', 'dns.rule.add': 'Added a DNS rule', 'dns.rule.delete': 'Deleted a DNS rule',
  'gateway.update': 'Updated a gateway', 'gateway.restart': 'Restarted a gateway', 'gateway.revoke': 'Revoked a gateway', 'gateway.enroll': 'Created a gateway install command',
  'apk.upload': 'Uploaded an app', 'client.create': 'Created a client', 'client.delete': 'Deleted a client', 'mdns.update': 'Changed mDNS reflector',
  'settings.update': 'Changed settings', 'automation.create': 'Created an automation',
};

function AuditTab() {
  const q = useQuery('audit', () => api.audit({ limit: 200 }));
  const [search, setSearch] = useState('');
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((e) => !s || [e.actor, e.action, AUDIT_LABELS[e.action], e.target_id, JSON.stringify(e.details ?? '')].some((v) => v?.toLowerCase().includes(s)));
  }, [q.data, search]);
  return (
    <div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search the audit log" className="mb-3 w-full sm:w-72" />
      <Card>
        {q.loading ? (
          <div className="p-4"><SkeletonRows rows={8} /></div>
        ) : list.length === 0 ? (
          <EmptyState icon={ScrollText} title="Nothing logged yet">Every change made in Screens — by you or an automation — is recorded here.</EmptyState>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line bg-surface-2/60"><tr><th className={th}>When</th><th className={th}>Who</th><th className={th}>What</th><th className={th}>Details</th></tr></thead>
              <tbody className="divide-y divide-line">
                {list.map((e) => (
                  <tr key={e.id}>
                    <td className={cn(td, 'text-xs whitespace-nowrap text-muted')}><RelTime ts={e.at} /></td>
                    <td className={cn(td, 'max-w-48 truncate text-muted')} title={e.actor}>{e.actor.startsWith('automation:') ? <StatusText tone="neutral" icon={Bot}>{e.actor.slice(11)}</StatusText> : e.actor}</td>
                    <td className={td}>
                      <span className="text-fg">{AUDIT_LABELS[e.action] ?? e.action}</span>
                      {e.target_id && <span className="ml-1.5 font-mono text-[11.5px] text-muted">{e.target_id}</span>}
                    </td>
                    <td className={cn(td, 'max-w-md truncate font-mono text-[11.5px] text-muted')} title={e.details ? JSON.stringify(e.details) : undefined}>
                      {e.details ? Object.entries(e.details as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

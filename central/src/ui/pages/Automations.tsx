import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Workflow, Plus, Play, Ellipsis, Pencil, Trash2, CalendarClock, Zap, CircleCheck, CircleX, Moon, Sparkles, BellRing } from 'lucide-react';
import type { Automation } from '../../shared/types';
import { api } from '../api';
import { act, setQueryData, useQuery } from '../lib/query';
import { describeAction, describeTarget, describeTrigger, TEMPLATE_INFO } from '../lib/automation';
import { Button, Card, EmptyState, IconButton, PageHeader, RelTime, SkeletonRows, StatusText } from '../components/ui';
import { Toggle } from '../components/forms';
import { ConfirmDialog, Menu } from '../components/overlay';

const TEMPLATE_ICON = { midnight: Moon, checkout: Sparkles, offline: BellRing } as const;

export default function Automations() {
  const q = useQuery('automations', api.automations.list);
  const sites = useQuery('sites', () => api.sites.list());
  const devices = useQuery('devices', () => api.devices.list());
  const [running, setRunning] = useState<string | null>(null);
  const [del, setDel] = useState<Automation | null>(null);
  const navigate = useNavigate();

  const toggle = async (a: Automation, enabled: boolean) => {
    setQueryData<Automation[]>('automations', (old) => old?.map((x) => (x.id === a.id ? { ...x, enabled } : x)));
    await act(() => api.automations.update(a.id, { enabled }), { success: enabled ? `“${a.name}” is on` : `“${a.name}” is paused`, invalidate: ['automations'] });
  };
  const run = async (a: Automation) => {
    setRunning(a.id);
    await act(() => api.automations.run(a.id), { success: (r) => `Ran “${a.name}”${r.jobs.length ? ` — ${r.jobs.length} job${r.jobs.length === 1 ? '' : 's'} started` : ''}`, invalidate: ['automations', 'jobs', 'overview'] });
    setRunning(null);
  };

  return (
    <>
      <PageHeader
        title="Automations"
        subtitle="Things Screens does by itself — on a schedule, or when something happens."
        actions={<Button variant="primary" icon={Plus} onClick={() => navigate('/automations/new')}>New automation</Button>}
      />

      <section aria-label="Start from a template" className="mb-5">
        <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Start from a template</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {TEMPLATE_INFO.map((t) => {
            const Icon = TEMPLATE_ICON[t.id as keyof typeof TEMPLATE_ICON];
            return (
              <Link key={t.id} to={`/automations/new?template=${t.id}`} className="group flex items-start gap-3 rounded-xl border border-dashed border-line-strong bg-surface/50 p-3.5 transition-colors hover:border-accent hover:bg-accent-soft/40">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-fg"><Icon className="size-4" aria-hidden /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-fg">{t.title}</span>
                  <span className="mt-0.5 block text-xs text-muted">{t.blurb}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <Card>
        {q.loading ? (
          <div className="p-4"><SkeletonRows rows={4} /></div>
        ) : !q.data?.length ? (
          <EmptyState icon={Workflow} title="No automations yet" action={<Button variant="primary" icon={Plus} onClick={() => navigate('/automations/new')}>New automation</Button>}>
            Pick a template above or build your own: choose when it runs, which devices it affects, and what it does.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.map((a) => {
              const failed = a.last_status && a.last_status !== 'ok';
              return (
                <li key={a.id} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5 sm:flex-nowrap">
                  <div className="pt-0.5"><Toggle checked={a.enabled} onChange={(v) => toggle(a, v)} ariaLabel={`${a.enabled ? 'Pause' : 'Turn on'} ${a.name}`} /></div>
                  <div className="min-w-0 flex-1">
                    <Link to={`/automations/${a.id}`} className="text-sm font-semibold text-fg hover:underline">{a.name}</Link>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                      {a.trigger.type === 'schedule' ? <CalendarClock className="size-3.5 shrink-0" aria-hidden /> : <Zap className="size-3.5 shrink-0" aria-hidden />}
                      <span>{describeTrigger(a.trigger)} · {describeTarget(a.target, sites.data ?? [], devices.data ?? [])}</span>
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-fg">
                      {a.actions.map((x, i) => (
                        <span key={i} className="inline-flex items-center gap-1">
                          {i > 0 && <span className="text-subtle" aria-hidden>→</span>}
                          <span className="rounded-md bg-surface-2 px-1.5 py-0.5">{describeAction(x)}</span>
                        </span>
                      ))}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 max-sm:w-full max-sm:justify-between max-sm:pl-12">
                    <div className="text-right text-xs">
                      {a.last_run ? (
                        <>
                          {failed ? <StatusText tone="crit" icon={CircleX} title={a.last_status ?? ''}>Had problems</StatusText> : <StatusText tone="ok" icon={CircleCheck}>Ran OK</StatusText>}
                          <p className="text-muted"><RelTime ts={a.last_run} /></p>
                        </>
                      ) : (
                        <span className="text-muted">Hasn’t run yet</span>
                      )}
                    </div>
                    <Button size="sm" icon={Play} loading={running === a.id} onClick={() => run(a)}>Run now</Button>
                    <Menu
                      trigger={({ toggle: t, ref }) => <IconButton ref={ref} icon={Ellipsis} label={`More actions for ${a.name}`} onClick={t} size="sm" />}
                      items={[
                        { label: 'Edit', icon: Pencil, onSelect: () => navigate(`/automations/${a.id}`) },
                        { label: 'Delete…', icon: Trash2, danger: true, onSelect: () => setDel(a) },
                      ]}
                    />
                  </div>
                  {failed && <p className="w-full pl-14 text-xs text-crit-fg sm:-mt-1">{a.last_status?.replace(/^error:\s*/, 'Last run: ')}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        danger
        title={`Delete “${del?.name}”?`}
        confirmLabel="Delete automation"
        onConfirm={async () => {
          if (!del) return;
          const ok = await act(() => api.automations.remove(del.id), { success: 'Automation deleted', invalidate: ['automations'] });
          if (ok) setDel(null);
        }}
      >
        <p>It stops running straight away. Past runs stay in Activity.</p>
      </ConfirmDialog>
    </>
  );
}

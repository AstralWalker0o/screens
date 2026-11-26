import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Workflow, CalendarClock, Zap, Target, ListOrdered, Plus, Trash2, ArrowUp, ArrowDown, Save, Play, ChevronDown, Terminal, Sparkles,
  PackageCheck, ShieldCheck, BellRing, Timer, Check,
} from 'lucide-react';
import type { AutomationAction, AutomationEvent, AutomationTrigger, DeviceKind, DnsMode, Severity } from '../../shared/types';
import { api } from '../api';
import { act, useQuery } from '../lib/query';
import { blankDraft, describeAction, describeTarget, describeTrigger, matchDevices, TEMPLATES, type Draft } from '../lib/automation';
import { buildCron, cronError, DAY_NAMES, parseCron, type CronMode } from '../lib/cron';
import { allTimezones, ALL_KEYS, COMMANDS, DNS_MODE, DNS_MODES, EVENTS, KEY_LABELS, KIND, KIND_ORDER, SEVERITY } from '../lib/labels';
import { Badge, Button, Callout, Card, CardBody, CardHeader, IconButton, PageHeader, SkeletonRows, cn } from '../components/ui';
import { ChipsInput, Field, Input, SearchInput, Segmented, Select, Toggle } from '../components/forms';
import { ConfirmDialog, Menu } from '../components/overlay';
import { KindIcon } from '../components/status';

const ACTION_TYPES: { type: AutomationAction['type']; label: string; icon: typeof Terminal; help: string }[] = [
  { type: 'command', label: 'Send a command', icon: Terminal, help: 'Power, keys, volume, open an app…' },
  { type: 'guest_reset', label: 'Guest reset', icon: Sparkles, help: 'Clear guest apps and go home' },
  { type: 'enforce_apps', label: 'Apply app policies', icon: PackageCheck, help: 'Install required apps, remove banned ones' },
  { type: 'dns_mode', label: 'Set DNS mode', icon: ShieldCheck, help: 'Enforce, monitor, off or bypass' },
  { type: 'alert', label: 'Raise an alert', icon: BellRing, help: 'Shows in the bell and Activity' },
  { type: 'delay', label: 'Wait', icon: Timer, help: 'Pause before the next step' },
];

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function newAction(type: AutomationAction['type']): AutomationAction {
  switch (type) {
    case 'command': return { type, command: 'power_off' };
    case 'dns_mode': return { type, mode: 'enforce' };
    case 'alert': return { type, severity: 'info', title: '' };
    case 'delay': return { type, seconds: 60 };
    default: return { type } as AutomationAction;
  }
}

export default function AutomationEditor() {
  const { id = 'new' } = useParams();
  const [params] = useSearchParams();
  const isNew = id === 'new';
  const list = useQuery('automations', api.automations.list);
  const sites = useQuery('sites', () => api.sites.list());
  const devices = useQuery('devices', () => api.devices.list());
  const navigate = useNavigate();
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [del, setDel] = useState(false);

  useEffect(() => {
    if (d) return;
    if (isNew) {
      const t = params.get('template');
      const site = params.get('site') ?? undefined;
      const rental = sites.data?.find((s) => s.kind === 'rental')?.id;
      if (t && TEMPLATES[t]) {
        if (t === 'checkout' && !site && !sites.data) return; // wait for sites to pick the rental
        setD(TEMPLATES[t]({ siteId: site ?? rental }));
      } else setD(blankDraft());
    } else if (list.data) {
      const a = list.data.find((x) => x.id === id);
      if (a) setD({ name: a.name, enabled: a.enabled, scope_type: a.scope_type, scope_id: a.scope_id, trigger: a.trigger, target: a.target, actions: a.actions });
    }
  }, [isNew, id, list.data, sites.data, params, d]);

  const existing = list.data?.find((x) => x.id === id);
  if (!isNew && list.data && !existing) {
    return <Callout kind="warn" title="Automation not found" action={<Button onClick={() => navigate('/automations')}>Back to automations</Button>}>It may have been deleted.</Callout>;
  }
  if (!d) return <SkeletonRows rows={10} />;

  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const matched = matchDevices(d.target, devices.data ?? []);
  const cronErr = d.trigger.type === 'schedule' ? cronError(d.trigger.cron) : null;
  const actionErr = d.actions.find((a) => (a.type === 'alert' && !a.title.trim()) || (a.type === 'delay' && !(a.seconds > 0)));
  const valid = d.name.trim() && !cronErr && d.actions.length > 0 && !actionErr;

  const save = async () => {
    const site_ids = d.target.site_ids ?? [];
    const body: Draft = { ...d, name: d.name.trim(), scope_type: site_ids.length === 1 ? 'site' : 'global', scope_id: site_ids.length === 1 ? site_ids[0] : null };
    setBusy('save');
    const r = isNew
      ? await act(() => api.automations.create(body), { success: `Created “${body.name}”`, invalidate: ['automations'] })
      : await act(() => api.automations.update(id, body), { success: 'Automation saved', invalidate: ['automations'] });
    setBusy(null);
    if (r) navigate('/automations');
  };

  return (
    <>
      <PageHeader
        back={{ to: '/automations', label: 'Automations' }}
        icon={Workflow}
        title={isNew ? 'New automation' : d.name || 'Automation'}
        subtitle={d.actions.length ? `${describeTrigger(d.trigger)}: ${d.actions.map((a) => lowerFirst(describeAction(a))).join(', then ')} — ${describeTarget(d.target, sites.data ?? [], devices.data ?? [])}.` : 'Choose when it runs, which devices, and what it does.'}
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card>
            <CardBody className="grid gap-4 pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label="Name" htmlFor="au-name"><Input id="au-name" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. TVs off at bedtime" autoFocus={isNew && !params.get('template')} /></Field>
              <Toggle checked={d.enabled} onChange={(v) => set({ enabled: v })} label="On" className="sm:pb-1.5" />
            </CardBody>
          </Card>
          <TriggerCard trigger={d.trigger} onChange={(trigger) => set({ trigger })} />
          <TargetCard draft={d} onChange={(target) => set({ target })} sites={sites.data ?? []} devices={devices.data ?? []} matchedCount={matched.length} />
          <ActionsCard actions={d.actions} onChange={(actions) => set({ actions })} />
        </div>
        <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <Card>
            <CardHeader title="Summary" />
            <CardBody className="space-y-3 text-sm">
              <p className="flex gap-2"><CalendarClock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span className="text-fg">{describeTrigger(d.trigger)}</span></p>
              <p className="flex gap-2"><Target className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span className="text-fg">{upperFirst(describeTarget(d.target, sites.data ?? [], devices.data ?? []))}<span className="block text-xs text-muted">{matched.length} device{matched.length === 1 ? '' : 's'} right now</span></span></p>
              <ol className="space-y-1 pl-6">
                {d.actions.map((a, i) => <li key={i} className="list-decimal text-fg">{describeAction(a)}</li>)}
                {!d.actions.length && <li className="list-none text-muted">No actions yet</li>}
              </ol>
              {cronErr && <p className="text-xs text-crit-fg">{cronErr}</p>}
              {!d.actions.length && <p className="text-xs text-warn-fg">Add at least one action.</p>}
              {actionErr && <p className="text-xs text-warn-fg">Finish filling in every action.</p>}
            </CardBody>
            <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
              <Button variant="primary" icon={Save} loading={busy === 'save'} disabled={!valid} onClick={save} className="flex-1">{isNew ? 'Create automation' : 'Save changes'}</Button>
              {!isNew && (
                <Button icon={Play} loading={busy === 'run'} onClick={async () => { setBusy('run'); await act(() => api.automations.run(id), { success: 'Running now', invalidate: ['automations', 'jobs'] }); setBusy(null); }}>Run now</Button>
              )}
              {!isNew && <Button variant="danger-ghost" icon={Trash2} onClick={() => setDel(true)}>Delete</Button>}
            </div>
          </Card>
          <Callout kind="tip">Automations that turn things off or reset them run even if nobody is watching — test with <strong className="text-fg">Run now</strong> first.</Callout>
        </div>
      </div>
      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        danger
        title={`Delete “${d.name}”?`}
        confirmLabel="Delete"
        onConfirm={async () => {
          const ok = await act(() => api.automations.remove(id), { success: 'Automation deleted', invalidate: ['automations'] });
          if (ok) navigate('/automations');
        }}
      >
        <p>It stops running straight away.</p>
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------

function TriggerCard({ trigger, onChange }: { trigger: AutomationTrigger; onChange: (t: AutomationTrigger) => void }) {
  const [lastSchedule, setLastSchedule] = useState<AutomationTrigger>(trigger.type === 'schedule' ? trigger : { type: 'schedule', cron: '0 0 * * *', timezone: 'Australia/Sydney' });
  const [lastEvent, setLastEvent] = useState<AutomationTrigger>(trigger.type === 'event' ? trigger : { type: 'event', event: 'device.offline' });
  const parts = trigger.type === 'schedule' ? parseCron(trigger.cron) : null;
  const [mode, setMode] = useState<CronMode>(parts?.mode ?? 'daily');
  const zones = useMemo(allTimezones, []);

  const setSchedule = (p: { mode?: CronMode; time?: string; days?: number[]; cron?: string; timezone?: string }) => {
    if (trigger.type !== 'schedule') return;
    const cur = parseCron(trigger.cron);
    const m = p.mode ?? mode;
    let cron = p.cron ?? trigger.cron;
    if (m !== 'custom' && !p.cron) cron = buildCron({ mode: m, time: p.time ?? cur.time, days: p.days ?? (m === 'days' && cur.mode !== 'days' ? [1, 3, 5] : cur.days) });
    const next: AutomationTrigger = { type: 'schedule', cron, timezone: p.timezone ?? trigger.timezone };
    setLastSchedule(next);
    onChange(next);
  };

  return (
    <Card>
      <CardHeader title="When" icon={CalendarClock} />
      <CardBody className="space-y-4">
        <Segmented<'schedule' | 'event'>
          ariaLabel="Trigger type"
          value={trigger.type}
          onChange={(t) => onChange(t === 'schedule' ? lastSchedule : lastEvent)}
          options={[{ value: 'schedule', label: 'On a schedule', icon: CalendarClock }, { value: 'event', label: 'When something happens', icon: Zap }]}
        />
        {trigger.type === 'schedule' ? (
          <div className="space-y-4">
            <Field label="Repeat">
              <Segmented<CronMode>
                ariaLabel="Repeat"
                size="sm"
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  if (m !== 'custom') setSchedule({ mode: m });
                }}
                options={[
                  { value: 'daily', label: 'Every day' },
                  { value: 'weekdays', label: 'Weekdays' },
                  { value: 'weekends', label: 'Weekends' },
                  { value: 'days', label: 'Pick days' },
                  { value: 'custom', label: 'Custom' },
                ]}
              />
            </Field>
            {mode === 'days' && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
                {DAY_NAMES.map((name, i) => {
                  const on = parseCron(trigger.cron).days.includes(i);
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        const cur = parseCron(trigger.cron).days;
                        const days = on ? cur.filter((x) => x !== i) : [...cur, i];
                        if (days.length) setSchedule({ days });
                      }}
                      className={cn('h-8 w-12 rounded-lg border text-sm font-medium transition-colors', on ? 'border-accent bg-accent text-on-accent' : 'border-line-strong text-muted hover:text-fg')}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            )}
            {mode === 'custom' ? (
              <Field label="Cron schedule" htmlFor="au-cron" error={cronError(trigger.cron)} hint={<>Five parts: minute, hour, day of month, month, day of week. <span className="font-mono">30 22 * * 5</span> means 10:30 pm every Friday.</>}>
                <Input id="au-cron" mono value={trigger.cron} onChange={(e) => setSchedule({ cron: e.target.value })} className="sm:w-60" />
              </Field>
            ) : (
              <Field label="At" htmlFor="au-time">
                <Input id="au-time" type="time" value={parseCron(trigger.cron).time} onChange={(e) => e.target.value && setSchedule({ time: e.target.value })} className="w-36" />
              </Field>
            )}
            <Field label="Time zone" htmlFor="au-tz">
              <Select id="au-tz" value={trigger.timezone ?? 'Australia/Sydney'} onChange={(e) => setSchedule({ timezone: e.target.value })} className="sm:w-72">
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </Select>
            </Field>
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg">{describeTrigger(trigger)}</p>
          </div>
        ) : (
          <div role="radiogroup" aria-label="Event" className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(EVENTS) as AutomationEvent[]).map((e) => {
              const on = trigger.event === e;
              return (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    const t: AutomationTrigger = { type: 'event', event: e };
                    setLastEvent(t);
                    onChange(t);
                  }}
                  className={cn('flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors', on ? 'border-accent bg-accent-soft/60 ring-1 ring-accent' : 'border-line hover:border-line-strong')}
                >
                  <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-accent bg-accent text-white' : 'border-line-strong')}>{on && <Check className="size-3" strokeWidth={3} aria-hidden />}</span>
                  <span>
                    <span className="block text-sm font-medium text-fg">{EVENTS[e].label}</span>
                    <span className="mt-0.5 block text-xs text-muted">{EVENTS[e].help}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function TargetCard({ draft, onChange, sites, devices, matchedCount }: {
  draft: Draft; onChange: (t: Draft['target']) => void; sites: { id: string; name: string }[]; devices: import('../../shared/types').Device[]; matchedCount: number;
}) {
  const t = draft.target;
  const [showDevices, setShowDevices] = useState(!!t.device_ids?.length);
  const [search, setSearch] = useState('');
  const tags = Array.from(new Set(devices.flatMap((x) => x.tags))).sort();
  const toggleIn = <T,>(arr: T[] | undefined, v: T) => (arr?.includes(v) ? arr.filter((x) => x !== v) : [...(arr ?? []), v]);
  const chip = (on: boolean) => cn('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors', on ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong text-muted hover:text-fg');
  const s = search.trim().toLowerCase();
  return (
    <Card>
      <CardHeader title="Which devices" icon={Target} subtitle="Leave a group empty to include everything." actions={<Badge tone="accent">{matchedCount} match{matchedCount === 1 ? '' : 'es'}</Badge>} />
      <CardBody className="space-y-4">
        <Field label="Sites">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Sites">
            <button type="button" aria-pressed={!t.site_ids?.length} className={chip(!t.site_ids?.length)} onClick={() => onChange({ ...t, site_ids: [] })}>All sites</button>
            {sites.map((x) => <button key={x.id} type="button" aria-pressed={!!t.site_ids?.includes(x.id)} className={chip(!!t.site_ids?.includes(x.id))} onClick={() => onChange({ ...t, site_ids: toggleIn(t.site_ids, x.id) })}>{x.name}</button>)}
          </div>
        </Field>
        <Field label="Kinds of device">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kinds">
            <button type="button" aria-pressed={!t.kinds?.length} className={chip(!t.kinds?.length)} onClick={() => onChange({ ...t, kinds: [] })}>Any kind</button>
            {KIND_ORDER.filter((k) => k !== 'other').map((k: DeviceKind) => (
              <button key={k} type="button" aria-pressed={!!t.kinds?.includes(k)} className={chip(!!t.kinds?.includes(k))} onClick={() => onChange({ ...t, kinds: toggleIn(t.kinds, k) })}>
                <KindIcon kind={k} className="size-3.5 text-current" />{KIND[k].label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Tags" optional hint="Only devices with at least one of these tags.">
          <ChipsInput value={t.tags ?? []} onChange={(v) => onChange({ ...t, tags: v })} suggestions={tags} placeholder={tags.length ? `e.g. ${tags.slice(0, 2).join(', ')}` : 'guest'} ariaLabel="Tags" />
        </Field>
        <div>
          <button type="button" onClick={() => setShowDevices((v) => !v)} aria-expanded={showDevices} className="flex items-center gap-1.5 text-sm font-medium text-fg">
            Specific devices {t.device_ids?.length ? <Badge tone="accent">{t.device_ids.length}</Badge> : <span className="text-xs font-normal text-subtle">optional</span>}
            <ChevronDown className={cn('size-4 text-muted transition-transform', showDevices && 'rotate-180')} aria-hidden />
          </button>
          {showDevices && (
            <div className="mt-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Find a device" className="mb-2 sm:w-64" />
              <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1">
                {devices.filter((x) => !s || x.name.toLowerCase().includes(s) || (x.site_name ?? '').toLowerCase().includes(s)).map((x) => {
                  const on = !!t.device_ids?.includes(x.id);
                  return (
                    <li key={x.id}>
                      <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
                        <input type="checkbox" checked={on} onChange={() => onChange({ ...t, device_ids: toggleIn(t.device_ids, x.id) })} className="size-4 accent-[var(--color-accent)]" />
                        <KindIcon kind={x.kind} />
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">{x.name}</span>
                        <span className="text-xs text-muted">{x.site_name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-xs text-muted">Picking devices here overrides the site and kind choices above.</p>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function ActionsCard({ actions, onChange }: { actions: AutomationAction[]; onChange: (a: AutomationAction[]) => void }) {
  const setAt = (i: number, a: AutomationAction) => onChange(actions.map((x, k) => (k === i ? a : x)));
  const move = (i: number, dir: -1 | 1) => {
    const n = [...actions];
    const j = i + dir;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    onChange(n);
  };
  const addMenu = (
    <Menu
      align="start"
      width={280}
      trigger={({ toggle, ref }) => <Button ref={ref} icon={Plus} onClick={toggle} variant={actions.length ? 'secondary' : 'primary'}>Add action</Button>}
      items={ACTION_TYPES.map((t) => ({ label: t.label, icon: t.icon, hint: undefined, onSelect: () => onChange([...actions, newAction(t.type)]) }))}
    />
  );
  return (
    <Card>
      <CardHeader title="Do this" icon={ListOrdered} subtitle="Steps run in order, on every matching device." />
      <CardBody className="space-y-2.5">
        {actions.length === 0 && <p className="rounded-lg border border-dashed border-line-strong p-5 text-center text-sm text-muted">No steps yet. Add what the automation should do.</p>}
        {actions.map((a, i) => {
          const meta = ACTION_TYPES.find((t) => t.type === a.type)!;
          return (
            <div key={i} className="rounded-lg border border-line p-3">
              <div className="flex items-center gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-muted tnum">{i + 1}</span>
                <Select aria-label={`Step ${i + 1} type`} value={a.type} onChange={(e) => setAt(i, newAction(e.target.value as AutomationAction['type']))} className="w-48">
                  {ACTION_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                </Select>
                <span className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block">{meta.help}</span>
                <div className="ml-auto flex">
                  <IconButton icon={ArrowUp} label="Move step up" size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon={ArrowDown} label="Move step down" size="sm" disabled={i === actions.length - 1} onClick={() => move(i, 1)} />
                  <IconButton icon={Trash2} label="Remove step" size="sm" variant="danger-ghost" onClick={() => onChange(actions.filter((_, k) => k !== i))} />
                </div>
              </div>
              <ActionFields action={a} onChange={(n) => setAt(i, n)} />
            </div>
          );
        })}
        <div className="pt-1">{addMenu}</div>
      </CardBody>
    </Card>
  );
}

function ActionFields({ action: a, onChange }: { action: AutomationAction; onChange: (a: AutomationAction) => void }) {
  const wrap = 'mt-3 grid gap-3 pl-8 sm:grid-cols-2';
  switch (a.type) {
    case 'command': {
      const meta = COMMANDS.find((c) => c.id === a.command);
      const args = a.args ?? {};
      const setArg = (k: string, v: unknown) => onChange({ ...a, args: { ...args, [k]: v } });
      return (
        <div className={wrap}>
          <Field label="Command" htmlFor={`cmd-${a.command}`} hint={meta ? `Works on: ${meta.kinds.map((k) => KIND[k].short).join(', ')}. Others are skipped.` : undefined}>
            <Select value={a.command} onChange={(e) => onChange({ type: 'command', command: e.target.value })} aria-label="Command">
              {COMMANDS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
          {meta?.args === 'key' && (
            <Field label="Key">
              <Select aria-label="Key" value={String(args.key ?? 'HOME')} onChange={(e) => setArg('key', e.target.value)}>
                {ALL_KEYS.map((k) => <option key={k} value={k}>{KEY_LABELS[k] ?? k}</option>)}
              </Select>
            </Field>
          )}
          {meta?.args === 'level' && <Field label="Volume (0–100)"><Input type="number" min={0} max={100} aria-label="Volume" value={Number(args.level ?? 20)} onChange={(e) => setArg('level', Number(e.target.value))} className="w-28" /></Field>}
          {meta?.args === 'package' && <Field label="App" hint="Android package name, e.g. com.netflix.ninja"><Input mono aria-label="App package" value={String(args.package ?? '')} onChange={(e) => setArg('package', e.target.value.trim())} /></Field>}
          {meta?.args === 'message' && <Field label="Message"><Input aria-label="Message" value={String(args.message ?? '')} onChange={(e) => setArg('message', e.target.value)} placeholder="Checkout is at 11 am" /></Field>}
          {meta?.args === 'text' && <Field label="Text"><Input aria-label="Text" value={String(args.text ?? '')} onChange={(e) => setArg('text', e.target.value)} /></Field>}
          {meta?.args === 'mute' && <div className="sm:pt-6"><Toggle checked={!!args.mute} onChange={(v) => setArg('mute', v)} label="Mute" /></div>}
          {meta?.args === 'on' && <div className="sm:pt-6"><Toggle checked={!!args.on} onChange={(v) => setArg('on', v)} label="Light on" /></div>}
          {meta?.args === 'media' && (
            <Field label="Do">
              <Select aria-label="Media action" value={String(args.action ?? 'pause')} onChange={(e) => setArg('action', e.target.value)}>
                {['play', 'pause', 'next', 'prev', 'stop'].map((x) => <option key={x} value={x}>{x[0].toUpperCase() + x.slice(1)}</option>)}
              </Select>
            </Field>
          )}
        </div>
      );
    }
    case 'dns_mode':
      return (
        <div className={wrap}>
          <Field label="DNS mode" hint={DNS_MODE[a.mode].help}>
            <Select aria-label="DNS mode" value={a.mode} onChange={(e) => onChange({ type: 'dns_mode', mode: e.target.value as DnsMode })}>
              {DNS_MODES.map((m) => <option key={m} value={m}>{DNS_MODE[m].label}</option>)}
            </Select>
          </Field>
        </div>
      );
    case 'alert':
      return (
        <div className={wrap}>
          <Field label="Alert text" error={a.title.trim() ? null : 'Write what the alert should say'}>
            <Input aria-label="Alert text" value={a.title} onChange={(e) => onChange({ ...a, title: e.target.value })} placeholder="Beach House reset for the next guest" />
          </Field>
          <Field label="Importance">
            <Select aria-label="Importance" value={a.severity} onChange={(e) => onChange({ ...a, severity: e.target.value as Severity })}>
              {(Object.keys(SEVERITY) as Severity[]).map((s) => <option key={s} value={s}>{SEVERITY[s].label}</option>)}
            </Select>
          </Field>
        </div>
      );
    case 'delay':
      return (
        <div className={wrap}>
          <Field label="Wait for" hint={a.seconds >= 60 ? `${Math.floor(a.seconds / 60)} min ${a.seconds % 60 ? `${a.seconds % 60} s` : ''}` : undefined}>
            <div className="flex items-center gap-2">
              <Input type="number" min={1} max={3600} aria-label="Seconds" value={a.seconds} onChange={(e) => onChange({ ...a, seconds: Number(e.target.value) })} className="w-28" />
              <span className="text-sm text-muted">seconds</span>
            </div>
          </Field>
        </div>
      );
    case 'guest_reset':
      return <p className="mt-2 pl-8 text-xs text-muted">Uses each site’s Guest settings: which apps to clear, go home, and whether to restart.</p>;
    case 'enforce_apps':
      return <p className="mt-2 pl-8 text-xs text-muted">Installs required apps and disables or removes banned ones, as set in Library → App policies.</p>;
  }
}

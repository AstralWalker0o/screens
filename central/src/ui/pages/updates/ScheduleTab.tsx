import { useState } from 'react';
import { Link } from 'react-router';
import { CalendarClock, Clock3, Cpu, Save } from 'lucide-react';
import type { UpdateDeviceInfo, UpdateSiteSettings, UpdatesOverview } from '../../../shared/updates';
import { api } from '../../api';
import { act, setQueryData } from '../../lib/query';
import { relTime } from '../../lib/format';
import { Field, Input, Select } from '../../components/forms';
import { Badge, Button, Card, CardHeader, EmptyState, RelTime, SkeletonRows, StatusText } from '../../components/ui';
import { ABI_LABEL, abiText, siteClock } from './meta';

export function ScheduleTab({ o }: { o?: UpdatesOverview }) {
  if (!o) return <SkeletonRows rows={5} />;
  return (
    <div className="space-y-5">
      <section aria-labelledby="upd-windows">
        <h2 id="upd-windows" className="text-sm font-semibold text-fg">Maintenance windows</h2>
        <p className="mb-3 text-sm text-muted">Apps set to <strong className="font-medium text-fg">Auto</strong> update only inside the site’s window, in the site’s own time zone. Boxes someone is using are skipped and tried again a few minutes later.</p>
        {o.sites.length ? (
          <ul className="grid gap-3 lg:grid-cols-2">
            {o.sites.map((s) => <li key={s.site_id}><SiteWindow s={s} boxes={o.devices.filter((d) => d.site_id === s.site_id)} /></li>)}
          </ul>
        ) : (
          <Card><EmptyState icon={CalendarClock} title="No sites yet" /></Card>
        )}
      </section>
      <BoxesCard devices={o.devices} />
    </div>
  );
}

function SiteWindow({ s, boxes }: { s: UpdateSiteSettings; boxes: UpdateDeviceInfo[] }) {
  const [f, setF] = useState({ window_start: s.window_start, window_end: s.window_end, canary_device_id: s.canary_device_id ?? '' });
  const [busy, setBusy] = useState(false);
  const dirty = f.window_start !== s.window_start || f.window_end !== s.window_end || (f.canary_device_id || null) !== s.canary_device_id;
  const valid = /^\d\d:\d\d$/.test(f.window_start) && /^\d\d:\d\d$/.test(f.window_end) && f.window_start !== f.window_end;
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.updates.saveSite(s.site_id, { ...f, canary_device_id: f.canary_device_id || null }), { success: `Saved the update window for ${s.site_name}`, invalidate: ['updates'] });
    if (r) setQueryData<UpdatesOverview>('updates', (old) => old && { ...old, sites: old.sites.map((x) => (x.site_id === s.site_id ? r : x)) });
    setBusy(false);
  };
  const id = `w-${s.site_id}`;
  return (
    <Card className="h-full">
      <CardHeader
        title={s.site_name}
        subtitle={<>{s.timezone} · it’s {siteClock(s.timezone)} there now</>}
        actions={s.in_window ? <Badge tone="accent" icon={Clock3}>Window open now</Badge> : s.next_window_at ? <span className="text-xs text-muted">Opens {relTime(s.next_window_at)}</span> : null}
      />
      <div className="space-y-3 px-4 pb-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" htmlFor={`${id}-s`}><Input id={`${id}-s`} type="time" step={300} value={f.window_start} onChange={(e) => setF({ ...f, window_start: e.target.value })} /></Field>
          <Field label="Until" htmlFor={`${id}-e`}><Input id={`${id}-e`} type="time" step={300} value={f.window_end} onChange={(e) => setF({ ...f, window_end: e.target.value })} /></Field>
        </div>
        <Field label="Canary box" htmlFor={`${id}-c`} hint="Updated first and checked (new version, app opens) before the other boxes at this site.">
          <Select id={`${id}-c`} value={f.canary_device_id} onChange={(e) => setF({ ...f, canary_device_id: e.target.value })}>
            <option value="">Automatic (first box that’s free)</option>
            {boxes.map((b) => <option key={b.device_id} value={b.device_id}>{b.name}{b.online ? '' : ' (offline)'}</option>)}
          </Select>
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {!s.gateway_online ? <StatusText tone="warn" icon={Clock3}>Gateway offline: nothing installs until it’s back</StatusText> : <span />}
          <Button size="sm" variant="primary" icon={Save} disabled={!dirty || !valid} loading={busy} onClick={save}>Save</Button>
        </div>
      </div>
    </Card>
  );
}

function BoxesCard({ devices }: { devices: UpdateDeviceInfo[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const setAbi = async (d: UpdateDeviceInfo, abi: string) => {
    setBusy(d.device_id);
    const ok = await act(() => api.updates.setDeviceAbi(d.device_id, abi || null), { success: abi ? `${d.name} will get ${ABI_LABEL[abi] ?? abi} builds` : `${d.name} picks its build automatically`, invalidate: ['updates'] });
    if (ok) setQueryData<UpdatesOverview>('updates', (old) => old && { ...old, devices: old.devices.map((x) => (x.device_id === d.device_id ? { ...x, abi_override: abi || null } : x)) });
    setBusy(null);
  };
  return (
    <Card>
      <CardHeader title="Android boxes" icon={Cpu} subtitle="Which build each box gets. Automatic picks the build made for the box’s processor, else a universal one." />
      {devices.length === 0 ? (
        <p className="border-t border-line px-4 py-5 text-sm text-muted">No Android boxes yet.</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {devices.map((d) => (
            <li key={d.device_id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
              <div className="min-w-0 flex-1 basis-48">
                <Link to={`/devices/${d.device_id}/apps`} className="block truncate text-sm font-medium text-fg hover:underline">{d.name}</Link>
                <p className="truncate text-xs text-muted">
                  {d.site_name}{d.model ? ` · ${d.model}` : ''}{d.sdk ? ` · Android SDK ${d.sdk}` : ''} · {d.abis.length ? abiText(d.abis[0]) : 'processor not read yet'}
                  {d.probed_at ? <> · read <RelTime ts={d.probed_at} /></> : null}
                </p>
              </div>
              <Select aria-label={`Build for ${d.name}`} value={d.abi_override ?? ''} disabled={!d.abis.length || busy === d.device_id} onChange={(e) => setAbi(d, e.target.value)} className="w-full sm:w-56">
                <option value="">Automatic{d.abis[0] ? ` (${d.abis[0]})` : ''}</option>
                {d.abis.map((a) => <option key={a} value={a}>{ABI_LABEL[a] ?? a} ({a})</option>)}
              </Select>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

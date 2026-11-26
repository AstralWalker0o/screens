import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { TvMinimalPlay, PowerOff, Sparkles, ShieldCheck, X, ChevronDown, Radar, ShieldAlert, CircleCheck, CircleX } from 'lucide-react';
import type { BulkCommandResult, Device, DeviceKind, DeviceStatus, DnsMode } from '../../shared/types';
import { api } from '../api';
import { invalidate, reportError, useQuery } from '../lib/query';
import { toast } from '../lib/toast';
import { DEVICE_STATUS, DNS_MODE, DNS_MODES, KIND, KIND_ORDER, gradeFor, kindLabel } from '../lib/labels';
import { Button, ButtonLink, Card, EmptyState, PageHeader, RelTime, SkeletonRows, StatusText, TableWrap, cn, td, th } from '../components/ui';
import { Checkbox, SearchInput, Select } from '../components/forms';
import { ConfirmDialog, Dialog, Menu } from '../components/overlay';
import { DeviceStatusBadge, DnsModeBadge, GradeBadge, KindIcon, PowerText } from '../components/status';

type Bulk = 'power_off' | 'guest_reset' | { mode: DnsMode } | null;

export default function Devices() {
  const q = useQuery('devices', () => api.devices.list(), { refreshMs: 20_000 });
  const sites = useQuery('sites', () => api.sites.list());
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<Bulk>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ title: string; rows: (BulkCommandResult['results'][number] & { name: string })[] } | null>(null);

  const f = {
    q: params.get('q') ?? '',
    kind: params.get('kind') ?? '',
    site: params.get('site') ?? '',
    status: params.get('status') ?? '',
    grade: params.get('grade') ?? '',
    dns: params.get('dns') ?? '',
  };
  const setF = (k: keyof typeof f, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const anyFilter = Object.values(f).some(Boolean);

  const list = useMemo(() => {
    const s = f.q.trim().toLowerCase();
    return (q.data ?? [])
      .filter((d) =>
        (!s || [d.name, d.room, d.ip, d.model, d.site_name, d.current_app].some((v) => v?.toLowerCase().includes(s))) &&
        (!f.kind || d.kind === f.kind) && (!f.site || d.site_id === f.site) && (!f.status || d.status === f.status) &&
        (!f.grade || (f.grade === 'none' ? d.privacy_score == null : gradeFor(d.privacy_score) === f.grade)) && (!f.dns || d.dns_mode === f.dns))
      .sort((a, b) => (a.site_name ?? '').localeCompare(b.site_name ?? '') || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
  }, [q.data, f.q, f.kind, f.site, f.status, f.grade, f.dns]);

  const sel = list.filter((d) => selected.has(d.id));
  const allSel = list.length > 0 && sel.length === list.length;
  const toggle = (id: string, v: boolean) => {
    const n = new Set(selected);
    if (v) n.add(id);
    else n.delete(id);
    setSelected(n);
  };

  const runBulk = async () => {
    if (!bulk) return;
    setBusy(true);
    try {
      let targets = sel;
      let res: BulkCommandResult;
      if (bulk === 'power_off' || bulk === 'guest_reset') {
        const cap = bulk === 'power_off' ? 'power' : 'guest_reset';
        targets = sel.filter((d) => d.capabilities.includes(cap));
        res = await api.devices.bulk({ device_ids: targets.map((d) => d.id), command: bulk });
      } else {
        res = await api.devices.bulk({ device_ids: sel.map((d) => d.id), command: 'dns_mode', args: { mode: bulk.mode } });
      }
      const named = res.results.map((r) => ({ ...r, name: r.name ?? targets.find((d) => d.id === r.device_id)?.name ?? r.device_id }));
      const failed = named.filter((r) => !r.ok).length;
      setBulk(null);
      setSelected(new Set());
      if (failed) setResults({ title: bulkTitle(bulk), rows: named });
      else toast.success(`${bulkTitle(bulk)}: done for ${named.length} device${named.length === 1 ? '' : 's'}`);
    } catch (e) {
      reportError(e, 'Bulk action failed');
    } finally {
      setBusy(false);
      invalidate('devices', 'device:', 'site:', 'sites', 'overview');
    }
  };

  const skipped = bulk === 'power_off' ? sel.filter((d) => !d.capabilities.includes('power')).length : bulk === 'guest_reset' ? sel.filter((d) => !d.capabilities.includes('guest_reset')).length : 0;

  return (
    <>
      <PageHeader title="Devices" subtitle="Every TV, streaming box and speaker across your sites." actions={<ButtonLink to="/sites" icon={Radar}>Add devices from a site</ButtonLink>} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Name, room, IP or model" className="w-full sm:w-60" />
        <Select aria-label="Kind" value={f.kind} onChange={(e) => setF('kind', e.target.value)} className="w-[calc(50%-4px)] sm:w-40">
          <option value="">All kinds</option>
          {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
        </Select>
        <Select aria-label="Site" value={f.site} onChange={(e) => setF('site', e.target.value)} className="w-[calc(50%-4px)] sm:w-44">
          <option value="">All sites</option>
          {(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select aria-label="Status" value={f.status} onChange={(e) => setF('status', e.target.value)} className="w-[calc(33%-6px)] sm:w-36">
          <option value="">Any status</option>
          {(Object.keys(DEVICE_STATUS) as DeviceStatus[]).map((s) => <option key={s} value={s}>{DEVICE_STATUS[s].label}</option>)}
        </Select>
        <Select aria-label="Privacy grade" value={f.grade} onChange={(e) => setF('grade', e.target.value)} className="w-[calc(33%-6px)] sm:w-32">
          <option value="">Any grade</option>
          {['A', 'B', 'C', 'D', 'F'].map((g) => <option key={g} value={g}>Grade {g}</option>)}
          <option value="none">Not scored</option>
        </Select>
        <Select aria-label="DNS mode" value={f.dns} onChange={(e) => setF('dns', e.target.value)} className="w-[calc(33%-6px)] sm:w-36">
          <option value="">Any DNS mode</option>
          {DNS_MODES.map((m) => <option key={m} value={m}>{DNS_MODE[m].label}</option>)}
        </Select>
        {anyFilter && <Button size="sm" variant="ghost" icon={X} onClick={() => setParams({}, { replace: true })}>Clear filters</Button>}
      </div>

      {sel.length > 0 && (
        <div className="sticky top-16 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-surface px-3 py-2 shadow-pop">
          <span className="mr-1 text-sm font-medium text-fg">{sel.length} selected</span>
          <Button size="sm" icon={PowerOff} onClick={() => setBulk('power_off')}>Power off</Button>
          <Button size="sm" icon={Sparkles} onClick={() => setBulk('guest_reset')}>Guest reset</Button>
          <Menu
            trigger={({ toggle: t, ref }) => <Button ref={ref} size="sm" icon={ShieldCheck} iconRight={ChevronDown} onClick={t}>Set DNS mode</Button>}
            items={DNS_MODES.map((m) => ({ label: DNS_MODE[m].label, hint: DNS_MODE[m].short, onSelect: () => setBulk({ mode: m }) }))}
          />
          <Button size="sm" variant="ghost" icon={X} className="ml-auto" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <Card>
        {q.loading ? (
          <div className="p-4"><SkeletonRows rows={8} /></div>
        ) : list.length === 0 ? (
          <EmptyState icon={TvMinimalPlay} title={anyFilter ? 'No devices match these filters' : 'No devices yet'} action={anyFilter ? <Button onClick={() => setParams({}, { replace: true })}>Clear filters</Button> : <ButtonLink to="/sites" variant="primary">Go to a site to find devices</ButtonLink>}>
            {anyFilter ? 'Try removing a filter.' : 'Open a site, run a scan on its Discover tab and adopt your TVs and speakers.'}
          </EmptyState>
        ) : (
          <>
            {/* Desktop: table */}
            <TableWrap className="hidden md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-2/60">
                  <tr>
                    <th className={cn(th, 'w-10')}>
                      <Checkbox checked={allSel} indeterminate={!allSel && sel.length > 0} onChange={(v) => setSelected(v ? new Set(list.map((d) => d.id)) : new Set())} ariaLabel="Select all" />
                    </th>
                    <th className={th}>Device</th>
                    <th className={th}>Site</th>
                    <th className={th}>Status</th>
                    <th className={cn(th, 'hidden xl:table-cell')}>Now</th>
                    <th className={th}>Privacy</th>
                    <th className={th}>DNS</th>
                    <th className={cn(th, 'hidden lg:table-cell')}>IP</th>
                    <th className={cn(th, 'hidden lg:table-cell')}>Seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.map((d) => (
                    <tr key={d.id} className={cn('transition-colors hover:bg-surface-2/60', selected.has(d.id) && 'bg-accent-soft/40')}>
                      <td className={td}><Checkbox checked={selected.has(d.id)} onChange={(v) => toggle(d.id, v)} ariaLabel={`Select ${d.name}`} /></td>
                      <td className={td}>
                        <Link to={`/devices/${d.id}`} className="group flex items-center gap-2.5">
                          <KindIcon kind={d.kind} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-fg group-hover:underline">{d.name}</span>
                            <span className="block truncate text-xs text-muted">{[d.room, kindLabel(d.kind, d.model)].filter(Boolean).join(' · ')}</span>
                          </span>
                        </Link>
                      </td>
                      <td className={cn(td, 'text-muted')}><Link to={`/sites/${d.site_id}`} className="hover:text-fg hover:underline">{d.site_name}</Link></td>
                      <td className={td}><DeviceStatusBadge status={d.status} /></td>
                      <td className={cn(td, 'hidden max-w-44 truncate xl:table-cell')}>{d.current_app ? <span className="text-fg">{d.current_app}</span> : d.kind === 'sonos' ? <span className="text-subtle">–</span> : <PowerText device={d} />}</td>
                      <td className={td}><span className="inline-flex items-center gap-2"><GradeBadge score={d.privacy_score} />{d.privacy_score != null && <span className="text-xs text-muted tnum">{d.privacy_score}</span>}</span></td>
                      <td className={td}><DnsModeBadge mode={d.dns_mode} /></td>
                      <td className={cn(td, 'hidden font-mono text-xs text-muted lg:table-cell')}>{d.ip}</td>
                      <td className={cn(td, 'hidden text-xs text-muted lg:table-cell')}><RelTime ts={d.last_seen} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {/* Phone: cards */}
            <ul className="divide-y divide-line md:hidden">
              {list.map((d) => <DeviceListCard key={d.id} d={d} checked={selected.has(d.id)} onCheck={(v) => toggle(d.id, v)} />)}
            </ul>
          </>
        )}
      </Card>
      {list.length > 0 && <p className="mt-2 text-xs text-muted">{list.length} of {q.data?.length ?? 0} devices</p>}

      <ConfirmDialog
        open={!!bulk}
        onClose={() => setBulk(null)}
        busy={busy}
        danger={bulk === 'power_off'}
        title={
          bulk === 'power_off' ? `Power off ${sel.length - skipped} device${sel.length - skipped === 1 ? '' : 's'}?`
            : bulk === 'guest_reset' ? `Guest reset ${sel.length - skipped} device${sel.length - skipped === 1 ? '' : 's'}?`
              : bulk ? `Set DNS to ${DNS_MODE[bulk.mode].label} for ${sel.length} device${sel.length === 1 ? '' : 's'}?` : ''
        }
        confirmLabel={bulk === 'power_off' ? 'Power off' : bulk === 'guest_reset' ? 'Reset now' : 'Apply'}
        onConfirm={runBulk}
      >
        {bulk === 'power_off' && <p>Anyone watching will be interrupted. TVs go to standby; you can turn them back on from here.</p>}
        {bulk === 'guest_reset' && <p>Clears the guest apps chosen in each site’s Guest settings, goes back to the home screen and (if set) restarts. Samsung TVs only return to Home.</p>}
        {bulk && typeof bulk === 'object' && <p>{DNS_MODE[bulk.mode].help}</p>}
        {skipped > 0 && <p className="text-warn-fg">{skipped} selected device{skipped === 1 ? ' doesn’t' : 's don’t'} support this and will be skipped.</p>}
      </ConfirmDialog>

      <Dialog open={!!results} onClose={() => setResults(null)} title={results?.title ?? ''} description={results ? `${results.rows.filter((r) => r.ok).length} done, ${results.rows.filter((r) => !r.ok).length} failed` : undefined} footer={<Button variant="primary" onClick={() => setResults(null)}>Close</Button>}>
        <ul className="divide-y divide-line">
          {results?.rows.map((r) => (
            <li key={r.device_id} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{r.name}</p>
                {r.error && <p className="mt-0.5 text-xs text-crit-fg">{r.error}</p>}
              </div>
              {r.ok ? <StatusText tone="ok" icon={CircleCheck}>Done</StatusText> : <StatusText tone="crit" icon={CircleX}>Failed</StatusText>}
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

function bulkTitle(b: Exclude<Bulk, null>): string {
  return b === 'power_off' ? 'Power off' : b === 'guest_reset' ? 'Guest reset' : `DNS mode → ${DNS_MODE[b.mode].label}`;
}

function DeviceListCard({ d, checked, onCheck }: { d: Device; checked: boolean; onCheck: (v: boolean) => void }) {
  return (
    <li className={cn('flex items-start gap-3 px-4 py-3', checked && 'bg-accent-soft/40')}>
      <Checkbox checked={checked} onChange={onCheck} ariaLabel={`Select ${d.name}`} className="mt-2.5" />
      <KindIcon kind={d.kind as DeviceKind} boxed />
      <Link to={`/devices/${d.id}`} className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate font-medium text-fg">{d.name}</span>
          <GradeBadge score={d.privacy_score} size="sm" />
        </span>
        <span className="block truncate text-xs text-muted">{[d.site_name, d.room].filter(Boolean).join(' · ')}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <DeviceStatusBadge status={d.status} />
          <DnsModeBadge mode={d.dns_mode} />
          {d.current_app && <span className="truncate text-xs text-muted">{d.current_app}</span>}
          {d.status === 'unauthorized' && <ShieldAlert className="size-3.5 text-warn-fg" aria-hidden />}
        </span>
      </Link>
    </li>
  );
}

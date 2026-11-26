import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Pause, Play, Ban, Check, Copy, Search, Radio, WifiOff, ShieldBan, Smartphone, History, Globe } from 'lucide-react';
import type { Device, DnsLogEntry, LiveEvent } from '../../shared/types';
import { api } from '../api';
import { act, peekQuery } from '../lib/query';
import { useDebounced, useLive, copyText } from '../lib/hooks';
import { clockTime, absTime } from '../lib/format';
import { CATEGORY } from '../lib/labels';
import { Button, cn, StatusText } from './ui';
import { SearchInput, Select } from './forms';
import { Menu, type MenuItem } from './overlay';
import { ACTION_META } from './status';
import { toast } from '../lib/toast';

type Row = DnsLogEntry & { _id: number; _new?: boolean };
let rowSeq = 0;
const MAX_ROWS = 500;

const ROW_TINT: Record<DnsLogEntry['action'], string> = {
  block: 'bg-crit-soft/45',
  would_block: 'bg-warn-soft/45',
  allow: '',
};

function matches(e: DnsLogEntry, f: { device: string; action: string; q: string }) {
  if (f.device && (f.device === '_unknown' ? e.device_id : e.device_id !== f.device)) return false;
  if (f.action && e.action !== f.action) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!e.qname.includes(q) && !e.client.includes(q) && !(e.device_name ?? '').toLowerCase().includes(q)) return false;
  }
  return true;
}

export function DnsLiveLog({ siteId, deviceId, devices, height = 520, onDeviceListChange }: {
  siteId: string; deviceId?: string; devices?: Device[]; height?: number; onDeviceListChange?: (d: Device) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [buffer, setBuffer] = useState<Row[]>([]);
  const [device, setDevice] = useState(deviceId ?? '');
  const [action, setAction] = useState('');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const filters = useMemo(() => ({ device, action, q }), [device, action, q]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [older, setOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setBuffer([]);
    api.sites
      .dnsLog(siteId, { device_id: device && device !== '_unknown' ? device : undefined, action: action || undefined, q: q || undefined, limit: 200 })
      .then((list) => {
        if (!alive) return;
        setRows(list.filter((e) => matches(e, filters)).map((e) => ({ ...e, _id: rowSeq++ })));
        setExhausted(list.length < 200);
      })
      .catch((err) => act(() => Promise.reject(err), { error: 'Couldn’t load the DNS log' }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [siteId, filters]);

  const status = useLive(siteId, (ev: LiveEvent) => {
    if (ev.type !== 'dns') return;
    const fresh = ev.entries.filter((e) => matches(e, filtersRef.current)).map((e) => ({ ...e, _id: rowSeq++, _new: true }));
    if (!fresh.length) return;
    if (pausedRef.current) setBuffer((b) => [...fresh, ...b].slice(0, MAX_ROWS));
    else setRows((r) => [...fresh, ...r.map((x) => (x._new ? { ...x, _new: false } : x))].slice(0, MAX_ROWS));
  });

  const resume = () => {
    setRows((r) => [...buffer, ...r].slice(0, MAX_ROWS));
    setBuffer([]);
    setPaused(false);
  };

  const loadOlder = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setOlder(true);
    const list = await act(() => api.sites.dnsLog(siteId, { device_id: device && device !== '_unknown' ? device : undefined, action: action || undefined, q: q || undefined, before: last.ts, limit: 200 }));
    setOlder(false);
    if (!list) return;
    setExhausted(list.length < 200);
    setRows((r) => [...r, ...list.filter((e) => matches(e, filters)).map((e) => ({ ...e, _id: rowSeq++ }))]);
  };

  const counts = useMemo(() => {
    const c = { block: 0, would_block: 0, allow: 0 };
    for (const r of rows) c[r.action]++;
    return c;
  }, [rows]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={text} onChange={setText} placeholder="Filter by domain, device or IP" className="w-full sm:w-64" />
        {!deviceId && (
          <Select aria-label="Device" value={device} onChange={(e) => setDevice(e.target.value)} className="w-[calc(50%-4px)] sm:w-48">
            <option value="">All devices</option>
            {(devices ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            <option value="_unknown">Unknown devices (guests)</option>
          </Select>
        )}
        <Select aria-label="Result" value={action} onChange={(e) => setAction(e.target.value)} className="w-[calc(50%-4px)] sm:w-40">
          <option value="">All results</option>
          <option value="block">Blocked</option>
          <option value="would_block">Would block</option>
          <option value="allow">Allowed</option>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <LiveIndicator status={status} paused={paused} />
          {paused ? (
            <Button size="sm" variant="primary" icon={Play} onClick={resume}>
              Resume{buffer.length ? ` (${buffer.length} new)` : ''}
            </Button>
          ) : (
            <Button size="sm" icon={Pause} onClick={() => setPaused(true)}>Pause</Button>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        Showing {rows.length} lookups · <span className="text-crit-fg">{counts.block} blocked</span> · <span className="text-warn-fg">{counts.would_block} would block</span> · {counts.allow} allowed.
        {' '}Click a domain to block or allow it.
      </p>

      <div className="mt-2 overflow-auto rounded-lg border border-line" style={{ maxHeight: height }} aria-busy={loading}>
        {loading && !rows.length ? (
          <div className="space-y-px p-1">{Array.from({ length: 8 }, (_, i) => <div key={i} className="h-9 animate-pulse-soft rounded bg-surface-2" />)}</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
            <Globe className="size-5 text-subtle" aria-hidden />
            <p className="text-sm font-medium text-fg">No lookups match</p>
            <p className="text-sm text-muted">{q || action || device ? 'Try clearing the filters.' : 'New lookups appear here as soon as devices make them.'}</p>
          </div>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 z-[1] bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="hidden w-[78px] px-3 py-2 font-medium sm:table-cell">Time</th>
                <th className="hidden w-[180px] px-3 py-2 font-medium md:table-cell">Device</th>
                <th className="px-3 py-2 font-medium">Domain</th>
                <th className="hidden w-[64px] px-3 py-2 font-medium lg:table-cell">Type</th>
                <th className="hidden w-[110px] px-3 py-2 font-medium sm:table-cell">Category</th>
                <th className="w-[100px] px-3 py-2 font-medium sm:w-[118px]">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <LogRow key={r._id} row={r} siteId={siteId} showDevice={!deviceId} onDeviceListChange={onDeviceListChange} />
              ))}
            </tbody>
          </table>
        )}
        {rows.length > 0 && !exhausted && (
          <div className="border-t border-line p-2 text-center">
            <Button size="sm" variant="ghost" icon={History} loading={older} onClick={loadOlder}>Load older lookups</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveIndicator({ status, paused }: { status: string; paused: boolean }) {
  if (paused) return <StatusText tone="warn" icon={Pause}>Paused</StatusText>;
  if (status === 'open') return <StatusText tone="ok" icon={Radio} pulse>Live</StatusText>;
  if (status === 'connecting') return <StatusText tone="neutral" icon={Radio} pulse>Connecting…</StatusText>;
  return <StatusText tone="crit" icon={WifiOff}>Reconnecting…</StatusText>;
}

function LogRow({ row: r, siteId, showDevice, onDeviceListChange }: { row: Row; siteId: string; showDevice: boolean; onDeviceListChange?: (d: Device) => void }) {
  const navigate = useNavigate();
  const meta = ACTION_META[r.action];
  const items = domainMenu(r, siteId, navigate, onDeviceListChange);
  return (
    <tr className={cn(ROW_TINT[r.action], r._new && 'animate-flash')}>
      <td className="hidden px-3 py-1.5 font-mono text-xs whitespace-nowrap text-muted tnum sm:table-cell" title={absTime(r.ts)}>{clockTime(r.ts)}</td>
      <td className="hidden truncate px-3 py-1.5 md:table-cell" title={r.client}>
        {r.device_name ? <span className="text-fg">{r.device_name}</span> : <span className="text-muted">Unknown · {r.client}</span>}
      </td>
      <td className="px-3 py-1">
        <Menu
          width={250}
          align="start"
          header={<span className="font-mono [overflow-wrap:anywhere]">{r.qname}</span>}
          trigger={({ toggle, ref }) => (
            <button
              ref={ref}
              type="button"
              onClick={toggle}
              className="block max-w-full truncate rounded px-1 py-0.5 text-left font-mono text-[12.5px] text-fg hover:bg-surface-3"
              title={`${r.qname}${r.rule ? ` — matched ${r.rule}` : ''}`}
            >
              {r.qname}
            </button>
          )}
          items={items}
        />
        <span className="block truncate px-1 text-xs text-muted md:hidden">
          <span className="font-mono tnum sm:hidden">{clockTime(r.ts)}</span>
          {showDevice && <><span className="sm:hidden"> · </span>{r.device_name ?? `Unknown · ${r.client}`}</>}
        </span>
      </td>
      <td className="hidden px-3 py-1.5 font-mono text-xs text-muted lg:table-cell">{r.qtype}</td>
      <td className="hidden truncate px-3 py-1.5 text-xs text-muted sm:table-cell" title={r.cat ? CATEGORY[r.cat]?.help : undefined}>{r.cat ? CATEGORY[r.cat]?.label : '–'}</td>
      <td className="px-3 py-1.5">
        <StatusText tone={meta.tone} icon={meta.icon}>{meta.label}</StatusText>
      </td>
    </tr>
  );
}

function domainMenu(r: DnsLogEntry, siteId: string, navigate: (to: string) => void, onDeviceListChange?: (d: Device) => void): (MenuItem | 'sep')[] {
  const rule = (action: 'block' | 'allow', scope: 'site' | 'global') =>
    act(
      () => api.dns.addRule({ domain: r.qname, action, category: r.cat ?? null, policies: action === 'block' ? ['balanced', 'strict'] : ['balanced', 'strict', 'monitor'], scope_type: scope, scope_id: scope === 'site' ? siteId : '', notes: 'Added from the live log' }),
      { success: `${action === 'block' ? 'Blocking' : 'Allowing'} ${r.qname} ${scope === 'site' ? 'at this site' : 'everywhere'}. Gateways update within a minute.`, invalidate: ['dns-', 'rules', 'privacy'] },
    );
  const deviceList = async (list: 'dns_block' | 'dns_allow') => {
    if (!r.device_id) return;
    const d = peekQuery<Device>(`device:${r.device_id}`) ?? (await act(() => api.devices.get(r.device_id!)));
    if (!d) return;
    const next = Array.from(new Set([...(d[list] ?? []), r.qname]));
    const upd = await act(() => api.devices.update(d.id, { [list]: next }), {
      success: `${list === 'dns_block' ? 'Blocked' : 'Allowed'} ${r.qname} for ${d.name}`,
      invalidate: [`device:${d.id}`],
    });
    if (upd) onDeviceListChange?.(upd);
  };
  const items: (MenuItem | 'sep')[] = [
    { label: 'Block at this site', icon: Ban, onSelect: () => void rule('block', 'site') },
    { label: 'Allow at this site', icon: Check, onSelect: () => void rule('allow', 'site') },
    { label: 'Block everywhere', icon: ShieldBan, onSelect: () => void rule('block', 'global') },
  ];
  if (r.device_id) {
    items.push('sep', { label: `Block for ${r.device_name ?? 'this device'} only`, icon: Smartphone, onSelect: () => void deviceList('dns_block') });
    items.push({ label: `Allow for ${r.device_name ?? 'this device'} only`, icon: Smartphone, onSelect: () => void deviceList('dns_allow') });
  }
  items.push('sep',
    { label: 'Copy domain', icon: Copy, onSelect: () => void copyText(r.qname).then((ok) => ok && toast.success('Copied')) },
    { label: 'See stats in DNS → Domains', icon: Search, onSelect: () => navigate(`/dns/domains?q=${encodeURIComponent(r.qname)}`) },
  );
  return items;
}

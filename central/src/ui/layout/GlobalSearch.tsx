import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Building2, Search, X } from 'lucide-react';
import { api } from '../api';
import { useQuery } from '../lib/query';
import { KindIcon, DeviceStatusBadge } from '../components/status';
import { cn, Kbd } from '../components/ui';
import { KIND } from '../lib/labels';

interface Result { id: string; type: 'site' | 'device'; title: string; sub: string; to: string; node: React.ReactNode }

export function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const devices = useQuery(open ? 'devices' : null, () => api.devices.list());
  const sites = useQuery(open ? 'sites' : null, () => api.sites.list());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const out: Result[] = [];
    for (const site of sites.data ?? []) {
      if ([site.name, site.client_name, site.address].some((v) => v?.toLowerCase().includes(s))) {
        out.push({
          id: site.id, type: 'site', title: site.name, sub: `${site.client_name ?? ''} · ${site.devices_total} devices`, to: `/sites/${site.id}`,
          node: <Building2 className="size-4 text-muted" aria-hidden />,
        });
      }
    }
    for (const d of devices.data ?? []) {
      if ([d.name, d.ip, d.room, d.model, d.mac, d.site_name, KIND[d.kind].short].some((v) => v?.toLowerCase().includes(s))) {
        out.push({ id: d.id, type: 'device', title: d.name, sub: [d.site_name, d.room, d.ip].filter(Boolean).join(' · '), to: `/devices/${d.id}`, node: <KindIcon kind={d.kind} /> });
      }
    }
    return out.slice(0, 12);
  }, [q, sites.data, devices.data]);

  useEffect(() => setActive(0), [q]);

  const go = (r: Result) => {
    navigate(r.to);
    setOpen(false);
    setQ('');
    input.current?.blur();
  };

  const statusOf = (id: string) => devices.data?.find((d) => d.id === id)?.status;

  return (
    <div ref={box} className="relative w-full max-w-md min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" aria-hidden />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={open && !!q}
        aria-controls="global-search-results"
        aria-label="Search devices and sites by name or IP"
        placeholder="Search devices, sites, IPs…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(results.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter' && results[active]) {
            go(results[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
            input.current?.blur();
          }
        }}
        className="h-9 w-full rounded-lg border border-line bg-surface pr-16 pl-8 text-sm text-fg shadow-card placeholder:text-subtle focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-3 focus:ring-accent/20 [&::-webkit-search-cancel-button]:hidden"
      />
      <div className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 items-center gap-1 sm:flex">
        {!q && <Kbd>/</Kbd>}
      </div>
      {q && (
        <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-subtle hover:text-fg">
          <X className="size-3.5" />
        </button>
      )}
      {open && q.trim() && (
        <div id="global-search-results" role="listbox" className="absolute top-full right-0 left-0 z-40 mt-1.5 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop sm:min-w-96">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">{devices.loading || sites.loading ? 'Searching…' : `Nothing matches “${q}”. Try a device name, room or IP address.`}</p>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.type}:${r.id}`}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r)}
                className={cn('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left', i === active ? 'bg-surface-2' : '')}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2">{r.node}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{r.title}</span>
                  <span className="block truncate text-xs text-muted">{r.sub}</span>
                </span>
                {r.type === 'device' && statusOf(r.id) && <DeviceStatusBadge status={statusOf(r.id)!} />}
                {r.type === 'site' && <span className="text-xs text-subtle">Site</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Radar, Plus, EyeOff, CircleHelp, ChevronDown, Router, TvMinimalPlay, Tv, Speaker } from 'lucide-react';
import type { Discovered, DeviceKind, SiteDetail } from '../../../shared/types';
import { api } from '../../api';
import { act, invalidate, setQueryData, useQuery } from '../../lib/query';
import { toast } from '../../lib/toast';
import { KIND, MDNS_SERVICE_NAMES } from '../../lib/labels';
import { Badge, Button, ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, RelTime, SkeletonRows, cn } from '../../components/ui';
import { Dialog } from '../../components/overlay';
import { Field, Input, Select } from '../../components/forms';
import { KindIcon } from '../../components/status';

const DEFAULT_PORT: Record<DeviceKind, number | undefined> = { android: 5555, samsung: 8002, lg: 3001, sonos: 1400, other: undefined };

export function DiscoverTab({ site }: { site: SiteDetail }) {
  const key = `discovered:${site.id}`;
  const q = useQuery(key, () => api.sites.discovered(site.id));
  const [scanning, setScanning] = useState(false);
  const [adopt, setAdopt] = useState<Discovered | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [showAdopted, setShowAdopted] = useState(false);
  const online = site.gateway_status === 'online';

  const scan = async () => {
    setScanning(true);
    const r = await act(() => api.sites.discover(site.id), { error: 'Scan failed' });
    setScanning(false);
    if (r) {
      setQueryData(key, () => r);
      const fresh = r.filter((d) => !d.adopted_device_id && !d.ignored).length;
      toast.success(fresh ? `Found ${fresh} device${fresh === 1 ? '' : 's'} you can adopt` : 'Scan finished — nothing new found');
    }
  };
  const ignore = async (d: Discovered) => {
    setQueryData<Discovered[]>(key, (old) => old?.map((x) => (x.ip === d.ip ? { ...x, ignored: true } : x)));
    await act(() => api.sites.ignore(site.id, d.ip), { invalidate: [key] });
  };

  const list = q.data ?? [];
  const fresh = list.filter((d) => !d.adopted_device_id && !d.ignored);
  const adopted = list.filter((d) => d.adopted_device_id);
  const ignored = list.filter((d) => d.ignored && !d.adopted_device_id);

  if (site.gateway_status === 'none' || site.gateway_status === 'revoked') {
    return (
      <Card>
        <EmptyState icon={Router} title="Discovery needs a gateway" action={<ButtonLink to={`/sites/${site.id}/gateway`} variant="primary" icon={Router}>Add gateway</ButtonLink>}>
          The gateway scans the site’s networks for TVs, streaming boxes and speakers.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Devices found on the network"
            icon={Radar}
            subtitle="A scan checks every address on the gateway’s networks for TVs, Android boxes and speakers. It takes about 10 seconds."
            actions={<Button variant="primary" icon={Radar} loading={scanning} onClick={scan} disabled={!online}>{scanning ? 'Scanning…' : 'Scan network'}</Button>}
          />
          <CardBody>
            {!online && <Callout kind="warn" className="mb-3">The gateway is offline, so scanning isn’t possible right now.</Callout>}
            {scanning && (
              <div className="mb-3 flex items-center gap-3 rounded-lg border border-accent/25 bg-accent-soft/50 px-3 py-2.5 text-sm text-fg">
                <Radar className="size-4 animate-spin text-accent-fg [animation-duration:2.5s]" aria-hidden />
                Looking for devices… checking ports, mDNS and SSDP announcements.
              </div>
            )}
            {q.loading ? (
              <SkeletonRows rows={4} />
            ) : fresh.length === 0 ? (
              <EmptyState icon={Radar} title="Nothing new to adopt" className="py-8">
                {list.length ? 'Every device found so far is adopted or ignored. Scan again after plugging something new in.' : 'Run a scan to look for devices.'}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {fresh.map((d) => <DiscoveredRow key={d.ip} d={d} onAdopt={() => setAdopt(d)} onIgnore={() => ignore(d)} />)}
              </ul>
            )}
          </CardBody>
        </Card>

        {adopted.length > 0 && (
          <Card>
            <button type="button" onClick={() => setShowAdopted((s) => !s)} aria-expanded={showAdopted} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-fg">
              Already adopted ({adopted.length})
              <ChevronDown className={cn('size-4 text-muted transition-transform', showAdopted && 'rotate-180')} aria-hidden />
            </button>
            {showAdopted && (
              <ul className="divide-y divide-line border-t border-line px-4">
                {adopted.map((d) => (
                  <li key={d.ip} className="flex items-center gap-3 py-2.5 text-sm">
                    <KindIcon kind={d.kind_guess ?? 'other'} />
                    <span className="min-w-0 flex-1 truncate">{d.name ?? d.ip}</span>
                    <span className="font-mono text-xs text-muted">{d.ip}</span>
                    <Link to={`/devices/${d.adopted_device_id}`} className="text-xs font-medium text-accent-fg hover:underline">Open</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {ignored.length > 0 && (
          <Card>
            <button type="button" onClick={() => setShowIgnored((s) => !s)} aria-expanded={showIgnored} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-fg">
              Ignored ({ignored.length})
              <ChevronDown className={cn('size-4 text-muted transition-transform', showIgnored && 'rotate-180')} aria-hidden />
            </button>
            {showIgnored && (
              <ul className="divide-y divide-line border-t border-line px-4">
                {ignored.map((d) => (
                  <li key={d.ip} className="flex items-center gap-3 py-2.5 text-sm">
                    <KindIcon kind={d.kind_guess ?? 'other'} />
                    <span className="min-w-0 flex-1 truncate text-muted">{d.name ?? d.manufacturer ?? 'Unknown device'}</span>
                    <span className="font-mono text-xs text-muted">{d.ip}</span>
                    <Button size="xs" variant="ghost" onClick={() => setAdopt(d)}>Adopt anyway</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      <div className="space-y-3">
        <Card>
          <CardHeader title="What happens when you adopt" />
          <CardBody className="space-y-4 text-sm">
            <div className="flex gap-3">
              <TvMinimalPlay className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              <div>
                <p className="font-medium text-fg">NVIDIA Shield & Android TV</p>
                <p className="mt-0.5 text-muted">
                  First turn on <em>Network debugging</em>: Settings → Device Preferences → About → select <em>Build</em> 7 times, then Developer options → Network debugging.
                  When you adopt, the TV shows <strong className="text-fg">“Allow USB debugging?”</strong> — tick <em>Always allow from this computer</em> and press OK with the remote.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <Tv className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              <div>
                <p className="font-medium text-fg">Samsung & LG TVs</p>
                <p className="mt-0.5 text-muted">
                  The TV shows an <strong className="text-fg">“Allow”</strong> prompt the first time Screens connects. Choose Allow with the TV’s remote within 30 seconds. If you miss it, use <em>Re-pair</em> on the device.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <Speaker className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              <div>
                <p className="font-medium text-fg">Sonos</p>
                <p className="mt-0.5 text-muted">Nothing to accept — Sonos speakers work straight away.</p>
              </div>
            </div>
          </CardBody>
        </Card>
        <Callout kind="tip">New devices start in <strong className="text-fg">Monitor</strong> mode for {site.settings.monitor_days} days: nothing is blocked while Screens learns what they normally do.</Callout>
      </div>

      <AdoptDialog site={site} d={adopt} onClose={() => setAdopt(null)} />
    </div>
  );
}

function DiscoveredRow({ d, onAdopt, onIgnore }: { d: Discovered; onAdopt: () => void; onIgnore: () => void }) {
  const kind = d.kind_guess;
  const services = (d.hints.mdns ?? []).map((s) => MDNS_SERVICE_NAMES[s] ?? s);
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap">
      {kind ? <KindIcon kind={kind} boxed /> : <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-line-strong text-subtle"><CircleHelp className="size-4" aria-label="Unknown kind" /></span>}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{d.name ?? (d.manufacturer ? `${d.manufacturer} device` : 'Unknown device')}</p>
        <p className="truncate text-xs text-muted">
          <span className="font-mono">{d.ip}</span>
          {d.mac && <> · <span className="font-mono">{d.mac}</span></>}
          {d.model && <> · {d.model}</>}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Badge tone={kind ? 'accent' : 'neutral'}>{kind ? `Looks like: ${KIND[kind].label}` : 'Kind unknown'}</Badge>
          {services.slice(0, 3).map((s) => <Badge key={s}>{s}</Badge>)}
          {(d.hints.ports ?? []).length > 0 && <span className="text-[11px] text-subtle">ports {(d.hints.ports ?? []).join(', ')}</span>}
          <span className="text-[11px] text-subtle">· seen <RelTime ts={d.last_seen} /></span>
        </div>
      </div>
      <div className="flex w-full shrink-0 gap-1.5 sm:w-auto">
        <Button size="sm" variant="ghost" icon={EyeOff} onClick={onIgnore}>Ignore</Button>
        <Button size="sm" variant="primary" icon={Plus} onClick={onAdopt} className="flex-1 sm:flex-none">Adopt</Button>
      </div>
    </li>
  );
}

function AdoptDialog({ site, d, onClose }: { site: SiteDetail; d: Discovered | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [kind, setKind] = useState<DeviceKind>('android');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);
  const navigate = useNavigate();
  if (d && seed !== d.ip) {
    setSeed(d.ip);
    const k = d.kind_guess ?? 'other';
    setKind(k);
    setName(d.name && !d.name.startsWith('[') ? d.name : '');
    setRoom('');
    setPort(String(DEFAULT_PORT[k] ?? ''));
  }
  if (!d && seed) setSeed(null);
  const submit = async () => {
    if (!d) return;
    setBusy(true);
    const r = await act(() => api.sites.adopt(site.id, { ip: d.ip, kind, name: name.trim(), room: room.trim() || undefined, port: port ? Number(port) : undefined }), {
      success: kind === 'sonos' ? `Adopted ${name}` : `Adopted ${name}. Look at the TV now and accept the prompt with its remote.`,
      invalidate: [`discovered:${site.id}`, `site:${site.id}`, 'devices', 'sites', 'overview'],
    });
    setBusy(false);
    if (r) {
      onClose();
      invalidate('devices');
      navigate(`/devices/${r.id}`);
    }
  };
  const rooms = Array.from(new Set(site.devices.map((x) => x.room).filter(Boolean))) as string[];
  return (
    <Dialog
      open={!!d}
      onClose={onClose}
      title="Adopt device"
      description={d ? <>At <span className="font-mono">{d.ip}</span>{d.manufacturer ? ` · ${d.manufacturer}` : ''}</> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>Adopt</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void submit(); }}>
        <Field label="Name" htmlFor="adopt-name" hint="What you’d call it, e.g. “Lounge TV”.">
          <Input id="adopt-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Room" htmlFor="adopt-room" optional>
            <Input id="adopt-room" value={room} onChange={(e) => setRoom(e.target.value)} list="adopt-rooms" />
            <datalist id="adopt-rooms">{rooms.map((r) => <option key={r} value={r} />)}</datalist>
          </Field>
          <Field label="Kind" htmlFor="adopt-kind">
            <Select id="adopt-kind" value={kind} onChange={(e) => { const k = e.target.value as DeviceKind; setKind(k); setPort(String(DEFAULT_PORT[k] ?? '')); }}>
              {(Object.keys(KIND) as DeviceKind[]).map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Port" htmlFor="adopt-port" optional hint="Leave the default unless you changed it on the device.">
          <Input id="adopt-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} className="w-28" mono />
        </Field>
        {kind === 'android' && <Callout kind="info">After you click Adopt, the TV shows <strong className="text-fg">“Allow USB debugging?”</strong>. Tick “Always allow from this computer” and press OK with the remote.</Callout>}
        {(kind === 'samsung' || kind === 'lg') && <Callout kind="info">After you click Adopt, the TV shows an <strong className="text-fg">Allow</strong> prompt. Choose Allow with the TV remote within 30 seconds.</Callout>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

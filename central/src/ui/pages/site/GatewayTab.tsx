import { useState } from 'react';
import { Router, Plus, RotateCw, ArrowUpCircle, Ban, Terminal, CircleCheck, CircleX, Server, Wifi, ScrollText, RefreshCw } from 'lucide-react';
import type { EnrollResult, SiteDetail } from '../../../shared/types';
import { api, ApiError } from '../../api';
import { act, invalidate, useQuery } from '../../lib/query';
import { cmpVersion, fmtBytes, fmtDuration, fmtNum, fmtPct, relTime } from '../../lib/format';
import { Badge, Button, Callout, Card, CardBody, CardHeader, CopyButton, EmptyState, IconButton, KeyVal, RelTime, SkeletonRows, cn } from '../../components/ui';
import { ConfirmDialog } from '../../components/overlay';
import { Meter } from '../../components/charts';
import { GatewayBadge } from '../../components/status';
import { NetworkInterfaces } from './NetworkInterfaces';

export function GatewayTab({ site }: { site: SiteDetail }) {
  const has = site.gateway && site.gateway.status !== 'revoked';
  const [enroll, setEnroll] = useState<EnrollResult | null>(null);
  if (!has || enroll) return <AddGateway site={site} result={enroll} setResult={setEnroll} revoked={site.gateway?.status === 'revoked'} />;
  return <GatewayStatus site={site} />;
}

function AddGateway({ site, result, setResult, revoked }: { site: SiteDetail; result: EnrollResult | null; setResult: (r: EnrollResult | null) => void; revoked: boolean }) {
  const [busy, setBusy] = useState(false);
  // Poll while waiting so the page flips to the status view when the gateway connects.
  useQuery(result ? `site:${site.id}:enroll-wait` : null, async () => {
    const s = await api.sites.get(site.id);
    if (s.gateway && s.gateway.status === 'online') {
      setResult(null);
      invalidate(`site:${site.id}`);
    }
    return s.gateway_status;
  }, { refreshMs: 5000 });

  const start = async () => {
    setBusy(true);
    const r = await act(() => api.sites.enroll(site.id), { error: 'Couldn’t create an install command' });
    setBusy(false);
    if (r) setResult(r);
  };

  if (!result) {
    return (
      <Card>
        <EmptyState
          icon={Router}
          title={revoked ? 'This site’s gateway was revoked' : 'This site doesn’t have a gateway yet'}
          action={<Button variant="primary" icon={Plus} loading={busy} onClick={start}>{revoked ? 'Add a new gateway' : 'Add gateway'}</Button>}
        >
          The gateway is a small program that runs on an always-on Linux machine at the site. It answers DNS (that’s how it blocks spying), finds devices and passes your remote-control commands to them.
          No ports need to be opened — it connects out to Screens.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader title="Install the gateway" icon={Terminal} subtitle={<>This command works once and expires {relTime(result.expires_at)}.</>} />
        <CardBody className="space-y-5">
          <div>
            <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-3">
              <code className="min-w-0 flex-1 font-mono text-[12.5px] leading-relaxed break-all text-fg select-all">{result.command}</code>
              <CopyButton text={result.command} />
            </div>
          </div>
          <ol className="space-y-4 text-sm">
            {[
              ['Get a Linux machine at the site', 'A small virtual machine on the site’s server or a mini PC is perfect. Ubuntu 24.04 or Debian 12 work well. It needs about 1 GB of memory and must stay on.'],
              ['Connect it to every network you want covered', 'The gateway needs to reach each VLAN with TVs, boxes or speakers. Start with one network; once it’s online you can add the other VLANs from this Gateway tab (Network interfaces → Add network), either as tagged VLANs on its port or as extra network devices on the VM.'],
              ['Paste the command', 'Open a terminal on the VM (or SSH in) and paste the command above. It installs Docker if needed and starts the Screens gateway. It takes about a minute.'],
              ['Point DNS at the gateway', 'In your router’s DHCP settings, hand out the gateway’s IP address as the DNS server on each VLAN. Devices pick it up the next time they reconnect.'],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-fg">{i + 1}</span>
                <div>
                  <p className="font-medium text-fg">{t}</p>
                  <p className="mt-0.5 text-muted">{d}</p>
                </div>
              </li>
            ))}
          </ol>
          <Callout kind="info" title="Waiting for the gateway to connect…">
            This page updates by itself when the gateway connects. If the command has expired, create a new one.
          </Callout>
        </CardBody>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader title="What it needs" />
          <CardBody>
            <ul className="space-y-2 text-sm text-muted">
              <li className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-fg" aria-hidden />Linux (x86-64 or ARM64) with internet access</li>
              <li className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-fg" aria-hidden />A fixed IP on each VLAN (set a DHCP reservation)</li>
              <li className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-fg" aria-hidden />Port 53 free (the installer handles systemd-resolved)</li>
              <li className="flex gap-2"><CircleX className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />No port forwarding or firewall holes needed</li>
            </ul>
          </CardBody>
        </Card>
        <div className="flex flex-wrap gap-2">
          <Button icon={RefreshCw} onClick={async () => setResult((await act(() => api.sites.enroll(site.id))) ?? result)}>New command</Button>
          <Button variant="ghost" onClick={() => setResult(null)}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

function GatewayStatus({ site }: { site: SiteDetail }) {
  const q = useQuery(`gateway:${site.id}`, () => api.sites.gateway(site.id), { refreshMs: 15_000 });
  const [confirm, setConfirm] = useState<null | 'restart' | 'update' | 'revoke'>(null);
  const g = q.data;
  if (q.error instanceof ApiError && q.error.status === 404) return <AddGateway site={site} result={null} setResult={() => invalidate(`site:${site.id}`)} revoked={false} />;
  if (!g) return <SkeletonRows rows={6} />;

  const online = g.status === 'online';
  const updatable = !!g.latest_version && cmpVersion(g.latest_version, g.version) > 0;
  const mem = g.metrics?.mem;
  const dns = g.metrics?.dns;
  const runAction = async (a: 'restart' | 'update' | 'revoke') => {
    const msg = { restart: 'Restarting the gateway. It’s back in about 20 seconds.', update: `Updating to ${g.latest_version}. The gateway restarts when it’s done.`, revoke: 'Gateway revoked. It can no longer connect.' }[a];
    const r = await act(() => api.sites.gatewayAction(site.id, a), { success: msg, invalidate: [`gateway:${site.id}`, `site:${site.id}`, 'sites', 'overview'] });
    if (r) setConfirm(null);
  };

  return (
    <div className="space-y-4">
      {!online && (
        <Callout kind="crit" title="The gateway is offline">
          Last heard from <RelTime ts={g.last_seen} />. DNS at the site keeps working with the last settings it received, but remote control and live logs are paused. Check the machine is on and has internet.
        </Callout>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title={g.hostname ?? 'Gateway'}
            icon={Server}
            subtitle={<GatewayBadge status={g.status} />}
            actions={
              <>
                <Button size="sm" icon={RotateCw} onClick={() => setConfirm('restart')} disabled={!online}>Restart</Button>
                <Button size="sm" icon={ArrowUpCircle} variant={updatable ? 'primary' : 'secondary'} onClick={() => setConfirm('update')} disabled={!online || !updatable} title={updatable ? undefined : 'Already up to date'}>
                  {updatable ? `Update to ${g.latest_version}` : 'Up to date'}
                </Button>
                <Button size="sm" icon={Ban} variant="danger-ghost" onClick={() => setConfirm('revoke')}>Revoke</Button>
              </>
            }
          />
          <CardBody>
            <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <KeyVal
                items={[
                  ['Version', <span className="inline-flex items-center gap-2">{g.version ?? '–'}{updatable && <Badge tone="accent">Update available</Badge>}</span>],
                  ['System', [g.os, g.arch].filter(Boolean).join(' / ') || '–'],
                  ['Uptime', fmtDuration(g.metrics?.uptime_s)],
                  ['Connected', g.connected_at ? <RelTime ts={g.connected_at} /> : '–'],
                  ['Last heard', <RelTime ts={g.last_seen} />],
                ]}
              />
              <div className="space-y-3">
                <div>
                  <p className="mb-1 flex justify-between text-xs text-muted"><span>Load (1 / 5 / 15 min)</span><span className="text-fg tnum">{g.metrics?.load?.map((l) => l.toFixed(2)).join(' / ') ?? '–'}</span></p>
                </div>
                {mem && (
                  <div>
                    <p className="mb-1 flex justify-between text-xs text-muted">
                      <span>Memory used</span>
                      <span className="text-fg tnum">{fmtBytes(mem.total - mem.available)} of {fmtBytes(mem.total)}</span>
                    </p>
                    <Meter value={mem.total - mem.available} max={mem.total} tone={(mem.total - mem.available) / mem.total > 0.85 ? 'crit' : 'accent'} label="Gateway memory used" />
                  </div>
                )}
                {dns && (
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div><dt className="text-xs text-muted">Lookups / sec</dt><dd className="font-semibold text-fg tnum">{dns.qps_1m.toFixed(1)}</dd></div>
                    <div><dt className="text-xs text-muted">Answered from cache</dt><dd className="font-semibold text-fg tnum">{fmtPct(dns.cache_hits, dns.queries)}</dd></div>
                    <div><dt className="text-xs text-muted">Blocked today</dt><dd className="font-semibold text-fg tnum">{fmtNum(dns.blocked)}</dd></div>
                    <div><dt className="text-xs text-muted">Upstream errors</dt><dd className={cn('font-semibold tnum', dns.upstream_errors ? 'text-warn-fg' : 'text-fg')}>{fmtNum(dns.upstream_errors)}</dd></div>
                  </dl>
                )}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="DNS is answered at" icon={Wifi} subtitle="Hand these out as the DNS server in your router’s DHCP settings." />
          <CardBody className="space-y-3">
            <ul className="space-y-1.5">
              {(g.dns_listening ?? []).map((a) => (
                <li key={a} className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-2.5 py-1.5">
                  <span className="font-mono text-[13px] text-fg">{a.replace(/:53$/, '')}</span>
                  <span className="text-xs text-muted">DNS · port 53</span>
                </li>
              ))}
              {(g.dot_listening ?? []).map((a) => (
                <li key={a} className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-2.5 py-1.5">
                  <span className="font-mono text-[13px] text-fg">{a.replace(/:853$/, '')}</span>
                  <span className="text-xs text-muted">Private DNS · port 853</span>
                </li>
              ))}
              {!g.dns_listening?.length && <li className="text-sm text-muted">Not listening on any address yet.</li>}
            </ul>
            {!!g.caps?.length && (
              <div>
                <p className="mb-1.5 text-xs text-muted">Features</p>
                <div className="flex flex-wrap gap-1">{g.caps.map((c) => <Badge key={c} mono>{c}</Badge>)}</div>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <NetworkInterfaces site={site} />

      <Card>
        <CardHeader title="Recent gateway log" icon={ScrollText} actions={<IconButton icon={RefreshCw} label="Refresh log" size="sm" loading={q.fetching} onClick={() => q.refetch()} />} />
        <CardBody>
          <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-fg">
            {g.logs.length ? g.logs.join('\n') : 'No log lines yet.'}
          </pre>
          <div className="mt-2 flex justify-end">
            <CopyButton text={g.logs.join('\n')} label="Copy log" size="xs" variant="ghost" />
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog open={confirm === 'restart'} onClose={() => setConfirm(null)} title="Restart the gateway?" confirmLabel="Restart" onConfirm={() => runAction('restart')}>
        <p>DNS at {site.name} pauses for about 20 seconds while it restarts. Devices may briefly show “No internet”.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'update'} onClose={() => setConfirm(null)} title={`Update to ${g.latest_version}?`} confirmLabel="Update" onConfirm={() => runAction('update')}>
        <p>The gateway downloads the new version, checks it, and restarts. DNS pauses for under a minute.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'revoke'} onClose={() => setConfirm(null)} danger title="Revoke this gateway?" confirmLabel="Revoke gateway" typeToConfirm={site.name} onConfirm={() => runAction('revoke')}>
        <p>The gateway is disconnected immediately and can never reconnect. Remote control, discovery and live logs stop for {site.name}.</p>
        <p>To use the machine again you’ll need to run a new install command. Do this if the machine was lost, stolen or replaced.</p>
      </ConfirmDialog>
    </div>
  );
}


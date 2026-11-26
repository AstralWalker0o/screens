import { useEffect, useState } from 'react';
import { Save, ShieldCheck, Radio, Ban, Check } from 'lucide-react';
import type { Device, DnsMode, DnsPolicyName } from '../../../shared/types';
import { api } from '../../api';
import { act, setQueryData, useQuery } from '../../lib/query';
import { fmtDate } from '../../lib/format';
import { DNS_MODE, DNS_MODES, POLICIES, POLICY } from '../../lib/labels';
import { DnsChartCard } from '../../components/charts';
import { DnsLiveLog } from '../../components/DnsLog';
import { Button, Callout, Card, CardBody, CardHeader, Skeleton, cn } from '../../components/ui';
import { ChipsInput, Field, Select, isDomain } from '../../components/forms';
import { MODE_ICON } from '../../components/status';

export function NetworkTab({ device: d }: { device: Device }) {
  const privacy = useQuery(`privacy:${d.id}`, () => api.devices.privacy(d.id));
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        {privacy.data ? (
          <DnsChartCard series={privacy.data.dns.series} title={`${d.name} — DNS lookups, last 24 hours`} height={220} />
        ) : (
          <Card className="p-4"><Skeleton className="mb-3 h-4 w-48" /><Skeleton className="h-52" /></Card>
        )}
        <DnsSettings device={d} />
      </div>
      <Card>
        <CardHeader title="Live lookups from this device" icon={Radio} subtitle="Click a domain to block or allow it for just this device, the site, or everywhere." />
        <CardBody>
          <DnsLiveLog siteId={d.site_id} deviceId={d.id} height={460} onDeviceListChange={(nd) => setQueryData(`device:${d.id}`, () => nd)} />
        </CardBody>
      </Card>
    </div>
  );
}

function DnsSettings({ device: d }: { device: Device }) {
  const [mode, setMode] = useState<DnsMode>(d.dns_mode);
  const [policy, setPolicy] = useState<DnsPolicyName>(d.dns_policy);
  const [allow, setAllow] = useState(d.dns_allow);
  const [block, setBlock] = useState(d.dns_block);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMode(d.dns_mode);
    setPolicy(d.dns_policy);
    setAllow(d.dns_allow);
    setBlock(d.dns_block);
  }, [d.dns_mode, d.dns_policy, d.dns_allow, d.dns_block]);
  const dirty = mode !== d.dns_mode || policy !== d.dns_policy || JSON.stringify(allow) !== JSON.stringify(d.dns_allow) || JSON.stringify(block) !== JSON.stringify(d.dns_block);

  const save = async () => {
    setBusy(true);
    const r = await act(() => api.devices.update(d.id, { dns_mode: mode, dns_policy: policy, dns_allow: allow, dns_block: block }), {
      success: 'DNS settings saved. The gateway applies them within a minute.',
      invalidate: ['devices', `site:${d.site_id}`, `privacy:${d.id}`],
    });
    setBusy(false);
    if (r) setQueryData(`device:${d.id}`, () => r);
  };

  return (
    <Card>
      <CardHeader title="DNS filtering for this device" icon={ShieldCheck} />
      <CardBody className="space-y-5">
        <div role="radiogroup" aria-label="DNS mode" className="grid grid-cols-2 gap-2">
          {DNS_MODES.map((m) => {
            const Icon = MODE_ICON[m];
            const on = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setMode(m)}
                className={cn('rounded-lg border p-2.5 text-left transition-colors', on ? 'border-accent bg-accent-soft/60 ring-1 ring-accent' : 'border-line hover:border-line-strong')}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-fg"><Icon className="size-3.5" aria-hidden />{DNS_MODE[m].label}</span>
                <span className="mt-0.5 block text-xs text-muted">{DNS_MODE[m].short}</span>
              </button>
            );
          })}
        </div>
        <p className="-mt-2 text-xs text-muted">{DNS_MODE[mode].help}</p>
        {mode === 'monitor' && d.dns_mode === 'monitor' && d.monitor_until && (
          <Callout kind="info">Monitoring until {fmtDate(d.monitor_until)}, then Screens switches to <strong className="text-fg">Enforce</strong> with the {POLICY[policy].label} policy.</Callout>
        )}
        {mode === 'bypass' && <Callout kind="warn">Nothing is filtered or logged for this device — it won’t get a privacy score.</Callout>}
        <Field label="Policy" htmlFor="dev-policy" hint={POLICY[policy].help}>
          <Select id="dev-policy" value={policy} onChange={(e) => setPolicy(e.target.value as DnsPolicyName)} disabled={mode === 'off' || mode === 'bypass'}>
            {POLICIES.map((p) => <option key={p} value={p}>{POLICY[p].label}</option>)}
          </Select>
        </Field>
        <Field label={<span className="inline-flex items-center gap-1.5"><Ban className="size-3.5 text-crit-fg" aria-hidden />Always block for this device</span>} hint="Blocks the domain and everything under it, even if the policy allows it.">
          <ChipsInput value={block} onChange={setBlock} mono validate={isDomain} placeholder="ads.example.com" ariaLabel="Domains to always block" />
        </Field>
        <Field label={<span className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-ok-fg" aria-hidden />Always allow for this device</span>} hint="Use when blocking breaks an app on this device only.">
          <ChipsInput value={allow} onChange={setAllow} mono validate={isDomain} placeholder="api.example.com" ariaLabel="Domains to always allow" />
        </Field>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          {dirty && <Button variant="ghost" onClick={() => { setMode(d.dns_mode); setPolicy(d.dns_policy); setAllow(d.dns_allow); setBlock(d.dns_block); }}>Discard</Button>}
          <Button variant="primary" icon={Save} loading={busy} disabled={!dirty} onClick={save}>Save</Button>
        </div>
      </CardBody>
    </Card>
  );
}

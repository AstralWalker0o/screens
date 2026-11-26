import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Save, Settings2, ShieldCheck, KeyRound, Trash2, Lock, Network, RotateCw } from 'lucide-react';
import type { DnsMode, DnsPolicyName, SiteDetail, SiteKind } from '../../../shared/types';
import { api } from '../../api';
import { act, setQueryData } from '../../lib/query';
import { allTimezones, DNS_MODE, DNS_MODES, POLICIES, POLICY, SITE_KIND } from '../../lib/labels';
import { Badge, Button, Callout, Card, CardBody, CardHeader, CopyButton, KeyVal } from '../../components/ui';
import { ChipsInput, Field, Input, Segmented, Select, Textarea, Toggle } from '../../components/forms';
import { ConfirmDialog } from '../../components/overlay';

type Form = Pick<SiteDetail, 'name' | 'kind' | 'timezone' | 'address' | 'notes'> & { settings: SiteDetail['settings'] };

const isCidr = (s: string) => (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s) ? null : `“${s}” should look like 10.0.20.0/24`);

export function SiteSettingsTab({ site }: { site: SiteDetail }) {
  const init = (): Form => ({ name: site.name, kind: site.kind, timezone: site.timezone, address: site.address ?? '', notes: site.notes ?? '', settings: structuredClone(site.settings) });
  const [f, setF] = useState<Form>(init);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const navigate = useNavigate();
  useEffect(() => setF(init()), [site.id]);
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const s = f.settings;
  const setS = (p: Partial<SiteDetail['settings']>) => setF({ ...f, settings: { ...s, ...p } });

  const save = async () => {
    setBusy(true);
    const r = await act(() => api.sites.update(site.id, { name: f.name.trim(), kind: f.kind, timezone: f.timezone, address: f.address || null, notes: f.notes || null, settings: f.settings }), {
      success: 'Site settings saved',
      invalidate: ['sites', 'overview'],
    });
    setBusy(false);
    if (r) setQueryData(`site:${site.id}`, () => r);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Site details" icon={Settings2} />
        <CardBody className="space-y-4">
          <Field label="Name" htmlFor="s-name"><Input id="s-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Kind of place">
            <Segmented<SiteKind> ariaLabel="Kind of place" value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={(['residential', 'rental', 'business'] as SiteKind[]).map((k) => ({ value: k, label: SITE_KIND[k].label }))} />
            <p className="mt-1.5 text-xs text-muted">{SITE_KIND[f.kind].help}</p>
          </Field>
          <Field label="Time zone" htmlFor="s-tz" hint="Used for schedules and the times in charts for this site.">
            <Select id="s-tz" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
              {allTimezones().map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
          <Field label="Address" htmlFor="s-addr" optional><Input id="s-addr" value={f.address ?? ''} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label="Notes" htmlFor="s-notes" optional hint="For you: where the router is, lockbox codes, quirks."><Textarea id="s-notes" rows={3} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </CardBody>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader title="DNS filtering" icon={ShieldCheck} />
          <CardBody className="space-y-5">
            <Field label="Watch new devices for" htmlFor="s-mon" hint="“Monitor” blocks nothing but records what would be blocked. After this many days the device switches to “Enforce” by itself. Use 0 to enforce straight away.">
              <div className="flex items-center gap-2">
                <Input id="s-mon" type="number" min={0} max={60} className="w-24" value={s.monitor_days} onChange={(e) => setS({ monitor_days: Number(e.target.value) })} />
                <span className="text-sm text-muted">days</span>
              </div>
            </Field>
            <Field label="Policy after monitoring" htmlFor="s-pol" hint={POLICY[s.default_policy].help}>
              <Select id="s-pol" value={s.default_policy} onChange={(e) => setS({ default_policy: e.target.value as DnsPolicyName })}>
                {POLICIES.map((p) => <option key={p} value={p}>{POLICY[p].label}</option>)}
              </Select>
            </Field>
            <Field label="Phones, laptops and other unknown devices" htmlFor="s-unk" hint={`Anything that isn’t an adopted device — guests’ phones, laptops. ${DNS_MODE[s.unknown_clients].help}`}>
              <Select id="s-unk" value={s.unknown_clients} onChange={(e) => setS({ unknown_clients: e.target.value as DnsMode })}>
                {DNS_MODES.map((m) => <option key={m} value={m}>{DNS_MODE[m].label}</option>)}
              </Select>
            </Field>
            <Field label="Extra networks to scan" hint="Discovery always scans the gateway’s own networks. Add others here if devices live on a routed subnet.">
              <ChipsInput value={s.scan_cidrs} onChange={(scan_cidrs) => setS({ scan_cidrs })} mono validate={isCidr} placeholder="10.0.40.0/24" ariaLabel="Extra networks to scan" />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Private DNS for Android" icon={KeyRound} />
          <CardBody className="space-y-4">
            <Toggle
              checked={s.dot_enabled}
              onChange={(v) => setS({ dot_enabled: v })}
              label="Offer encrypted DNS (DNS-over-TLS) at this site"
              description="Android boxes can then be pointed at this site’s Private DNS hostname, so apps can’t sidestep the filter. Turn it on per device from its Privacy tab."
            />
            <KeyVal
              items={[
                ['Hostname', site.dot_hostname ? (
                  <span className="inline-flex flex-wrap items-center gap-2"><span className="font-mono text-[13px]">{site.dot_hostname}</span><CopyButton text={site.dot_hostname} size="xs" variant="ghost" /></span>
                ) : s.dot_enabled ? 'A random name is assigned when you save' : 'A random name is assigned when you turn this on'],
                ['Status', site.dot_status ? <Badge tone={/active|issued/i.test(site.dot_status) ? 'ok' : /off/i.test(site.dot_status) ? 'neutral' : 'warn'} icon={Lock}>{/^error/.test(site.dot_status) ? 'Error' : site.dot_status}</Badge> : '–'],
              ]}
            />
            {site.dot_status?.startsWith('error') && site.settings.dot_enabled && (
              <Callout
                kind="warn"
                title="The certificate couldn’t be issued yet"
                action={<Button size="sm" icon={RotateCw} onClick={() => act(() => api.sites.retryDot(site.id), { success: 'Retrying. This usually takes a couple of minutes.', invalidate: [`site:${site.id}`] })}>Retry now</Button>}
              >
                {site.dot_status.replace(/^error:\s*/, '')} Screens retries automatically every 30 minutes.
              </Callout>
            )}
            {s.dot_enabled !== site.settings.dot_enabled && s.dot_enabled && (
              <Callout kind="info">After saving, Screens publishes the hostname and gets a certificate for it. This usually takes a couple of minutes.</Callout>
            )}
          </CardBody>
        </Card>

        <Card className="border-crit/30">
          <CardHeader title="Danger zone" icon={Network} />
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-sm text-sm text-muted">Deleting the site removes its devices and history and disconnects its gateway.</p>
            <Button variant="danger-ghost" icon={Trash2} onClick={() => setDel(true)}>Delete site…</Button>
          </CardBody>
        </Card>
      </div>

      {dirty && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-line bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur lg:col-span-2">
          <span className="mr-auto text-sm text-muted">Unsaved changes to {site.name}.</span>
          <Button variant="ghost" onClick={() => setF(init())}>Discard</Button>
          <Button variant="primary" icon={Save} loading={busy} disabled={!f.name.trim()} onClick={save}>Save changes</Button>
        </div>
      )}

      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        danger
        title={`Delete ${site.name}?`}
        confirmLabel="Delete site"
        typeToConfirm={site.name}
        onConfirm={async () => {
          const ok = await act(() => api.sites.remove(site.id), { success: `Deleted ${site.name}`, invalidate: ['sites', 'overview', 'devices'] });
          if (ok) navigate('/sites');
        }}
      >
        <p>This removes {site.devices.length} devices and all their history, and disconnects the gateway. The TVs and speakers themselves aren’t changed.</p>
      </ConfirmDialog>
    </div>
  );
}

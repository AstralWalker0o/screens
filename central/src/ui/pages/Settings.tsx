import { useEffect, useState } from 'react';
import { Save, KeyRound, CircleCheck, CircleDashed, ShieldCheck, Router, Palette, Info, Lock, Sun, Moon, Monitor, FlaskConical } from 'lucide-react';
import type { AppSettings, DnsPolicyName } from '../../shared/types';
import { api, MOCK, setMockMode } from '../api';
import { act, errorMessage, setQueryData, useQuery } from '../lib/query';
import { POLICIES, POLICY } from '../lib/labels';
import { useTheme, type ThemePref } from '../lib/theme';
import { toast } from '../lib/toast';
import { Button, Card, CardBody, CardHeader, KeyVal, PageHeader, SkeletonRows, StatusText } from '../components/ui';
import { Field, Input, Segmented, Select, Toggle } from '../components/forms';
import { ConfirmDialog } from '../components/overlay';

const DEFAULT_DOT = 'dns.screens.supercluster.au';

export default function Settings() {
  const q = useQuery('settings', api.settings.get);
  const me = useQuery('me', api.me, { staleMs: 600_000 });
  const [form, setForm] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);

  const dirty = !!form && !!q.data && (['dot_base_domain', 'default_monitor_days', 'default_policy', 'dns_log_retention_days'] as const).some((k) => form[k] !== q.data![k]);
  const save = async () => {
    if (!form) return;
    setBusy(true);
    const r = await act(
      () => api.settings.save({
        dot_base_domain: form.dot_base_domain?.trim() || null,
        default_monitor_days: Number(form.default_monitor_days),
        default_policy: form.default_policy,
        dns_log_retention_days: Number(form.dns_log_retention_days),
      }),
      { success: 'Settings saved' },
    );
    setBusy(false);
    if (r) {
      setQueryData('settings', () => r);
      setForm(r);
    }
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Defaults for new sites and devices, Private DNS and appearance." />
      {!form ? (
        <SkeletonRows rows={8} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <Card>
              <CardHeader title="DNS defaults" icon={ShieldCheck} subtitle="Used when you create a site or adopt a device. Each site can override them." />
              <CardBody className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Monitor new devices for" htmlFor="mon-days" hint="New devices start in Monitor mode: nothing is blocked, but Screens logs what would be. After this many days it switches to Enforce by itself.">
                    <div className="flex items-center gap-2">
                      <Input id="mon-days" type="number" min={0} max={60} className="w-24" value={form.default_monitor_days} onChange={(e) => setForm({ ...form, default_monitor_days: Number(e.target.value) })} />
                      <span className="text-sm text-muted">days</span>
                    </div>
                  </Field>
                  <Field label="Keep the DNS lookup log for" htmlFor="ret-days" hint="Individual lookups older than this are deleted. Shorter keeps less history about what people watch.">
                    <div className="flex items-center gap-2">
                      <Input id="ret-days" type="number" min={1} max={365} className="w-24" value={form.dns_log_retention_days} onChange={(e) => setForm({ ...form, dns_log_retention_days: Number(e.target.value) })} />
                      <span className="text-sm text-muted">days</span>
                    </div>
                  </Field>
                </div>
                <Field label="Policy after monitoring" htmlFor="def-policy" hint={POLICY[form.default_policy].help}>
                  <Select id="def-policy" className="sm:w-64" value={form.default_policy} onChange={(e) => setForm({ ...form, default_policy: e.target.value as DnsPolicyName })}>
                    {POLICIES.map((p) => <option key={p} value={p}>{POLICY[p].label}</option>)}
                  </Select>
                </Field>
              </CardBody>
            </Card>

            <PrivateDnsCard form={form} setForm={setForm} saved={q.data} />

            {dirty && (
              <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-line bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur">
                <span className="mr-auto text-sm text-muted">You have unsaved changes.</span>
                <Button variant="ghost" onClick={() => setForm(q.data ?? null)}>Discard</Button>
                <Button variant="primary" icon={Save} loading={busy} onClick={save}>Save settings</Button>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <AppearanceCard />
            <Card>
              <CardHeader title="Gateway software" icon={Router} />
              <CardBody>
                <KeyVal items={[['Latest version', q.data?.agent_latest_version ?? 'Not published yet']]} />
                <p className="mt-3 text-xs text-muted">Each site’s Gateway tab shows its version and offers an update when this is newer.</p>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="About Screens" icon={Info} />
              <CardBody className="space-y-3 text-sm text-muted">
                <KeyVal items={[['Version', 'Central 0.1.0'], ['Signed in as', me.data?.email ?? '…'], ['Sign-in', me.data?.dev ? 'Local development (no Cloudflare Access)' : 'Cloudflare Access']]} />
                <p>
                  Screens watches what your TVs, streaming boxes and speakers talk to, blocks the spying (ACR, ads, telemetry) with a DNS filter at each site, and lets you control the devices from anywhere.
                </p>
                <p className="flex items-start gap-2 text-xs">
                  <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  This dashboard loads no third-party fonts, analytics or trackers.
                </p>
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function PrivateDnsCard({ form, setForm, saved }: { form: AppSettings; setForm: (f: AppSettings) => void; saved?: AppSettings }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isSet = !!saved?.cf_dns_token_set;
  const base = form.dot_base_domain || DEFAULT_DOT;

  const putToken = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.settings.save({ cf_dns_token: value });
      setQueryData<AppSettings>('settings', (old) => ({ ...(old ?? r), ...r, cf_dns_token_set: r.cf_dns_token_set ?? value !== '' }));
      setToken('');
      toast.success(value ? 'Cloudflare token saved' : 'Cloudflare token removed');
      return true;
    } catch (e) {
      setError(errorMessage(e));
      toast.error(value ? 'Token not saved' : 'Couldn’t remove the token', errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Private DNS (Android)" icon={KeyRound} subtitle="Encrypted DNS that Android TV boxes can’t sidestep." />
      <CardBody className="space-y-5">
        <p className="text-sm text-muted">
          Android’s Private DNS setting sends every lookup to Screens over an encrypted connection (DNS-over-TLS), even if an app or the network tries to use a different DNS server. Each site gets its own hostname, such as <span className="font-mono text-fg">beach-house.{base}</span>.
        </p>
        <Field label="DNS-over-TLS base domain" htmlFor="dot-base" hint="Site hostnames are created under this domain. Change it only if you use your own domain.">
          <Input id="dot-base" mono placeholder={DEFAULT_DOT} value={form.dot_base_domain ?? ''} onChange={(e) => setForm({ ...form, dot_base_domain: e.target.value })} className="sm:max-w-sm" />
        </Field>

        <div className="rounded-lg border border-line bg-surface-2/60 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-fg">Cloudflare DNS token</p>
            {isSet ? (
              <StatusText tone="ok" icon={CircleCheck}>Saved ✓</StatusText>
            ) : (
              <StatusText tone="neutral" icon={CircleDashed}>Not set</StatusText>
            )}
          </div>
          <p className="mt-1.5 text-xs text-muted">
            Create a token in Cloudflare → My Profile → API Tokens → Create Token → template “Edit zone DNS” → Zone: supercluster.au. Screens uses it only to publish each site’s DNS-over-TLS hostname and its certificate challenge.
          </p>
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) void putToken(token.trim());
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Cloudflare API token"
                placeholder={isSet ? 'Paste a new token to replace the saved one' : 'Paste the API token'}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setError(null);
                }}
                aria-invalid={!!error}
                aria-describedby={error ? 'cf-token-error' : undefined}
                mono
              />
              {error && <p id="cf-token-error" className="mt-1 text-xs text-crit-fg">{error}</p>}
            </div>
            <Button type="submit" variant="primary" icon={Save} loading={busy && !!token} disabled={!token.trim()}>
              {isSet ? 'Replace token' : 'Save token'}
            </Button>
          </form>
          {isSet && (
            <button type="button" className="mt-2 text-xs font-medium text-crit-fg hover:underline" onClick={() => setConfirmRemove(true)}>
              Remove token
            </button>
          )}
        </div>
      </CardBody>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        danger
        title="Remove the Cloudflare token?"
        confirmLabel="Remove token"
        onConfirm={async () => {
          if (await putToken('')) setConfirmRemove(false);
        }}
      >
        <p>Existing Private DNS hostnames keep working until their certificates expire, but Screens won’t be able to create hostnames for new sites or renew certificates.</p>
      </ConfirmDialog>
    </Card>
  );
}

function AppearanceCard() {
  const { pref, setPref } = useTheme();
  return (
    <Card>
      <CardHeader title="Appearance" icon={Palette} />
      <CardBody className="space-y-4">
        <Field label="Theme">
          <Segmented<ThemePref>
            ariaLabel="Theme"
            value={pref}
            onChange={setPref}
            options={[
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'system', label: 'System', icon: Monitor },
              { value: 'dark', label: 'Dark', icon: Moon },
            ]}
          />
        </Field>
        <Toggle
          checked={MOCK}
          onChange={(v) => setMockMode(v)}
          label={<span className="inline-flex items-center gap-1.5"><FlaskConical className="size-3.5" aria-hidden />Demo data</span>}
          description="Show a made-up fleet instead of your real one. Handy for trying things without touching real TVs. Reloads the page."
        />
      </CardBody>
    </Card>
  );
}

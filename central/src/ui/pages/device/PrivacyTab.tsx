import { useState } from 'react';
import { Link } from 'react-router';
import { ShieldCheck, ShieldAlert, ListChecks, Mic, CircleCheck, TriangleAlert, CircleX, ChevronDown, KeyRound, Radar, Sparkles, Lock } from 'lucide-react';
import type { Device, DevicePrivacy } from '../../../shared/types';
import { api } from '../../api';
import { act, setQueryData, useQuery } from '../../lib/query';
import { sendCommand } from '../../lib/commands';
import { fmtCompact, fmtNum } from '../../lib/format';
import { CATEGORY, GRADE, type Grade } from '../../lib/labels';
import { useTheme } from '../../lib/theme';
import { BarList, Meter, SegmentedBar } from '../../components/charts';
import { Badge, Button, ButtonLink, Callout, Card, CardBody, CardHeader, Skeleton, SkeletonRows, StatusText, cn } from '../../components/ui';
import { Toggle } from '../../components/forms';
import { GradeBadge } from '../../components/status';

export function PrivacyTab({ device: d }: { device: Device }) {
  const key = `privacy:${d.id}`;
  const q = useQuery(key, () => api.devices.privacy(d.id));
  const p = q.data;
  if (q.loading || !p) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5"><Skeleton className="h-16 w-40" /><SkeletonRows rows={4} className="mt-6" /></Card>
        <Card className="p-5"><SkeletonRows rows={6} /></Card>
      </div>
    );
  }
  const pending = d.privacy_score == null;
  return (
    <div className="space-y-4">
      {p.bypass_suspected && (
        <Callout
          kind="crit"
          title={`${d.name} may be bypassing Screens’ DNS filter`}
          action={d.capabilities.includes('private_dns') ? <Button size="sm" variant="primary" icon={KeyRound} onClick={() => document.getElementById('private-dns')?.scrollIntoView({ behavior: 'smooth' })}>Turn on Private DNS</Button> : undefined}
        >
          It kept working while sending almost no lookups through the gateway, so an app is probably using its own DNS (for example Google’s 8.8.8.8 or encrypted DNS-over-HTTPS).
          Turning on Private DNS forces Android to use Screens. For extra certainty, block outgoing DNS (port 53 and 853) to the internet on this VLAN in your router.
        </Callout>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ScoreCard p={p} pending={pending} device={d} />
        <TrafficCard p={p} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ChecklistCard p={p} device={d} onChange={(next) => setQueryData<DevicePrivacy>(key, () => next)} />
        <div className="space-y-4">
          {d.kind === 'android' && <MicCard p={p} />}
          {d.capabilities.includes('private_dns') && <PrivateDnsCard device={d} />}
          {d.kind !== 'android' && (
            <Card>
              <CardHeader title="Microphone" icon={Mic} />
              <CardBody>
                <p className="text-sm text-muted">
                  {d.kind === 'sonos'
                    ? 'Sonos speakers with a microphone only listen for a wake word when a voice assistant is set up. The checklist shows how to switch the mic off.'
                    : 'TV voice features use the mic in the remote and send recordings to the manufacturer’s cloud. Turning off voice recognition (see the checklist) stops that.'}
                </p>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

const IMPACT_CLS = { good: 'text-ok-fg', warn: 'text-warn-fg', bad: 'text-crit-fg' } as const;

function ScoreCard({ p, pending, device }: { p: DevicePrivacy; pending: boolean; device: Device }) {
  const g = p.grade as Grade;
  const icon = { good: CircleCheck, warn: TriangleAlert, bad: CircleX } as const;
  return (
    <Card>
      <CardHeader title="Privacy score" icon={ShieldCheck} subtitle="100 means nothing leaves the device that shouldn’t. Points come off for each problem below." />
      <CardBody>
        {pending ? (
          <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-4 text-sm text-muted">
            <Radar className="size-5 shrink-0" aria-hidden />
            Screens hasn’t scored {device.name} yet. Scores appear once the device is paired and has been watched for a little while.
          </div>
        ) : (
          <div className="flex items-center gap-5">
            <GradeBadge grade={g} size="xl" />
            <div className="min-w-0 flex-1">
              <p className="text-5xl leading-none font-semibold tracking-tight text-fg">
                {p.score}
                <span className="ml-1 text-lg font-medium text-subtle">/100</span>
              </p>
              <p className="mt-1.5 text-sm text-muted">{GRADE[g].label}</p>
              <Meter className="mt-3" value={p.score} tone={GRADE[g].tone} label={`Privacy score ${p.score} of 100`} />
            </div>
          </div>
        )}
        <ul className="mt-5 divide-y divide-line">
          {p.factors.map((f) => {
            const Icon = icon[f.status];
            return (
              <li key={f.key} className="flex items-start gap-3 py-2.5">
                <Icon className={cn('mt-0.5 size-4 shrink-0', { good: 'text-ok-fg', warn: 'text-warn-fg', bad: 'text-crit-fg' }[f.status])} aria-label={f.status === 'good' ? 'Good' : f.status === 'warn' ? 'Could be better' : 'Problem'} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-fg">{f.label}</p>
                  {f.detail && <p className="mt-0.5 text-xs text-muted">{f.detail}</p>}
                </div>
                {f.impact !== 0 && (
                  <span className={cn('shrink-0 text-sm font-semibold tnum', f.impact < 0 ? IMPACT_CLS[f.status] : 'text-ok-fg')}>
                    {f.impact > 0 ? `+${f.impact}` : `−${Math.abs(f.impact)}`}
                  </span>
                )}
              </li>
            );
          })}
          {!p.factors.length && <li className="py-4 text-sm text-muted">No findings yet.</li>}
        </ul>
      </CardBody>
    </Card>
  );
}

function TrafficCard({ p }: { p: DevicePrivacy }) {
  const { resolved } = useTheme();
  const c = p.dns.by_category;
  const privacyTotal = (c.acr ?? 0) + (c.ads ?? 0) + (c.telemetry ?? 0) + (c.tracking ?? 0);
  const other = Math.max(0, p.dns.queries - privacyTotal);
  const parts = [
    { key: 'acr', label: 'ACR', value: c.acr ?? 0, color: 'var(--color-s1)' },
    { key: 'ads', label: 'Ads', value: c.ads ?? 0, color: 'var(--color-s2)' },
    { key: 'telemetry', label: 'Telemetry', value: c.telemetry ?? 0, color: 'var(--color-s3)' },
    { key: 'tracking', label: 'Tracking', value: c.tracking ?? 0, color: 'var(--color-s4)', ink: 'dark' as const },
    { key: 'other', label: 'Everything else', value: other, color: 'var(--color-other)', ink: resolved === 'light' ? ('dark' as const) : ('light' as const) },
  ];
  return (
    <Card>
      <CardHeader title="Where its lookups go" icon={ShieldAlert} subtitle={`${fmtNum(p.dns.queries)} lookups in the last 24 h · ${fmtNum(privacyTotal)} to spying, ad or tracking servers`} />
      <CardBody>
        <SegmentedBar parts={parts} ariaLabel="Share of lookups by category, last 24 hours" />
        <p className="mt-5 mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Top trackers contacted</p>
        <BarList
          max={6}
          format={fmtCompact}
          emptyText="No tracker lookups in the last 24 hours."
          items={p.dns.top_blocked.map((x) => ({
            key: x.domain,
            label: <span className="font-mono text-[12.5px]">{x.domain}</span>,
            value: x.blocked + x.would_block,
            sub: [x.category && CATEGORY[x.category]?.label, x.vendor, x.blocked ? 'blocked' : 'would be blocked'].filter(Boolean).join(' · '),
            href: `/dns/domains?q=${encodeURIComponent(x.domain)}`,
          }))}
        />
      </CardBody>
    </Card>
  );
}

function ChecklistCard({ p, device, onChange }: { p: DevicePrivacy; device: Device; onChange: (p: DevicePrivacy) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const done = p.checklist.filter((c) => c.done).length;
  const toggle = async (k: string, v: boolean) => {
    const prev = p;
    onChange({ ...p, checklist: p.checklist.map((c) => (c.key === k ? { ...c, done: v } : c)) });
    const ok = await act(() => api.devices.setChecklist(device.id, k, v), { invalidate: [`device:${device.id}`, 'overview', 'privacy'] });
    if (!ok) onChange(prev);
  };
  return (
    <Card>
      <CardHeader
        title="Settings to change on the device"
        icon={ListChecks}
        subtitle="Some spying can only be switched off on the device itself. Do these with the remote, then tick them off."
        actions={<Badge tone={done === p.checklist.length ? 'ok' : 'neutral'}>{done}/{p.checklist.length} done</Badge>}
      />
      <CardBody>
        <ul className="space-y-2">
          {p.checklist.map((c) => {
            const expanded = open === c.key;
            return (
              <li key={c.key} className={cn('rounded-lg border', c.done ? 'border-line bg-surface-2/50' : 'border-line')}>
                <div className="flex items-start gap-3 p-3">
                  <input
                    type="checkbox"
                    checked={c.done}
                    disabled={c.auto}
                    onChange={(e) => toggle(c.key, e.target.checked)}
                    aria-label={`${c.label}${c.done ? ' — done' : ''}`}
                    className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--color-accent)] disabled:cursor-default"
                  />
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm', c.done ? 'text-muted line-through decoration-subtle' : 'font-medium text-fg')}>{c.label}</p>
                    {c.auto && <p className="mt-0.5 text-xs text-muted">Checked automatically by Screens</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : c.key)}
                    aria-expanded={expanded}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent-fg hover:bg-accent-soft"
                  >
                    How to <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden />
                  </button>
                </div>
                {expanded && <p className="border-t border-line px-3 py-2.5 pl-10 text-sm text-muted">{c.how}</p>}
              </li>
            );
          })}
          {!p.checklist.length && <li className="text-sm text-muted">Nothing to change by hand on this device.</li>}
        </ul>
      </CardBody>
    </Card>
  );
}

function MicCard({ p }: { p: DevicePrivacy }) {
  return (
    <Card>
      <CardHeader title="Apps that can use the microphone" icon={Mic} subtitle="Android TV remotes and some boxes have a mic. These apps are allowed to use it." />
      <CardBody>
        {p.mic.length === 0 ? (
          <p className="text-sm text-muted">No app has microphone permission.</p>
        ) : (
          <ul className="divide-y divide-line">
            {p.mic.map((m) => (
              <li key={m.package} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{m.label ?? m.package}</p>
                  <p className="truncate font-mono text-[11px] text-muted">{m.package}</p>
                </div>
                <div className="text-right">
                  {m.granted ? <StatusText tone="warn" icon={Mic}>Allowed</StatusText> : <StatusText tone="ok" icon={Lock}>Denied</StatusText>}
                  <p className="text-[11px] text-muted">{m.last_access ? `Last used ${m.last_access}` : 'Never used'}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">To take the permission away: Settings → Apps → the app → Permissions → Microphone → Don’t allow.</p>
      </CardBody>
    </Card>
  );
}

function PrivateDnsCard({ device: d }: { device: Device }) {
  const site = useQuery(`site:${d.site_id}`, () => api.sites.get(d.site_id));
  const [busy, setBusy] = useState(false);
  const on = !!d.private_dns;
  const siteOn = site.data?.settings.dot_enabled;
  const toggle = async (v: boolean) => {
    setBusy(true);
    await sendCommand(d.id, 'private_dns', { enabled: v }, { success: v ? `Private DNS is on and working on ${d.name}` : 'Private DNS turned off', invalidate: [`device:${d.id}`, `privacy:${d.id}`] });
    setBusy(false);
  };
  return (
    <Card id="private-dns">
      <CardHeader title="Private DNS" icon={KeyRound} />
      <CardBody className="space-y-3">
        <Toggle
          checked={on}
          disabled={busy || d.status === 'offline' || (!on && siteOn === false)}
          onChange={toggle}
          label={busy ? 'Checking…' : 'Use Screens Private DNS'}
          description="Android then sends every lookup to Screens over an encrypted connection, so apps can’t quietly use their own DNS. Screens checks it works and switches it back automatically if not."
        />
        {on && <p className="text-xs text-muted">Using <span className="font-mono text-fg">{d.private_dns}</span></p>}
        {siteOn === false && !on && (
          <Callout kind="tip" action={<ButtonLink to={`/sites/${d.site_id}/settings`} size="sm" icon={Sparkles}>Open site settings</ButtonLink>}>
            Private DNS is off for this site. Turn it on in the site’s settings first.
          </Callout>
        )}
        {site.data?.dot_hostname && !on && siteOn && <p className="text-xs text-muted">Will use <span className="font-mono">{site.data.dot_hostname}</span>.</p>}
        <p className="text-xs text-muted">Needs a Cloudflare token in <Link to="/settings" className="font-medium text-accent-fg hover:underline">Settings</Link>.</p>
      </CardBody>
    </Card>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { BedDouble, Sparkles, CircleCheck, CircleX, Save, CalendarClock, TvMinimalPlay } from 'lucide-react';
import type { GuestSettings, SiteDetail } from '../../../shared/types';
import { api, type GuestResetResult } from '../../api';
import { act, setQueryData } from '../../lib/query';
import { KioskCard, LauncherDevicesCard, useSiteApps, WelcomeCard } from './LauncherSettings';

type ResetPrefs = Pick<GuestSettings, 'clear_packages' | 'go_home' | 'reboot'>;
import { Button, ButtonLink, Callout, Card, CardBody, CardHeader, SectionLabel, StatusText, cn } from '../../components/ui';
import { Checkbox, ChipsInput, Toggle, isPackage } from '../../components/forms';
import { ConfirmDialog } from '../../components/overlay';
import { DeviceStatusBadge, KindIcon } from '../../components/status';

export function GuestTab({ site }: { site: SiteDetail }) {
  const targets = site.devices.filter((d) => d.capabilities.includes('guest_reset'));
  const [selected, setSelected] = useState<string[]>(targets.map((d) => d.id));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<GuestResetResult['results'] | null>(null);

  const run = async () => {
    setBusy(true);
    setResults(null);
    const r = await act(() => api.sites.guestReset(site.id, selected.length === targets.length ? undefined : selected), { error: 'Guest reset failed', invalidate: [`site:${site.id}`, 'devices', 'overview', 'jobs'] });
    setBusy(false);
    setConfirm(false);
    if (r) setResults(r.results);
  };

  return (
    <div className="space-y-4">
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card>
          <CardHeader title="Guest reset" icon={Sparkles} subtitle="Run this between guests so the next one starts fresh." />
          <CardBody className="space-y-4">
            <p className="text-sm text-muted">
              On each Android TV box Screens clears the apps you pick on the right — signing the last guest out of Netflix, Stan and the rest — then goes back to the home screen{site.settings.guest.reboot ? ' and restarts' : ''}.
              Samsung TVs don’t allow apps to be cleared remotely, so they’re just returned to their Home screen.
            </p>
            {targets.length === 0 ? (
              <Callout kind="tip">No devices here support guest reset yet. Adopt an Android TV box or a Samsung TV first.</Callout>
            ) : (
              <>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {targets.map((d) => {
                    const res = results?.find((r) => r.device_id === d.id);
                    return (
                      <li key={d.id} className="flex items-start gap-3 px-3 py-2.5">
                        <Checkbox
                          checked={selected.includes(d.id)}
                          onChange={(v) => setSelected(v ? [...selected, d.id] : selected.filter((x) => x !== d.id))}
                          ariaLabel={`Include ${d.name}`}
                        />
                        <KindIcon kind={d.kind} className="mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-fg">{d.name}</p>
                          {res ? (
                            <p className={cn('mt-0.5 text-xs', res.ok ? 'text-muted' : 'text-crit-fg')}>{res.detail}</p>
                          ) : (
                            <p className="mt-0.5 text-xs text-muted">{d.room ?? ''}</p>
                          )}
                        </div>
                        {res ? (
                          res.ok ? <StatusText tone="ok" icon={CircleCheck}>Done</StatusText> : <StatusText tone="crit" icon={CircleX}>Failed</StatusText>
                        ) : (
                          <DeviceStatusBadge status={d.status} />
                        )}
                      </li>
                    );
                  })}
                </ul>
                <Button variant="primary" size="lg" icon={Sparkles} loading={busy} disabled={!selected.length} onClick={() => setConfirm(true)} className="w-full sm:w-auto">
                  {busy ? 'Resetting…' : selected.length === targets.length ? 'Reset all devices for the next guest' : `Reset ${selected.length} device${selected.length === 1 ? '' : 's'}`}
                </Button>
                {results && (
                  <Callout kind={results.every((r) => r.ok) ? 'tip' : 'warn'} title={results.every((r) => r.ok) ? 'All set for the next guest' : `${results.filter((r) => !r.ok).length} device${results.filter((r) => !r.ok).length === 1 ? '' : 's'} couldn’t be reset`}>
                    {results.every((r) => r.ok) ? 'Every selected device was reset.' : 'Check the device has power and is on the network, then try again — or reset it by hand.'}
                  </Callout>
                )}
              </>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Do it automatically at checkout" icon={CalendarClock} />
          <CardBody>
            <p className="mb-3 text-sm text-muted">An automation can run a guest reset every day at checkout time, then make sure the right apps are installed.</p>
            <ButtonLink to={`/automations/new?template=checkout&site=${site.id}`} icon={CalendarClock}>Set up a checkout automation</ButtonLink>
          </CardBody>
        </Card>
      </div>
      <GuestSettingsCard site={site} />
    </div>
      <LauncherDevicesCard site={site} />
      <WelcomeCard site={site} />
      <KioskCard site={site} />
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Reset for the next guest?" confirmLabel="Reset now" busy={busy} onConfirm={run}>
        <p>Anyone watching a TV at {site.name} right now will be interrupted, and signed out of the apps being cleared.</p>
      </ConfirmDialog>
    </div>
  );
}

function GuestSettingsCard({ site }: { site: SiteDetail }) {
  const androids = site.devices.filter((d) => d.kind === 'android');
  const allApps = useSiteApps(site);
  const appsQ = { ...allApps, data: allApps.data?.filter((a) => !a.system) };
  const pick = (x: GuestSettings): ResetPrefs => ({ clear_packages: x.clear_packages, go_home: x.go_home, reboot: x.reboot });
  const [g, setG] = useState<ResetPrefs>(pick(site.settings.guest));
  const [busy, setBusy] = useState(false);
  useEffect(() => setG(pick(site.settings.guest)), [site.settings.guest]);
  const dirty = JSON.stringify(g) !== JSON.stringify(pick(site.settings.guest));
  const known = useMemo(() => new Set((appsQ.data ?? []).map((a) => a.package)), [appsQ.data]);
  const custom = g.clear_packages.filter((p) => !known.has(p));

  const save = async () => {
    setBusy(true);
    const r = await act(() => api.sites.update(site.id, { settings: { guest: g } }), { success: 'Guest reset settings saved' });
    setBusy(false);
    if (r) setQueryData(`site:${site.id}`, () => r);
  };

  return (
    <Card>
      <CardHeader title="What a reset does" icon={BedDouble} />
      <CardBody className="space-y-5">
        <div>
          <SectionLabel>Clear these apps</SectionLabel>
          <p className="mb-2 text-xs text-muted">Clearing an app deletes its sign-ins, history and downloads on the box — like reinstalling it. Pick anything a guest might sign in to.</p>
          {androids.length === 0 ? (
            <p className="text-sm text-muted">No Android TV boxes at this site.</p>
          ) : (
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {(appsQ.data ?? []).map((a) => (
                <li key={a.package}>
                  <Checkbox
                    checked={g.clear_packages.includes(a.package)}
                    onChange={(v) => setG({ ...g, clear_packages: v ? [...g.clear_packages, a.package] : g.clear_packages.filter((p) => p !== a.package) })}
                    label={a.label ?? a.package}
                    description={<span className="font-mono text-[11px]">{a.package}</span>}
                  />
                </li>
              ))}
              {appsQ.loading && <li className="text-sm text-muted">Loading installed apps…</li>}
            </ul>
          )}
          <div className="mt-3">
            <p className="mb-1 text-xs text-muted">Other packages (not installed yet)</p>
            <ChipsInput value={custom} onChange={(v) => setG({ ...g, clear_packages: [...g.clear_packages.filter((p) => known.has(p)), ...v] })} mono validate={isPackage} placeholder="com.example.app" ariaLabel="Other packages to clear" />
          </div>
        </div>
        <Toggle checked={g.go_home} onChange={(v) => setG({ ...g, go_home: v })} label="Go to the home screen" description="So the next guest doesn’t walk in to the last show." />
        <Toggle checked={g.reboot} onChange={(v) => setG({ ...g, reboot: v })} label="Restart Android boxes afterwards" description="Takes about a minute. Clears anything stuck in memory." />
        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          {dirty && <Button variant="ghost" onClick={() => setG(pick(site.settings.guest))}>Discard</Button>}
          <Button variant="primary" icon={Save} loading={busy} disabled={!dirty} onClick={save}>Save</Button>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted"><TvMinimalPlay className="size-3.5" aria-hidden />{androids.length} Android box{androids.length === 1 ? '' : 'es'} at this site.</p>
      </CardBody>
    </Card>
  );
}

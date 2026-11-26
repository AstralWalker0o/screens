import { useState } from 'react';
import { CircleCheck, CircleDashed, CircleX, Download, House, ImageOff, LoaderCircle, RefreshCw, Send, TriangleAlert, TvMinimalPlay, ArrowUpCircle } from 'lucide-react';
import { compareVersions, type LauncherDeviceRollout, type LauncherLayout, type LauncherSiteState } from '../../../shared/launcher';
import type { Device } from '../../../shared/types';
import { api } from '../../api';
import { act, invalidate, useQuery } from '../../lib/query';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, CardBody, CardHeader, RelTime, StatusText, cn } from '../ui';
import { Select } from '../forms';
import { DeviceStatusBadge, KindIcon } from '../status';

export const launcherSiteKey = (siteId: string) => `launcher-site:${siteId}`;

export function useLauncherSite(siteId: string, refreshMs?: number) {
  return useQuery(launcherSiteKey(siteId), () => api.launcher.site(siteId), { refreshMs });
}

function refresh(siteId: string, deviceId?: string) {
  const keys = [launcherSiteKey(siteId), `site:${siteId}`, 'devices', ...(deviceId ? [`device:${deviceId}`] : [])];
  invalidate(...keys);
  // Layout changes are pushed in the background: look again once the box has had a moment.
  setTimeout(() => invalidate(...keys), 3500);
}

/** Plain-English state of one box. */
export function rolloutStatus(d: LauncherDeviceRollout, latest: string | null): { tone: 'ok' | 'warn' | 'crit' | 'neutral' | 'accent'; icon: typeof CircleCheck; text: string; detail?: string } {
  const l = d.launcher;
  if (!l || !l.installed) return { tone: 'neutral', icon: CircleDashed, text: 'Launcher not installed' };
  if (l.push_error && !d.in_sync) return { tone: 'crit', icon: CircleX, text: 'Last update failed', detail: l.push_error };
  if (d.layout_id && !d.supports_v2) return { tone: 'warn', icon: ArrowUpCircle, text: 'Needs launcher 2 for this home screen', detail: `It has ${l.version ? `v${l.version}` : 'an old version'}${latest ? `; update it to v${latest}` : ''}. Until then it shows the classic grid with your kiosk and welcome settings.` };
  if (!d.in_sync) return { tone: 'accent', icon: LoaderCircle, text: d.status === 'online' || d.status === 'standby' ? 'Waiting to update' : 'Updates when it’s back online' };
  if (l.missing_assets?.length) return { tone: 'warn', icon: ImageOff, text: `${l.missing_assets.length} picture${l.missing_assets.length === 1 ? '' : 's'} missing`, detail: 'The box shows its plain background or the app’s own banner instead. Push again to copy them.' };
  return { tone: 'ok', icon: CircleCheck, text: 'Up to date' };
}

const layoutName = (layouts: LauncherLayout[], id: string | null) => (id ? layouts.find((l) => l.id === id)?.name ?? 'Deleted layout' : 'Classic grid');

/** Layout choices for a box: follow the site, or any of the site's layouts / fleet templates. */
function LayoutSelect({ state, device, onPicked, id }: { state: LauncherSiteState; device: LauncherDeviceRollout; onPicked?: () => void; id?: string }) {
  const [busy, setBusy] = useState(false);
  const site = state.layouts.filter((l) => l.site_id);
  const tpl = state.layouts.filter((l) => !l.site_id);
  const set = async (v: string) => {
    setBusy(true);
    const layout_id = v === '' ? null : v;
    const r = await act(() => api.launcher.setDeviceLayout(device.device_id, layout_id), {
      success: layout_id ? `${device.name} will show “${layoutName(state.layouts, layout_id)}”` : `${device.name} follows the site again`,
    });
    setBusy(false);
    if (r) { refresh(state.site_id, device.device_id); onPicked?.(); }
  };
  return (
    <Select id={id} aria-label={`Home screen layout for ${device.name}`} value={device.override_layout_id ?? ''} disabled={busy} onChange={(e) => void set(e.target.value)}>
      <option value="">Same as the site ({layoutName(state.layouts, state.layout_id)})</option>
      {site.length > 0 && <optgroup label="This site’s layouts">{site.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>}
      {tpl.length > 0 && <optgroup label="Fleet templates">{tpl.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>}
    </Select>
  );
}

type Act = 'push' | 'launcher_home' | 'launcher_install';

/** Per-box rollout: version, whether its config matches, missing pictures, last push, errors, and actions. */
export function LauncherRolloutCard({ siteId, state }: { siteId: string; state: LauncherSiteState }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (d: LauncherDeviceRollout | null, a: Act) => {
    setBusy(d ? `${d.device_id}:${a}` : 'all');
    try {
      if (a === 'push') {
        const r = await api.launcher.push(siteId, d ? [d.device_id] : undefined);
        const failed = r.results.filter((x) => !x.ok);
        if (!r.results.length) toast.info('No box is online with the launcher installed');
        else if (failed.length) toast.error(d ? `${d.name} didn’t take the update` : `${failed.length} of ${r.results.length} boxes didn’t take the update`, failed[0].detail);
        else toast.success(d ? `Sent to ${d.name}` : `Sent to ${r.results.length} box${r.results.length === 1 ? '' : 'es'}`);
      } else if (d) {
        const r = await api.devices.command(d.device_id, a);
        if (!r.ok) throw new Error(r.error ?? 'The box didn’t accept the command');
        toast.success(a === 'launcher_home' ? `The Screens Launcher is now the home screen on ${d.name}` : `Screens Launcher installed on ${d.name}`);
      }
    } catch (e) {
      toast.error('That didn’t work', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      refresh(siteId, d?.device_id);
    }
  };
  const installed = state.devices.filter((d) => d.launcher?.installed);
  return (
    <Card>
      <CardHeader
        title="On the boxes"
        icon={TvMinimalPlay}
        subtitle="Saving sends the home screen to every box automatically. Boxes that were off get it when they come back."
        actions={installed.length > 0 && <Button size="sm" icon={Send} loading={busy === 'all'} onClick={() => run(null, 'push')}>Push to all now</Button>}
      />
      <CardBody>
        {state.devices.length === 0 ? (
          <p className="text-sm text-muted">No Android TV boxes at this site yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {state.devices.map((d) => {
              const l = d.launcher;
              const st = rolloutStatus(d, state.latest_version);
              const online = d.status === 'online' || d.status === 'standby';
              const outdated = !!l?.installed && !!state.latest_version && compareVersions(l.version, state.latest_version) < 0;
              return (
                <li key={d.device_id} className="grid gap-3 py-3.5 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] lg:items-center">
                  <div className="flex min-w-0 items-start gap-3">
                    <KindIcon kind="android" boxed />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="truncate text-sm font-medium text-fg">{d.name}</span>
                        {!online && <DeviceStatusBadge status={d.status} />}
                        {l?.installed && <Badge tone={d.supports_v2 ? 'accent' : 'neutral'} mono>v{l.version ?? '?'}</Badge>}
                        {l?.installed && (l.is_home ? <StatusText tone="ok" icon={House}>Home screen</StatusText> : <StatusText tone="warn" icon={House}>Not the home screen</StatusText>)}
                      </p>
                      <p className="mt-1"><StatusText tone={st.tone} icon={st.icon} pulse={st.icon === LoaderCircle}>{st.text}</StatusText></p>
                      {st.detail && <p className={cn('mt-0.5 text-xs [overflow-wrap:anywhere]', st.tone === 'crit' ? 'text-crit-fg' : 'text-muted')}>{st.detail}</p>}
                      {l?.installed && (
                        <p className="mt-0.5 text-xs text-subtle">
                          Last sent <RelTime ts={l.pushed_at} />
                          {l.pushed_v ? ` · config v${l.pushed_v}` : ''}
                          {l.assets_pushed ? ` · ${l.assets_pushed} picture${l.assets_pushed === 1 ? '' : 's'} copied` : ''}
                          {l.last_error ? ` · launcher says: ${l.last_error}` : ''}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <label htmlFor={`lay-${d.device_id}`} className="mb-1 block text-xs text-muted">Home screen on this box</label>
                    <LayoutSelect id={`lay-${d.device_id}`} state={state} device={d} />
                  </div>
                  <div className="flex flex-wrap gap-1.5 lg:justify-end">
                    {!l?.installed ? (
                      <Button size="sm" variant="primary" icon={Download} disabled={!online} loading={busy === `${d.device_id}:launcher_install`} onClick={() => run(d, 'launcher_install')}>Install launcher</Button>
                    ) : (
                      <>
                        <Button size="sm" icon={RefreshCw} disabled={!online} loading={busy === `${d.device_id}:push`} onClick={() => run(d, 'push')}>Push now</Button>
                        {!l.is_home && <Button size="sm" icon={House} disabled={!online} loading={busy === `${d.device_id}:launcher_home`} onClick={() => run(d, 'launcher_home')}>Make it the home screen</Button>}
                        {outdated && <Button size="sm" variant="soft" icon={ArrowUpCircle} disabled={!online} loading={busy === `${d.device_id}:launcher_install`} onClick={() => run(d, 'launcher_install')}>Update to v{state.latest_version}</Button>}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {state.devices.some((d) => d.layout_id && d.launcher?.installed && !d.supports_v2) && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-muted">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn-fg" aria-hidden />
            Boxes on launcher 1.x keep working with the classic grid. Use “Update” (or “Install launcher”) once version 2 is in the APK library.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** "Use a different layout on this box" for the device page. */
export function DeviceLayoutPicker({ device }: { device: Device }) {
  const q = useLauncherSite(device.site_id);
  const s = q.data;
  const d = s?.devices.find((x) => x.device_id === device.id);
  if (!s || !d) return null;
  const st = rolloutStatus(d, s.latest_version);
  return (
    <div className="mt-4 border-t border-line pt-3">
      <label htmlFor={`dev-lay-${d.device_id}`} className="mb-1 block text-sm font-medium text-fg">Home screen layout</label>
      <LayoutSelect id={`dev-lay-${d.device_id}`} state={s} device={d} />
      <p className="mt-1.5"><StatusText tone={st.tone} icon={st.icon}>{st.text}</StatusText></p>
      <p className="mt-1 text-xs text-muted">Design layouts on the site’s Home screen tab. Pick one here to use a different layout on just this box.</p>
    </div>
  );
}

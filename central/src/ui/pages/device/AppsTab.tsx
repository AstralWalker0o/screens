import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AppWindow, Play, Ellipsis, Square, Eraser, Ban, CircleCheck, Trash2, Store, RefreshCw, Download, Mic, Camera, MapPin, Package, PackageMinus, MicOff, CameraOff, MapPinOff, ContactRound, UserX, CircleX, CircleDashed } from 'lucide-react';
import type { Device, DeviceApp } from '../../../shared/types';
import { api } from '../../api';
import { sendCommand } from '../../lib/commands';
import { errorMessage, invalidate, setQueryData, useQuery } from '../../lib/query';
import { toast } from '../../lib/toast';
import { fmtBytes } from '../../lib/format';
import { PRIVACY_PERMISSION } from '../../lib/labels';
import { AppIcon } from '../../components/AppLauncher';
import { Badge, Button, ButtonLink, Callout, Card, EmptyState, IconButton, SkeletonRows, StatusText, cn } from '../../components/ui';
import { Checkbox, Field, Input, SearchInput, Segmented } from '../../components/forms';
import { ConfirmDialog, Dialog, Menu } from '../../components/overlay';
import { DeviceUpdatesBanner, UpdateBadge, useDeviceUpdates } from '../updates/DeviceUpdates';
import type { DeviceUpdateItem } from '../../../shared/updates';

type Filter = 'all' | 'user' | 'system';

export function AppsTab({ device: d }: { device: Device }) {
  const key = `apps:${d.id}`;
  const q = useQuery(key, () => api.devices.apps(d.id));
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('user');
  const [refreshing, setRefreshing] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'clear' | 'uninstall'; app: DeviceApp } | null>(null);
  const [keepData, setKeepData] = useState(false);
  const [blocked, setBlocked] = useState<Record<string, boolean>>({});
  const [debloat, setDebloat] = useState<'confirm' | 'running' | DebloatResult | null>(null);
  const android = d.kind === 'android';
  const updates = useDeviceUpdates(d);

  const apps = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((a) => (filter === 'all' ? true : filter === 'system' ? a.system : !a.system))
      .filter((a) => !s || (a.label ?? '').toLowerCase().includes(s) || a.package.toLowerCase().includes(s))
      .sort((a, b) => (a.label ?? a.package).localeCompare(b.label ?? b.package));
  }, [q.data, search, filter]);
  const counts = { all: q.data?.length ?? 0, user: q.data?.filter((a) => !a.system).length ?? 0, system: q.data?.filter((a) => a.system).length ?? 0 };

  const refresh = async () => {
    setRefreshing(true);
    const r = await sendCommand(d.id, 'apps', undefined, { success: 'App list refreshed', invalidate: false });
    setRefreshing(false);
    if (Array.isArray(r?.data)) setQueryData(key, () => r!.data as DeviceApp[]);
  };
  const cmd = async (command: string, app: DeviceApp, success: string, args: Record<string, unknown> = {}) => {
    const r = await sendCommand(d.id, command, { package: app.package, ...args }, { success, invalidate: [key, `device:${d.id}`] });
    if (r && (command === 'disable' || command === 'enable')) setQueryData<DeviceApp[]>(key, (old) => old?.map((x) => (x.package === app.package ? { ...x, enabled: command === 'enable' } : x)));
    if (r && command === 'uninstall') setQueryData<DeviceApp[]>(key, (old) => old?.filter((x) => x.package !== app.package));
    return r;
  };

  const setPermission = async (app: DeviceApp, perm: PermKey, block: boolean) => {
    const r = await sendCommand(d.id, block ? 'revoke_permission' : 'grant_permission', { package: app.package, permission: perm }, {
      success: block ? `${app.label ?? app.package} can no longer use the ${perm}` : `${app.label ?? app.package} can use the ${perm} again`,
      error: block ? `Couldn’t block the ${perm}` : `Couldn’t allow the ${perm}`,
      invalidate: [key, `privacy:${d.id}`],
    });
    if (r) setBlocked((b) => ({ ...b, [`${app.package}|${perm}`]: block }));
  };

  const runDebloat = async () => {
    setDebloat('running');
    try {
      // A partial failure comes back as ok:false with the lists in data, so read data either way.
      const r = await api.devices.command(d.id, 'debloat');
      const res = (r.data ?? {}) as Partial<DebloatResult>;
      const out: DebloatResult = { disabled: res.disabled ?? [], failed: res.failed ?? [], skipped: res.skipped ?? [] };
      if (!r.ok && !out.failed.length && r.error) throw new Error(r.error);
      setDebloat(out);
      setQueryData<DeviceApp[]>(key, (old) => old?.map((x) => (out.disabled.includes(x.package) ? { ...x, enabled: false } : x)));
      invalidate(key, `privacy:${d.id}`);
    } catch (e) {
      toast.error('Debloat failed', errorMessage(e));
      setDebloat(null);
    }
  };

  return (
    <div className="space-y-4">
      {!android && (
        <Callout kind="info">
          {d.kind === 'samsung' ? 'Samsung' : 'LG'} TVs only let Screens see which apps are installed and open them. Installing, removing or clearing apps has to be done on the TV itself.
        </Callout>
      )}
      {android && <DeviceUpdatesBanner device={d} items={updates} />}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search apps" className="w-full sm:w-64" />
        <Segmented<Filter>
          ariaLabel="Which apps"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'user', label: `Installed (${counts.user})` },
            { value: 'system', label: `System (${counts.system})` },
            { value: 'all', label: `All (${counts.all})` },
          ]}
        />
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button size="sm" icon={RefreshCw} loading={refreshing} onClick={refresh} disabled={d.status === 'offline'}>Refresh app list</Button>
          {android && d.capabilities.includes('install') && (
            <>
              <Button size="sm" icon={PackageMinus} onClick={() => setDebloat('confirm')} disabled={d.status === 'offline' || !d.capabilities.includes('disable')} title="Turn off pre-installed apps known for ads and tracking">Debloat</Button>
              <Button size="sm" icon={Store} onClick={() => setStoreOpen(true)} disabled={d.status === 'offline'}>Open in Play Store</Button>
              <Button size="sm" variant="primary" icon={Download} onClick={() => setInstallOpen(true)} disabled={d.status === 'offline'}>Install from library</Button>
            </>
          )}
        </div>
      </div>

      <Card>
        {q.loading ? (
          <div className="p-4"><SkeletonRows rows={8} /></div>
        ) : apps.length === 0 ? (
          <EmptyState icon={AppWindow} title={search ? `No apps match “${search}”` : 'No apps in this list'}>
            {search ? 'Try another name or the package name.' : 'Use “Refresh app list” to read the apps from the device.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {apps.map((a) => (
              <AppRow
                key={a.package}
                app={a}
                device={d}
                update={updates.get(a.package)}
                onLaunch={() => cmd('launch', a, `Opening ${a.label ?? a.package}`, android ? {} : { app_id: a.app_id, package: undefined })}
                onStop={() => cmd('stop', a, `Stopped ${a.label}`)}
                onToggle={() => cmd(a.enabled ? 'disable' : 'enable', a, a.enabled ? `Disabled ${a.label}` : `Enabled ${a.label}`)}
                onStore={() => cmd('play_store', a, 'Play Store page opened on the TV')}
                onClear={() => setConfirm({ kind: 'clear', app: a })}
                onUninstall={() => {
                  setKeepData(false);
                  setConfirm({ kind: 'uninstall', app: a });
                }}
                blocked={blocked}
                onPermission={(perm, block) => setPermission(a, perm, block)}
              />
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirm?.kind === 'clear'}
        onClose={() => setConfirm(null)}
        danger
        title={`Clear ${confirm?.app.label ?? ''} data?`}
        confirmLabel="Clear data"
        onConfirm={async () => {
          if (confirm && (await cmd('clear', confirm.app, `Cleared ${confirm.app.label}`))) setConfirm(null);
        }}
      >
        <p>This signs out of {confirm?.app.label} and deletes its settings, history and downloads on {d.name}. The app stays installed.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === 'uninstall'}
        onClose={() => setConfirm(null)}
        danger
        title={`Uninstall ${confirm?.app.label ?? ''}?`}
        confirmLabel="Uninstall"
        onConfirm={async () => {
          if (confirm && (await cmd('uninstall', confirm.app, `Uninstalled ${confirm.app.label}`, { keep_data: keepData }))) setConfirm(null);
        }}
        extra={<Checkbox className="mt-4" checked={keepData} onChange={setKeepData} label="Keep the app’s data" description="Useful if you’ll reinstall it soon." />}
      >
        <p>{confirm?.app.label} will be removed from {d.name}. You can reinstall it from the Play Store or your library.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={debloat === 'confirm' || debloat === 'running'}
        onClose={() => setDebloat((cur) => (cur === 'confirm' ? null : cur))}
        title={`Debloat ${d.name}?`}
        confirmLabel="Turn them off"
        busy={debloat === 'running'}
        onConfirm={runDebloat}
      >
        <p>Screens turns off pre-installed apps that are known for ads, tracking or telemetry (from its app catalogue), such as recommendation feeds and vendor feedback tools.</p>
        <p>Nothing is uninstalled. Any of them can be turned back on from this list with <strong className="text-fg">Enable</strong>.</p>
      </ConfirmDialog>
      <Dialog
        open={!!debloat && typeof debloat === 'object'}
        onClose={() => setDebloat(null)}
        title="Debloat finished"
        description={debloat && typeof debloat === 'object' ? `${debloat.disabled.length} turned off · ${debloat.failed.length} failed · ${debloat.skipped.length} not installed or already off` : undefined}
        footer={<Button variant="primary" onClick={() => setDebloat(null)}>Done</Button>}
      >
        {debloat && typeof debloat === 'object' && (
          <div className="space-y-4">
            <DebloatList title="Turned off" tone="ok" icon={CircleCheck} items={debloat.disabled} labelOf={(p) => q.data?.find((x) => x.package === p)?.label} empty="Nothing needed turning off." />
            {debloat.failed.length > 0 && <DebloatList title="Couldn’t turn off" tone="crit" icon={CircleX} items={debloat.failed} labelOf={(p) => q.data?.find((x) => x.package === p)?.label} />}
            {debloat.skipped.length > 0 && <DebloatList title="Not installed or already off" tone="neutral" icon={CircleDashed} items={debloat.skipped} labelOf={(p) => q.data?.find((x) => x.package === p)?.label} />}
          </div>
        )}
      </Dialog>
      <InstallDialog device={d} open={installOpen} onClose={() => setInstallOpen(false)} />
      <PlayStoreDialog device={d} open={storeOpen} onClose={() => setStoreOpen(false)} />
    </div>
  );
}

function AppRow({ app: a, device: d, update, onLaunch, onStop, onToggle, onStore, onClear, onUninstall, blocked, onPermission }: {
  app: DeviceApp; device: Device; update?: DeviceUpdateItem; onLaunch: () => void; onStop: () => void; onToggle: () => void; onStore: () => void; onClear: () => void; onUninstall: () => void;
  blocked: Record<string, boolean>; onPermission: (perm: PermKey, block: boolean) => Promise<void>;
}) {
  const android = d.kind === 'android';
  const sensitive = Array.from(new Set(a.permissions.map((p) => PRIVACY_PERMISSION[p]?.key).filter(Boolean))) as PermKey[];
  const running = d.current_app === a.label;
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
      <AppIcon app={a} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-fg">
          <span className="truncate">{a.label ?? a.package}</span>
          {running && <Badge tone="ok" icon={Play}>Open now</Badge>}
          {!a.enabled && <Badge tone="neutral" icon={Ban}>Disabled</Badge>}
          {a.system && <Badge>System</Badge>}
          {a.risk === 'high' && <Badge tone="crit" title="Known for heavy tracking or ads">High risk</Badge>}
          {a.risk === 'medium' && <Badge tone="warn" title="Some tracking or data collection">Medium risk</Badge>}
          {a.category && <Badge>{a.category}</Badge>}
          <UpdateBadge item={update} />
        </p>
        <p className="mt-0.5 truncate font-mono text-[11.5px] text-muted">
          {a.package}
          {a.version_name ? ` · v${a.version_name}` : ''}
        </p>
        {sensitive.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {sensitive.map((perm) => (
              <PermissionControl key={perm} perm={perm} app={a} blocked={!!blocked[`${a.package}|${perm}`]} canChange={android && d.status !== 'offline'} onChange={(b) => onPermission(perm, b)} />
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:justify-end">
        <Button size="sm" icon={Play} onClick={onLaunch} disabled={!a.enabled || d.status === 'offline' || !d.capabilities.includes('launch')}>Open</Button>
        {android && (
          <Menu
            trigger={({ toggle, ref }) => <IconButton ref={ref} icon={Ellipsis} label={`More actions for ${a.label ?? a.package}`} onClick={toggle} size="sm" variant="secondary" />}
            items={[
              { label: 'Stop', icon: Square, onSelect: onStop },
              { label: 'Clear data…', icon: Eraser, onSelect: onClear, disabled: !d.capabilities.includes('clear') },
              { label: a.enabled ? 'Disable' : 'Enable', icon: a.enabled ? Ban : CircleCheck, onSelect: onToggle, disabled: !d.capabilities.includes('disable') },
              { label: 'Open in Play Store', icon: Store, onSelect: onStore },
              'sep',
              { label: a.system ? 'Uninstall (system app)' : 'Uninstall…', icon: Trash2, danger: true, onSelect: onUninstall, disabled: a.system || !d.capabilities.includes('uninstall') },
            ]}
          />
        )}
      </div>
    </li>
  );
}

function InstallDialog({ device, open, onClose }: { device: Device; open: boolean; onClose: () => void }) {
  const apks = useQuery(open ? 'apks' : null, api.apks.list);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="Install from library" description={`Pick an app you’ve uploaded. It installs on ${device.name} in the background.`} size="lg">
      {apks.loading ? (
        <SkeletonRows rows={3} />
      ) : !apks.data?.length ? (
        <EmptyState icon={Package} title="Your library is empty" action={<ButtonLink to="/library/apks" variant="primary">Upload an APK</ButtonLink>}>
          Upload Android app files (.apk) in the Library and they’ll show up here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {apks.data.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-2.5">
              <AppIcon app={{ label: a.label, package: a.package ?? a.id }} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{a.label ?? a.package}</p>
                <p className="truncate font-mono text-[11.5px] text-muted">{a.package}{a.version_name ? ` · v${a.version_name}` : ''} · {fmtBytes(a.size)}</p>
              </div>
              <Button
                size="sm"
                variant="primary"
                icon={Download}
                loading={busy === a.id}
                onClick={async () => {
                  setBusy(a.id);
                  const r = await sendCommand(device.id, 'install', { apk_id: a.id }, { success: `Installed ${a.label ?? a.package} on ${device.name}`, invalidate: [`apps:${device.id}`] });
                  setBusy(null);
                  if (r) onClose();
                }}
              >
                Install
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">Need something else? <Link to="/library/apks" className="font-medium text-accent-fg hover:underline">Upload to the library</Link>.</p>
    </Dialog>
  );
}

function PlayStoreDialog({ device, open, onClose }: { device: Device; open: boolean; onClose: () => void }) {
  const [pkg, setPkg] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(pkg.trim());
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Open in Play Store"
      description="Opens the app’s Play Store page on the TV, ready for you to press Install with the remote."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={Store}
            loading={busy}
            disabled={!ok}
            onClick={async () => {
              setBusy(true);
              const r = await sendCommand(device.id, 'play_store', { package: pkg.trim() }, { success: 'Play Store opened on the TV', invalidate: false });
              setBusy(false);
              if (r) {
                setPkg('');
                onClose();
              }
            }}
          >
            Open on TV
          </Button>
        </>
      }
    >
      <Field label="Package name" htmlFor="ps-pkg" hint="Find it in the app’s Play Store web address after “id=”, e.g. com.netflix.ninja.">
        <Input id="ps-pkg" mono value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="com.example.app" autoFocus />
      </Field>
    </Dialog>
  );
}

type PermKey = 'microphone' | 'camera' | 'location' | 'contacts';
interface DebloatResult { disabled: string[]; failed: string[]; skipped: string[] }

const PERM_META: Record<PermKey, { label: string; on: typeof Mic; off: typeof Mic }> = {
  microphone: { label: 'Microphone', on: Mic, off: MicOff },
  camera: { label: 'Camera', on: Camera, off: CameraOff },
  location: { label: 'Location', on: MapPin, off: MapPinOff },
  contacts: { label: 'Contacts', on: ContactRound, off: UserX },
};

/** "Can use microphone · Block" — or "Microphone blocked · Undo" once revoked. */
function PermissionControl({ perm, app, blocked, canChange, onChange }: { perm: PermKey; app: DeviceApp; blocked: boolean; canChange: boolean; onChange: (block: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const m = PERM_META[perm];
  const Icon = blocked ? m.off : m.on;
  const name = app.label ?? app.package;
  return (
    <span className={cn('inline-flex items-stretch overflow-hidden rounded-md border text-xs', blocked ? 'border-line bg-surface-2' : 'border-serious/30 bg-serious-soft')}>
      <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 font-medium', blocked ? 'text-muted' : 'text-serious-fg')} title={blocked ? `${name} can no longer use the ${perm}` : `${name} is allowed to use the ${perm}`}>
        <Icon className="size-3" aria-hidden />
        {blocked ? `${m.label} blocked` : m.label}
      </span>
      {canChange && (
        <button
          type="button"
          disabled={busy}
          aria-label={blocked ? `Allow ${name} to use the ${perm} again` : `Block ${perm} for ${name}`}
          onClick={async () => {
            setBusy(true);
            await onChange(!blocked);
            setBusy(false);
          }}
          className={cn('border-l px-1.5 font-medium transition-colors disabled:opacity-50', blocked ? 'border-line text-accent-fg hover:bg-surface-3' : 'border-serious/30 text-fg hover:bg-serious/15')}
        >
          {busy ? '…' : blocked ? 'Undo' : `Block ${perm}`}
        </button>
      )}
    </span>
  );
}

function DebloatList({ title, items, labelOf, tone, icon, empty }: { title: string; items: string[]; labelOf: (p: string) => string | null | undefined; tone: 'ok' | 'crit' | 'neutral'; icon: typeof Mic; empty?: string }) {
  return (
    <div>
      <StatusText tone={tone} icon={icon} className="mb-1.5 text-sm">{title} ({items.length})</StatusText>
      {items.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((p) => (
            <li key={p} className="flex items-baseline justify-between gap-3 rounded-md bg-surface-2 px-2.5 py-1.5">
              {labelOf(p) ? (
                <>
                  <span className="truncate text-sm text-fg">{labelOf(p)}</span>
                  <span className="truncate font-mono text-[11px] text-muted">{p}</span>
                </>
              ) : (
                <span className="truncate font-mono text-[12px] text-fg">{p}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

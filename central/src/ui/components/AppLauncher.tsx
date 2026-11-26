import { useState } from 'react';
import type { Device, DeviceApp } from '../../shared/types';
import { api } from '../api';
import { sendCommand } from '../lib/commands';
import { useQuery } from '../lib/query';
import { cn, Skeleton } from './ui';

const PREFERRED = ['Netflix', 'YouTube', 'Plex', 'Stan', 'Disney+', 'Prime Video', 'Spotify', 'ABC iview', 'Apple TV', 'Kodi', 'SmartTube'];

function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function AppIcon({ app, size = 'md' }: { app: Pick<DeviceApp, 'label' | 'package' | 'icon'>; size?: 'sm' | 'md' }) {
  const name = app.label ?? app.package;
  const dims = size === 'sm' ? 'size-8 rounded-lg text-xs' : 'size-11 rounded-xl text-sm';
  if (app.icon) return <img src={app.icon} alt="" className={cn(dims, 'shrink-0 object-cover')} loading="lazy" referrerPolicy="no-referrer" />;
  return (
    <span
      className={cn(dims, 'inline-flex shrink-0 items-center justify-center font-bold text-white')}
      style={{ background: `oklch(0.52 0.12 ${hue(name)})` }}
      aria-hidden
    >
      {name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2)}
    </span>
  );
}

export function pinnedApps(apps: DeviceApp[], n = 8): DeviceApp[] {
  const user = apps.filter((a) => !a.system && a.enabled);
  const rank = (a: DeviceApp) => {
    const i = PREFERRED.indexOf(a.label ?? '');
    return i === -1 ? 100 : i;
  };
  return [...user].sort((a, b) => rank(a) - rank(b) || (a.label ?? '').localeCompare(b.label ?? '')).slice(0, n);
}

/** A row of the device's most-used apps; clicking opens the app on the TV. */
export function AppLauncher({ device }: { device: Device }) {
  const q = useQuery(device.capabilities.includes('apps') ? `apps:${device.id}` : null, () => api.devices.apps(device.id));
  const [busy, setBusy] = useState<string | null>(null);
  if (!device.capabilities.includes('launch')) return null;
  const apps = pinnedApps(q.data ?? []);
  const launch = async (a: DeviceApp) => {
    setBusy(a.package);
    await sendCommand(device.id, 'launch', device.kind === 'android' ? { package: a.package } : { app_id: a.app_id ?? a.package }, { success: `Opening ${a.label ?? a.package}` });
    setBusy(null);
  };
  return (
    <div>
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {q.loading
          ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[74px] w-[76px] shrink-0 rounded-xl" />)
          : apps.map((a) => {
              const current = device.current_app && device.current_app === a.label;
              return (
                <button
                  key={a.package}
                  type="button"
                  onClick={() => launch(a)}
                  disabled={busy === a.package || device.status === 'offline'}
                  title={`Open ${a.label ?? a.package}`}
                  className={cn(
                    'flex w-[76px] shrink-0 flex-col items-center gap-1.5 rounded-xl px-1 py-2 text-center transition-colors hover:bg-surface-2 disabled:opacity-50',
                    current && 'bg-accent-soft',
                  )}
                >
                  <AppIcon app={a} />
                  <span className="w-full truncate text-[11px] text-fg">{a.label ?? a.package}</span>
                </button>
              );
            })}
        {!q.loading && !apps.length && <p className="py-3 text-sm text-muted">No apps found yet. Use “Refresh app list” on the Apps tab.</p>}
      </div>
    </div>
  );
}

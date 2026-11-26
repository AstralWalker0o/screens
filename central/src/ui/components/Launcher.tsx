import { useState } from 'react';
import { Download, RefreshCw, Trash2, PartyPopper, CircleCheck, CircleDashed, House, TriangleAlert } from 'lucide-react';
import type { Device, LauncherState } from '../../shared/types';
import { api } from '../api';
import { errorMessage, invalidate } from '../lib/query';
import { toast } from '../lib/toast';
import { Button, RelTime, StatusText, cn } from './ui';
import { ConfirmDialog } from './overlay';

export function launcherState(d: Device): LauncherState | null {
  const l = (d.facts as Record<string, unknown>).launcher;
  return l && typeof l === 'object' ? (l as LauncherState) : null;
}

export function LauncherStatusText({ device }: { device: Device }) {
  const l = launcherState(device);
  if (!l) return <StatusText tone="neutral" icon={CircleDashed}>Not checked yet</StatusText>;
  if (!l.installed) return <StatusText tone="neutral" icon={CircleDashed}>Not installed</StatusText>;
  if (l.is_home) return <StatusText tone="ok" icon={House}>Home screen{l.version ? ` · v${l.version}` : ''}</StatusText>;
  return <StatusText tone="warn" icon={CircleCheck}>Installed, not the home screen{l.version ? ` · v${l.version}` : ''}</StatusText>;
}

type Action = 'launcher_install' | 'launcher_config' | 'launcher_remove' | 'welcome_show';
const SUCCESS: Record<Action, (n: string) => string> = {
  launcher_install: (n) => `Screens Launcher installed on ${n} and set as the home screen`,
  launcher_config: (n) => `Latest welcome and kiosk settings sent to ${n}`,
  launcher_remove: (n) => `Removed the Screens Launcher from ${n}. The normal home screen is back.`,
  welcome_show: (n) => `Welcome screen opened on ${n}`,
};

/** Launcher status + Install / Update config / Remove / Show welcome for one Android device. */
export function LauncherActions({ device: d, compact }: { device: Device; compact?: boolean }) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const l = launcherState(d);
  const installed = !!l?.installed;
  const offline = d.status === 'offline';

  const run = async (a: Action) => {
    setBusy(a);
    setError(null);
    try {
      const r = await api.devices.command(d.id, a);
      if (!r.ok) throw new Error(r.error ?? 'The device didn’t accept the command.');
      toast.success(SUCCESS[a](d.name));
      invalidate(`device:${d.id}`, `site:${d.site_id}`, 'devices');
      return true;
    } catch (e) {
      // e.g. 404 “The Screens Launcher has not been published …” — show it right here.
      const msg = errorMessage(e);
      setError(msg);
      toast.error('Launcher command failed', msg);
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className={cn('flex flex-wrap items-center gap-1.5', compact ? '' : 'mt-1')}>
        {!installed ? (
          <Button size="sm" variant="primary" icon={Download} loading={busy === 'launcher_install'} disabled={offline} onClick={() => run('launcher_install')}>Install launcher</Button>
        ) : (
          <>
            <Button size="sm" icon={PartyPopper} loading={busy === 'welcome_show'} disabled={offline} onClick={() => run('welcome_show')}>Show welcome now</Button>
            <Button size="sm" icon={RefreshCw} loading={busy === 'launcher_config'} disabled={offline} onClick={() => run('launcher_config')}>Update config</Button>
            <Button size="sm" variant="danger-ghost" icon={Trash2} disabled={offline} onClick={() => setConfirmRemove(true)}>Remove</Button>
          </>
        )}
      </div>
      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-crit-fg" role="alert">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {l?.checked_at && !compact && <p className="mt-1.5 text-xs text-subtle">Checked <RelTime ts={l.checked_at} /></p>}
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        danger
        title={`Remove the Screens Launcher from ${d.name}?`}
        confirmLabel="Remove launcher"
        onConfirm={async () => {
          if (await run('launcher_remove')) setConfirmRemove(false);
        }}
      >
        <p>The normal Android TV home screen comes back, kiosk mode stops and guests won’t see the welcome screen.</p>
      </ConfirmDialog>
    </div>
  );
}

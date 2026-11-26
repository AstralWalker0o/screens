import { Link } from 'react-router';
import { Bell, BellRing, Check } from 'lucide-react';
import { api } from '../api';
import { act, setQueryData, useQuery } from '../lib/query';
import { Popover } from '../components/overlay';
import { SeverityBadge } from '../components/status';
import { Button, cn, RelTime } from '../components/ui';
import type { Alert } from '../../shared/types';

export function AlertsBell() {
  const alerts = useQuery('alerts:open', () => api.alerts(true), { refreshMs: 30_000 });
  const list = alerts.data ?? [];
  const n = list.length;
  const crit = list.some((a) => a.severity === 'critical');
  const ack = async (a: Alert) => {
    setQueryData<Alert[]>('alerts:open', (old) => old?.filter((x) => x.id !== a.id));
    await act(() => api.ackAlert(a.id), { invalidate: ['alerts', 'overview'] });
  };
  return (
    <Popover
      width={380}
      label="Open alerts"
      trigger={({ toggle, ref, open }) => (
        <button
          ref={ref}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={n ? `${n} open alerts` : 'No open alerts'}
          title={n ? `${n} open alerts` : 'No open alerts'}
          className="relative inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {n ? <BellRing className="size-[18px]" aria-hidden /> : <Bell className="size-[18px]" aria-hidden />}
          {n > 0 && (
            <span
              className={cn(
                'absolute -top-0.5 -right-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ring-2 ring-bg tnum',
                crit ? 'bg-danger' : 'bg-accent',
              )}
            >
              {n}
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between px-2.5 pt-1.5 pb-2">
            <p className="text-sm font-semibold text-fg">Open alerts</p>
            <Link to="/activity/alerts" onClick={close} className="text-xs font-medium text-accent-fg hover:underline">
              View all
            </Link>
          </div>
          {n === 0 ? (
            <p className="px-3 pt-4 pb-6 text-center text-sm text-muted">All clear. Nothing needs your attention.</p>
          ) : (
            <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto">
              {list.map((a) => (
                <li key={a.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-surface-2">
                  <SeverityBadge severity={a.severity} iconOnly />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={a.device_id ? `/devices/${a.device_id}` : a.site_id ? `/sites/${a.site_id}` : '/activity/alerts'}
                      onClick={close}
                      className="block text-sm leading-snug font-medium text-fg hover:underline"
                    >
                      {a.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted">
                      {a.site_name && <>{a.site_name} · </>}
                      <RelTime ts={a.at} />
                    </p>
                  </div>
                  <Button size="xs" variant="ghost" icon={Check} onClick={() => ack(a)} aria-label={`Acknowledge: ${a.title}`}>
                    Ack
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Popover>
  );
}

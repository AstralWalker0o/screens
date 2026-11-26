import { Link } from 'react-router';
import { Bot, CircleArrowUp, CircleCheck, CircleX, LoaderCircle, Store } from 'lucide-react';
import { api } from '../../api';
import { useQuery } from '../../lib/query';
import { plural } from '../../lib/format';
import { AppIcon } from '../../components/AppLauncher';
import { ButtonLink, Card, CardHeader, RelTime, SkeletonRows, StatusText, cn } from '../../components/ui';

/** Small "Updates" card for the Overview page. */
export function UpdatesCard({ className }: { className?: string }) {
  const q = useQuery('updates:summary', api.updates.summary, { refreshMs: 60_000, silent: true });
  const s = q.data;
  return (
    <Card className={className}>
      <CardHeader
        title="App updates"
        icon={CircleArrowUp}
        subtitle={s ? (s.available ? `${plural(s.apps_with_updates, 'app')} can be updated on ${plural(s.boxes_with_updates, 'box', 'boxes')}` : 'Sideloaded apps on Android boxes are up to date') : ' '}
        actions={<ButtonLink to="/updates" size="sm" variant="ghost">Updates</ButtonLink>}
      />
      <div className="px-4 pb-4">
        {!s ? (
          q.error ? <p className="text-sm text-muted">Couldn’t load update status.</p> : <SkeletonRows rows={2} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            {s.top.length ? (
              <ul className="grid content-start gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {s.top.map((t) => (
                  <li key={t.package}>
                    <Link to="/updates/apps" className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-surface-2">
                      <AppIcon app={{ label: t.label, package: t.package }} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-fg">{t.label}</span>
                        <span className="block truncate text-xs text-muted">{t.to} for {plural(t.boxes, 'box', 'boxes')}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <StatusText tone="ok" icon={CircleCheck} className="self-start text-sm">Nothing to update</StatusText>
            )}
            <ul className="space-y-1.5 text-xs text-muted sm:min-w-44">
              {s.running > 0 && <li><StatusText tone="accent" icon={LoaderCircle} className="[&>svg]:animate-spin">{plural(s.running, 'update')} running</StatusText></li>}
              <li className="flex items-center gap-1.5"><Bot className="size-3.5" aria-hidden />{plural(s.auto_apps, 'app')} update automatically</li>
              <li className="flex items-center gap-1.5"><Store className="size-3.5" aria-hidden />{plural(s.store_managed, 'app')} kept current by Play</li>
              <li className={cn('flex items-center gap-1.5', s.failed_7d > 0 && 'text-crit-fg')}><CircleX className="size-3.5" aria-hidden />{s.failed_7d ? `${plural(s.failed_7d, 'failed update')} this week` : 'No failed updates this week'}</li>
              <li>Sources checked <RelTime ts={s.last_check} /></li>
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

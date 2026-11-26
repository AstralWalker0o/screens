import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  AppWindow, CircleArrowUp, CloudDownload, History, RefreshCw, Settings2, CalendarClock, Bot, Store, CircleX, CircleCheck, ChevronDown, ChevronRight, LoaderCircle,
} from 'lucide-react';
import type { UpdateBox, UpdatePackage, UpdateRunRequest, UpdatesOverview } from '../../shared/updates';
import { versionText } from '../../shared/updates';
import { api } from '../api';
import { act, useQuery } from '../lib/query';
import { plural } from '../lib/format';
import { AppIcon } from '../components/AppLauncher';
import { KpiTile } from '../components/charts';
import { SearchInput, Segmented } from '../components/forms';
import { Badge, Button, Callout, Card, EmptyState, IconButton, PageHeader, RelTime, SkeletonRows, StatusText, TabNav, cn } from '../components/ui';
import { checkMessage, MODE, runMessage, STATE } from './updates/meta';
import { PackageDialog } from './updates/PackageDialog';
import { ActivityTab } from './updates/ActivityTab';
import { ScheduleTab } from './updates/ScheduleTab';

export default function Updates() {
  const { tab = 'apps' } = useParams();
  const q = useQuery('updates', api.updates.overview, { refreshMs: 10_000 });
  const o = q.data;
  const [checking, setChecking] = useState(false);
  const [probing, setProbing] = useState(false);
  const running = o?.rollouts.filter((r) => r.status === 'canary' || r.status === 'rolling').length ?? 0;

  const check = async () => {
    setChecking(true);
    await act(() => api.updates.check(), { success: (r) => checkMessage(r.results), invalidate: ['updates'] });
    setChecking(false);
  };
  const probe = async () => {
    setProbing(true);
    await act(() => api.updates.probe(), {
      success: (r) => (r.devices ? `Reading the apps on ${plural(r.devices, 'box', 'boxes')}. This takes a minute or two.` : 'No Android boxes are online right now.'),
      invalidate: ['updates'],
    });
    setProbing(false);
  };

  return (
    <>
      <PageHeader
        title="Updates"
        subtitle="Keep the apps you sideload on Android TV boxes up to date. Screens updates one box first, checks it, then the rest."
        actions={
          <>
            <Button icon={RefreshCw} loading={probing} onClick={probe} title="Read the installed apps and versions on every online box again">Re-read boxes</Button>
            <Button variant="primary" icon={CloudDownload} loading={checking} onClick={check}>Check for updates</Button>
          </>
        }
      />
      {o?.github.backoff_until && (
        <Callout kind="warn" className="mb-4" title="GitHub asked Screens to slow down">
          GitHub limits how often apps can check for releases without signing in. Screens will check again <RelTime ts={o.github.backoff_until} />. Updates already downloaded still install as normal.
        </Callout>
      )}
      <section aria-label="Update summary" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile loading={!o} icon={CircleArrowUp} label="Updates ready" value={o?.summary.available}
          sub={o && (o.summary.available ? `${plural(o.summary.apps_with_updates, 'app')} on ${plural(o.summary.boxes_with_updates, 'box', 'boxes')}` : 'Everything is up to date')} />
        <KpiTile loading={!o} icon={Bot} label="Update automatically" value={o?.summary.auto_apps} sub="apps, in the maintenance window" />
        <KpiTile loading={!o} icon={Store} label="Kept current by Play" value={o?.summary.store_managed} sub="apps Google Play updates itself" />
        <KpiTile loading={!o} icon={CircleX} label="Failed · 7 days" value={o?.summary.failed_7d}
          sub={o && (o.summary.failed_7d ? <Link to="/updates/activity" className="text-crit-fg hover:underline">See what went wrong</Link> : 'No failed updates')} />
      </section>
      <TabNav
        base="/updates"
        active={tab}
        tabs={[
          { id: 'apps', label: 'Apps', icon: AppWindow, count: o?.summary.apps_with_updates },
          { id: 'activity', label: 'Activity', icon: History, count: running || null },
          { id: 'schedule', label: 'Schedule & boxes', icon: CalendarClock },
        ]}
      />
      {tab === 'activity' ? <ActivityTab o={o} /> : tab === 'schedule' ? <ScheduleTab o={o} /> : <AppsTab o={o} />}
    </>
  );
}

type Filter = 'updates' | 'managed' | 'play' | 'all';

function AppsTab({ o }: { o?: UpdatesOverview }) {
  const [filter, setFilter] = useState<Filter | null>(null);
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<string | null>(null);
  const pkgs = o?.packages ?? [];
  const counts = {
    updates: pkgs.filter((p) => p.counts.update > 0).length,
    managed: pkgs.filter((p) => p.latest || p.source || p.builtin).length,
    play: pkgs.filter((p) => p.counts.store > 0).length,
    all: pkgs.length,
  };
  const f: Filter = filter ?? (counts.updates ? 'updates' : 'managed');
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return pkgs
      .filter((p) => (f === 'updates' ? p.counts.update > 0 : f === 'managed' ? p.latest || p.source || p.builtin : f === 'play' ? p.counts.store > 0 : true))
      .filter((p) => !s || p.label.toLowerCase().includes(s) || p.package.toLowerCase().includes(s));
  }, [pkgs, f, search]);
  const editing = pkgs.find((p) => p.package === edit) ?? null;

  if (!o) return <SkeletonRows rows={5} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search apps" className="w-full sm:w-64" />
        <Segmented<Filter>
          ariaLabel="Which apps"
          size="sm"
          value={f}
          onChange={setFilter}
          options={[
            { value: 'updates', label: `Updates (${counts.updates})` },
            { value: 'managed', label: `Managed (${counts.managed})`, title: 'Apps Screens has builds or an update source for' },
            { value: 'play', label: `Play (${counts.play})`, title: 'Apps Google Play keeps up to date' },
            { value: 'all', label: `All (${counts.all})` },
          ]}
        />
      </div>
      {list.length === 0 ? (
        <Card>
          {f === 'updates' && !search ? (
            <EmptyState icon={CircleCheck} title="Every box is up to date" action={<Button size="sm" onClick={() => setFilter('all')}>Show all apps</Button>}>
              When a newer build reaches the library (uploaded, or downloaded from GitHub), it shows up here.
            </EmptyState>
          ) : (
            <EmptyState icon={AppWindow} title={search ? `No apps match “${search}”` : 'No apps here'}>
              {f === 'managed' ? 'Upload an APK to the Library, or open an app and add its GitHub releases as a source.' : 'Try another filter.'}
            </EmptyState>
          )}
        </Card>
      ) : (
        <ul className="space-y-3">
          {list.map((p) => <li key={p.package}><PackageCard p={p} onEdit={() => setEdit(p.package)} sites={o.sites} /></li>)}
        </ul>
      )}
      <PackageDialog pkg={editing} sites={o.sites} onClose={() => setEdit(null)} />
    </div>
  );
}

function sourceText(p: UpdatePackage) {
  if (p.builtin) return 'Built in (Screens Launcher)';
  if (p.source) return `GitHub ${p.source.repo}`;
  if (p.latest) return 'Library';
  return 'No source';
}

function modeSummary(p: UpdatePackage, sites: UpdatesOverview['sites']) {
  const base = MODE[p.fleet_mode ?? 'notify'].label;
  const overrides = Object.entries(p.site_modes).filter(([, m]) => m !== (p.fleet_mode ?? 'notify'));
  if (!overrides.length) return base;
  const names = overrides.map(([id, m]) => `${MODE[m].label} at ${sites.find((s) => s.site_id === id)?.site_name ?? 'a site'}`);
  return `${base} (${names.join(', ')})`;
}

function PackageCard({ p, onEdit, sites }: { p: UpdatePackage; onEdit: () => void; sites: UpdatesOverview['sites'] }) {
  const storeOnly = p.boxes.length > 0 && p.counts.store === p.boxes.length;
  const [open, setOpen] = useState(!storeOnly && p.boxes.length > 0);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, b: UpdateRunRequest) => {
    setBusy(key);
    await act(() => api.updates.run(b), { success: (r) => runMessage(r, p.label), invalidate: ['updates'] });
    setBusy(null);
  };
  const bySite = useMemo(() => {
    const m = new Map<string, UpdateBox[]>();
    for (const b of p.boxes) m.set(b.site_id, [...(m.get(b.site_id) ?? []), b]);
    return [...m.entries()];
  }, [p.boxes]);
  const multiSite = bySite.length > 1;

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3 px-4 pt-3.5 pb-3 sm:flex-nowrap">
        <AppIcon app={{ label: p.label, package: p.package }} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-sm font-semibold text-fg">{p.label}</h3>
            {p.counts.update > 0 && <Badge tone="accent" icon={CircleArrowUp}>{versionText(p.latest!)} ready</Badge>}
            {p.counts.blocked > 0 && <Badge tone="warn" title="Some boxes can’t take the newest build">{p.counts.blocked} blocked</Badge>}
            {storeOnly && <Badge icon={Store}>Google Play</Badge>}
          </div>
          <p className="truncate font-mono text-[11.5px] text-muted">{p.package}</p>
          <p className="mt-1 text-xs text-muted">
            {p.latest ? <>Newest build <span className="font-medium text-fg tnum">{versionText(p.latest)}</span> · </> : null}
            {sourceText(p)} · {modeSummary(p, sites)}
            {p.source?.last_status === 'error' && <span className="text-crit-fg"> · source has a problem</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:justify-end">
          {p.counts.update > 0 && (
            <Button size="sm" variant="primary" icon={CircleArrowUp} loading={busy === 'all'} onClick={() => run('all', { package: p.package })}>
              {p.counts.update === 1 ? 'Update 1 box' : `Update ${p.counts.update} boxes`}
            </Button>
          )}
          <IconButton icon={Settings2} label={`Update source and policy for ${p.label}`} variant="secondary" size="sm" onClick={onEdit} />
        </div>
      </div>
      {p.boxes.length === 0 ? (
        <p className="border-t border-line px-4 py-2.5 text-xs text-muted">Not installed on any Android box yet.</p>
      ) : (
        <div className="border-t border-line">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs font-medium text-muted hover:text-fg"
          >
            {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
            {plural(p.boxes.length, 'box', 'boxes')}
            {multiSite ? ` at ${bySite.length} sites` : ` at ${bySite[0][1][0].site_name}`}
            {p.counts.current > 0 && <span className="text-subtle"> · {p.counts.current} up to date</span>}
          </button>
          {open && (
            <div className="space-y-3 px-4 pb-3">
              {bySite.map(([siteId, boxes]) => {
                const n = boxes.filter((b) => b.state === 'update').length;
                const siteMode = p.site_modes[siteId];
                return (
                  <div key={siteId}>
                    {(multiSite || n > 1) && (
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold text-fg">{boxes[0].site_name}</p>
                        {siteMode && <Badge icon={MODE[siteMode].icon} title="Set for this site">{MODE[siteMode].label} here</Badge>}
                        {n > 1 && multiSite && (
                          <Button size="xs" variant="soft" className="ml-auto" loading={busy === siteId} onClick={() => run(siteId, { package: p.package, site_id: siteId })}>
                            Update {n === 1 ? 'here' : `${n} here`}
                          </Button>
                        )}
                      </div>
                    )}
                    <ul className="divide-y divide-line rounded-lg border border-line">
                      {boxes.map((b) => <BoxRow key={b.device_id} b={b} busy={busy === b.device_id} onUpdate={() => run(b.device_id, { package: p.package, device_id: b.device_id })} />)}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function BoxRow({ b, busy, onUpdate }: { b: UpdateBox; busy: boolean; onUpdate: () => void }) {
  const s = STATE[b.state];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <div className="flex min-w-0 flex-1 basis-40 items-center gap-2">
        <span className={cn('size-1.5 shrink-0 rounded-full', b.online ? 'bg-ok' : 'bg-subtle')} title={b.online ? 'Online' : 'Offline'} aria-label={b.online ? 'Online' : 'Offline'} role="img" />
        <Link to={`/devices/${b.device_id}/apps`} className="truncate text-sm text-fg hover:underline">{b.device_name}</Link>
      </div>
      <span className="font-mono text-xs text-muted tnum">
        {b.version_name ?? (b.version_code != null ? `build ${b.version_code}` : '–')}
        {b.candidate && b.state === 'update' && <> → <span className="font-semibold text-accent-fg">{b.candidate.version_name ?? `build ${b.candidate.version_code}`}</span></>}
      </span>
      {b.busy ? (
        <StatusText tone="accent" icon={LoaderCircle} className="[&>svg]:animate-spin">Updating</StatusText>
      ) : b.state === 'update' ? (
        b.online
          ? <Button size="xs" variant="soft" icon={CircleArrowUp} loading={busy} onClick={onUpdate} title={`Update ${b.device_name} now`}>Update</Button>
          : <Badge title="The box is offline right now">Offline</Badge>
      ) : (
        <Badge tone={s.tone} icon={s.icon} title={b.detail}>{s.short}</Badge>
      )}
      {(b.state !== 'update' && b.state !== 'current' && b.state !== 'store') || b.last_result?.status === 'error' ? (
        <p className={cn('w-full text-xs', b.last_result?.status === 'error' ? 'text-crit-fg' : 'text-muted')}>
          {b.last_result?.status === 'error' ? <>Last update failed <RelTime ts={b.last_result.at} />: {b.last_result.detail}</> : b.detail}
        </p>
      ) : null}
    </li>
  );
}

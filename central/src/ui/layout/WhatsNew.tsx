import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import {
  X, Sparkles, TrendingUp, Wrench, ShieldCheck, Router, House, ChevronDown, CircleCheck, TriangleAlert, ArrowRight, Gift, type LucideIcon,
} from 'lucide-react';
import { APP_VERSION, RELEASES, type Release, type ReleaseNoteKind } from '../../shared/releases';
import { BUILD_SHA, BUILD_TIME } from '../../shared/build';
import { api } from '../api';
import { errorMessage, useQuery, type QueryResult } from '../lib/query';
import type { VersionInfo } from '../../shared/types';
import type { Tone } from '../lib/labels';
import { cmpVersion } from '../lib/format';
import { Badge, Card, IconButton, RelTime, Skeleton, StatusText, TONE_BADGE, cn } from '../components/ui';

// ---------------------------------------------------------------------------
// Tiny store: panel open state + "seen" version (localStorage, guarded).

const SEEN_KEY = 'screens.seenVersion';
const subs = new Set<() => void>();
let open = false;
let seen: string | null = readSeen();

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}
function emit() {
  subs.forEach((s) => s());
}
function markSeen() {
  seen = APP_VERSION;
  try {
    localStorage.setItem(SEEN_KEY, APP_VERSION);
  } catch {
    /* private mode: the dot just comes back next visit */
  }
}
export function openWhatsNew() {
  open = true;
  markSeen();
  emit();
}
function closeWhatsNew() {
  open = false;
  emit();
}
function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}
function useWhatsNew() {
  const isOpen = useSyncExternalStore(subscribe, () => open, () => false);
  const seenVersion = useSyncExternalStore(subscribe, () => seen, () => null);
  return { isOpen, unseen: seenVersion !== APP_VERSION };
}

const shortSha = (s: string | null | undefined) => (s && s !== 'dev' ? s.slice(0, 7) : 'dev');
const minor = (v: string) => v.split('.').slice(0, 2).join('.');

// ---------------------------------------------------------------------------
// Top bar badge

export function VersionBadge() {
  const { isOpen, unseen } = useWhatsNew();
  return (
    <button
      type="button"
      onClick={openWhatsNew}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-label={`Version ${APP_VERSION} — what’s new${unseen ? ' (new release)' : ''}`}
      title={unseen ? `What’s new in v${APP_VERSION}` : `Screens v${APP_VERSION} — release notes`}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
        unseen ? 'border-accent/40 bg-accent-soft text-accent-fg hover:bg-accent-soft/70' : 'border-line bg-surface text-muted hover:text-fg',
      )}
    >
      {unseen && (
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-accent" />
        </span>
      )}
      <span className="font-mono tnum">
        <span className="sm:hidden">v{minor(APP_VERSION)}</span>
        <span className="max-sm:hidden">v{APP_VERSION}</span>
      </span>
      {unseen && <span className="max-sm:hidden">What’s new</span>}
    </button>
  );
}

/** Muted line at the bottom of the sidebar. */
export function SidebarVersion() {
  const { unseen } = useWhatsNew();
  return (
    <button
      type="button"
      onClick={openWhatsNew}
      aria-label={`Version ${APP_VERSION}, build ${shortSha(BUILD_SHA)} — what’s new`}
      className="flex w-full items-center gap-1.5 rounded-md px-0.5 text-left text-[11px] text-subtle transition-colors hover:text-fg"
    >
      {unseen && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
      <span className="truncate">
        Screens <span className="font-mono">v{APP_VERSION}</span> · <span className="font-mono">{shortSha(BUILD_SHA)}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Panel

const KIND: Record<ReleaseNoteKind, { label: string; icon: LucideIcon; tone: Tone }> = {
  new: { label: 'New', icon: Sparkles, tone: 'accent' },
  improved: { label: 'Improved', icon: TrendingUp, tone: 'ok' },
  fixed: { label: 'Fixed', icon: Wrench, tone: 'neutral' },
  security: { label: 'Security', icon: ShieldCheck, tone: 'serious' },
};
const KIND_ORDER: ReleaseNoteKind[] = ['new', 'improved', 'fixed', 'security'];

const fmtReleaseDate = (d: string) => {
  const t = new Date(`${d}T00:00:00`);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
};

export function WhatsNewHost() {
  const { isOpen } = useWhatsNew();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (isOpen && !d.open) d.showModal();
    if (!isOpen && d.open) d.close();
  }, [isOpen]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="whats-new-title"
      onClose={closeWhatsNew}
      onCancel={(e) => {
        e.preventDefault();
        closeWhatsNew();
      }}
      onMouseDown={(e) => e.target === ref.current && closeWhatsNew()}
      className={cn(
        'fixed m-0 max-w-none border-line bg-surface p-0 text-fg shadow-pop',
        // phone: bottom sheet
        'inset-x-0 top-auto bottom-0 max-h-[88dvh] w-full rounded-t-2xl border-t',
        // desktop: right-hand drawer
        'sm:inset-y-0 sm:right-0 sm:left-auto sm:h-dvh sm:max-h-none sm:w-[460px] sm:rounded-none sm:rounded-l-2xl sm:border-t-0 sm:border-l',
      )}
    >
      {isOpen && <PanelBody />}
    </dialog>
  );
}

function PanelBody() {
  const v = useQuery('version', api.version, { staleMs: 60_000, silent: true });
  const sha = BUILD_SHA !== 'dev' ? BUILD_SHA : v.data?.build_sha ?? 'dev';
  const built = BUILD_TIME ?? v.data?.built_at ?? null;
  const builtTs = built ? Date.parse(built) : null;
  return (
    <div className="flex max-h-[88dvh] flex-col sm:h-dvh sm:max-h-none">
      <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong sm:hidden" aria-hidden />
      <header className="flex items-start gap-3 border-b border-line px-5 pt-3 pb-4 sm:pt-5">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-fg"><Gift className="size-[18px]" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h2 id="whats-new-title" className="text-base font-semibold text-fg">
            Screens <span className="font-mono">v{APP_VERSION}</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {builtTs ? <>Built <RelTime ts={builtTs} /></> : 'Development build'} · <span className="font-mono">{shortSha(sha)}</span>
          </p>
        </div>
        <IconButton icon={X} label="Close what’s new" size="sm" onClick={closeWhatsNew} className="-mt-0.5 -mr-1.5" />
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <FleetVersions q={v} />
        <section aria-labelledby="releases-title">
          <h3 id="releases-title" className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">Release notes</h3>
          <ol className="relative space-y-4 border-l border-line pl-5">
            {RELEASES.map((r, i) => <ReleaseItem key={r.version} release={r} latest={i === 0} />)}
          </ol>
        </section>
      </div>
    </div>
  );
}

function FleetVersions({ q }: { q: QueryResult<VersionInfo> }) {
  const v = q.data;
  if (q.loading) {
    return (
      <Card className="space-y-2 p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </Card>
    );
  }
  if (!v) return <Card className="p-4 text-sm text-muted">Couldn’t load fleet versions{q.error ? `: ${errorMessage(q.error)}` : '.'}</Card>;
  const g = v.gateway;
  const outdated = g.sites.filter((s) => !s.up_to_date);
  const l = v.launcher;
  return (
    <Card className="p-4">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Fleet versions</h3>
      <div className="mt-3 space-y-3">
        <div className="flex items-start gap-3">
          <Router className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">
              Gateways: <strong className="font-semibold">{g.up_to_date} of {g.total}</strong> up to date
              {g.latest && <span className="text-muted"> (latest <span className="font-mono">{g.latest}</span>)</span>}
            </p>
            {g.total === 0 ? (
              <p className="mt-0.5 text-xs text-muted">No gateways installed yet.</p>
            ) : outdated.length === 0 ? (
              <StatusText tone="ok" icon={CircleCheck} className="mt-1">All gateways are current</StatusText>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {outdated.map((s) => (
                  <li key={s.site_id}>
                    <Link
                      to={`/sites/${s.site_id}/gateway`}
                      onClick={closeWhatsNew}
                      className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface-2"
                    >
                      <TriangleAlert className="size-3.5 shrink-0 text-warn-fg" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-fg">{s.site_name}</span>
                      <span className="shrink-0 font-mono text-xs text-muted">
                        {s.version ?? '?'}{g.latest && cmpVersion(g.latest, s.version) > 0 ? ` → ${g.latest}` : ''}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-accent-fg">
                        {s.status === 'online' ? 'Update' : 'Offline'} <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="flex items-start gap-3 border-t border-line pt-3">
          <House className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <p className="min-w-0 flex-1 text-sm text-fg">
            Screens Launcher: {l.latest ? <>latest <span className="font-mono">{l.latest}</span>, </> : 'not published yet, '}
            installed on <strong className="font-semibold">{l.installed}</strong> box{l.installed === 1 ? '' : 'es'}
            {l.installed > 0 && l.latest && <span className="text-muted"> ({l.up_to_date} up to date)</span>}
          </p>
        </div>
      </div>
    </Card>
  );
}

function ReleaseItem({ release: r, latest }: { release: Release; latest: boolean }) {
  const [expanded, setExpanded] = useState(latest);
  const groups = KIND_ORDER.map((k) => [k, r.notes.filter((n) => n.kind === k)] as const).filter(([, ns]) => ns.length);
  const id = `release-${r.version.replace(/\./g, '-')}`;
  return (
    <li className="relative">
      <span className={cn('absolute top-1.5 -left-[26px] size-2.5 rounded-full ring-4 ring-surface', latest ? 'bg-accent' : 'bg-line-strong')} aria-hidden />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-semibold text-fg">v{r.version}</span>
        <span className="text-xs text-muted">{fmtReleaseDate(r.date)}</span>
        {latest && <Badge tone="accent">Latest</Badge>}
      </div>
      <p className="mt-1 text-sm font-semibold text-fg">{r.title}</p>
      {r.summary && <p className="mt-0.5 text-sm text-muted">{r.summary}</p>}
      {r.components && (r.components.gateway || r.components.launcher) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {r.components.gateway && <Badge icon={Router}>Gateway <span className="font-mono">{r.components.gateway}</span></Badge>}
          {r.components.launcher && <Badge icon={House}>Launcher <span className="font-mono">{r.components.launcher}</span></Badge>}
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls={id}
        className="mt-2 inline-flex items-center gap-1 rounded-md text-xs font-medium text-accent-fg hover:underline"
      >
        {expanded ? 'Hide changes' : `Show ${r.notes.length} change${r.notes.length === 1 ? '' : 's'}`}
        <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden />
      </button>
      {expanded && (
        <div id={id} className="mt-2 space-y-3">
          {groups.map(([kind, notes]) => {
            const m = KIND[kind];
            return (
              <div key={kind}>
                <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-xs font-semibold', TONE_BADGE[m.tone])}>
                  <m.icon className="size-3" aria-hidden />
                  {m.label}
                </span>
                <ul className="mt-1.5 space-y-1.5">
                  {notes.map((n, i) => (
                    <li key={i} className="flex gap-2 text-sm text-fg">
                      <span className="mt-2 size-1 shrink-0 rounded-full bg-subtle" aria-hidden />
                      <span className="min-w-0">{n.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

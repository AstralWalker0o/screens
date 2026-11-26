import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigation } from 'react-router';
import {
  LayoutDashboard, Building2, TvMinimalPlay, ShieldCheck, Globe, Workflow, Package, Activity, Settings, Menu as MenuIcon, X,
  Sun, Moon, Monitor, FlaskConical, CircleCheck, CircleAlert, Info,
} from 'lucide-react';
import { api, MOCK, setMockMode } from '../api';
import { useQuery } from '../lib/query';
import { useTheme, type ThemePref } from '../lib/theme';
import { dismissToast, useToasts } from '../lib/toast';
import { cn, IconButton } from '../components/ui';
import { GlobalSearch } from './GlobalSearch';
import { AlertsBell } from './AlertsBell';
import { SidebarVersion, VersionBadge, WhatsNewHost } from './WhatsNew';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/sites', label: 'Sites', icon: Building2 },
  { to: '/devices', label: 'Devices', icon: TvMinimalPlay },
  { to: '/privacy', label: 'Privacy', icon: ShieldCheck },
  { to: '/dns', label: 'DNS', icon: Globe },
  { to: '/automations', label: 'Automations', icon: Workflow },
  { to: '/library', label: 'Library', icon: Package },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
        <rect x="7" y="9" width="18" height="12" rx="2" fill="none" stroke="#fff" strokeWidth="2.2" />
        <path d="M12 25h8" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <div className="leading-tight">
        <p className="text-sm font-semibold tracking-tight text-fg">Screens</p>
        <p className="text-[11px] text-muted">Private media fleet</p>
      </div>
    </div>
  );
}

function ThemeSwitch() {
  const { pref, setPref } = useTheme();
  const opts: { v: ThemePref; icon: typeof Sun; label: string }[] = [
    { v: 'light', icon: Sun, label: 'Light' },
    { v: 'system', icon: Monitor, label: 'Match system' },
    { v: 'dark', icon: Moon, label: 'Dark' },
  ];
  return (
    <div role="radiogroup" aria-label="Colour theme" className="flex rounded-lg border border-line bg-surface-2 p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={pref === o.v}
          aria-label={o.label}
          title={o.label}
          onClick={() => setPref(o.v)}
          className={cn('flex h-6 flex-1 items-center justify-center rounded-md transition-colors', pref === o.v ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-subtle hover:text-fg')}
        >
          <o.icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const me = useQuery('me', api.me, { staleMs: 600_000 });
  const alerts = useQuery('alerts:open', () => api.alerts(true), { refreshMs: 30_000 });
  const openCount = alerts.data?.length ?? 0;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-3">
        <Logo />
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-2">
        <ul className="space-y-0.5">
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink
                to={n.to}
                end={n.end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors',
                    isActive ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <n.icon className={cn('size-4', isActive ? 'text-accent-fg' : '')} aria-hidden />
                    <span className="flex-1">{n.label}</span>
                    {n.to === '/activity' && openCount > 0 && (
                      <span className="rounded-full bg-crit-soft px-1.5 text-[11px] font-semibold text-crit-fg tnum" aria-label={`${openCount} open alerts`}>
                        {openCount}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="space-y-3 border-t border-line p-3">
        {MOCK && (
          <button
            type="button"
            onClick={() => setMockMode(false)}
            className="flex w-full items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft px-2.5 py-1.5 text-left text-xs text-warn-fg"
            title="You are looking at demo data. Click to switch to the real API."
          >
            <FlaskConical className="size-3.5 shrink-0" aria-hidden />
            <span className="flex-1">Demo data</span>
            <span className="underline underline-offset-2">Exit</span>
          </button>
        )}
        <ThemeSwitch />
        <div className="flex items-center gap-2 px-0.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-fg">
            {(me.data?.name ?? me.data?.email ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-xs font-medium text-fg">{me.data?.name ?? 'Signed in'}</p>
            <p className="truncate text-[11px] text-muted">{me.data?.email ?? '…'}</p>
          </div>
        </div>
        <SidebarVersion />
      </div>
    </div>
  );
}

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onMouseDown={(e) => e.target === ref.current && onClose()}
      aria-label="Navigation"
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-72 max-w-[85vw] border-r border-line bg-surface p-0 shadow-pop"
    >
      <div className="relative h-full">
        <IconButton icon={X} label="Close menu" onClick={onClose} className="absolute top-3 right-2 z-10" size="sm" />
        <SidebarContent onNavigate={onClose} />
      </div>
    </dialog>
  );
}

function Toaster() {
  const toasts = useToasts();
  const icon = { success: CircleCheck, error: CircleAlert, info: Info };
  const tone = { success: 'text-ok-fg', error: 'text-crit-fg', info: 'text-accent-fg' };
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
      {toasts.map((t) => {
        const Icon = icon[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 shadow-pop"
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', tone[t.kind])} aria-hidden />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-fg">{t.title}</p>
              {t.detail && <p className="mt-0.5 text-muted [overflow-wrap:anywhere]">{t.detail}</p>}
            </div>
            <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="rounded p-0.5 text-subtle hover:text-fg">
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  const nav = useNavigation();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setDrawer(false);
    window.scrollTo({ top: 0 });
  }, [loc.pathname]);

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only z-50 rounded-lg bg-accent px-3 py-2 text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      {/* The column stretches with the page so its background and border never stop short; the nav itself sticks. */}
      <div className="relative z-30 hidden w-60 shrink-0 border-r border-line bg-surface/60 lg:block">
        <aside className="sticky top-0 h-dvh">
          <SidebarContent />
        </aside>
      </div>
      <MobileDrawer open={drawer} onClose={() => setDrawer(false)} />
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-bg/85 px-3 backdrop-blur sm:px-4 lg:px-6">
          <IconButton icon={MenuIcon} label="Open menu" onClick={() => setDrawer(true)} className="lg:hidden" />
          <div className="lg:hidden">
            <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
              <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
              <rect x="7" y="9" width="18" height="12" rx="2" fill="none" stroke="#fff" strokeWidth="2.2" />
              <path d="M12 25h8" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </div>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1.5">
            <VersionBadge />
            <AlertsBell />
          </div>
        </header>
        {nav.state === 'loading' && <div className="fixed top-0 right-0 left-0 z-40 h-0.5 animate-pulse-soft bg-accent" />}
        <main id="main" ref={mainRef} className="mx-auto w-full max-w-[1400px] px-4 pt-5 pb-16 sm:px-5 lg:px-8 lg:pt-7">
          {children ?? <Outlet />}
        </main>
      </div>
      <WhatsNewHost />
      <Toaster />
    </div>
  );
}

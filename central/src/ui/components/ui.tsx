import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode, type HTMLAttributes } from 'react';
import { NavLink, Link } from 'react-router';
import { Check, Copy, Info, LoaderCircle, TriangleAlert, CircleAlert, Lightbulb, type LucideIcon } from 'lucide-react';
import { absTime, relTime } from '../lib/format';
import { useNow, copyText } from '../lib/hooks';
import type { Tone } from '../lib/labels';
import { toast } from '../lib/toast';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'soft';
type Size = 'xs' | 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-sm disabled:opacity-50',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-surface-2 shadow-card disabled:opacity-50',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2 disabled:opacity-40',
  soft: 'bg-accent-soft text-accent-fg hover:bg-accent-soft/70 disabled:opacity-50',
  danger: 'bg-danger text-white hover:bg-danger/90 shadow-sm disabled:opacity-50',
  'danger-ghost': 'text-crit-fg hover:bg-crit-soft disabled:opacity-40',
};
const SIZE: Record<Size, string> = {
  xs: 'h-6 px-2 text-xs gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-sm gap-2 rounded-lg',
  lg: 'h-10 px-4 text-sm gap-2 rounded-lg',
};
const ICON_SIZE: Record<Size, string> = { xs: 'size-6 rounded-md', sm: 'size-7 rounded-md', md: 'size-8 rounded-lg', lg: 'size-10 rounded-lg' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  loading?: boolean;
  iconRight?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, iconRight: IconRight, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconCls = size === 'xs' || size === 'sm' ? 'size-3.5' : 'size-4';
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors select-none',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className={cn(iconCls, 'animate-spin')} aria-hidden /> : Icon ? <Icon className={iconCls} aria-hidden /> : null}
      {children}
      {IconRight && <IconRight className={iconCls} aria-hidden />}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, variant = 'ghost', size = 'md', loading, className, type = 'button', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      className={cn('inline-flex shrink-0 items-center justify-center transition-colors', VARIANT[variant], ICON_SIZE[size], className)}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Icon className={size === 'xs' ? 'size-3.5' : 'size-4'} aria-hidden />}
    </button>
  );
});

export function ButtonLink({ to, children, variant = 'secondary', size = 'md', icon: Icon, className }: {
  to: string; children: ReactNode; variant?: Variant; size?: Size; icon?: LucideIcon; className?: string;
}) {
  return (
    <Link to={to} className={cn('inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors', VARIANT[variant], SIZE[size], className)}>
      {Icon && <Icon className={size === 'xs' || size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden />}
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Cards & layout

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('min-w-0 rounded-xl border border-line bg-surface shadow-card', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions, icon: Icon, className }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: LucideIcon; className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-3.5 pb-3', className)}>
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          {Icon && <Icon className="size-4 text-muted" aria-hidden />}
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-4 pb-4', className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions, back, icon: Icon, meta }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string }; icon?: LucideIcon; meta?: ReactNode;
}) {
  return (
    <header className="mb-5">
      {back && (
        <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-fg">
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {Icon && (
            <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-muted shadow-card">
              <Icon className="size-5" aria-hidden />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-fg [overflow-wrap:anywhere]">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
            {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Badges & status

export const TONE_BADGE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  accent: 'bg-accent-soft text-accent-fg border-transparent',
  ok: 'bg-ok-soft text-ok-fg border-transparent',
  warn: 'bg-warn-soft text-warn-fg border-transparent',
  serious: 'bg-serious-soft text-serious-fg border-transparent',
  crit: 'bg-crit-soft text-crit-fg border-transparent',
};
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted', accent: 'text-accent-fg', ok: 'text-ok-fg', warn: 'text-warn-fg', serious: 'text-serious-fg', crit: 'text-crit-fg',
};
export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-subtle', accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', serious: 'bg-serious', crit: 'bg-crit',
};

export function Badge({ tone = 'neutral', icon: Icon, children, className, title, mono }: {
  tone?: Tone; icon?: LucideIcon; children: ReactNode; className?: string; title?: string; mono?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-xs font-medium whitespace-nowrap',
        TONE_BADGE[tone],
        mono && 'font-mono text-[11px]',
        className,
      )}
    >
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Icon + colour + text. Never colour alone. */
export function StatusText({ tone, icon: Icon, children, className, title, pulse }: {
  tone: Tone; icon: LucideIcon; children: ReactNode; className?: string; title?: string; pulse?: boolean;
}) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap', TONE_TEXT[tone], className)}>
      <Icon className={cn('size-3.5 shrink-0', pulse && 'animate-pulse-soft')} aria-hidden />
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10px] font-medium text-muted">
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------------------
// Feedback

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn('size-4 animate-spin text-muted', className)} aria-label="Loading" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse-soft rounded-md bg-surface-3', className)} aria-hidden />;
}

export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2.5', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-9', i % 3 === 1 ? 'w-11/12' : i % 3 === 2 ? 'w-4/5' : 'w-full')} />
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action, className }: {
  icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      {Icon && (
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-surface-2 text-muted">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

const CALLOUT: Record<'info' | 'tip' | 'warn' | 'crit', { icon: LucideIcon; cls: string; iconCls: string }> = {
  info: { icon: Info, cls: 'bg-accent-soft/60 border-accent/20', iconCls: 'text-accent-fg' },
  tip: { icon: Lightbulb, cls: 'bg-surface-2 border-line', iconCls: 'text-muted' },
  warn: { icon: TriangleAlert, cls: 'bg-warn-soft border-warn/30', iconCls: 'text-warn-fg' },
  crit: { icon: CircleAlert, cls: 'bg-crit-soft border-crit/30', iconCls: 'text-crit-fg' },
};
export function Callout({ kind = 'info', title, children, className, action }: {
  kind?: 'info' | 'tip' | 'warn' | 'crit'; title?: ReactNode; children?: ReactNode; className?: string; action?: ReactNode;
}) {
  const c = CALLOUT[kind];
  const Icon = c.icon;
  return (
    <div className={cn('flex gap-3 rounded-lg border px-3.5 py-3 text-sm', c.cls, className)} role={kind === 'crit' || kind === 'warn' ? 'alert' : undefined}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', c.iconCls)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold text-fg">{title}</p>}
        {children && <div className={cn('text-muted', !!title && 'mt-0.5')}>{children}</div>}
        {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time

export function RelTime({ ts, className, prefix }: { ts: number | null | undefined; className?: string; prefix?: string }) {
  const now = useNow();
  if (!ts) return <span className={cn('text-subtle', className)}>never</span>;
  return (
    <time dateTime={new Date(ts).toISOString()} title={absTime(ts)} className={cn('whitespace-nowrap', className)}>
      {prefix}
      {relTime(ts, Math.max(now, Date.now()))}
    </time>
  );
}

// ---------------------------------------------------------------------------
// Tabs (URL driven)

export interface TabDef { id: string; label: string; icon?: LucideIcon; count?: number | null; hidden?: boolean }

export function TabNav({ tabs, base, active, className }: { tabs: TabDef[]; base: string; active: string; className?: string }) {
  return (
    <nav aria-label="Sections" className={cn('-mx-4 mb-5 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0', className)}>
      <ul className="flex min-w-max gap-1">
        {tabs.filter((t) => !t.hidden).map((t) => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <li key={t.id}>
              <NavLink
                to={`${base}/${t.id}`}
                replace
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'relative -mb-px flex h-10 items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium transition-colors',
                  isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
                )}
              >
                {Icon && <Icon className="size-4" aria-hidden />}
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className="rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold text-muted tnum">{t.count}</span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Copy

export function CopyButton({ text, label = 'Copy', size = 'sm', variant = 'secondary' }: { text: string; label?: string; size?: Size; variant?: Variant }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      icon={done ? Check : Copy}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } else toast.error('Could not copy', 'Select the text and copy it manually.');
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Tables

export const th = 'px-3 py-2 text-left text-xs font-medium text-muted whitespace-nowrap';
export const td = 'px-3 py-2.5 align-middle';

export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('max-w-full overflow-x-auto', className)}>{children}</div>;
}

export function KeyVal({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{v ?? <span className="text-subtle">–</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn('mb-2 text-xs font-semibold tracking-wide text-muted uppercase', className)}>{children}</h3>;
}

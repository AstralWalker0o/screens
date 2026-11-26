import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search, X, type LucideIcon } from 'lucide-react';
import { cn } from './ui';

const control =
  'w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-fg placeholder:text-subtle shadow-card transition-colors hover:border-subtle/60 focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon; mono?: boolean }>(function Input(
  { className, icon: Icon, mono, ...rest },
  ref,
) {
  if (Icon) {
    return (
      <div className={cn('relative min-w-0', className)}>
        <Icon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" aria-hidden />
        <input ref={ref} className={cn(control, 'h-8 pl-8', mono && 'font-mono text-[13px]')} {...rest} />
      </div>
    );
  }
  // Width/margin classes go on a wrapper so they don't fight the control's own w-full.
  if (className) {
    return (
      <div className={cn('min-w-0', className)}>
        <input ref={ref} className={cn(control, 'h-8', mono && 'font-mono text-[13px]')} {...rest} />
      </div>
    );
  }
  return <input ref={ref} className={cn(control, 'h-8', mono && 'font-mono text-[13px]')} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function Textarea(
  { className, mono, ...rest },
  ref,
) {
  const custom = className?.includes('min-h-');
  return <textarea ref={ref} className={cn(control, !custom && 'min-h-20', 'py-2', mono && 'font-mono text-[13px]', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <div className={cn('relative min-w-0', className)}>
      <select ref={ref} className={cn(control, 'h-8 appearance-none pr-8')} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-subtle" aria-hidden />
    </div>
  );
});

export function SearchInput({ value, onChange, placeholder = 'Search…', className, label }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string; label?: string;
}) {
  return (
    <div className={cn('relative min-w-0', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" aria-hidden />
      <input
        type="search"
        aria-label={label ?? placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(control, 'h-8 pr-7 pl-8 [&::-webkit-search-cancel-button]:hidden')}
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function Field({ label, hint, children, className, htmlFor, error, optional }: {
  label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string; error?: string | null; optional?: boolean;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-1 flex items-baseline gap-1.5 text-sm font-medium text-fg">
        {label}
        {optional && <span className="text-xs font-normal text-subtle">optional</span>}
      </label>
      {children}
      {error ? <p className="mt-1 text-xs text-crit-fg">{error}</p> : hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description, disabled, size = 'md', className, id, ariaLabel }: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; size?: 'sm' | 'md'; className?: string; id?: string; ariaLabel?: string;
}) {
  const autoId = useId();
  const tid = id ?? autoId;
  const sw = (
    <button
      id={tid}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        size === 'sm' ? 'h-4.5 w-8' : 'h-5.5 w-10',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        className={cn(
          'inline-block rounded-full bg-white shadow transition-transform',
          size === 'sm' ? 'size-3.5' : 'size-4.5',
          checked ? (size === 'sm' ? 'translate-x-4' : 'translate-x-5') : 'translate-x-0.5',
        )}
      />
    </button>
  );
  if (!label && !description) return sw;
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={tid} className="block cursor-pointer text-sm font-medium text-fg">{label}</label>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      <div className="pt-0.5">{sw}</div>
    </div>
  );
}

export function Checkbox({ checked, onChange, label, description, disabled, className, indeterminate, ariaLabel }: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; className?: string; indeterminate?: boolean; ariaLabel?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <span className="relative mt-0.5 inline-flex size-4 shrink-0">
        <input
          id={id}
          type="checkbox"
          aria-label={ariaLabel}
          checked={checked}
          disabled={disabled}
          ref={(el) => {
            if (el) el.indeterminate = !!indeterminate;
          }}
          onChange={(e) => onChange(e.target.checked)}
          className="peer size-4 cursor-pointer appearance-none rounded border border-line-strong bg-surface checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent disabled:opacity-50"
        />
        <Check className="pointer-events-none absolute inset-0 m-auto hidden size-3 text-white peer-checked:block" strokeWidth={3} aria-hidden />
        {indeterminate && <span className="pointer-events-none absolute inset-0 m-auto h-0.5 w-2 rounded bg-white" aria-hidden />}
      </span>
      {(label || description) && (
        <label htmlFor={id} className="min-w-0 cursor-pointer text-sm">
          {label && <span className="text-fg">{label}</span>}
          {description && <span className="block text-xs text-muted">{description}</span>}
        </label>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md', className, ariaLabel }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: LucideIcon; title?: string }[]; size?: 'sm' | 'md'; className?: string; ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-surface-2 p-0.5', className)}>
      {options.map((o) => {
        const Icon = o.icon;
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
              on ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg',
            )}
          >
            {Icon && <Icon className="size-3.5" aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A list of short strings (domains, packages, tags) edited as removable chips. */
export function ChipsInput({ value, onChange, placeholder, mono, validate, ariaLabel, suggestions }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; mono?: boolean; validate?: (s: string) => string | null; ariaLabel?: string; suggestions?: string[];
}) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const listId = useId();
  const add = (raw: string) => {
    const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const next = [...value];
    for (const p of parts) {
      const e = validate?.(p);
      if (e) {
        setErr(e);
        return;
      }
      if (!next.includes(p)) next.push(p);
    }
    setErr(null);
    onChange(next);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (draft.trim()) add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div>
      <div className={cn(control, 'flex min-h-8 flex-wrap items-center gap-1 px-1.5 py-1 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20')}>
        {value.map((v) => (
          <span key={v} className={cn('inline-flex max-w-full items-center gap-1 rounded-md bg-surface-3 py-0.5 pr-1 pl-1.5 text-xs text-fg', mono && 'font-mono text-[11.5px]')}>
            <span className="truncate">{v}</span>
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} className="rounded text-subtle hover:text-fg">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          aria-label={ariaLabel ?? placeholder}
          value={draft}
          list={suggestions ? listId : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setErr(null);
          }}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={value.length ? '' : placeholder}
          className={cn('h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-subtle focus-visible:outline-none', mono && 'font-mono text-[13px]')}
        />
        {suggestions && (
          <datalist id={listId}>
            {suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}
          </datalist>
        )}
      </div>
      {err && <p className="mt-1 text-xs text-crit-fg">{err}</p>}
    </div>
  );
}

export const isDomain = (s: string) =>
  /^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]{2,}$/i.test(s) ? null : `“${s}” doesn’t look like a domain (example: ads.example.com)`;
export const isPackage = (s: string) => (/^[a-zA-Z][\w]*(\.[\w]+)+$/.test(s) ? null : `“${s}” doesn’t look like an Android package name (example: com.netflix.ninja)`);
export const isServiceType = (s: string) => (/^_[\w-]+\._(tcp|udp)$/.test(s) ? null : `“${s}” should look like _name._tcp`);

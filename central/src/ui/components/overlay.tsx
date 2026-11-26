import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, type LucideIcon } from 'lucide-react';
import { Button, cn, IconButton } from './ui';
import { Input } from './forms';

// ---------------------------------------------------------------------------
// Dialog — native <dialog> gives us focus trapping, Escape and inert background.

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', className }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const w = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }[size];
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto mb-0 max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-2xl border border-line bg-surface p-0 text-fg shadow-pop sm:mb-auto sm:rounded-2xl',
        w,
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[92dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-fg">{title}</h2>
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <IconButton icon={X} label="Close" size="sm" onClick={onClose} className="-mt-0.5 -mr-1.5" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2/50 px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', danger, typeToConfirm, busy, extra }: {
  open: boolean; onClose: () => void; onConfirm: () => void | Promise<unknown>; title: ReactNode; children?: ReactNode;
  confirmLabel?: string; danger?: boolean; typeToConfirm?: string; busy?: boolean; extra?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const blocked = typeToConfirm ? typed.trim() !== typeToConfirm : false;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={blocked}
            loading={busy || working}
            onClick={async () => {
              setWorking(true);
              try {
                await onConfirm();
              } finally {
                setWorking(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">{children}</div>
      {extra}
      {typeToConfirm && (
        <div className="mt-4">
          <label className="mb-1 block text-sm text-fg">
            Type <span className="font-mono font-semibold">{typeToConfirm}</span> to confirm
          </label>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-label="Confirmation text" />
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Popover — fixed-position panel anchored to a trigger, flips near edges.

export function Popover({ trigger, children, align = 'end', width = 240, className, label }: {
  trigger: (p: { open: boolean; toggle: () => void; ref: (el: HTMLElement | null) => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  width?: number;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(width, vw - 16);
      let left = align === 'end' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      const ph = panel.current?.offsetHeight ?? 200;
      const below = vh - r.bottom - 8;
      const above = r.top - 8;
      const top = below >= Math.min(ph, 280) || below >= above ? r.bottom + 4 : Math.max(8, r.top - 4 - Math.min(ph, above));
      setPos({ top, left, maxH: Math.max(160, top > r.top ? below - 4 : above - 4) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        anchor.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // Move focus into the panel for keyboard users.
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('button, a, input, [tabindex]')?.focus());
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref: (el) => (anchor.current = el) })}
      {open &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={label}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: Math.min(width, window.innerWidth - 16), maxHeight: pos?.maxH }}
            className={cn('fixed z-50 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop', className)}
          >
            {typeof children === 'function' ? children(close) : children}
          </div>,
          document.body,
        )}
    </>
  );
}

export interface MenuItem {
  label: ReactNode;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}

export function Menu({ trigger, items, align = 'end', width = 220, header }: {
  trigger: (p: { open: boolean; toggle: () => void; ref: (el: HTMLElement | null) => void }) => ReactNode;
  items: (MenuItem | 'sep')[];
  align?: 'start' | 'end';
  width?: number;
  header?: ReactNode;
}) {
  return (
    <Popover trigger={trigger} align={align} width={width} label="Menu">
      {(close) => (
        <div
          role="menu"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const btns = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
            const i = btns.indexOf(document.activeElement as HTMLButtonElement);
            btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length]?.focus();
          }}
        >
          {header && <div className="border-b border-line px-2.5 pt-1.5 pb-2 text-xs text-muted">{header}</div>}
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="my-1 h-px bg-line" role="separator" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  close();
                  it.onSelect();
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors focus:outline-none focus-visible:outline-none disabled:opacity-40',
                  it.danger ? 'text-crit-fg hover:bg-crit-soft focus:bg-crit-soft' : 'text-fg hover:bg-surface-2 focus:bg-surface-2',
                )}
              >
                {it.icon && <it.icon className={cn('size-4 shrink-0', it.danger ? '' : 'text-muted')} aria-hidden />}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint && <span className="text-xs text-subtle">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </Popover>
  );
}

import {
  Ban, CircleCheck, CircleDashed, CircleHelp, CircleX, Eye, Link2, LoaderCircle, Lock, Moon, Power, ShieldCheck,
  TriangleAlert, Info, CircleAlert, Clock, Check, PowerOff, type LucideIcon,
} from 'lucide-react';
import type { Device, DeviceKind, DeviceStatus, DnsCategory, DnsLogEntry, DnsMode, Job, Severity } from '../../shared/types';
import {
  CATEGORY, DEVICE_STATUS, DNS_MODE, GATEWAY_STATUS, GRADE, KIND, SEVERITY, gradeFor, type Grade, type Tone,
} from '../lib/labels';
import { Badge, StatusText, cn, TONE_BADGE } from './ui';

const DEVICE_STATUS_ICON: Record<DeviceStatus, LucideIcon> = {
  online: CircleCheck, standby: Moon, offline: CircleX, unauthorized: Lock, pairing: Link2, unknown: CircleHelp,
};

export function DeviceStatusBadge({ status, className }: { status: DeviceStatus; className?: string }) {
  const m = DEVICE_STATUS[status] ?? DEVICE_STATUS.unknown;
  return (
    <StatusText tone={m.tone} icon={DEVICE_STATUS_ICON[status] ?? CircleHelp} title={m.help} className={className} pulse={status === 'pairing'}>
      {m.label}
    </StatusText>
  );
}

const GW_ICON: Record<keyof typeof GATEWAY_STATUS, LucideIcon> = { online: CircleCheck, offline: CircleX, none: CircleDashed, revoked: Ban };
export function GatewayBadge({ status, short }: { status: keyof typeof GATEWAY_STATUS; short?: boolean }) {
  const m = GATEWAY_STATUS[status] ?? GATEWAY_STATUS.none;
  return (
    <StatusText tone={m.tone} icon={GW_ICON[status] ?? CircleDashed}>
      {short ? m.label.replace('Gateway ', '').replace(/^./, (c) => c.toUpperCase()) : m.label}
    </StatusText>
  );
}

export function PowerText({ device }: { device: Pick<Device, 'power' | 'status'> }) {
  if (device.status === 'offline') return <span className="text-xs text-subtle">—</span>;
  const p = device.power ?? 'unknown';
  if (p === 'on') return <StatusText tone="ok" icon={Power}>On</StatusText>;
  if (p === 'standby') return <StatusText tone="neutral" icon={Moon}>Standby</StatusText>;
  if (p === 'off') return <StatusText tone="neutral" icon={PowerOff}>Off</StatusText>;
  return <span className="text-xs text-subtle">Unknown</span>;
}

const GRADE_CLS: Record<Grade, string> = {
  A: 'bg-ok-soft text-ok-fg ring-ok/25',
  B: 'bg-ok-soft text-ok-fg ring-ok/25',
  C: 'bg-warn-soft text-warn-fg ring-warn/35',
  D: 'bg-serious-soft text-serious-fg ring-serious/35',
  F: 'bg-crit-soft text-crit-fg ring-crit/35',
};

export function GradeBadge({ score, grade, size = 'md', showLabel }: { score?: number | null; grade?: string | null; size?: 'sm' | 'md' | 'lg' | 'xl'; showLabel?: boolean }) {
  const g = ((grade as Grade | undefined) ?? gradeFor(score)) as Grade | null;
  if (!g) return <span className="text-xs text-subtle" title="No privacy score yet">–</span>;
  const dims = { sm: 'size-5 text-[11px] rounded', md: 'size-6 text-xs rounded-md', lg: 'size-9 text-base rounded-lg', xl: 'size-16 text-4xl rounded-2xl' }[size];
  return (
    <span className="inline-flex items-center gap-1.5" title={`Privacy grade ${g}${score != null ? ` (${score}/100)` : ''}: ${GRADE[g].label}`}>
      <span className={cn('inline-flex shrink-0 items-center justify-center font-bold ring-1 ring-inset', dims, GRADE_CLS[g])} aria-label={`Privacy grade ${g}`}>
        {g}
      </span>
      {showLabel && <span className="text-xs text-muted">{GRADE[g].label}</span>}
    </span>
  );
}

export function KindIcon({ kind, className, boxed }: { kind: DeviceKind; className?: string; boxed?: boolean }) {
  const Icon = KIND[kind]?.icon ?? KIND.other.icon;
  if (!boxed) return <Icon className={cn('size-4 text-muted', className)} aria-label={KIND[kind]?.label} />;
  return (
    <span className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-muted', className)}>
      <Icon className="size-[18px]" aria-label={KIND[kind]?.label} />
    </span>
  );
}

export const ACTION_META: Record<DnsLogEntry['action'], { label: string; tone: Tone; icon: LucideIcon }> = {
  block: { label: 'Blocked', tone: 'crit', icon: Ban },
  would_block: { label: 'Would block', tone: 'warn', icon: Eye },
  allow: { label: 'Allowed', tone: 'neutral', icon: Check },
};

export function ActionBadge({ action }: { action: DnsLogEntry['action'] }) {
  const m = ACTION_META[action];
  return <Badge tone={m.tone} icon={m.icon}>{m.label}</Badge>;
}

export function CategoryBadge({ cat, className }: { cat?: DnsCategory | null; className?: string }) {
  if (!cat) return <span className="text-xs text-subtle">–</span>;
  const m = CATEGORY[cat] ?? CATEGORY.unknown;
  const tone: Tone = cat === 'acr' || cat === 'malware' ? 'crit' : m.privacy ? 'serious' : 'neutral';
  return (
    <Badge tone={tone} title={m.help} className={className}>
      {m.label}
    </Badge>
  );
}

const SEV_ICON: Record<Severity, LucideIcon> = { info: Info, warning: TriangleAlert, critical: CircleAlert };
export function SeverityBadge({ severity, iconOnly }: { severity: Severity; iconOnly?: boolean }) {
  const m = SEVERITY[severity];
  const Icon = SEV_ICON[severity];
  if (iconOnly) {
    return (
      <span className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-lg', TONE_BADGE[m.tone])} title={m.label}>
        <Icon className="size-4" aria-label={m.label} />
      </span>
    );
  }
  return <Badge tone={m.tone} icon={Icon}>{m.label}</Badge>;
}

const JOB_META: Record<Job['status'], { label: string; tone: Tone; icon: LucideIcon }> = {
  queued: { label: 'Queued', tone: 'neutral', icon: Clock },
  running: { label: 'Running', tone: 'accent', icon: LoaderCircle },
  ok: { label: 'Done', tone: 'ok', icon: CircleCheck },
  error: { label: 'Failed', tone: 'crit', icon: CircleX },
};
export function JobStatusBadge({ status }: { status: Job['status'] }) {
  const m = JOB_META[status];
  return (
    <StatusText tone={m.tone} icon={m.icon} className={status === 'running' ? '[&>svg]:animate-spin' : undefined}>
      {m.label}
    </StatusText>
  );
}

const MODE_ICON: Record<DnsMode, LucideIcon> = { enforce: ShieldCheck, monitor: Eye, off: CircleDashed, bypass: Ban };
export function DnsModeBadge({ mode, monitorUntil }: { mode: DnsMode; monitorUntil?: number | null }) {
  const m = DNS_MODE[mode];
  const until = mode === 'monitor' && monitorUntil ? ` until ${new Date(monitorUntil).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` : '';
  return (
    <Badge tone={m.tone} icon={MODE_ICON[mode]} title={m.help}>
      {m.label}
      {until}
    </Badge>
  );
}
export { MODE_ICON };

import { useId, useMemo, useState, type ReactNode, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { ChartColumn, Table2, type LucideIcon } from 'lucide-react';
import type { DnsSeriesPoint } from '../../shared/types';
import { useElementWidth } from '../lib/hooks';
import { fmtCompact, fmtNum, fmtPct, hourLabel, niceTicks } from '../lib/format';
import { cn, IconButton, th, td } from './ui';
import type { Tone } from '../lib/labels';

// ---------------------------------------------------------------------------
// Shared bits

/** Path for a bar with rounded data-end (top) and a square baseline. */
function topRoundedRect(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
export function LegendItem({ color, label, value, shape = 'rect' }: { color: string; label: ReactNode; value?: ReactNode; shape?: 'rect' | 'line' }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted">
      {shape === 'rect' ? (
        <span className="chart-mark inline-block size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
      ) : (
        <span className="chart-mark inline-block h-0.5 w-3 rounded" style={{ background: color }} aria-hidden />
      )}
      <span>{label}</span>
      {value != null && <span className="font-medium text-fg tnum">{value}</span>}
    </span>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="chart-mark h-0.5 w-3 shrink-0 rounded" style={{ background: color }} aria-hidden />
      <span className="font-semibold text-fg tnum">{value}</span>
      <span className="text-muted">{label}</span>
    </div>
  );
}

/** Card chrome that owns a chart, its legend slot and its table-view twin. */
export function ChartFrame({ title, subtitle, actions, legend, table, children, className, icon }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; legend?: ReactNode; table?: ReactNode; children: ReactNode; className?: string; icon?: LucideIcon;
}) {
  const [showTable, setShowTable] = useState(false);
  const Icon = icon;
  return (
    <figure className={cn('min-w-0 rounded-xl border border-line bg-surface shadow-card', className)}>
      <figcaption className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {Icon && <Icon className="size-4 text-muted" aria-hidden />}
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          {table && (
            <IconButton
              size="sm"
              icon={showTable ? ChartColumn : Table2}
              label={showTable ? 'Show chart' : 'Show as table'}
              aria-pressed={showTable}
              onClick={() => setShowTable((s) => !s)}
            />
          )}
        </div>
      </figcaption>
      {legend && !showTable && <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-2.5">{legend}</div>}
      <div className="px-4 pt-2 pb-3">{showTable && table ? <div className="max-h-80 overflow-auto rounded-lg border border-line">{table}</div> : children}</div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// DNS stacked columns: blocked (baseline) / would-block / allowed per hour.

const DNS_SERIES = [
  { key: 'blocked', label: 'Blocked', color: 'var(--color-crit)' },
  { key: 'would_block', label: 'Would block', color: 'var(--color-warn)' },
  { key: 'allowed', label: 'Allowed', color: 'var(--color-allowed)' },
] as const;

export function dnsTotals(series: DnsSeriesPoint[]) {
  let queries = 0, blocked = 0, would = 0;
  for (const p of series) {
    queries += p.queries;
    blocked += p.blocked;
    would += p.would_block;
  }
  return { queries, blocked, would, allowed: Math.max(0, queries - blocked - would) };
}

export function DnsLegend({ series }: { series: DnsSeriesPoint[] }) {
  const t = dnsTotals(series);
  return (
    <>
      <LegendItem color={DNS_SERIES[0].color} label="Blocked" value={fmtCompact(t.blocked)} />
      <LegendItem color={DNS_SERIES[1].color} label="Would block (monitor)" value={fmtCompact(t.would)} />
      <LegendItem color={DNS_SERIES[2].color} label="Allowed" value={fmtCompact(t.allowed)} />
    </>
  );
}

export function DnsTable({ series }: { series: DnsSeriesPoint[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-surface-2">
        <tr>
          <th className={th}>Hour</th>
          <th className={cn(th, 'text-right')}>Queries</th>
          <th className={cn(th, 'text-right')}>Blocked</th>
          <th className={cn(th, 'text-right')}>Would block</th>
          <th className={cn(th, 'text-right')}>Allowed</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line tnum">
        {[...series].reverse().map((p) => (
          <tr key={p.t}>
            <td className={cn(td, 'py-1.5 text-muted')}>{new Date(p.t).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric' })}</td>
            <td className={cn(td, 'py-1.5 text-right')}>{fmtNum(p.queries)}</td>
            <td className={cn(td, 'py-1.5 text-right')}>{fmtNum(p.blocked)}</td>
            <td className={cn(td, 'py-1.5 text-right')}>{fmtNum(p.would_block)}</td>
            <td className={cn(td, 'py-1.5 text-right')}>{fmtNum(Math.max(0, p.queries - p.blocked - p.would_block))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DnsColumns({ series, height = 200 }: { series: DnsSeriesPoint[]; height?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 8, right: 4, bottom: 22, left: 40 };
  const plotW = Math.max(0, width - m.left - m.right);
  // Keep a sensible aspect ratio on narrow screens.
  const plotH = width ? Math.round(Math.min(height, Math.max(140, width * 0.5))) : height;
  const max = Math.max(1, ...series.map((p) => p.queries));
  const ticks = niceTicks(max, 4);
  const top = ticks[ticks.length - 1] || 1;
  const n = series.length || 1;
  const band = plotW / n;
  const barW = Math.max(2, Math.min(24, band - Math.max(2, band * 0.28)));
  const y = (v: number) => m.top + plotH - (v / top) * plotH;
  const labelEvery = plotW / n < 22 ? 6 : plotW / n < 34 ? 4 : 3;
  const t = dnsTotals(series);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const hp = hover != null ? series[hover] : null;
  const tipLeft = hover != null ? Math.min(Math.max(m.left + band * hover + band / 2, 90), width - 90) : 0;

  return (
    <div
      ref={ref}
      className="relative outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-accent"
      tabIndex={0}
      role="img"
      aria-label={`DNS queries per hour over ${n} hours: ${fmtNum(t.queries)} total, ${fmtNum(t.blocked)} blocked, ${fmtNum(t.would)} would have been blocked. Use left and right arrow keys to read each hour.`}
      onKeyDown={onKey}
      onBlur={() => setHover(null)}
      style={{ height: plotH + m.top + m.bottom }}
    >
      {width > 0 && (
        <svg width={width} height={plotH + m.top + m.bottom} className="block overflow-visible" onPointerLeave={() => setHover(null)}>
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={m.left} x2={width - m.right} y1={y(tk)} y2={y(tk)} stroke={tk === 0 ? 'var(--color-axis)' : 'var(--color-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={m.left - 8} y={y(tk)} dy="0.32em" textAnchor="end" className="fill-muted text-[10.5px] tnum">
                {fmtCompact(tk)}
              </text>
            </g>
          ))}
          {series.map((p, i) => {
            const cx = m.left + band * i + band / 2;
            const x = cx - barW / 2;
            const allowed = Math.max(0, p.queries - p.blocked - p.would_block);
            const vals = [p.blocked, p.would_block, allowed];
            let acc = 0;
            const lastIdx = vals.reduce((li, v, k) => (v > 0 ? k : li), -1);
            const segs = vals.map((v, k) => {
              if (v <= 0) return null;
              const y0 = y(acc);
              acc += v;
              const y1 = y(acc);
              const gap = k > 0 && vals.slice(0, k).some((pv) => pv > 0) ? 2 : 0;
              const h = Math.max(0, y0 - y1 - gap);
              if (h <= 0.2) return null;
              const d = k === lastIdx ? topRoundedRect(x, y1, barW, h) : `M${x},${y1}h${barW}v${h}h${-barW}Z`;
              return <path key={k} d={d} fill={DNS_SERIES[k].color} className="chart-mark" />;
            });
            const dim = hover != null && hover !== i;
            return (
              <g key={p.t} style={{ opacity: dim ? 0.45 : 1, transition: 'opacity 120ms' }}>
                {segs}
              </g>
            );
          })}
          {series.map((p, i) =>
            i % labelEvery === (n - 1) % labelEvery ? (
              <text key={p.t} x={m.left + band * i + band / 2} y={m.top + plotH + 15} textAnchor="middle" className="fill-muted text-[10.5px]">
                {i === n - 1 ? 'now' : hourLabel(p.t)}
              </text>
            ) : null,
          )}
          {/* hit targets: the whole hour band, bigger than the mark */}
          {series.map((p, i) => (
            <rect key={p.t} x={m.left + band * i} y={m.top} width={band} height={plotH} fill="transparent" onPointerEnter={() => setHover(i)} onPointerMove={() => setHover(i)} />
          ))}
        </svg>
      )}
      {hp && (
        <div className="pointer-events-none absolute top-0 z-10 w-44 -translate-x-1/2 rounded-lg border border-line bg-surface px-3 py-2 shadow-pop" style={{ left: tipLeft }}>
          <p className="mb-1 text-xs font-medium text-muted">
            {new Date(hp.t).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric' })} – {hourLabel(hp.t + 3600_000)}
          </p>
          <p className="mb-1.5 text-sm font-semibold text-fg tnum">
            {fmtNum(hp.queries)} <span className="text-xs font-normal text-muted">queries</span>
          </p>
          <TooltipRow color={DNS_SERIES[0].color} label="blocked" value={fmtNum(hp.blocked)} />
          <TooltipRow color={DNS_SERIES[1].color} label="would block" value={fmtNum(hp.would_block)} />
          <TooltipRow color={DNS_SERIES[2].color} label="allowed" value={fmtNum(Math.max(0, hp.queries - hp.blocked - hp.would_block))} />
        </div>
      )}
    </div>
  );
}

export function DnsChartCard({ series, title = 'DNS queries, last 24 hours', subtitle, actions, height = 200, className }: {
  series: DnsSeriesPoint[]; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; height?: number; className?: string;
}) {
  const t = dnsTotals(series);
  return (
    <ChartFrame
      className={className}
      title={title}
      subtitle={subtitle ?? `${fmtNum(t.queries)} lookups · ${fmtPct(t.blocked, t.queries)} blocked · ${fmtPct(t.would, t.queries)} would be blocked once monitoring ends`}
      actions={actions}
      legend={<DnsLegend series={series} />}
      table={<DnsTable series={series} />}
    >
      {series.length ? <DnsColumns series={series} height={height} /> : <p className="py-12 text-center text-sm text-muted">No DNS traffic recorded yet.</p>}
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Sparkline: de-emphasis line, current period dot in the accent.

export function Sparkline({ values, width = 96, height = 28, className, label }: { values: number[]; width?: number; height?: number; className?: string; label?: string }) {
  const id = useId();
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pad = 4;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (width - pad * 2), pad + (1 - (v - min) / span) * (height - pad * 2)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${d}L${pts[pts.length - 1][0]},${height}L${pts[0][0]},${height}Z`;
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} className={cn('block overflow-visible', className)} role="img" aria-label={label ?? 'Trend'}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--color-subtle)" stopOpacity="0.16" />
          <stop offset="1" stopColor="var(--color-subtle)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke="var(--color-subtle)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={3.5} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} />
    </svg>
  );
}

/** Downsample an hourly series to ~12 points for a tile sparkline. */
export function toSpark(values: number[], points = 12): number[] {
  if (values.length <= points) return values;
  const size = Math.ceil(values.length / points);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size).reduce((a, b) => a + b, 0));
  return out;
}

// ---------------------------------------------------------------------------
// KPI tile

export function KpiTile({ label, value, sub, spark, href, icon: Icon, status, loading }: {
  label: string; value: ReactNode; sub?: ReactNode; spark?: number[]; href?: string; icon?: LucideIcon; status?: ReactNode; loading?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-muted">
          {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
          {label}
        </p>
        {status}
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        {loading ? (
          <div className="h-8 w-20 animate-pulse-soft rounded-md bg-surface-3" />
        ) : (
          <p className="text-[26px] leading-8 font-semibold tracking-tight text-fg">{value}</p>
        )}
        {spark && !loading && <Sparkline values={spark} className="mb-0.5 hidden shrink-0 sm:block" width={72} height={26} label={`${label} trend`} />}
      </div>
      {sub && <div className="mt-1 min-h-4 truncate text-xs text-muted">{loading ? ' ' : sub}</div>}
    </>
  );
  const cls = 'block min-w-0 rounded-xl border border-line bg-surface px-4 py-3.5 shadow-card';
  if (href) {
    return (
      <Link to={href} className={cn(cls, 'transition-colors hover:border-line-strong hover:bg-surface-2/40')}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}

// ---------------------------------------------------------------------------
// Ranked horizontal bars (one hue; optional emphasis for some rows)

export interface BarItem { key: string; label: ReactNode; value: number; sub?: ReactNode; emphasis?: boolean; href?: string; title?: string; right?: ReactNode }

export function BarList({ items, total, format = fmtCompact, emptyText = 'Nothing yet.', max: maxRows, color = 'var(--color-s1)', mutedColor = 'var(--color-other)', showPct }: {
  items: BarItem[]; total?: number; format?: (n: number) => string; emptyText?: string; max?: number; color?: string; mutedColor?: string; showPct?: boolean;
}) {
  const rows = maxRows ? items.slice(0, maxRows) : items;
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted">{emptyText}</p>;
  return (
    <ul className="space-y-0.5">
      {rows.map((r) => {
        const pct = (r.value / max) * 100;
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-fg">{r.label}</span>
              <span className="shrink-0 text-xs text-muted tnum">
                <span className="font-semibold text-fg">{format(r.value)}</span>
                {showPct && total ? <span className="ml-1.5">{fmtPct(r.value, total)}</span> : null}
                {r.right}
              </span>
            </div>
            {r.sub && <div className="truncate text-xs text-muted">{r.sub}</div>}
            <div className="mt-0.5 h-2 w-full" aria-hidden>
              <div className="chart-mark h-2 rounded-r-[4px]" style={{ width: `${Math.max(0.8, pct)}%`, background: r.emphasis === false ? mutedColor : color }} />
            </div>
          </>
        );
        return (
          <li key={r.key} title={r.title ?? `${typeof r.label === 'string' ? r.label : r.key}: ${fmtNum(r.value)}${total ? ` (${fmtPct(r.value, total)})` : ''}`}>
            {r.href ? (
              <Link to={r.href} className="block rounded-md px-1.5 py-1 transition-colors hover:bg-surface-2">
                {inner}
              </Link>
            ) : (
              <div className="rounded-md px-1.5 py-1 transition-colors hover:bg-surface-2">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Tall segmented bar: one whole split into <= 6 parts, values printed where they fit.

export interface Segment { key: string; label: string; value: number; color: string; ink?: 'light' | 'dark' }

export function SegmentedBar({ parts, format = fmtCompact, height = 28, ariaLabel }: { parts: Segment[]; format?: (n: number) => string; height?: number; ariaLabel: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const visible = parts.filter((p) => p.value > 0);
  const total = visible.reduce((a, p) => a + p.value, 0);
  const gap = 2;
  const usable = Math.max(0, width - gap * Math.max(0, visible.length - 1));
  const layout = useMemo(() => {
    let x = 0;
    return visible.map((p) => {
      const w = total ? (p.value / total) * usable : 0;
      const label = fmtPct(p.value, total, 0);
      const fits = w >= label.length * 7 + 14;
      const r = { ...p, x, w, label, fits };
      x += w + gap;
      return r;
    });
  }, [visible, total, usable]);
  const hp = layout.find((l) => l.key === hover);
  if (!total) return <p className="py-3 text-sm text-muted">No lookups yet.</p>;
  return (
    <div>
      <div ref={ref} className="relative" role="group" aria-label={ariaLabel} style={{ height }}>
        {width > 0 &&
          layout.map((l) => (
            <div
              key={l.key}
              tabIndex={0}
              role="img"
              aria-label={`${parts.find((p) => p.key === l.key)?.label ?? l.key}: ${l.label}, ${fmtNum(l.value)} lookups`}
              onPointerEnter={() => setHover(l.key)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(l.key)}
              onBlur={() => setHover(null)}
              className="chart-mark absolute top-0 flex items-center overflow-visible rounded-[4px] px-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              style={{
                left: l.x, width: Math.max(1, l.w), height, background: l.color,
                color: l.ink === 'dark' ? '#0b0b0b' : '#ffffff',
                opacity: hover && hover !== l.key ? 0.55 : 1, transition: 'opacity 120ms',
              }}
            >
              {l.fits ? <span className="tnum">{l.label}</span> : null}
            </div>
          ))}
        {hp && (
          <div
            className="pointer-events-none absolute z-10 w-max -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 shadow-pop"
            style={{ left: Math.min(Math.max(hp.x + hp.w / 2, 70), width - 70), top: height + 6 }}
          >
            <TooltipRow color={hp.color} label={parts.find((p) => p.key === hp.key)?.label ?? hp.key} value={`${format(hp.value)} · ${fmtPct(hp.value, total)}`} />
          </div>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => {
          const l = layout.find((x) => x.key === p.key);
          return <LegendItem key={p.key} color={p.color} label={p.label} value={l && !l.fits ? fmtPct(p.value, total, 0) : p.value === 0 ? '0' : undefined} />;
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meter: fill carries severity, track is a lighter step of the same hue.

const METER_FILL: Record<Tone, string> = {
  ok: 'var(--color-ok)', warn: 'var(--color-warn)', serious: 'var(--color-serious)', crit: 'var(--color-crit)', accent: 'var(--color-accent)', neutral: 'var(--color-subtle)',
};

export function Meter({ value, max = 100, tone = 'accent', className, label, thin }: { value: number; max?: number; tone?: Tone; className?: string; label: string; thin?: boolean }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const c = METER_FILL[tone];
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('chart-mark relative w-full overflow-hidden rounded-full', thin ? 'h-1.5' : 'h-2', className)}
      style={{ background: `color-mix(in oklab, ${c} 18%, transparent)` }}
    >
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: c }} />
    </div>
  );
}

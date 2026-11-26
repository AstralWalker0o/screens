// Formatting helpers. All timestamps are epoch milliseconds.

const nf = new Intl.NumberFormat('en-AU');
const compactNf = new Intl.NumberFormat('en-AU', { notation: 'compact', maximumFractionDigits: 1 });

export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '–';
  return nf.format(Math.round(n));
}

/** 1,284 / 12.9K / 4.2M — for tiles and chart labels. */
export function fmtCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '–';
  if (Math.abs(n) < 10_000) return nf.format(Math.round(n));
  return compactNf.format(n);
}

export function fmtPct(part: number, whole: number, digits = 1): string {
  if (!whole) return '0%';
  const p = (part / whole) * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(p >= 10 ? 0 : digits)}%`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '–';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'long' });

/** "3 min ago", "in 2 days", "just now". */
export function relTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return diff <= 0 ? 'just now' : 'in a moment';
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (abs < hr) {
    const m = Math.max(1, Math.round(abs / min));
    return diff < 0 ? `${m} min ago` : `in ${m} min`;
  }
  if (abs < day) return rtf.format(Math.round(diff / hr), 'hour');
  if (abs < 30 * day) return rtf.format(Math.round(diff / day), 'day');
  if (abs < 365 * day) return rtf.format(Math.round(diff / (30 * day)), 'month');
  return rtf.format(Math.round(diff / (365 * day)), 'year');
}

const absFmt = new Intl.DateTimeFormat('en-AU', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
});
export function absTime(ts: number | null | undefined): string {
  if (!ts) return '';
  return absFmt.format(new Date(ts));
}

const shortFmt = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export function shortTime(ts: number | null | undefined): string {
  if (!ts) return '–';
  return shortFmt.format(new Date(ts));
}

const dateFmt = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '–';
  return dateFmt.format(new Date(ts));
}

const clockFmt = new Intl.DateTimeFormat('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export function clockTime(ts: number): string {
  return clockFmt.format(new Date(ts));
}

const hourFmt = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', hour12: true });
export function hourLabel(ts: number): string {
  return hourFmt.format(new Date(ts)).replace(' ', '').toLowerCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

export function truncateMiddle(s: string, max = 24): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 1) / 2);
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

/** Compare dotted versions, returns >0 when a > b. */
export function cmpVersion(a?: string | null, b?: string | null): number {
  if (!a || !b) return 0;
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Nice axis ticks from 0..max (inclusive), about `count` of them. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

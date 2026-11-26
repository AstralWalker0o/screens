// Friendly cron: the editor offers daily / weekdays / weekends / chosen days at a time,
// and falls back to a raw 5-field cron for anything else.

export type CronMode = 'daily' | 'weekdays' | 'weekends' | 'days' | 'custom';
export interface CronParts { mode: CronMode; time: string; days: number[] }

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

export function parseCron(cron: string): CronParts {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return { mode: 'custom', time: '00:00', days: [] };
  const [mi, h, dom, mon, dow] = f;
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(h) || dom !== '*' || mon !== '*') return { mode: 'custom', time: '00:00', days: [] };
  const time = `${pad(+h)}:${pad(+mi)}`;
  if (dow === '*') return { mode: 'daily', time, days: [] };
  if (dow === '1-5') return { mode: 'weekdays', time, days: [1, 2, 3, 4, 5] };
  if (dow === '0,6' || dow === '6,0') return { mode: 'weekends', time, days: [0, 6] };
  if (/^[0-6](,[0-6])*$/.test(dow)) return { mode: 'days', time, days: dow.split(',').map(Number).sort() };
  return { mode: 'custom', time, days: [] };
}

export function buildCron(p: CronParts): string {
  const [h, m] = p.time.split(':').map((x) => parseInt(x, 10) || 0);
  const dow = p.mode === 'weekdays' ? '1-5' : p.mode === 'weekends' ? '0,6' : p.mode === 'days' ? (p.days.length ? [...p.days].sort().join(',') : '*') : '*';
  return `${m} ${h} * * ${dow}`;
}

const FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;
export function cronError(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return 'A schedule needs 5 parts: minute hour day-of-month month day-of-week';
  if (!f.every((x) => FIELD.test(x))) return 'Each part should be a number, a range like 1-5, a list like 1,3,5, * or */15';
  return null;
}

function time12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = h % 12 || 12;
  if (h === 0 && m === 0) return 'midnight';
  if (h === 12 && m === 0) return 'noon';
  return `${hh}${m ? `:${pad(m)}` : ''} ${ap}`;
}

export function describeCron(cron: string, tz?: string): string {
  const p = parseCron(cron);
  const zone = tz ? ` (${tz.split('/').pop()?.replace(/_/g, ' ')} time)` : '';
  switch (p.mode) {
    case 'daily': return `Every day at ${time12(p.time)}${zone}`;
    case 'weekdays': return `Weekdays at ${time12(p.time)}${zone}`;
    case 'weekends': return `Weekends at ${time12(p.time)}${zone}`;
    case 'days': return `${p.days.map((d) => DAY_NAMES[d]).join(', ')} at ${time12(p.time)}${zone}`;
    default: return `Custom schedule “${cron}”${zone}`;
  }
}

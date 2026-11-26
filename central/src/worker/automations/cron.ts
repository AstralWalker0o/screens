/** 5-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA timezone. */

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${field}"`);
    let lo = min, hi = max;
    if (rangePart !== '*') {
      const [a, b] = rangePart.split('-');
      lo = Number(a); hi = b !== undefined ? Number(b) : stepPart ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`bad range in "${field}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface CronSpec { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron needs 5 fields: minute hour day month weekday');
  const dow = parseField(f[4], 0, 7);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    minute: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12), dow, domStar: f[2] === '*', dowStar: f[4] === '*',
  };
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(ts: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { minute: Number(get('minute')), hour: Number(get('hour')) % 24, dom: Number(get('day')), month: Number(get('month')), dow: WD[get('weekday')] ?? 0 };
}

export function cronMatches(expr: string | CronSpec, ts: number, tz = 'UTC'): boolean {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const p = localParts(ts, tz);
  if (!c.minute.has(p.minute) || !c.hour.has(p.hour) || !c.month.has(p.month)) return false;
  // Standard cron: if both day fields are restricted, either may match.
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return c.dow.has(p.dow);
  if (c.dowStar) return c.dom.has(p.dom);
  return c.dom.has(p.dom) || c.dow.has(p.dow);
}

export function nextRun(expr: string, from: number, tz = 'UTC', horizonDays = 8): number | null {
  const c = parseCron(expr);
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const end = from + horizonDays * 86_400_000;
  for (; t < end; t += 60_000) if (cronMatches(c, t, tz)) return t;
  return null;
}

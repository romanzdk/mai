// Five-field cron (minute hour day-of-month month day-of-week), local time, 0 or 7 = Sunday.
// Supports *, lists, ranges and steps. Like standard cron, when both day fields are
// restricted a day matches either of them.
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week'];

function field(text: string, [lo, hi]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad ${name} "${part}"`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === '*' ? lo : Number(m[2]);
    const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
    if (step < 1 || from < lo || to > hi || from > to)
      throw new Error(`${name} out of range in "${part}"`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron needs 5 fields: minute hour day month weekday');
  const [minute, hour, dom, month, dow] = parts.map((p, i) =>
    field(p, BOUNDS[i] as [number, number], NAMES[i] as string),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (dow.has(7)) dow.add(0);
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  return c.domAny || c.dowAny ? dom && dow : dom || dow;
}

export function cronMatches(c: Cron, d: Date): boolean {
  return (
    c.minute.has(d.getMinutes()) &&
    c.hour.has(d.getHours()) &&
    c.month.has(d.getMonth() + 1) &&
    dayMatches(c, d)
  );
}

// The first matching minute strictly after `after`, within about four years.
export function nextRun(c: Cron, after: Date): Date | null {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0);
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0);
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0);
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
    } else {
      return d;
    }
  }
  return null;
}

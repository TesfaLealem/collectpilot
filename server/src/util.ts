export const DAY = 86_400_000;

export const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
export const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY);
export const iso = (d: Date) => d.toISOString().slice(0, 10);

export function money(cents: number, currency = 'ETB') {
  const v = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${v}`;
}

export const toCents = (v: number | string) => Math.round(Number(String(v).replace(/[^0-9.\-]/g, '')) * 100);

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Hour of day (0-23) in an IANA timezone. */
export function hourIn(tz: string, d = new Date()) {
  const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(d);
  return Number(h) % 24;
}

export function parseDateLoose(s: string | undefined | null): Date | null {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])); // day first
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : startOfDay(d);
}

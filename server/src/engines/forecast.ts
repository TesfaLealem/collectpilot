// Per-invoice payment-date prediction and the 13-week cash forecast. Deterministic.
import { addDays, clamp, daysBetween, median, quantile, startOfDay, iso } from '../util.js';
import type { Segment } from './risk.js';

const SEGMENT_DELAY: Record<Segment, number> = { reliable: 1, forgetful: 6, 'slow-but-sure': 18, 'cash-constrained': 25, disputing: 30, chronic: 45 };

export interface PredictInput {
  dueDate: Date; dueCents: number; segment: Segment; riskScore: number;
  paidDaysLate: number[]; // most recent last
  promiseDate?: Date | null; pausedUntil?: Date | null;
}
export interface Prediction { expected: Date; best: Date; worst: Date; probability: number; basis: string }

export function predictPayment(i: PredictInput, today = new Date()): Prediction {
  const t = startOfDay(today);
  const dpd = daysBetween(i.dueDate, t);
  const hist = i.paidDaysLate.slice(-8);
  let delay: number, lo: number, hi: number, basis: string;
  if (hist.length >= 3) {
    delay = median(hist); lo = quantile(hist, 0.25); hi = quantile(hist, 0.8);
    basis = `Median of the last ${hist.length} payments: ${Math.round(delay)} days after due date`;
  } else {
    delay = SEGMENT_DELAY[i.segment]; lo = delay * 0.5; hi = delay * 1.8 + 5;
    basis = `Segment default for "${i.segment}" customers (${delay} days after due date)`;
  }
  let expected = addDays(i.dueDate, Math.round(Math.max(0, delay)));
  let best = addDays(i.dueDate, Math.round(Math.max(0, lo)));
  let worst = addDays(i.dueDate, Math.round(Math.max(delay + 3, hi)));
  // Already later than the customer usually pays: expect payment a residual time from today.
  if (expected <= t) { const resid = Math.round(5 + Math.max(0, dpd) * 0.25); expected = addDays(t, resid); basis += '; already past the usual delay, so a residual wait is assumed'; }
  if (best <= t) best = addDays(t, 2);
  if (worst <= expected) worst = addDays(expected, Math.round(7 + Math.max(0, dpd) * 0.4));
  if (i.promiseDate && i.promiseDate >= t) {
    expected = i.promiseDate; best = i.promiseDate; worst = addDays(i.promiseDate, 10);
    basis = `Customer promised to pay on ${iso(i.promiseDate)}`;
  }
  // Collectability falls with age and risk.
  const ageP = dpd <= 0 ? 0.98 : dpd <= 30 ? 0.95 : dpd <= 60 ? 0.88 : dpd <= 90 ? 0.72 : 0.5;
  const probability = clamp(ageP - (i.riskScore / 100) * 0.25, 0.2, 0.99);
  return { expected, best, worst, probability: Math.round(probability * 100) / 100, basis };
}

export interface ForecastItem { invoiceId: string; customerId: string; customerName: string; number: string; dueCents: number; prediction: Prediction }
export interface ForecastWeek { index: number; start: string; end: string; best: number; expected: number; worst: number; items: { number: string; customerName: string; cents: number }[] }

export function buildForecast(items: ForecastItem[], today = new Date(), weeks = 13, delays: Record<string, number> = {}): ForecastWeek[] {
  const t = startOfDay(today);
  const out: ForecastWeek[] = Array.from({ length: weeks }, (_, i) => ({ index: i + 1, start: iso(addDays(t, i * 7)), end: iso(addDays(t, i * 7 + 6)), best: 0, expected: 0, worst: 0, items: [] }));
  const weekOf = (d: Date) => Math.floor(Math.max(0, daysBetween(t, d)) / 7);
  for (const it of items) {
    const shift = delays[it.customerId] ?? 0;
    const p = it.prediction;
    const e = weekOf(addDays(p.expected, shift)), b = weekOf(addDays(p.best, shift)), w = weekOf(addDays(p.worst, shift));
    if (b < weeks) out[b].best += Math.round(it.dueCents * Math.min(1, p.probability + 0.05));
    if (e < weeks) { out[e].expected += Math.round(it.dueCents * p.probability); out[e].items.push({ number: it.number, customerName: it.customerName, cents: Math.round(it.dueCents * p.probability) }); }
    if (w < weeks) out[w].worst += Math.round(it.dueCents * Math.max(0, p.probability - 0.15));
  }
  return out;
}

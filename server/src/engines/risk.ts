// Explainable, rule-based risk score (0-100). Deterministic: the model explains it, never computes it.
import { clamp } from '../util.js';

export interface RiskInput {
  openInvoices: { dueCents: number; daysPastDue: number }[];
  paidDaysLate: number[]; // days late for each historically paid invoice (negative = early)
  brokenPromises: number;
  keptPromises: number;
  openDisputes: number;
  unansweredOutbound: number; // consecutive outbound messages with no reply
  creditLimitCents: number;
  hasActivePlan?: boolean;
  planRequests?: number;
}

export interface RiskDriver { key: string; label: string; points: number; max: number; detail: string }
export interface RiskResult { score: number; drivers: RiskDriver[]; avgDaysLate: number; overdueCents: number; exposureCents: number }

export function scoreRisk(i: RiskInput): RiskResult {
  const overdue = i.openInvoices.filter((x) => x.daysPastDue > 0);
  const overdueCents = overdue.reduce((s, x) => s + x.dueCents, 0);
  const exposureCents = i.openInvoices.reduce((s, x) => s + x.dueCents, 0);
  const wDpd = overdueCents ? overdue.reduce((s, x) => s + x.dueCents * x.daysPastDue, 0) / overdueCents : 0;

  const drivers: RiskDriver[] = [];

  const sev = Math.round(clamp((wDpd / 60) * 35, 0, 35));
  drivers.push({ key: 'overdue', label: 'Overdue severity', points: sev, max: 35,
    detail: overdueCents ? `Amount-weighted average of ${Math.round(wDpd)} days past due` : 'Nothing overdue' });

  const expRatio = i.creditLimitCents > 0 ? overdueCents / i.creditLimitCents : overdueCents > 0 ? 1 : 0;
  const exp = Math.round(clamp(expRatio * 10, 0, 10));
  drivers.push({ key: 'exposure', label: 'Overdue vs credit limit', points: exp, max: 10,
    detail: i.creditLimitCents > 0 ? `${Math.round(expRatio * 100)}% of the credit limit is overdue` : 'No credit limit set' });

  const avgLate = i.paidDaysLate.length ? i.paidDaysLate.reduce((s, x) => s + Math.max(0, x), 0) / i.paidDaysLate.length : NaN;
  const hist = isNaN(avgLate) ? 8 : Math.round(clamp((avgLate / 30) * 25, 0, 25));
  drivers.push({ key: 'history', label: 'Payment history', points: hist, max: 25,
    detail: isNaN(avgLate) ? 'No payment history yet (neutral default)' : `Pays ${Math.round(avgLate)} days late on average over ${i.paidDaysLate.length} invoices` });

  const prom = clamp(i.brokenPromises * 10 - i.keptPromises * 3, 0, 20);
  drivers.push({ key: 'promises', label: 'Broken promises', points: prom, max: 20,
    detail: `${i.brokenPromises} broken, ${i.keptPromises} kept` });

  const disp = clamp(i.openDisputes * 5, 0, 10);
  drivers.push({ key: 'disputes', label: 'Open disputes', points: disp, max: 10, detail: `${i.openDisputes} open` });

  const resp = i.unansweredOutbound >= 3 ? 10 : i.unansweredOutbound === 2 ? 6 : i.unansweredOutbound === 1 ? 3 : 0;
  drivers.push({ key: 'responsiveness', label: 'Responsiveness', points: resp, max: 10,
    detail: i.unansweredOutbound ? `${i.unansweredOutbound} message(s) without a reply` : 'Replies to messages' });

  const score = clamp(drivers.reduce((s, d) => s + d.points, 0), 0, 100);
  return { score, drivers, avgDaysLate: isNaN(avgLate) ? 0 : avgLate, overdueCents, exposureCents };
}

export type Segment = 'reliable' | 'forgetful' | 'slow-but-sure' | 'cash-constrained' | 'disputing' | 'chronic';

export const SEGMENTS: Segment[] = ['reliable', 'forgetful', 'slow-but-sure', 'cash-constrained', 'disputing', 'chronic'];

export function classifySegment(i: RiskInput, r: RiskResult): Segment {
  if (i.openDisputes > 0) return 'disputing';
  if (r.score >= 75 || (r.avgDaysLate > 30 && i.brokenPromises >= 2)) return 'chronic';
  if (i.hasActivePlan || (i.planRequests ?? 0) > 0 || i.brokenPromises >= 1) return 'cash-constrained';
  if (r.avgDaysLate > 10) return 'slow-but-sure';
  if (r.avgDaysLate > 2 || r.overdueCents > 0) return 'forgetful';
  return 'reliable';
}

export const SEGMENT_DEFAULTS: Record<Segment, { tone: string; note: string }> = {
  reliable: { tone: 'friendly', note: 'Light-touch courtesy reminder only.' },
  forgetful: { tone: 'friendly', note: 'Short, early reminders with a one-tap portal link.' },
  'slow-but-sure': { tone: 'neutral', note: 'Consistent reminders; expect payment after the usual delay.' },
  'cash-constrained': { tone: 'neutral', note: 'Offer a payment plan early.' },
  disputing: { tone: 'neutral', note: 'Resolve the dispute; collect the undisputed part.' },
  chronic: { tone: 'firm', note: 'Firm tone, credit hold, human call.' },
};

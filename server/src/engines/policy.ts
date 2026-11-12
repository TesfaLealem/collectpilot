// Policy engine: hard limits the agents cannot cross, and autonomy levels per action type.
import { hourIn } from '../util.js';

export type Autonomy = 'shadow' | 'assisted' | 'autonomous';

export const ACTION_TYPES: { key: string; label: string; agent: string; default: Autonomy }[] = [
  { key: 'send_reminder', label: 'Send friendly / neutral reminder', agent: 'Communicator', default: 'autonomous' },
  { key: 'send_firm_reminder', label: 'Send firm reminder', agent: 'Communicator', default: 'autonomous' },
  { key: 'send_final_notice', label: 'Send final notice', agent: 'Communicator', default: 'assisted' },
  { key: 'reply_customer', label: 'Reply to customer messages', agent: 'Negotiator', default: 'autonomous' },
  { key: 'record_promise', label: 'Record a promise to pay', agent: 'Negotiator', default: 'autonomous' },
  { key: 'offer_plan', label: 'Offer a payment plan within policy', agent: 'Negotiator', default: 'autonomous' },
  { key: 'custom_plan', label: 'Accept a plan outside policy', agent: 'Negotiator', default: 'assisted' },
  { key: 'apply_payment', label: 'Apply a matched payment', agent: 'Reconciler', default: 'autonomous' },
  { key: 'accept_proof', label: 'Accept proof of payment (pause reminders)', agent: 'Reconciler', default: 'autonomous' },
  { key: 'resolve_dispute', label: 'Resolve a dispute / issue credit note', agent: 'Dispute agent', default: 'assisted' },
  { key: 'credit_hold', label: 'Place / release credit hold', agent: 'Analyst', default: 'autonomous' },
  { key: 'opt_out', label: 'Stop automated contact on request', agent: 'Negotiator', default: 'autonomous' },
];

export const defaultAutonomy = () => Object.fromEntries(ACTION_TYPES.map((a) => [a.key, a.default])) as Record<string, Autonomy>;

export interface PolicyLike {
  autonomy: unknown; maxContactsPerDay: number; quietStartHour: number; quietEndHour: number; timezone: string;
  creditHoldRisk: number; creditHoldDaysOverdue: number; autoMatchConfidence: number; minIntentConfidence: number;
  maxInstalments: number; minUpfrontPct: number; maxPlanDays: number; earlyPayDiscountPct: number; maxDiscountPct: number;
}

export function autonomyFor(policy: PolicyLike, actionType: string): Autonomy {
  const a = (policy.autonomy as Record<string, Autonomy> | null)?.[actionType];
  return a ?? ACTION_TYPES.find((x) => x.key === actionType)?.default ?? 'assisted';
}

export function inQuietHours(policy: PolicyLike, now = new Date()): boolean {
  const h = hourIn(policy.timezone, now);
  const { quietStartHour: s, quietEndHour: e } = policy;
  return s > e ? h >= s || h < e : h >= s && h < e;
}

export interface ContactCheck { ok: boolean; reason?: string; defer?: boolean }

/** Contact rules for proactive outreach. Replies to an inbound message are exempt from frequency and quiet hours. */
export function canContact(policy: PolicyLike, c: { optOut: boolean; contactsToday: number }, now = new Date(), isReply = false): ContactCheck {
  if (c.optOut) return { ok: false, reason: 'Customer opted out of automated contact' };
  if (isReply) return { ok: true };
  if (c.contactsToday >= policy.maxContactsPerDay) return { ok: false, reason: `Contact limit reached (${policy.maxContactsPerDay} per day)` };
  if (inQuietHours(policy, now)) return { ok: false, defer: true, reason: `Quiet hours (${policy.quietStartHour}:00–${policy.quietEndHour}:00 ${policy.timezone})` };
  return { ok: true };
}

export interface CreditInput { riskScore: number; maxDaysPastDue: number; exposureCents: number; creditLimitCents: number; orderCents: number; onHold: boolean; brokenPromises: number }

export function creditCheck(policy: PolicyLike, i: CreditInput) {
  const reasons: string[] = [];
  let decision: 'approve' | 'approve_with_deposit' | 'hold' = 'approve';
  const after = i.exposureCents + i.orderCents;
  if (i.onHold) { decision = 'hold'; reasons.push('Account is on credit hold'); }
  if (i.maxDaysPastDue >= policy.creditHoldDaysOverdue) { decision = 'hold'; reasons.push(`Oldest invoice is ${i.maxDaysPastDue} days overdue (limit ${policy.creditHoldDaysOverdue})`); }
  if (i.riskScore >= policy.creditHoldRisk) { decision = 'hold'; reasons.push(`Risk score ${i.riskScore} is at or above ${policy.creditHoldRisk}`); }
  let depositCents = 0;
  if (decision !== 'hold') {
    if (i.creditLimitCents > 0 && after > i.creditLimitCents) {
      decision = 'approve_with_deposit'; depositCents = Math.min(i.orderCents, after - i.creditLimitCents);
      reasons.push('Order takes exposure above the credit limit; deposit covers the excess');
    } else if (i.riskScore >= policy.creditHoldRisk - 20 || i.brokenPromises > 0) {
      decision = 'approve_with_deposit'; depositCents = Math.round(i.orderCents * 0.3);
      reasons.push(i.brokenPromises > 0 ? 'Recent broken promise: 30% deposit advised' : `Elevated risk score ${i.riskScore}: 30% deposit advised`);
    } else reasons.push('Within credit limit, no serious overdue, acceptable risk');
  }
  return { decision, depositCents, exposureAfterCents: after, reasons };
}

/** Advice on the credit limit from behaviour. */
export function creditLimitAdvice(i: { riskScore: number; avgDaysLate: number; creditLimitCents: number; paidCount: number }) {
  if (i.paidCount >= 5 && i.riskScore <= 15 && i.avgDaysLate <= 3) return { change: 'increase', toCents: Math.round(i.creditLimitCents * 1.2), reason: 'Consistently pays on time' };
  if (i.riskScore >= 70) return { change: 'decrease', toCents: Math.round(i.creditLimitCents * 0.5), reason: 'High risk score' };
  if (i.riskScore >= 50) return { change: 'decrease', toCents: Math.round(i.creditLimitCents * 0.8), reason: 'Rising risk' };
  return { change: 'keep', toCents: i.creditLimitCents, reason: 'Behaviour consistent with current limit' };
}

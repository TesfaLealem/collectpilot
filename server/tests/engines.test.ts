import { describe, expect, it } from 'vitest';
import { scoreRisk, classifySegment } from '../src/engines/risk.js';
import { generatePlanOptions, validatePlan, buildPlan } from '../src/engines/plan.js';
import { matchPayment, extractInvoiceRefs, nameSimilarity, allocateOldestFirst, type OpenInvoice } from '../src/engines/matching.js';
import { predictPayment, buildForecast } from '../src/engines/forecast.js';
import { selectArm, allowedTones, allArms } from '../src/engines/bandit.js';
import { canContact, creditCheck, defaultAutonomy, autonomyFor } from '../src/engines/policy.js';
import { addDays } from '../src/util.js';

const today = new Date(Date.UTC(2026, 10, 12));
const policy = {
  autonomy: defaultAutonomy(), maxInstalments: 4, minUpfrontPct: 25, maxPlanDays: 45, earlyPayDiscountPct: 0, maxDiscountPct: 2,
  maxContactsPerDay: 1, quietStartHour: 19, quietEndHour: 8, creditHoldRisk: 70, creditHoldDaysOverdue: 45,
  autoMatchConfidence: 0.9, minIntentConfidence: 0.7, timezone: 'Africa/Addis_Ababa',
};
const base = { openInvoices: [], paidDaysLate: [], brokenPromises: 0, keptPromises: 0, openDisputes: 0, unansweredOutbound: 0, creditLimitCents: 1_000_000 };

describe('risk score', () => {
  it('is low for a customer who pays on time with nothing overdue', () => {
    const r = scoreRisk({ ...base, paidDaysLate: [0, -2, 1, 0], openInvoices: [{ dueCents: 50_000, daysPastDue: -10 }] });
    expect(r.score).toBeLessThan(10);
    expect(classifySegment({ ...base, paidDaysLate: [0, -2, 1, 0] }, r)).toBe('reliable');
  });
  it('rises with overdue age, broken promises, and silence, and stays within 0-100', () => {
    const i = { ...base, paidDaysLate: [40, 55, 35], brokenPromises: 3, unansweredOutbound: 4, openInvoices: [{ dueCents: 900_000, daysPastDue: 80 }] };
    const r = scoreRisk(i);
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(classifySegment(i, r)).toBe('chronic');
  });
  it('drivers add up to the score and each stays within its cap', () => {
    const r = scoreRisk({ ...base, paidDaysLate: [12, 20], brokenPromises: 1, openInvoices: [{ dueCents: 100_000, daysPastDue: 20 }] });
    expect(r.drivers.reduce((s, d) => s + d.points, 0)).toBe(r.score);
    for (const d of r.drivers) expect(d.points).toBeLessThanOrEqual(d.max);
  });
  it('classifies disputing and cash-constrained customers', () => {
    const d = { ...base, openDisputes: 1 };
    expect(classifySegment(d, scoreRisk(d))).toBe('disputing');
    const c = { ...base, hasActivePlan: true, paidDaysLate: [5] };
    expect(classifySegment(c, scoreRisk(c))).toBe('cash-constrained');
  });
});

describe('payment plans', () => {
  it('every generated option satisfies the policy and sums exactly', () => {
    for (const total of [100_000, 333_333, 1_000_001, 99]) {
      const opts = generatePlanOptions(total, policy, today);
      expect(opts.length).toBeGreaterThanOrEqual(2);
      for (const o of opts) {
        expect(o.instalments.reduce((s, x) => s + x.amountCents, 0) + o.discountCents).toBe(total);
        expect(validatePlan(o, total, policy, today).ok).toBe(true);
      }
    }
  });
  it('rejects plans outside policy', () => {
    const tooLong = buildPlan('x', 100_000, [50, 50], [0, 90], today);
    expect(validatePlan(tooLong, 100_000, policy, today).ok).toBe(false);
    const lowUpfront = buildPlan('x', 100_000, [10, 90], [0, 14], today);
    expect(validatePlan(lowUpfront, 100_000, policy, today).violations.join(' ')).toMatch(/minimum/);
    const tooMany = buildPlan('x', 100_000, [25, 15, 15, 15, 15, 15], [0, 7, 14, 21, 28, 35], today);
    expect(validatePlan(tooMany, 100_000, policy, today).ok).toBe(false);
    const wrongSum = { instalments: [{ dueDate: today, amountCents: 40_000 }, { dueDate: addDays(today, 7), amountCents: 40_000 }] };
    expect(validatePlan(wrongSum, 100_000, policy, today).ok).toBe(false);
  });
  it('applies the early-payment discount within the cap', () => {
    const opts = generatePlanOptions(200_000, { ...policy, earlyPayDiscountPct: 5 }, today);
    const d = opts.find((o) => o.discountCents > 0)!;
    expect(d.discountCents).toBe(4_000); // capped at maxDiscountPct = 2%
  });
});

const inv = (id: string, number: string, customerId: string, customerName: string, dueCents: number, dueOffset: number): OpenInvoice =>
  ({ id, number, customerId, customerName, dueCents, dueDate: addDays(today, dueOffset) });
const open = [
  inv('a', 'INV-1042', 'c1', 'Abebe Trading PLC', 250_000, -40),
  inv('b', 'INV-1047', 'c1', 'Abebe Trading PLC', 180_000, -10),
  inv('c', 'INV-1051', 'c2', 'Selam Pharmacy', 75_000, -5),
  inv('d', 'INV-1060', 'c3', 'Hawassa Building Materials', 75_000, -2),
];

describe('payment matching', () => {
  it('matches an exact reference and amount with high confidence', () => {
    const m = matchPayment({ amountCents: 75_000, reference: 'INV-1051' }, open);
    expect(m.status).toBe('matched'); expect(m.confidence).toBeGreaterThan(0.95);
    expect(m.allocations).toEqual([{ invoiceId: 'c', amountCents: 75_000 }]);
  });
  it('handles combined and partial narrations', () => {
    const refs = extractInvoiceRefs('pmt inv 1042 & part 1047', open);
    expect(refs.map((r) => r.number)).toEqual(['INV-1042', 'INV-1047']);
    const m = matchPayment({ amountCents: 300_000, narration: 'pmt inv 1042 & part 1047' }, open);
    expect(m.allocations).toEqual([{ invoiceId: 'a', amountCents: 250_000 }, { invoiceId: 'b', amountCents: 50_000 }]);
    expect(m.unappliedCents).toBe(0);
  });
  it('matches by payer name and amount when there is no reference', () => {
    const m = matchPayment({ amountCents: 180_000, payerName: 'ABEBE TRADING', narration: 'transfer' }, open);
    expect(m.status).toBe('matched'); expect(m.customerId).toBe('c1');
    expect(m.allocations[0].invoiceId).toBe('b');
  });
  it('only suggests when the amount is ambiguous or by amount alone', () => {
    const m = matchPayment({ amountCents: 75_000, narration: 'cash deposit' }, open);
    expect(m.status).toBe('unmatched'); // two invoices share this amount, no payer
    const s = matchPayment({ amountCents: 180_000, narration: 'deposit' }, open);
    expect(s.status).toBe('suggested'); expect(s.confidence).toBeLessThan(0.9);
  });
  it('leaves overpayment unapplied and never allocates more than received', () => {
    const m = matchPayment({ amountCents: 300_000, reference: 'INV-1042' }, open);
    expect(m.unappliedCents).toBe(50_000);
    const { allocations, unappliedCents } = allocateOldestFirst(100_000, open.filter((o) => o.customerId === 'c1'));
    expect(allocations.reduce((s, a) => s + a.amountCents, 0) + unappliedCents).toBe(100_000);
  });
  it('name similarity ignores company suffixes', () => {
    expect(nameSimilarity('Abebe Trading PLC', 'ABEBE TRADING')).toBeGreaterThan(0.8);
    expect(nameSimilarity('Selam Pharmacy', 'Hawassa Building')).toBe(0);
  });
});

describe('prediction and forecast', () => {
  it('uses the customer history and never predicts a date in the past', () => {
    const p = predictPayment({ dueDate: addDays(today, 10), dueCents: 100_000, segment: 'slow-but-sure', riskScore: 30, paidDaysLate: [10, 12, 14, 11] }, today);
    expect(p.expected.getTime()).toBe(addDays(today, 10 + 12).getTime()); // median 11.5 -> 12
    const late = predictPayment({ dueDate: addDays(today, -60), dueCents: 100_000, segment: 'chronic', riskScore: 80, paidDaysLate: [] }, today);
    expect(late.expected.getTime()).toBeGreaterThan(today.getTime());
    expect(late.probability).toBeLessThan(p.probability);
  });
  it('a promise overrides the statistical prediction', () => {
    const promise = addDays(today, 4);
    const p = predictPayment({ dueDate: addDays(today, -20), dueCents: 1, segment: 'forgetful', riskScore: 20, paidDaysLate: [], promiseDate: promise }, today);
    expect(p.expected.getTime()).toBe(promise.getTime());
  });
  it('builds 13 weeks and what-if delays move cash later', () => {
    const pred = predictPayment({ dueDate: addDays(today, 3), dueCents: 100_000, segment: 'reliable', riskScore: 5, paidDaysLate: [0, 1, 0] }, today);
    const items = [{ invoiceId: 'a', customerId: 'c1', customerName: 'A', number: 'INV-1', dueCents: 100_000, prediction: pred }];
    const f = buildForecast(items, today);
    expect(f).toHaveLength(13);
    expect(f[0].expected).toBeGreaterThan(0);
    const g = buildForecast(items, today, 13, { c1: 30 });
    expect(g[0].expected).toBe(0);
    expect(g[4].expected).toBe(f[0].expected);
  });
});

describe('bandit', () => {
  it('never offers a firm tone before an invoice is overdue', () => {
    expect(allowedTones(0)).toEqual(['friendly']);
    expect(allowedTones(20)).toContain('firm');
    const s = selectArm([], { tones: allowedTones(0), channels: ['email'], defaultTone: 'friendly', preferredChannel: 'email' });
    expect(s.arm.tone).toBe('friendly'); expect(s.arm.channel).toBe('email');
  });
  it('tries untested arms first, then exploits the best one', () => {
    const stats = allArms().map((a) => ({ ...a, pulls: 20, rewards: a.tone === 'neutral' && a.channel === 'telegram' && a.window === 'morning' ? 16 : 4 }));
    const s = selectArm(stats, { tones: allowedTones(20), channels: ['email', 'telegram'], defaultTone: 'friendly', preferredChannel: 'email' });
    expect(`${s.arm.tone}|${s.arm.channel}|${s.arm.window}`).toBe('neutral|telegram|morning');
    stats[0].pulls = 0; stats[0].rewards = 0;
    const e = selectArm(stats, { tones: allowedTones(20), channels: ['email', 'telegram'], defaultTone: 'friendly', preferredChannel: 'email' });
    expect(e.arm.pulls).toBe(0);
  });
});

describe('policy engine', () => {
  const noon = new Date('2026-11-12T09:00:00Z'); // 12:00 in Addis Ababa
  const night = new Date('2026-11-12T19:00:00Z'); // 22:00 in Addis Ababa
  it('enforces opt-out, daily frequency, and quiet hours', () => {
    expect(canContact(policy, { optOut: true, contactsToday: 0 }, noon).ok).toBe(false);
    expect(canContact(policy, { optOut: false, contactsToday: 1 }, noon).ok).toBe(false);
    expect(canContact(policy, { optOut: false, contactsToday: 0 }, night)).toMatchObject({ ok: false, defer: true });
    expect(canContact(policy, { optOut: false, contactsToday: 0 }, noon).ok).toBe(true);
    expect(canContact(policy, { optOut: false, contactsToday: 3 }, night, true).ok).toBe(true); // replies are exempt
  });
  it('final notices default to assisted, reminders to autonomous', () => {
    expect(autonomyFor(policy, 'send_final_notice')).toBe('assisted');
    expect(autonomyFor(policy, 'send_reminder')).toBe('autonomous');
    expect(autonomyFor({ ...policy, autonomy: { send_reminder: 'shadow' } }, 'send_reminder')).toBe('shadow');
  });
  it('credit check returns approve / deposit / hold with reasons', () => {
    const b = { riskScore: 10, maxDaysPastDue: 0, exposureCents: 100_000, creditLimitCents: 500_000, orderCents: 100_000, onHold: false, brokenPromises: 0 };
    expect(creditCheck(policy, b).decision).toBe('approve');
    const dep = creditCheck(policy, { ...b, orderCents: 600_000 });
    expect(dep.decision).toBe('approve_with_deposit'); expect(dep.depositCents).toBe(200_000);
    expect(creditCheck(policy, { ...b, maxDaysPastDue: 50 }).decision).toBe('hold');
    expect(creditCheck(policy, { ...b, riskScore: 80 }).decision).toBe('hold');
  });
});

// Payment-plan arithmetic and policy validation. Integer cents only; the last instalment absorbs rounding.
import { addDays, daysBetween, startOfDay } from '../util.js';

export interface PlanPolicy { maxInstalments: number; minUpfrontPct: number; maxPlanDays: number; earlyPayDiscountPct: number; maxDiscountPct: number }
export interface PlanInstalment { seq: number; dueDate: Date; amountCents: number }
export interface PlanOption { label: string; instalments: PlanInstalment[]; totalCents: number; discountCents: number }

function split(totalCents: number, shares: number[]): number[] {
  const sum = shares.reduce((a, b) => a + b, 0);
  const out = shares.map((s) => Math.floor((totalCents * s) / sum));
  out[out.length - 1] += totalCents - out.reduce((a, b) => a + b, 0);
  return out;
}

export function buildPlan(label: string, totalCents: number, shares: number[], offsetsDays: number[], today: Date, discountCents = 0): PlanOption {
  const amounts = split(totalCents - discountCents, shares);
  const t = startOfDay(today);
  return {
    label, totalCents: totalCents - discountCents, discountCents,
    instalments: amounts.map((a, i) => ({ seq: i + 1, dueDate: addDays(t, offsetsDays[i]), amountCents: a })),
  };
}

/** Standard options the Negotiator may offer without approval. All are guaranteed to satisfy the policy. */
export function generatePlanOptions(totalCents: number, policy: PlanPolicy, today = new Date()): PlanOption[] {
  const opts: PlanOption[] = [];
  const up = Math.max(policy.minUpfrontPct, 0);

  if (policy.earlyPayDiscountPct > 0) {
    const pct = Math.min(policy.earlyPayDiscountPct, policy.maxDiscountPct);
    const disc = Math.floor((totalCents * pct) / 100);
    opts.push(buildPlan(`Pay in full within 3 days and get ${pct}% off`, totalCents, [1], [3], today, disc));
  }
  if (policy.maxInstalments >= 2 && policy.maxPlanDays >= 14) {
    const first = Math.max(50, up);
    opts.push(buildPlan(`${first}% now, ${100 - first}% in 14 days`, totalCents, [first, 100 - first], [0, 14], today));
  }
  const n = Math.min(policy.maxInstalments, 3);
  if (n >= 3 && policy.maxPlanDays >= 14) {
    // Equal instalments unless policy demands a larger first payment.
    const shares = 100 / n >= up ? Array(n).fill(1) : [up, ...Array(n - 1).fill((100 - up) / (n - 1))];
    opts.push(buildPlan(`${n} weekly instalments`, totalCents, shares, Array.from({ length: n }, (_, i) => i * 7), today));
  }
  if (policy.maxInstalments >= 4 && policy.maxPlanDays >= 42) {
    const first = Math.max(25, up);
    const rest = (100 - first) / 3;
    opts.push(buildPlan('4 instalments, every two weeks', totalCents, [first, rest, rest, rest], [0, 14, 28, 42], today));
  }
  return opts.filter((o) => validatePlan(o, totalCents, policy, today).ok);
}

export function validatePlan(plan: { instalments: { dueDate: Date; amountCents: number }[]; discountCents?: number }, totalCents: number, policy: PlanPolicy, today = new Date()) {
  const violations: string[] = [];
  const ins = [...plan.instalments].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const disc = plan.discountCents ?? 0;
  const sum = ins.reduce((s, x) => s + x.amountCents, 0);
  if (!ins.length) violations.push('Plan has no instalments');
  if (ins.some((x) => x.amountCents <= 0)) violations.push('Every instalment must be positive');
  if (sum + disc !== totalCents) violations.push(`Instalments (${sum}) plus discount (${disc}) do not equal the amount due (${totalCents})`);
  if (ins.length > policy.maxInstalments) violations.push(`More than ${policy.maxInstalments} instalments`);
  if (disc > Math.floor((totalCents * policy.maxDiscountPct) / 100)) violations.push(`Discount above the ${policy.maxDiscountPct}% cap`);
  if (ins.length > 1) {
    const upfrontPct = (ins[0].amountCents / (totalCents - disc)) * 100;
    if (upfrontPct + 1e-9 < policy.minUpfrontPct) violations.push(`First payment ${upfrontPct.toFixed(0)}% is below the ${policy.minUpfrontPct}% minimum`);
    if (daysBetween(today, ins[0].dueDate) > 7) violations.push('First payment must be within 7 days');
  }
  const last = ins[ins.length - 1];
  if (last && daysBetween(today, last.dueDate) > policy.maxPlanDays) violations.push(`Plan ends later than ${policy.maxPlanDays} days from today`);
  if (ins.some((x) => daysBetween(today, x.dueDate) < 0)) violations.push('Instalment dated in the past');
  return { ok: violations.length === 0, violations };
}

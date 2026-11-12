// Analyst: risk scores, segments, payment-date predictions, cash forecast, KPIs, ROI, anomaly alerts.
import { db, audit } from '../db.js';
import { getPolicy, gate, type Policy } from '../core.js';
import { scoreRisk, classifySegment, type RiskInput, type Segment } from '../engines/risk.js';
import { predictPayment, buildForecast, type ForecastItem } from '../engines/forecast.js';
import { creditLimitAdvice } from '../engines/policy.js';
import { addDays, daysBetween, startOfDay, iso, DAY } from '../util.js';
import { ensureFx, toBase } from '../integrations/fx.js';
import type { Trace } from '../trace.js';

const dueOf = (i: { amountCents: number; paidCents: number }) => i.amountCents - i.paidCents;

export async function loadTenant(tenantId: string) {
  await ensureFx();
  const base = (await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { baseCurrency: true } })).baseCurrency;
  const [customers, invoices, promises, plans, disputes, interactions] = await Promise.all([
    db.customer.findMany({ where: { tenantId } }),
    db.invoice.findMany({ where: { tenantId } }),
    db.promiseToPay.findMany({ where: { tenantId } }),
    db.paymentPlan.findMany({ where: { tenantId }, include: { instalments: true } }),
    db.dispute.findMany({ where: { tenantId } }),
    db.interaction.findMany({ where: { tenantId, channel: { in: ['email', 'telegram', 'portal'] } }, select: { customerId: true, direction: true, createdAt: true, rewarded: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { customers, invoices, promises, plans, disputes, interactions, base };
}
type Data = Awaited<ReturnType<typeof loadTenant>>;

export function riskInputFor(d: Data, customerId: string, today: Date): RiskInput & { paidCount: number; maxDpd: number } {
  const c = d.customers.find((x) => x.id === customerId)!;
  const invs = d.invoices.filter((i) => i.customerId === customerId);
  const open = invs.filter((i) => dueOf(i) > 0 && i.status !== 'written_off');
  const paid = invs.filter((i) => i.status === 'paid' && i.paidAt).sort((a, b) => a.paidAt!.getTime() - b.paidAt!.getTime());
  const its = d.interactions.filter((i) => i.customerId === customerId);
  let unanswered = 0;
  // Messages since the last reply that produced neither a reply nor a payment, within the last 45 days.
  for (let k = its.length - 1; k >= 0; k--) { if (its[k].direction === 'in' || its[k].createdAt < addDays(today, -45)) break; if (its[k].direction === 'out' && !its[k].rewarded) unanswered++; }
  const prs = d.promises.filter((p) => p.customerId === customerId);
  const pls = d.plans.filter((p) => p.customerId === customerId);
  const openInvoices = open.map((i) => ({ dueCents: toBase(dueOf(i), i.currency, d.base), daysPastDue: daysBetween(i.dueDate, today) }));
  return {
    openInvoices, paidDaysLate: paid.map((i) => daysBetween(i.dueDate, i.paidAt!)),
    brokenPromises: prs.filter((p) => p.status === 'broken').length + pls.filter((p) => p.status === 'defaulted').length,
    keptPromises: prs.filter((p) => p.status === 'kept').length,
    openDisputes: d.disputes.filter((x) => x.customerId === customerId && !['resolved', 'rejected'].includes(x.stage)).length,
    unansweredOutbound: unanswered, creditLimitCents: c.creditLimitCents,
    hasActivePlan: pls.some((p) => p.status === 'active'), planRequests: pls.filter((p) => p.status !== 'cancelled').length,
    paidCount: paid.length, maxDpd: Math.max(0, ...openInvoices.map((o) => o.daysPastDue)),
  };
}

/** Recompute risk, segment, predictions, and credit hold for every customer. */
export async function refreshAll(tenantId: string, trace?: Trace, today = new Date()) {
  const policy = await getPolicy(tenantId);
  const d = await loadTenant(tenantId);
  const t = startOfDay(today);
  const changes: { customer: string; from: number; to: number; segment: Segment }[] = [];
  const alerts: string[] = [];
  let holdsPlaced = 0, holdsReleased = 0;

  for (const c of d.customers) {
    const input = riskInputFor(d, c.id, t);
    const r = scoreRisk(input);
    const segment = classifySegment(input, r);
    const shouldHold = r.score >= policy.creditHoldRisk || input.maxDpd >= policy.creditHoldDaysOverdue;
    let creditHold = c.creditHold;
    if (shouldHold !== c.creditHold) {
      const res = await gate(tenantId, policy, { agent: 'Analyst', actionType: 'credit_hold', customerId: c.id,
        title: `${shouldHold ? 'Place' : 'Release'} credit hold: ${c.name}`,
        reason: shouldHold ? `Risk score ${r.score}; oldest invoice ${input.maxDpd} days overdue.` : `Risk score fell to ${r.score} and nothing is seriously overdue.`,
        payload: { customerId: c.id, hold: shouldHold } }, trace);
      if (res === 'execute') { creditHold = shouldHold; shouldHold ? holdsPlaced++ : holdsReleased++; await audit(tenantId, 'Analyst', shouldHold ? 'credit_hold_placed' : 'credit_hold_released', 'Customer', c.id, { score: r.score, maxDpd: input.maxDpd }); }
    }
    if (Math.abs(r.score - c.riskScore) >= 5 || segment !== c.segment) changes.push({ customer: c.name, from: c.riskScore, to: r.score, segment });
    // Anomaly: a normally punctual customer is now clearly late.
    if (input.paidCount >= 3 && r.avgDaysLate <= 3 && input.maxDpd >= 10) alerts.push(`${c.name} normally pays on time but is now ${input.maxDpd} days overdue.`);
    await db.customer.update({ where: { id: c.id }, data: { riskScore: r.score, riskDrivers: r.drivers as any, segment, creditHold } });

    const promise = d.promises.filter((p) => p.customerId === c.id && p.status === 'open').sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())[0];
    for (const inv of d.invoices.filter((i) => i.customerId === c.id && dueOf(i) > 0 && i.status !== 'written_off')) {
      const p = predictPayment({ dueDate: inv.dueDate, dueCents: dueOf(inv), segment, riskScore: r.score, paidDaysLate: input.paidDaysLate, promiseDate: promise && (!promise.invoiceId || promise.invoiceId === inv.id) ? promise.dueDate : null }, t);
      if (!inv.predictedPayDate || inv.predictedPayDate.getTime() !== p.expected.getTime()) await db.invoice.update({ where: { id: inv.id }, data: { predictedPayDate: p.expected } });
    }
  }
  const exposure = d.invoices.reduce((s, i) => s + toBase(Math.max(0, dueOf(i)), i.currency, d.base), 0);
  const byCust = d.customers.map((c) => ({ name: c.name, due: d.invoices.filter((i) => i.customerId === c.id).reduce((s, i) => s + toBase(Math.max(0, dueOf(i)), i.currency, d.base), 0) })).sort((a, b) => b.due - a.due);
  if (exposure > 0 && byCust[0] && byCust[0].due / exposure > 0.3) alerts.push(`Concentration: ${byCust[0].name} is ${Math.round((byCust[0].due / exposure) * 100)}% of all receivables.`);

  await trace?.step('Analyst', 'refresh_scores', { tool: 'risk + prediction engines', input: { customers: d.customers.length, openInvoices: d.invoices.filter((i) => dueOf(i) > 0).length },
    reasoning: 'Risk scores, segments, and payment-date predictions are recomputed from deterministic rules; the model is not involved.',
    output: { changed: changes.slice(0, 12), holdsPlaced, holdsReleased, alerts } });
  return { changes, alerts, holdsPlaced, holdsReleased };
}

/** Promises and instalments that passed their date without payment become broken / missed. */
export async function checkPromisesAndPlans(tenantId: string, trace?: Trace, today = new Date()) {
  const t = startOfDay(today);
  const broken: { customerId: string; kind: string; ref: string }[] = [];
  const promises = await db.promiseToPay.findMany({ where: { tenantId, status: 'open', dueDate: { lt: t } }, include: { customer: true } });
  for (const p of promises) {
    await db.promiseToPay.update({ where: { id: p.id }, data: { status: 'broken', resolvedAt: new Date() } });
    if (p.invoiceId) await db.invoice.updateMany({ where: { id: p.invoiceId, tenantId }, data: { pausedUntil: null } });
    else await db.invoice.updateMany({ where: { customerId: p.customerId, tenantId }, data: { pausedUntil: null } });
    await db.interaction.create({ data: { tenantId, customerId: p.customerId, invoiceId: p.invoiceId, direction: 'internal', channel: 'system', kind: 'note', body: `Promise to pay on ${iso(p.dueDate)} was not kept.`, status: 'sent' } });
    broken.push({ customerId: p.customerId, kind: 'promise', ref: p.id });
  }
  const instalments = await db.instalment.findMany({ where: { status: { in: ['due', 'claimed'] }, dueDate: { lt: t }, plan: { tenantId, status: 'active' } }, include: { plan: true } });
  for (const ins of instalments) {
    if (ins.paidCents >= ins.amountCents) continue;
    await db.instalment.update({ where: { id: ins.id }, data: { status: 'missed' } });
    await db.paymentPlan.update({ where: { id: ins.planId }, data: { status: 'defaulted' } });
    await db.invoice.updateMany({ where: { id: { in: ins.plan.invoiceIds }, tenantId }, data: { pausedUntil: null } });
    await db.interaction.create({ data: { tenantId, customerId: ins.plan.customerId, direction: 'internal', channel: 'system', kind: 'note', body: `Instalment ${ins.seq} of the payment plan (due ${iso(ins.dueDate)}) was missed. The plan is in default.`, status: 'sent' } });
    broken.push({ customerId: ins.plan.customerId, kind: 'instalment', ref: ins.id });
  }
  // Payment claims that the bank never confirmed: resume collection after the pause.
  const stale = await db.invoice.findMany({ where: { tenantId, status: 'claimed', pausedUntil: { lt: t } } });
  for (const inv of stale) await db.invoice.update({ where: { id: inv.id }, data: { status: inv.paidCents > 0 ? 'partial' : 'open', pausedUntil: null } });
  if (broken.length || stale.length) await trace?.step('Analyst', 'check_promises', { input: { date: iso(t) }, output: { broken, staleClaims: stale.length }, reasoning: 'Promises and instalments past their date with no matching payment are marked broken; this feeds the risk score and the next strategy choice.' });
  return broken;
}

export async function forecastFor(tenantId: string, delays: Record<string, number> = {}, today = new Date()) {
  const d = await loadTenant(tenantId);
  const t = startOfDay(today);
  const items: ForecastItem[] = [];
  for (const c of d.customers) {
    const input = riskInputFor(d, c.id, t);
    const promise = d.promises.filter((p) => p.customerId === c.id && p.status === 'open').sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())[0];
    const plan = d.plans.find((p) => p.customerId === c.id && p.status === 'active');
    const planInv = new Set(plan?.invoiceIds ?? []);
    if (plan) for (const ins of plan.instalments.filter((i) => i.status !== 'paid')) {
      const due = ins.dueDate < t ? addDays(t, 3) : ins.dueDate;
      items.push({ invoiceId: ins.id, customerId: c.id, customerName: c.name, number: `Plan ${ins.seq}/${plan.instalments.length}`, dueCents: ins.amountCents - ins.paidCents,
        prediction: { expected: due, best: due, worst: addDays(due, 10), probability: 0.85, basis: 'Payment plan instalment' } });
    }
    for (const inv of d.invoices.filter((i) => i.customerId === c.id && dueOf(i) > 0 && i.status !== 'written_off' && !planInv.has(i.id))) {
      const collectible = dueOf(inv) - Math.min(inv.disputedCents, dueOf(inv));
      if (collectible <= 0) continue;
      items.push({ invoiceId: inv.id, customerId: c.id, customerName: c.name, number: inv.number, dueCents: toBase(collectible, inv.currency, d.base),
        prediction: predictPayment({ dueDate: inv.dueDate, dueCents: collectible, segment: c.segment as Segment, riskScore: c.riskScore, paidDaysLate: input.paidDaysLate, promiseDate: promise && (!promise.invoiceId || promise.invoiceId === inv.id) ? promise.dueDate : null }, t) });
    }
  }
  const weeks = buildForecast(items, t, 13, delays);
  const sum = (k: 'best' | 'expected' | 'worst') => weeks.reduce((s, w) => s + w[k], 0);
  return { weeks, totals: { best: sum('best'), expected: sum('expected'), worst: sum('worst') }, items: items.map((i) => ({ ...i, prediction: { ...i.prediction, expected: iso(i.prediction.expected), best: iso(i.prediction.best), worst: iso(i.prediction.worst) } })) };
}

export async function kpis(tenantId: string, today = new Date()) {
  const t = startOfDay(today);
  await ensureFx();
  const base = (await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { baseCurrency: true } })).baseCurrency;
  const [rawInvoices, rawAllocations, customers, promises] = await Promise.all([
    db.invoice.findMany({ where: { tenantId }, include: { customer: { select: { name: true } } } }),
    db.allocation.findMany({ where: { invoice: { tenantId } }, include: { payment: { select: { date: true } }, invoice: { select: { currency: true } } } }),
    db.customer.findMany({ where: { tenantId } }),
    db.promiseToPay.findMany({ where: { tenantId } }),
  ]);
  // Everything below is in the tenant base currency.
  const invoices = rawInvoices.map((i) => ({ ...i, amountCents: toBase(i.amountCents, i.currency, base), paidCents: toBase(i.paidCents, i.currency, base), disputedCents: toBase(i.disputedCents, i.currency, base) }));
  const allocations = rawAllocations.map((a) => ({ ...a, amountCents: toBase(a.amountCents, a.invoice.currency, base) }));
  const open = invoices.filter((i) => dueOf(i) > 0 && i.status !== 'written_off');
  const outstanding = open.reduce((s, i) => s + dueOf(i), 0);
  const overdue = open.filter((i) => i.dueDate < t).reduce((s, i) => s + dueOf(i), 0);
  const disputed = open.reduce((s, i) => s + Math.min(i.disputedCents, dueOf(i)), 0);
  const buckets = [{ label: 'Not due', min: -1e9, max: 0 }, { label: '1–30', min: 1, max: 30 }, { label: '31–60', min: 31, max: 60 }, { label: '61–90', min: 61, max: 90 }, { label: '90+', min: 91, max: 1e9 }];
  const aging = buckets.map((b) => ({ label: b.label, cents: open.filter((i) => { const d = daysBetween(i.dueDate, t); return d >= b.min && d <= b.max; }).reduce((s, i) => s + dueOf(i), 0) }));

  const dsoAt = (date: Date) => {
    const sales = invoices.filter((i) => i.issueDate <= date && i.issueDate > addDays(date, -90)).reduce((s, i) => s + i.amountCents, 0);
    const issued = invoices.filter((i) => i.issueDate <= date).reduce((s, i) => s + i.amountCents, 0);
    const paid = allocations.filter((a) => a.payment.date <= date).reduce((s, a) => s + a.amountCents, 0);
    return sales > 0 ? Math.round(((issued - paid) / sales) * 90) : 0;
  };
  const dsoTrend = Array.from({ length: 9 }, (_, k) => { const date = addDays(t, -(8 - k) * 7); return { week: iso(date), dso: dsoAt(date) }; });
  const monthStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const collectedMonth = allocations.filter((a) => a.payment.date >= monthStart).reduce((s, a) => s + a.amountCents, 0);
  const resolved = promises.filter((p) => p.status === 'kept' || p.status === 'broken');
  return {
    baseCurrency: base, outstanding, overdue, disputed, dso: dsoAt(t), dsoTrend, aging, collectedMonth,
    overdueCount: open.filter((i) => i.dueDate < t).length, customersOnHold: customers.filter((c) => c.creditHold).length,
    promiseKeptRate: resolved.length ? Math.round((resolved.filter((p) => p.status === 'kept').length / resolved.length) * 100) : null,
    topRisks: customers.filter((c) => open.some((i) => i.customerId === c.id)).sort((a, b) => b.riskScore - a.riskScore).slice(0, 6).map((c) => ({
      id: c.id, name: c.name, riskScore: c.riskScore, segment: c.segment, creditHold: c.creditHold,
      overdueCents: open.filter((i) => i.customerId === c.id && i.dueDate < t).reduce((s, i) => s + dueOf(i), 0),
      drivers: ((c.riskDrivers as any[]) ?? []).filter((d) => d.points > 0).sort((a, b) => b.points - a.points).slice(0, 3),
    })),
  };
}

export async function roi(tenantId: string) {
  const since = new Date(Date.now() - 30 * DAY);
  const [outs, ins, allocs, proofs, payments, promises, approvals, paidInvoices] = await Promise.all([
    db.interaction.findMany({ where: { tenantId, direction: 'out', channel: { in: ['email', 'telegram'] } }, select: { customerId: true, createdAt: true } }),
    db.interaction.count({ where: { tenantId, direction: 'in', createdAt: { gte: since } } }),
    db.allocation.findMany({ where: { invoice: { tenantId }, payment: { date: { gte: since } } }, include: { payment: true, invoice: { select: { customerId: true, id: true } } } }),
    db.paymentProof.count({ where: { tenantId, createdAt: { gte: since } } }),
    db.payment.findMany({ where: { tenantId, status: 'matched', date: { gte: since } }, select: { matchConfidence: true } }),
    db.promiseToPay.findMany({ where: { tenantId, status: { in: ['kept', 'broken'] } } }),
    db.approval.findMany({ where: { tenantId, status: { in: ['approved', 'executed', 'rejected'] }, decidedBy: { not: null } }, select: { invoiceId: true, customerId: true } }),
    db.invoice.findMany({ where: { tenantId, status: 'paid', paidAt: { gte: since } }, select: { id: true, customerId: true } }),
  ]);
  let afterAction = 0, total = 0;
  for (const a of allocs) {
    total += a.amountCents;
    if (outs.some((o) => o.customerId === a.invoice.customerId && o.createdAt <= addDays(a.payment.date, 1) && o.createdAt >= addDays(a.payment.date, -14))) afterAction += a.amountCents;
  }
  const outs30 = outs.filter((o) => o.createdAt >= since).length;
  const humanTouched = new Set(approvals.map((a) => a.customerId));
  const zeroTouch = paidInvoices.length ? Math.round((paidInvoices.filter((i) => !humanTouched.has(i.customerId)).length / paidInvoices.length) * 100) : null;
  const minutes = outs30 * 4 + ins * 5 + payments.length * 3 + proofs * 3;
  return {
    windowDays: 30, collectedCents: total, collectedAfterAgentCents: afterAction, messagesSent: outs30, repliesHandled: ins, paymentsMatched: payments.length, proofsRead: proofs,
    hoursSaved: Math.round((minutes / 60) * 10) / 10, zeroTouchPct: zeroTouch,
    promiseKeptRate: promises.length ? Math.round((promises.filter((p) => p.status === 'kept').length / promises.length) * 100) : null,
    assumptions: 'Hours saved assumes 4 min per message written, 5 min per reply handled, 3 min per payment matched or proof read.',
  };
}

export async function limitAdvice(tenantId: string, customerId: string) {
  const d = await loadTenant(tenantId);
  const c = d.customers.find((x) => x.id === customerId);
  if (!c) return null;
  const input = riskInputFor(d, customerId, startOfDay(new Date()));
  const r = scoreRisk(input);
  return creditLimitAdvice({ riskScore: r.score, avgDaysLate: r.avgDaysLate, creditLimitCents: c.creditLimitCents, paidCount: input.paidCount });
}

export type { Policy };

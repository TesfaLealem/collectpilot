// The ledger: applying payments to invoices and everything that follows from money arriving
// (promises kept, instalments paid, proofs confirmed, strategy reward). All arithmetic is integer cents.
import { db, audit } from './db.js';
import { addDays, money } from './util.js';
import type { Alloc } from './engines/matching.js';
import type { Trace } from './trace.js';

export const invoiceStatus = (amountCents: number, paidCents: number) => (paidCents >= amountCents ? 'paid' : paidCents > 0 ? 'partial' : 'open');

export async function applyPayment(tenantId: string, paymentId: string, allocs: Alloc[], meta: { actor: string; confidence?: number; reason?: string }, trace?: Trace) {
  const result = await db.$transaction(async (tx) => {
    const pay = await tx.payment.findFirstOrThrow({ where: { id: paymentId, tenantId }, include: { allocations: true } });
    let left = pay.amountCents - pay.allocations.reduce((s, a) => s + a.amountCents, 0);
    const applied: { invoiceId: string; number: string; amountCents: number; customerId: string; paidInFull: boolean }[] = [];
    for (const a of allocs) {
      if (left <= 0) break;
      const inv = await tx.invoice.findFirst({ where: { id: a.invoiceId, tenantId } });
      if (!inv) continue;
      const amt = Math.min(a.amountCents, inv.amountCents - inv.paidCents, left);
      if (amt <= 0) continue;
      const paid = inv.paidCents + amt;
      const st = invoiceStatus(inv.amountCents, paid);
      await tx.allocation.create({ data: { paymentId, invoiceId: inv.id, amountCents: amt } });
      await tx.invoice.update({ where: { id: inv.id }, data: { paidCents: paid, status: st, paidAt: st === 'paid' ? pay.date : null, pausedUntil: null } });
      left -= amt;
      applied.push({ invoiceId: inv.id, number: inv.number, amountCents: amt, customerId: inv.customerId, paidInFull: st === 'paid' });
    }
    const customerId = applied[0]?.customerId ?? pay.customerId;
    await tx.payment.update({ where: { id: paymentId }, data: {
      status: applied.length ? 'matched' : 'unapplied', unappliedCents: left, customerId,
      matchConfidence: meta.confidence ?? pay.matchConfidence, matchReason: meta.reason ?? pay.matchReason, suggestion: undefined,
    } });
    return { pay, applied, left, customerId };
  });

  const { pay, applied, customerId } = result;
  if (!applied.length || !customerId) return result;
  const appliedTotal = applied.reduce((s, a) => s + a.amountCents, 0);

  // Promises: the earliest open promise is kept when its invoice is settled or the payment covers it.
  const promises = await db.promiseToPay.findMany({ where: { tenantId, customerId, status: 'open' }, orderBy: { dueDate: 'asc' } });
  let budget = appliedTotal;
  for (const p of promises) {
    const invoicePaid = p.invoiceId ? applied.some((a) => a.invoiceId === p.invoiceId && a.paidInFull) : false;
    if (invoicePaid || budget >= Math.floor(p.amountCents * 0.95)) {
      await db.promiseToPay.update({ where: { id: p.id }, data: { status: 'kept', resolvedAt: new Date() } });
      budget -= p.amountCents;
    }
  }

  // Active payment plan: pay instalments in sequence.
  const plan = await db.paymentPlan.findFirst({ where: { tenantId, customerId, status: 'active' }, include: { instalments: { orderBy: { seq: 'asc' } } } });
  if (plan) {
    let amt = appliedTotal;
    for (const ins of plan.instalments) {
      if (amt <= 0) break;
      const need = ins.amountCents - ins.paidCents;
      if (need <= 0) continue;
      const pay2 = Math.min(need, amt);
      amt -= pay2;
      await db.instalment.update({ where: { id: ins.id }, data: { paidCents: ins.paidCents + pay2, status: ins.paidCents + pay2 >= ins.amountCents ? 'paid' : ins.status === 'missed' ? 'missed' : 'due' } });
    }
    const fresh = await db.instalment.findMany({ where: { planId: plan.id } });
    if (fresh.every((i) => i.status === 'paid')) await db.paymentPlan.update({ where: { id: plan.id }, data: { status: 'completed' } });
  }

  // Proofs of payment awaiting bank confirmation.
  const proofs = await db.paymentProof.findMany({ where: { tenantId, customerId, status: { in: ['claimed', 'review'] } } });
  for (const pr of proofs) {
    const sameAmount = pr.amountCents != null && Math.abs(pr.amountCents - pay.amountCents) <= 100;
    const sameInvoice = pr.invoiceId ? applied.some((a) => a.invoiceId === pr.invoiceId) : false;
    if (sameAmount || sameInvoice) await db.paymentProof.update({ where: { id: pr.id }, data: { status: 'confirmed', paymentId } });
  }
  // Any still-"claimed" invoices not fully settled revert to their arithmetic status.
  for (const a of applied.filter((x) => !x.paidInFull)) {
    const inv = await db.invoice.findUnique({ where: { id: a.invoiceId } });
    if (inv?.status === 'claimed') await db.invoice.update({ where: { id: inv.id }, data: { status: invoiceStatus(inv.amountCents, inv.paidCents) } });
  }

  // Strategy reward: credit the most recent outreach approach if money arrived within 7 days of it.
  const last = await db.interaction.findFirst({ where: { tenantId, customerId, direction: 'out', armKey: { not: null }, rewarded: false, createdAt: { gte: addDays(pay.date, -7) } }, orderBy: { createdAt: 'desc' } });
  if (last?.armKey) {
    const [tone, channel, window] = last.armKey.split('|');
    const segment = (last.meta as any)?.segment ?? 'reliable';
    await db.strategyArm.updateMany({ where: { tenantId, segment, tone, channel, window }, data: { rewards: { increment: 1 } } });
    await db.interaction.update({ where: { id: last.id }, data: { rewarded: true } });
    await trace?.step('Strategist', 'reward', { input: { arm: last.armKey, segment }, reasoning: 'Payment arrived within 7 days of this outreach, so the approach is rewarded.', output: { reward: 1 } });
  }

  const list = applied.map((a) => `${a.number} (${money(a.amountCents, pay.currency)})`).join(', ');
  await db.interaction.create({ data: { tenantId, customerId, direction: 'internal', channel: 'system', kind: 'note', body: `Payment of ${money(pay.amountCents, pay.currency)} applied to ${list}.`, status: 'sent', meta: { paymentId } } });
  await audit(tenantId, meta.actor, 'payment_applied', 'Payment', paymentId, { applied, confidence: meta.confidence, reason: meta.reason });
  return result;
}

/** Record a reward when a promise is kept or a plan accepted (a softer positive signal than cash). */
export async function rewardLastOutreach(tenantId: string, customerId: string, amount: number) {
  const last = await db.interaction.findFirst({ where: { tenantId, customerId, direction: 'out', armKey: { not: null }, rewarded: false, createdAt: { gte: addDays(new Date(), -7) } }, orderBy: { createdAt: 'desc' } });
  if (!last?.armKey) return;
  const [tone, channel, window] = last.armKey.split('|');
  await db.strategyArm.updateMany({ where: { tenantId, segment: (last.meta as any)?.segment ?? 'reliable', tone, channel, window }, data: { rewards: { increment: amount } } });
  await db.interaction.update({ where: { id: last.id }, data: { rewarded: true } });
}

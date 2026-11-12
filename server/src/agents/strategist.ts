// Strategist: chooses the next best action for each account and the outreach approach (bandit),
// then hands the message to the Communicator through the policy gate.
import type { Customer, Invoice } from '@prisma/client';
import { db } from '../db.js';
import { gate, portalLink, type Policy } from '../core.js';
import { allowedTones, armKey, selectArm, WINDOW_HOURS, type Selection } from '../engines/bandit.js';
import { canContact } from '../engines/policy.js';
import { SEGMENT_DEFAULTS, type Segment } from '../engines/risk.js';
import { addDays, daysBetween, hourIn, iso, money, startOfDay } from '../util.js';
import { compose, type MsgKind } from './communicator.js';
import { recall } from './memory.js';
import { contactsToday, deliver } from '../messaging.js';
import { ensureFx, toBase } from '../integrations/fx.js';
import type { Trace } from '../trace.js';

const dueOf = (i: { amountCents: number; paidCents: number }) => i.amountCents - i.paidCents;
export const collectibleOf = (i: Invoice) => Math.max(0, dueOf(i) - Math.min(i.disputedCents, dueOf(i)));

export async function loadAccount(tenantId: string, customerId: string, today = new Date()) {
  const t = startOfDay(today);
  await ensureFx();
  const [customer, tenant, invoices, plans, promises, disputes] = await Promise.all([
    db.customer.findFirstOrThrow({ where: { id: customerId, tenantId } }),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    db.invoice.findMany({ where: { tenantId, customerId, status: { notIn: ['paid', 'written_off'] } }, orderBy: { dueDate: 'asc' } }),
    db.paymentPlan.findMany({ where: { tenantId, customerId }, include: { instalments: { orderBy: { seq: 'asc' } } }, orderBy: { createdAt: 'desc' } }),
    db.promiseToPay.findMany({ where: { tenantId, customerId }, orderBy: { createdAt: 'desc' } }),
    db.dispute.findMany({ where: { tenantId, customerId, stage: { notIn: ['resolved', 'rejected'] } } }),
  ]);
  const open = invoices.filter((i) => dueOf(i) > 0);
  const overdue = open.filter((i) => i.dueDate < t);
  return {
    customer, tenant, open, overdue, plans, promises, disputes, today: t,
    // Totals are in the tenant base currency.
    totalDueCents: open.reduce((s, i) => s + toBase(dueOf(i), i.currency, tenant.baseCurrency), 0),
    collectibleCents: open.reduce((s, i) => s + toBase(collectibleOf(i), i.currency, tenant.baseCurrency), 0),
    overdueCents: overdue.reduce((s, i) => s + toBase(collectibleOf(i), i.currency, tenant.baseCurrency), 0),
    maxDpd: Math.max(0, ...open.map((i) => daysBetween(i.dueDate, t))),
    activePlan: plans.find((p) => p.status === 'active') ?? null,
    offeredPlans: plans.filter((p) => p.status === 'offered'),
    openPromise: promises.find((p) => p.status === 'open') ?? null,
  };
}
export type Account = Awaited<ReturnType<typeof loadAccount>>;

export function accountVars(a: Account, invoices: Invoice[] = a.overdue.length ? a.overdue : a.open): Record<string, string> {
  // Amounts in messages are never converted: each currency is stated as invoiced.
  const byCur = new Map<string, number>();
  for (const i of invoices) byCur.set(i.currency, (byCur.get(i.currency) ?? 0) + collectibleOf(i));
  const amountText = [...byCur.entries()].map(([cur, cents]) => money(cents, cur)).join(' + ') || money(0, a.tenant.baseCurrency);
  const maxDpd = Math.max(0, ...invoices.map((i) => daysBetween(i.dueDate, a.today)));
  const am = a.customer.language === 'am';
  const list = invoices.length <= 3 ? invoices.map((i) => i.number).join(', ') : `${invoices.slice(0, 3).map((i) => i.number).join(', ')} +${invoices.length - 3}`;
  return {
    CONTACT: a.customer.contactName || a.customer.name, BUSINESS: a.tenant.name, AMOUNT: amountText,
    INVOICES: am ? `ደረሰኝ ${list}` : `${invoices.length > 1 ? 'invoices' : 'invoice'} ${list}`,
    DUE_PHRASE: maxDpd > 0 ? (am ? `ከተከፈለበት ቀን ${maxDpd} ቀናት አልፏል` : `${invoices.length > 1 ? 'are' : 'is'} now ${maxDpd} day${maxDpd === 1 ? '' : 's'} overdue`) : (am ? 'በቅርቡ የሚከፈል ነው' : `${invoices.length > 1 ? 'are' : 'is'} due soon`),
    PORTAL_LINK: portalLink(a.tenant.id, a.customer.id), DATE: '', PLAN_OPTIONS: '', PLAN_SCHEDULE: '', DETAIL: '',
  };
}

export interface NBA {
  type: 'wait' | 'remind' | 'final_notice' | 'offer_plan' | 'call_task';
  reason: string; expectedValueCents: number; invoices: Invoice[]; selection?: Selection; tone?: string; channel?: 'email' | 'telegram'; window?: string;
}

export async function nextBestAction(tenantId: string, a: Account): Promise<NBA> {
  const c = a.customer, t = a.today;
  const targets = a.open.filter((i) => collectibleOf(i) > 0 && (!i.pausedUntil || i.pausedUntil < t) && i.status !== 'claimed'
    && (i.dueDate < t || (c.segment === 'forgetful' && daysBetween(t, i.dueDate) <= 2)));
  const wait = (reason: string): NBA => ({ type: 'wait', reason, expectedValueCents: 0, invoices: [] });
  if (!a.open.length) return wait('Nothing outstanding.');
  if (!targets.length) {
    if (a.activePlan) return wait('Payment plan is active; reminders follow the plan schedule.');
    if (a.openPromise) return wait(`Customer promised to pay on ${iso(a.openPromise.dueDate)}; reminders are paused until then.`);
    if (a.open.some((i) => i.status === 'claimed')) return wait('Payment claimed; waiting for bank confirmation.');
    if (a.disputes.length && a.collectibleCents === 0) return wait('Whole balance is disputed; the Dispute agent owns this account.');
    return wait('Nothing overdue yet.');
  }
  const value = targets.reduce((s, i) => s + collectibleOf(i), 0);
  const maxDpd = Math.max(0, ...targets.map((i) => daysBetween(i.dueDate, t)));
  const stage = Math.max(0, ...targets.map((i) => i.reminderStage));
  if (c.optOut) return { type: 'call_task', reason: 'Customer opted out of automated messages; a person should call.', expectedValueCents: Math.round(value * 0.3), invoices: targets };

  const recentBreak = a.promises.some((p) => p.status === 'broken' && p.resolvedAt && p.resolvedAt > addDays(t, -14)) || a.plans.some((p) => p.status === 'defaulted');
  // A payment plan is offered before any final notice: it recovers more than escalation for accounts short of cash.
  if (c.segment === 'cash-constrained' && !a.plans.length && maxDpd >= 7) {
    return { type: 'offer_plan', reason: 'Cash-constrained segment, more than a week overdue, and no plan offered yet: a payment plan converts better than another reminder.', expectedValueCents: Math.round(value * 0.5), invoices: targets, tone: 'neutral', channel: c.preferredChannel as any };
  }
  if (stage >= 2 && (maxDpd >= 45 || (recentBreak && maxDpd >= 15))) {
    return { type: 'final_notice', reason: `${maxDpd} days overdue after ${stage} reminders${recentBreak ? ' and a broken commitment' : ''}: final notice, credit hold, and a human call.`, expectedValueCents: Math.round(value * 0.35), invoices: targets, tone: 'firm', channel: c.preferredChannel as any };
  }

  const channels = [c.email ? 'email' : null, c.telegramChatId ? 'telegram' : null].filter(Boolean) as string[];
  if (!channels.length) return { type: 'call_task', reason: 'No email or Telegram contact on file.', expectedValueCents: Math.round(value * 0.3), invoices: targets };
  const stats = await db.strategyArm.findMany({ where: { tenantId, segment: c.segment } });
  const selection = selectArm(stats, { tones: allowedTones(maxDpd), channels, defaultTone: SEGMENT_DEFAULTS[c.segment as Segment]?.tone ?? 'friendly', preferredChannel: c.preferredChannel });
  const p = selection.arm.pulls >= 3 ? selection.mean : 0.25;
  return { type: 'remind', reason: selection.reason, expectedValueCents: Math.round(value * p), invoices: targets, selection, tone: selection.arm.tone, channel: selection.arm.channel as any, window: selection.arm.window };
}

/** Decide and act for one account. `immediate` ignores the send window (manual runs and demos). */
export async function workAccount(tenantId: string, customerId: string, policy: Policy, trace: Trace, opts: { immediate?: boolean } = {}) {
  const a = await loadAccount(tenantId, customerId);
  const nba = await nextBestAction(tenantId, a);
  const c = a.customer;
  await trace.step('Strategist', 'next_best_action', { tool: 'bandit statistics + policy engine',
    input: { customer: c.name, segment: c.segment, riskScore: c.riskScore, overdue: money(a.overdueCents), maxDaysPastDue: a.maxDpd },
    reasoning: nba.reason, output: { action: nba.type, expectedValue: money(nba.expectedValueCents), tone: nba.tone, channel: nba.channel, window: nba.window, candidates: nba.selection?.candidates } });
  if (nba.type === 'wait') return { customer: c.name, action: 'wait', detail: nba.reason };

  if (nba.type === 'call_task') {
    const brief = await callBrief(a);
    await db.interaction.create({ data: { tenantId, customerId, direction: 'internal', channel: 'call', kind: 'brief', subject: `Call brief: ${c.name}`, body: brief, status: 'draft' } });
    await db.approval.create({ data: { tenantId, agent: 'Strategist', actionType: 'call_task', customerId, title: `Call ${c.name}`, reason: nba.reason, payload: { brief }, agentRunId: trace.runId } });
    return { customer: c.name, action: 'call_task', detail: nba.reason };
  }

  const check = canContact(policy, { optOut: c.optOut, contactsToday: await contactsToday(c.id) }, new Date());
  if (!check.ok && !(opts.immediate && check.defer)) {
    await trace.step('Policy engine', 'contact_rules', { input: { customer: c.name }, output: { allowed: false }, reasoning: check.reason });
    return { customer: c.name, action: 'blocked', detail: check.reason };
  }
  if (nba.type === 'remind' && nba.window && !opts.immediate) {
    const [from, to] = WINDOW_HOURS[nba.window];
    const h = hourIn(policy.timezone);
    if (h < from) {
      await trace.step('Strategist', 'schedule', { reasoning: `Chosen send window is ${nba.window} (${from}:00–${to}:00); the reminder is queued for then.`, output: { deferredHours: from - h } });
      return { customer: c.name, action: 'scheduled', detail: `Send window ${nba.window}`, deferHours: from - h };
    }
  }

  if (nba.type === 'offer_plan') {
    const { offerPlans } = await import('./negotiator.js');
    const r = await offerPlans(tenantId, a, policy, trace, { proactive: true });
    return { customer: c.name, action: 'offer_plan', detail: r.detail };
  }

  const kind: MsgKind = nba.type === 'final_notice' ? 'final_notice' : 'reminder';
  const tone = nba.tone ?? 'friendly';
  const memories = await recall(tenantId, customerId, 'payment reminder preferences and past promises', 3);
  const msg = await compose({ customer: c, kind, tone, vars: accountVars(a, nba.invoices), context: memories.join('\n'), trace,
    brief: kind === 'final_notice' ? 'Final notice: state that the account stays on credit hold and will go to formal recovery unless payment or a plan is agreed within 5 days.' : `A ${tone} reminder to pay the overdue invoices, offering the portal for a statement, a payment date, a plan, or proof of payment.` });
  const key = nba.selection ? armKey(nba.selection.arm) : null;
  const actionType = kind === 'final_notice' ? 'send_final_notice' : tone === 'firm' ? 'send_firm_reminder' : 'send_reminder';
  const payload = { customerId, channel: nba.channel ?? 'email', subject: msg.subject, body: msg.body, kind, tone, armKey: key, segment: c.segment, invoiceIds: nba.invoices.map((i) => i.id) };
  const res = await gate(tenantId, policy, { agent: 'Communicator', actionType, customerId, invoiceId: nba.invoices[0]?.id,
    title: `${kind === 'final_notice' ? 'Final notice' : `${tone[0].toUpperCase()}${tone.slice(1)} reminder`} to ${c.name} (${accountVars(a, nba.invoices).AMOUNT})`, reason: nba.reason, payload }, trace);
  if (res === 'execute') await sendOutreach(tenantId, payload, trace);
  if (kind === 'final_notice') {
    const brief = await callBrief(a);
    await db.interaction.create({ data: { tenantId, customerId, direction: 'internal', channel: 'call', kind: 'brief', subject: `Call brief: ${c.name}`, body: brief, status: 'draft' } });
  }
  return { customer: c.name, action: res === 'execute' ? kind : `${kind} (${res})`, detail: nba.reason };
}

export interface OutreachPayload { customerId: string; channel: string; subject: string; body: string; kind: string; tone: string; armKey: string | null; segment: string; invoiceIds: string[] }

/** Deliver an approved or autonomous outreach message and record the strategy pull. */
export async function sendOutreach(tenantId: string, p: OutreachPayload, trace?: Trace) {
  const customer = await db.customer.findFirstOrThrow({ where: { id: p.customerId, tenantId } });
  const it = await deliver({ tenantId, customer, channel: p.channel as any, subject: p.subject, body: p.body, kind: p.kind, tone: p.tone, invoiceId: p.invoiceIds[0], armKey: p.armKey, meta: { segment: p.segment, invoiceIds: p.invoiceIds }, trace });
  if (it.status === 'failed') return it;
  await db.invoice.updateMany({ where: { id: { in: p.invoiceIds }, tenantId }, data: { reminderStage: { increment: 1 }, lastReminderAt: new Date() } });
  if (p.armKey) {
    const [tone, channel, window] = p.armKey.split('|');
    await db.strategyArm.upsert({ where: { tenantId_segment_tone_channel_window: { tenantId, segment: p.segment, tone, channel, window } }, create: { tenantId, segment: p.segment, tone, channel, window, pulls: 1 }, update: { pulls: { increment: 1 } } });
  }
  return it;
}

/** One-page brief for a human call: history, what was promised, suggested script. Deterministic. */
export async function callBrief(a: Account) {
  const c = a.customer;
  const recent = await db.interaction.findMany({ where: { customerId: c.id, channel: { in: ['email', 'telegram', 'portal'] } }, orderBy: { createdAt: 'desc' }, take: 5 });
  const lines = [
    `CALL BRIEF: ${c.name}${c.contactName ? ` (${c.contactName})` : ''}${c.phone ? `, ${c.phone}` : ''}`,
    `Segment: ${c.segment}. Risk score: ${c.riskScore}/100. Credit hold: ${c.creditHold ? 'yes' : 'no'}.`,
    `Outstanding: ${money(a.totalDueCents)} across ${a.open.length} invoice(s); oldest is ${a.maxDpd} days overdue.`,
    ...a.open.slice(0, 6).map((i) => `  - ${i.number}: ${money(dueOf(i), i.currency)} due ${iso(i.dueDate)}${i.disputedCents ? ` (disputed ${money(i.disputedCents, i.currency)})` : ''}`),
    `Promises: ${a.promises.filter((p) => p.status === 'kept').length} kept, ${a.promises.filter((p) => p.status === 'broken').length} broken.`,
    a.plans[0] ? `Latest plan: ${a.plans[0].label} (${a.plans[0].status}).` : 'No payment plan so far.',
    'Recent contact:',
    ...recent.reverse().map((r) => `  ${iso(r.createdAt)} ${r.direction === 'in' ? 'Customer' : 'We'} (${r.channel}): ${r.body.replace(/\s+/g, ' ').slice(0, 110)}`),
    'Suggested script: 1) Confirm they received the statement. 2) Ask what is preventing payment. 3) Agree one dated commitment or a plan within policy. 4) Confirm it in writing through CollectPilot.',
  ];
  return lines.join('\n');
}

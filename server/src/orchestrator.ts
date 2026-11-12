// Orchestrator: event-driven agent loop on a database-backed job queue.
// Events: schedule ticks, inbound messages, proofs, statement imports. Jobs are retried with back-off and de-duplicated.
import fs from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { db, audit } from './db.js';
import { cfg } from './config.js';
import { getPolicy, notifyOwner, type Policy } from './core.js';
import { traced, startRun, type Trace } from './trace.js';
import { checkPromisesAndPlans, forecastFor, kpis, refreshAll } from './agents/analyst.js';
import { accountVars, loadAccount, sendOutreach, workAccount, type OutreachPayload } from './agents/strategist.js';
import { handleInbound, offerPlans, recordPromise, transcribe } from './agents/negotiator.js';
import { acceptProof, handleProof, ingestPaymentEmail, saveUpload } from './agents/reconciler.js';
import { addEvidence, resolveDispute } from './agents/disputes.js';
import { compose } from './agents/communicator.js';
import { applyPayment } from './ledger.js';
import { deliver } from './messaging.js';
import { gmailInbound, gmailSend, googleConnected } from './integrations/google.js';
import { telegramDownload, telegramSend, type TgInbound } from './integrations/telegram.js';
import { addDays, iso, money, startOfDay } from './util.js';

// ---------- Job queue ----------
export async function enqueue(tenantId: string, type: string, payload: object, opts: { dedupeKey?: string; runAfter?: Date } = {}) {
  try { return await db.job.create({ data: { tenantId, type, payload: payload as any, dedupeKey: opts.dedupeKey, runAfter: opts.runAfter ?? new Date() } }); }
  catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null; throw e; } // already queued: idempotent
}

type Handler = (tenantId: string, payload: any) => Promise<unknown>;
const handlers: Record<string, Handler> = {
  'daily.run': (t, p) => dailyCycle(t, p ?? {}),
  'account.work': async (t, p) => traced(t, 'event: scheduled reminder', { customerId: p.customerId }, async (tr) => { const r = await workAccount(t, p.customerId, await getPolicy(t), tr, { immediate: true }); return { summary: `${r.customer}: ${r.action}`, result: r }; }),
  'message.received': (t, p) => inboundMessage(t, p),
  'proof.received': async (t, p) => traced(t, `event: proof of payment (${p.channel})`, { customerId: p.customerId }, async (tr) => {
    const proof = await handleProof(t, p.customerId, { data: await fs.readFile(p.filePath), mimeType: p.mimeType }, p.channel, tr, p.invoiceId);
    return { summary: `Proof of payment ${proof.status}${proof.amountCents ? `: ${money(proof.amountCents)}` : ''}`, result: proof };
  }),
  'evidence.received': async (t, p) => traced(t, 'event: dispute evidence', { customerId: p.customerId }, async (tr) => { await addEvidence(t, p.disputeId, { filePath: p.filePath, mimeType: p.mimeType }, tr); return { summary: 'Evidence attached and resolution re-assessed', result: null }; }),
  'voice.received': async (t, p) => {
    const text = await transcribe(await fs.readFile(p.filePath), p.mimeType);
    if (text) return inboundMessage(t, { customerId: p.customerId, channel: p.channel, text, kind: 'voice', externalId: p.externalId });
    const c = await db.customer.findFirstOrThrow({ where: { id: p.customerId, tenantId: t } });
    await db.interaction.create({ data: { tenantId: t, customerId: c.id, direction: 'in', channel: p.channel, kind: 'voice', body: '[Voice note: could not be transcribed]', status: 'received', externalId: p.externalId, meta: { filePath: p.filePath } } });
    await db.approval.create({ data: { tenantId: t, agent: 'Negotiator', actionType: 'call_task', customerId: c.id, title: `Listen to voice note from ${c.name}`, reason: 'The voice note could not be transcribed automatically.', payload: { filePath: p.filePath } } });
  },
  'inbox.sync': (t) => inboxSync(t),
  'weekly.report': (t) => weeklyReport(t),
};

let working = false;
export function startWorker(intervalMs = 1500) {
  setInterval(async () => {
    if (working) return;
    working = true;
    try {
      for (;;) {
        const job = await db.job.findFirst({ where: { status: 'queued', runAfter: { lte: new Date() } }, orderBy: { createdAt: 'asc' } });
        if (!job) break;
        const claimed = await db.job.updateMany({ where: { id: job.id, status: 'queued' }, data: { status: 'running', attempts: { increment: 1 } } });
        if (!claimed.count) continue;
        try {
          const h = handlers[job.type];
          if (!h) throw new Error(`No handler for ${job.type}`);
          await h(job.tenantId, job.payload);
          await db.job.update({ where: { id: job.id }, data: { status: 'done', finishedAt: new Date(), dedupeKey: job.dedupeKey ? `${job.dedupeKey}#done` : null } }).catch(() => db.job.update({ where: { id: job.id }, data: { status: 'done', finishedAt: new Date() } }));
        } catch (e: any) {
          const attempts = job.attempts + 1, msg = String(e?.message ?? e).slice(0, 500);
          console.error(`[job ${job.type}] attempt ${attempts} failed:`, msg);
          await db.job.update({ where: { id: job.id }, data: attempts >= 3 ? { status: 'failed', lastError: msg, finishedAt: new Date() } : { status: 'queued', lastError: msg, runAfter: new Date(Date.now() + 30_000 * 2 ** (attempts - 1)) } });
        }
      }
    } catch (e) { console.error('[worker]', e); } finally { working = false; }
  }, intervalMs);
}

// ---------- Daily cycle ----------
export async function dailyCycle(tenantId: string, opts: { immediate?: boolean } = {}) {
  return traced(tenantId, opts.immediate ? 'manual: run daily cycle' : 'schedule: daily run', {}, async (trace) => {
    const policy = await getPolicy(tenantId);
    const broken = await checkPromisesAndPlans(tenantId, trace);
    const analysis = await refreshAll(tenantId, trace);
    const instalments = await instalmentReminders(tenantId, trace);

    const customers = await db.customer.findMany({ where: { tenantId, invoices: { some: { status: { notIn: ['paid', 'written_off'] } } } }, orderBy: { riskScore: 'desc' } });
    const results: Awaited<ReturnType<typeof workAccount>>[] = [];
    for (const c of customers) {
      try {
        const r = await workAccount(tenantId, c.id, policy, trace, opts);
        results.push(r);
        if (r.action === 'scheduled' && 'deferHours' in r) await enqueue(tenantId, 'account.work', { customerId: c.id }, { dedupeKey: `work:${c.id}:${iso(new Date())}`, runAfter: new Date(Date.now() + (r.deferHours as number) * 3600_000) });
      } catch (e: any) { await trace.step('Orchestrator', 'account_error', { input: { customer: c.name }, output: { error: String(e?.message ?? e).slice(0, 200) } }); }
    }
    const count = (f: (a: string) => boolean) => results.filter((r) => f(r.action)).length;
    const k = await kpis(tenantId);
    const fc = await forecastFor(tenantId);
    await db.forecastSnapshot.create({ data: { tenantId, weeks: fc.weeks as any } });
    const pending = await db.approval.count({ where: { tenantId, status: 'pending' } });
    const lines = [
      `Outstanding ${money(k.outstanding)}, overdue ${money(k.overdue)} on ${k.overdueCount} invoices. DSO ${k.dso} days.`,
      `Today: ${count((a) => a === 'reminder')} reminders sent, ${count((a) => a === 'offer_plan')} plan offers, ${count((a) => a.includes('queued'))} drafts waiting for approval, ${count((a) => a === 'scheduled')} scheduled for their send window, ${count((a) => a === 'wait')} accounts waiting on a promise, plan, or claim.`,
      broken.length ? `${broken.length} broken promise(s) or missed instalment(s).` : 'No broken promises.',
      instalments ? `${instalments} instalment reminder(s) sent.` : '',
      analysis.holdsPlaced ? `${analysis.holdsPlaced} account(s) placed on credit hold.` : '',
      ...analysis.alerts.map((a) => `Alert: ${a}`),
      `Expected cash next 4 weeks: ${money(fc.weeks.slice(0, 4).reduce((s, w) => s + w.expected, 0))}.`,
      pending ? `${pending} item(s) need your approval.` : '',
    ].filter(Boolean);
    await trace.step('Orchestrator', 'daily_briefing', { tool: cfg.ownerChatId ? 'Telegram Bot API' : 'database', output: { lines } });
    await notifyOwner(tenantId, 'CollectPilot daily briefing', lines.join('\n'));
    return { summary: lines[1], result: { results, briefing: lines, alerts: analysis.alerts } };
  });
}

async function instalmentReminders(tenantId: string, trace: Trace) {
  const t = startOfDay(new Date());
  const due = await db.instalment.findMany({ where: { status: 'due', dueDate: { gte: t, lte: addDays(t, 1) }, plan: { tenantId, status: 'active' } }, include: { plan: true } });
  let n = 0;
  for (const ins of due) {
    if (ins.paidCents >= ins.amountCents) continue;
    const a = await loadAccount(tenantId, ins.plan.customerId);
    if (a.customer.optOut) continue;
    const recent = await db.interaction.findFirst({ where: { customerId: a.customer.id, kind: 'instalment_reminder', createdAt: { gte: addDays(t, -1) } } });
    if (recent) continue;
    const msg = await compose({ customer: a.customer, kind: 'instalment_reminder', tone: 'friendly', vars: { ...accountVars(a), AMOUNT: money(ins.amountCents - ins.paidCents), DATE: iso(ins.dueDate) }, useModel: false });
    await deliver({ tenantId, customer: a.customer, channel: a.customer.preferredChannel as any, subject: msg.subject, body: msg.body, kind: 'instalment_reminder', tone: 'friendly', trace });
    n++;
  }
  return n;
}

// ---------- Inbound ----------
export async function inboundMessage(tenantId: string, p: { customerId: string; channel: 'email' | 'telegram' | 'portal'; text: string; kind?: 'message' | 'voice'; externalId?: string | null; subject?: string }) {
  if (p.externalId && (await db.interaction.findFirst({ where: { tenantId, externalId: p.externalId, direction: 'in' } }))) return { duplicate: true };
  return traced(tenantId, `event: ${p.kind === 'voice' ? 'voice note' : 'message'} received (${p.channel})`, { customerId: p.customerId }, async (trace) => {
    const r = await handleInbound(tenantId, p, await getPolicy(tenantId), trace);
    return { summary: `${r.intent} → ${r.outcome}${r.detail ? `: ${r.detail}` : ''}`, result: r };
  });
}

/** Telegram updates: link chats, route text / photos / voice notes to the right agent. */
export async function onTelegram(m: TgInbound) {
  const start = m.text?.match(/^\/start(?:\s+(\S+))?/);
  if (start) {
    const code = start[1];
    const c = code ? await db.customer.findUnique({ where: { telegramLinkCode: code } }) : null;
    if (c) {
      await db.customer.update({ where: { id: c.id }, data: { telegramChatId: m.chatId, preferredChannel: 'telegram' } });
      await telegramSend(m.chatId, `Thank you. This chat is now linked to the account of ${c.name}. You can reply here, send a photo of a transfer slip, or send a voice note.`);
    } else await telegramSend(m.chatId, `Hello ${m.fromName || ''}. Your chat id is ${m.chatId}. To link this chat to a customer account, use the link from your statement or ask your supplier.`);
    return;
  }
  const c = await db.customer.findFirst({ where: { telegramChatId: m.chatId } });
  if (!c) { await telegramSend(m.chatId, `This chat is not linked to an account yet. Your chat id is ${m.chatId}.`); return; }
  const t = c.tenantId;
  const fileId = m.photoFileId ?? (m.documentMime && /image|pdf/.test(m.documentMime) ? m.documentFileId : undefined);
  if (fileId) {
    const f = await telegramDownload(fileId);
    const mimeType = m.documentMime ?? (f.path.endsWith('.png') ? 'image/png' : 'image/jpeg');
    const dispute = await db.dispute.findFirst({ where: { tenantId: t, customerId: c.id, stage: { in: ['opened', 'evidence'] } }, orderBy: { createdAt: 'desc' } });
    const aboutPayment = /paid|payment|transfer|slip|receipt|deposit|ከፍ/i.test(m.text ?? '');
    const filePath = await saveUpload(t, { data: f.data, mimeType }, dispute && !aboutPayment ? 'evidence' : 'proof');
    if (dispute && !aboutPayment) await enqueue(t, 'evidence.received', { customerId: c.id, disputeId: dispute.id, filePath, mimeType }, { dedupeKey: m.messageId });
    else await enqueue(t, 'proof.received', { customerId: c.id, filePath, mimeType, channel: 'telegram' }, { dedupeKey: m.messageId });
    return;
  }
  if (m.voiceFileId) {
    const f = await telegramDownload(m.voiceFileId);
    const mimeType = m.voiceMime ?? 'audio/ogg';
    const filePath = await saveUpload(t, { data: f.data, mimeType }, 'voice');
    await enqueue(t, 'voice.received', { customerId: c.id, filePath, mimeType, channel: 'telegram', externalId: m.messageId }, { dedupeKey: m.messageId });
    return;
  }
  if (m.text?.trim()) await enqueue(t, 'message.received', { customerId: c.id, channel: 'telegram', text: m.text.trim(), externalId: m.messageId }, { dedupeKey: m.messageId });
}

/** Hourly: read the business mailbox for customer replies and bank payment notifications. */
export async function inboxSync(tenantId: string) {
  const emails = await gmailInbound(tenantId);
  if (!emails) return { connected: false, replies: 0, payments: 0 };
  const key = `gmail:seen:${tenantId}`;
  const seen = new Set<string>(((await db.kV.findUnique({ where: { key } }))?.value as string[] | undefined) ?? []);
  const customers = await db.customer.findMany({ where: { tenantId, email: { not: null } } });
  let replies = 0, payments = 0;
  for (const e of emails.sort((a, b) => a.date.getTime() - b.date.getTime())) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const c = customers.find((x) => x.email?.toLowerCase() === e.fromEmail);
    if (c && e.text) { await enqueue(tenantId, 'message.received', { customerId: c.id, channel: 'email', text: e.text, subject: e.subject, externalId: `gmail:${e.id}` }, { dedupeKey: `gmail:${e.id}` }); replies++; }
    else {
      const tr = await startRun(tenantId, 'event: payment notification email');
      const r = await ingestPaymentEmail(tenantId, e, tr).catch(() => null);
      if (r) { payments++; await tr.finish(`Payment email ${r}`); } else await db.agentRun.delete({ where: { id: tr.runId } }).catch(() => undefined);
    }
  }
  await db.kV.upsert({ where: { key }, create: { key, value: [...seen].slice(-300) }, update: { value: [...seen].slice(-300) } });
  return { connected: true, replies, payments };
}

export async function weeklyReport(tenantId: string) {
  const [k, fc, tenant, owner] = await Promise.all([kpis(tenantId), forecastFor(tenantId), db.tenant.findUniqueOrThrow({ where: { id: tenantId } }), db.user.findFirst({ where: { tenantId, role: 'owner' } })]);
  const body = [
    `Weekly collections report for ${tenant.name}`, '',
    `Outstanding: ${money(k.outstanding)}   Overdue: ${money(k.overdue)}   DSO: ${k.dso} days   Collected this month: ${money(k.collectedMonth)}`,
    `Promise-kept rate: ${k.promiseKeptRate ?? 'n/a'}%   Accounts on credit hold: ${k.customersOnHold}`, '',
    'Aging:', ...k.aging.map((a) => `  ${a.label.padEnd(8)} ${money(a.cents)}`), '',
    '13-week cash forecast (expected / best / worst):', ...fc.weeks.map((w) => `  Week ${String(w.index).padStart(2)} (${w.start}): ${money(w.expected)} / ${money(w.best)} / ${money(w.worst)}`), '',
    'Top risks:', ...k.topRisks.map((r) => `  ${r.name}: risk ${r.riskScore}, overdue ${money(r.overdueCents)} (${r.drivers.map((d: any) => d.label).join(', ')})`),
  ].join('\n');
  let status = 'recorded';
  const to = owner?.email.toLowerCase();
  if (to && (await googleConnected(tenantId)) && (!cfg.demoMode || cfg.allowedEmails.includes(to))) { await gmailSend(tenantId, to, `CollectPilot weekly report: ${iso(new Date())}`, body); status = 'emailed'; }
  await audit(tenantId, 'agent', 'weekly_report', undefined, undefined, { status, body });
  return { status, body };
}

// ---------- Approvals ----------
export async function executeApproval(tenantId: string, approvalId: string, user: string, edits?: { subject?: string; body?: string }) {
  const ap = await db.approval.findFirstOrThrow({ where: { id: approvalId, tenantId, status: { in: ['pending', 'shadow'] } } });
  const p = { ...(ap.payload as any), ...(edits?.body ? { body: edits.body } : {}), ...(edits?.subject ? { subject: edits.subject } : {}) };
  await traced(tenantId, `approval: ${ap.actionType}`, { customerId: ap.customerId, invoiceId: ap.invoiceId }, async (trace) => {
    await trace.step('Human', 'approve', { input: { title: ap.title, by: user, edited: !!(edits?.body || edits?.subject) }, reasoning: 'A person approved this action in the action centre.' });
    const policy: Policy = await getPolicy(tenantId);
    switch (ap.actionType) {
      case 'send_reminder': case 'send_firm_reminder': case 'send_final_notice': await sendOutreach(tenantId, p as OutreachPayload, trace); break;
      case 'reply_customer': { const c = await db.customer.findFirstOrThrow({ where: { id: p.customerId, tenantId } }); await deliver({ tenantId, customer: c, channel: p.channel, subject: p.subject, body: p.body, kind: 'message', tone: 'neutral', trace }); break; }
      case 'record_promise': case 'custom_plan': await recordPromise(tenantId, p, trace); break;
      case 'offer_plan': await offerPlans(tenantId, await loadAccount(tenantId, p.customerId), policy, trace, { approved: true }); break;
      case 'apply_payment': await applyPayment(tenantId, p.paymentId, p.allocations, { actor: user }, trace); break;
      case 'accept_proof': await acceptProof(tenantId, p.proofId, 'portal', trace); break;
      case 'resolve_dispute': await resolveDispute(tenantId, p, user, trace); break;
      case 'credit_hold': await db.customer.update({ where: { id: p.customerId }, data: { creditHold: !!p.hold } }); break;
      case 'opt_out': await db.customer.update({ where: { id: p.customerId }, data: { optOut: true } }); break;
      case 'call_task': break; // a human task: approving marks it done
      default: throw new Error(`Unknown action type ${ap.actionType}`);
    }
    await db.approval.update({ where: { id: ap.id }, data: { status: 'executed', decidedBy: user, decidedAt: new Date(), payload: p } });
    await audit(tenantId, user, 'approval_executed', 'Approval', ap.id, { actionType: ap.actionType, edited: !!(edits?.body || edits?.subject) });
    return { summary: `Approved: ${ap.title}`, result: null };
  });
}

export async function rejectApproval(tenantId: string, approvalId: string, user: string, note?: string) {
  const ap = await db.approval.findFirstOrThrow({ where: { id: approvalId, tenantId, status: { in: ['pending', 'shadow'] } } });
  await db.approval.update({ where: { id: ap.id }, data: { status: 'rejected', decidedBy: user, decidedAt: new Date() } });
  await audit(tenantId, user, 'approval_rejected', 'Approval', ap.id, { actionType: ap.actionType, note });
}

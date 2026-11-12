// Customer self-service portal. No login: the signed, expiring token identifies exactly one customer.
// Every action feeds the same agent loop as a message would.
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { cfg } from '../config.js';
import { db } from '../db.js';
import { h } from '../auth.js';
import { getPolicy, verifyPortal } from '../core.js';
import { collectibleOf, loadAccount } from '../agents/strategist.js';
import { activatePlan, offerPlans, recordPromise } from '../agents/negotiator.js';
import { handleProof, saveUpload } from '../agents/reconciler.js';
import { openDispute, addEvidence, CATEGORIES } from '../agents/disputes.js';
import { inboundMessage } from '../orchestrator.js';
import { traced } from '../trace.js';
import { addDays, daysBetween, iso, parseDateLoose } from '../util.js';
import { upload } from './api.js';

export const portal = Router();

// Simple per-token rate limit for an unauthenticated surface.
const hits = new Map<string, { n: number; at: number }>();
portal.use('/:token', (req, res, next) => {
  const who = verifyPortal(req.params.token);
  if (!who) return res.status(401).json({ error: 'This link is invalid or has expired. Please ask for a new one.' });
  const k = who.cid, now = Date.now(), e = hits.get(k);
  if (!e || now - e.at > 60_000) hits.set(k, { n: 1, at: now });
  else if (++e.n > 40) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  (req as any).who = who;
  next();
});
const W = (req: any) => req.who as { tid: string; cid: string };

portal.get('/:token', h(async (req, res) => {
  const { tid, cid } = W(req);
  const a = await loadAccount(tid, cid);
  const policy = await getPolicy(tid);
  const [disputes, proofs, paid] = await Promise.all([
    db.dispute.findMany({ where: { tenantId: tid, customerId: cid }, orderBy: { createdAt: 'desc' }, take: 10 }),
    db.paymentProof.findMany({ where: { tenantId: tid, customerId: cid }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, amountCents: true, status: true, createdAt: true, reference: true } }),
    db.invoice.findMany({ where: { tenantId: tid, customerId: cid, status: 'paid' }, orderBy: { paidAt: 'desc' }, take: 5 }),
  ]);
  // Only what this customer needs to see: no risk score, segment, or internal notes.
  res.json({
    business: a.tenant.name, customer: { name: a.customer.name, contactName: a.customer.contactName, language: a.customer.language }, currency: a.open[0]?.currency ?? a.tenant.baseCurrency,
    totals: { due: a.totalDueCents, overdue: a.overdueCents },
    invoices: a.open.map((i) => ({ id: i.id, number: i.number, issueDate: iso(i.issueDate), dueDate: iso(i.dueDate), amountCents: i.amountCents, paidCents: i.paidCents, disputedCents: i.disputedCents, status: i.status, daysOverdue: Math.max(0, daysBetween(i.dueDate, a.today)), currency: i.currency })),
    recentlyPaid: paid.map((i) => ({ number: i.number, amountCents: i.amountCents, paidAt: i.paidAt ? iso(i.paidAt) : null })),
    promise: a.openPromise ? { amountCents: a.openPromise.amountCents, dueDate: iso(a.openPromise.dueDate) } : null,
    activePlan: a.activePlan ? { label: a.activePlan.label, instalments: a.activePlan.instalments.map((i) => ({ seq: i.seq, dueDate: iso(i.dueDate), amountCents: i.amountCents, paidCents: i.paidCents, status: i.status })) } : null,
    offeredPlans: a.offeredPlans.filter((p) => p.offerGroup === a.offeredPlans[0]?.offerGroup).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((p) => ({ id: p.id, label: p.label, totalCents: p.totalCents, discountCents: p.discountCents, instalments: p.instalments.map((i) => ({ seq: i.seq, dueDate: iso(i.dueDate), amountCents: i.amountCents })) })),
    disputes: disputes.map((d) => ({ id: d.id, category: d.category, stage: d.stage, disputedCents: d.disputedCents, invoiceId: d.invoiceId, createdAt: iso(d.createdAt), evidenceCount: ((d.evidence as any[]) ?? []).length })),
    proofs: proofs.map((p) => ({ ...p, createdAt: iso(p.createdAt) })),
    limits: { latestPromiseDate: iso(addDays(a.today, policy.maxPlanDays)), disputeCategories: CATEGORIES },
  });
}));

portal.post('/:token/promise', h(async (req, res) => {
  const { tid, cid } = W(req);
  const b = z.object({ date: z.string() }).parse(req.body);
  const date = parseDateLoose(b.date), a = await loadAccount(tid, cid), policy = await getPolicy(tid);
  if (!date || date < a.today) return res.status(400).json({ error: 'Choose a date from today onwards.' });
  if (daysBetween(a.today, date) > policy.maxPlanDays) return res.status(400).json({ error: `Please choose a date on or before ${iso(addDays(a.today, policy.maxPlanDays))}, or request a payment plan.` });
  const invs = a.open.filter((i) => collectibleOf(i) > 0);
  const amountCents = invs.reduce((s, i) => s + collectibleOf(i), 0);
  if (!amountCents) return res.status(400).json({ error: 'Nothing is outstanding.' });
  await traced(tid, 'event: portal promise', { customerId: cid }, async (tr) => {
    await db.interaction.create({ data: { tenantId: tid, customerId: cid, direction: 'in', channel: 'portal', kind: 'message', body: `Promised in the portal to pay by ${iso(date)}.`, intent: 'promise_to_pay', status: 'received' } });
    await recordPromise(tid, { customerId: cid, amountCents, dueDate: iso(date), invoiceIds: invs.map((i) => i.id), source: 'portal' }, tr);
    return { summary: `Portal promise for ${iso(date)}`, result: null };
  });
  res.json({ ok: true });
}));

portal.post('/:token/request-plan', h(async (req, res) => {
  const { tid, cid } = W(req);
  const r = await traced(tid, 'event: portal plan request', { customerId: cid }, async (tr) => {
    await db.interaction.create({ data: { tenantId: tid, customerId: cid, direction: 'in', channel: 'portal', kind: 'message', body: 'Asked for payment plan options in the portal.', intent: 'request_plan', status: 'received' } });
    const o = await offerPlans(tid, await loadAccount(tid, cid), await getPolicy(tid), tr);
    return { summary: o.detail, result: o };
  });
  res.json(r);
}));

portal.post('/:token/plan', h(async (req, res) => {
  const { tid, cid } = W(req);
  const b = z.object({ planId: z.string() }).parse(req.body);
  await db.paymentPlan.findFirstOrThrow({ where: { id: b.planId, tenantId: tid, customerId: cid, status: 'offered' } });
  await traced(tid, 'event: portal plan accepted', { customerId: cid }, async (tr) => {
    const p = await activatePlan(tid, b.planId, 'portal', tr);
    await db.interaction.create({ data: { tenantId: tid, customerId: cid, direction: 'in', channel: 'portal', kind: 'message', body: `Chose payment plan "${p.label}" in the portal.`, intent: 'accept_plan', status: 'received' } });
    return { summary: `Plan accepted: ${p.label}`, result: null };
  });
  res.json({ ok: true });
}));

portal.post('/:token/proof', upload.single('file'), h(async (req, res) => {
  const { tid, cid } = W(req);
  if (!req.file || !/^(image\/|application\/pdf)/.test(req.file.mimetype)) return res.status(400).json({ error: 'Attach a photo or PDF of the transfer slip.' });
  const invoiceId = typeof req.body.invoiceId === 'string' && req.body.invoiceId ? req.body.invoiceId : null;
  const p = await traced(tid, 'event: proof of payment (portal)', { customerId: cid }, async (tr) => {
    const proof = await handleProof(tid, cid, { data: req.file!.buffer, mimeType: req.file!.mimetype, name: req.file!.originalname }, 'portal', tr, invoiceId);
    return { summary: `Proof of payment ${proof.status}`, result: proof };
  });
  res.json({ status: p.status, amountCents: p.amountCents, reference: p.reference });
}));

portal.post('/:token/dispute', upload.array('files', 3), h(async (req, res) => {
  const { tid, cid } = W(req);
  const b = z.object({ invoiceId: z.string(), category: z.enum(CATEGORIES as [string, ...string[]]), text: z.string().min(5).max(2000), amount: z.coerce.number().positive().optional() }).parse(req.body);
  await db.invoice.findFirstOrThrow({ where: { id: b.invoiceId, tenantId: tid, customerId: cid } });
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const evidence = [] as { filePath: string; mimeType: string }[];
  for (const f of files) evidence.push({ filePath: await saveUpload(tid, { data: f.buffer, mimeType: f.mimetype, name: f.originalname }, 'evidence'), mimeType: f.mimetype });
  const r = await traced(tid, 'event: portal dispute', { customerId: cid, invoiceId: b.invoiceId }, async (tr) => {
    await db.interaction.create({ data: { tenantId: tid, customerId: cid, invoiceId: b.invoiceId, direction: 'in', channel: 'portal', kind: 'message', body: `Raised a ${b.category} dispute in the portal: ${b.text}`, intent: 'dispute', status: 'received' } });
    const o = await openDispute(tid, await loadAccount(tid, cid), { ...b, evidence }, await getPolicy(tid), tr);
    return { summary: o.detail, result: o.detail };
  });
  res.json({ ok: true, detail: r });
}));

portal.post('/:token/dispute/:id/evidence', upload.single('file'), h(async (req, res) => {
  const { tid, cid } = W(req);
  if (!req.file) return res.status(400).json({ error: 'Attach a file.' });
  await db.dispute.findFirstOrThrow({ where: { id: req.params.id, tenantId: tid, customerId: cid } });
  const filePath = await saveUpload(tid, { data: req.file.buffer, mimeType: req.file.mimetype, name: req.file.originalname }, 'evidence');
  await traced(tid, 'event: dispute evidence (portal)', { customerId: cid }, async (tr) => { await addEvidence(tid, req.params.id, { filePath, mimeType: req.file!.mimetype }, tr); return { summary: 'Evidence attached', result: null }; });
  res.json({ ok: true });
}));

portal.post('/:token/message', h(async (req, res) => {
  const { tid, cid } = W(req);
  const b = z.object({ text: z.string().min(2).max(2000) }).parse(req.body);
  const r: any = await inboundMessage(tid, { customerId: cid, channel: 'portal', text: b.text });
  res.json({ ok: true, outcome: r?.outcome ?? null });
}));

// Invoice lines for the statement view.
portal.get('/:token/invoice/:id', h(async (req, res) => {
  const { tid, cid } = W(req);
  const inv = await db.invoice.findFirstOrThrow({ where: { id: req.params.id, tenantId: tid, customerId: cid }, include: { lines: true } });
  res.json({ number: inv.number, issueDate: iso(inv.issueDate), dueDate: iso(inv.dueDate), amountCents: inv.amountCents, paidCents: inv.paidCents, currency: inv.currency, lines: inv.lines });
}));

export { fs, path, cfg };

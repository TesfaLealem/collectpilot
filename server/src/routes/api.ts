// Owner / AR-team API. Every query is scoped to the tenant from the signed session token.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { cfg } from '../config.js';
import { db, audit } from '../db.js';
import { h, requireAuth, signToken, writeGuard } from '../auth.js';
import { getPolicy, portalLink } from '../core.js';
import { ACTION_TYPES } from '../engines/policy.js';
import { SEGMENTS } from '../engines/risk.js';
import { allArms, armKey } from '../engines/bandit.js';
import { forecastFor, kpis, limitAdvice, refreshAll, roi } from '../agents/analyst.js';
import { loadAccount, nextBestAction, workAccount } from '../agents/strategist.js';
import { importStatement, processPayment, acceptProof, saveUpload } from '../agents/reconciler.js';
import { openDispute, addEvidence, proposeResolution } from '../agents/disputes.js';
import { copilot, runCreditCheck, whatIf, type PlanStep } from '../agents/copilot.js';
import { extractInvoice, parseInvoiceCsv, parseInvoiceSheet, saveInvoices } from '../agents/intake.js';
import { offerPlans } from '../agents/negotiator.js';
import { recall } from '../agents/memory.js';
import { applyPayment } from '../ledger.js';
import { dailyCycle, executeApproval, inboundMessage, inboxSync, rejectApproval, weeklyReport } from '../orchestrator.js';
import { traced } from '../trace.js';
import { authUrl, googleConfigured, googleConnected, handleCallback, sheetsRead } from '../integrations/google.js';
import { botUsername, telegramConfigured } from '../integrations/telegram.js';
import { ensureFx, rates, toBase } from '../integrations/fx.js';
import { llmAvailable, llmStats } from '../llm/gemini.js';
import { parseDateLoose, startOfDay, toCents } from '../util.js';

const ALLOWED_UPLOAD = /^(image\/(jpeg|png|webp|heic)|application\/pdf|text\/csv|text\/plain|application\/vnd\.ms-excel|audio\/(ogg|mpeg|mp4|wav|webm))$/;
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 4 },
  fileFilter: (_req, file, cb) => (ALLOWED_UPLOAD.test(file.mimetype) ? cb(null, true) : cb(new Error(`File type ${file.mimetype} is not allowed`))) });

export const api = Router();

// ---------- Public: login and OAuth callback ----------
api.post('/auth/login', h(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const u = await db.user.findUnique({ where: { email: email.toLowerCase() }, include: { tenant: true } });
  if (!u || !(await bcrypt.compare(password, u.passwordHash))) return res.status(401).json({ error: 'Wrong email or password' });
  const user = { uid: u.id, tid: u.tenantId, role: u.role as any, name: u.name, email: u.email };
  res.json({ token: signToken(user), user, tenant: { name: u.tenant.name, baseCurrency: u.tenant.baseCurrency } });
}));

api.get('/google/callback', h(async (req, res) => {
  await handleCallback(String(req.query.code ?? ''), String(req.query.state ?? ''));
  res.redirect(`${cfg.publicUrl}/settings?google=connected`);
}));

api.use(requireAuth, writeGuard);
const T = (req: { user: { tid: string } }) => req.user.tid;

api.get('/me', h(async (req, res) => { const t = await db.tenant.findUniqueOrThrow({ where: { id: T(req) } }); res.json({ user: req.user, tenant: { name: t.name, baseCurrency: t.baseCurrency } }); }));

api.get('/status', h(async (req, res) => res.json({
  gemini: { configured: llmAvailable(), model: cfg.geminiModel, ...llmStats },
  telegram: { configured: telegramConfigured(), bot: await botUsername(), ownerChat: !!cfg.ownerChatId },
  google: { configured: googleConfigured(), connected: await googleConnected(T(req)) },
  demoMode: cfg.demoMode, allowedEmails: cfg.allowedEmails.length, allowedChats: cfg.allowedChats.length,
  fx: await rates().then((r) => ({ asOf: r.asOf, live: r.live, ETB: r.rates.ETB, EUR: r.rates.EUR })),
  jobs: { queued: await db.job.count({ where: { tenantId: T(req), status: 'queued' } }), failed: await db.job.count({ where: { tenantId: T(req), status: 'failed' } }) },
})));
api.get('/google/auth-url', h(async (req, res) => { if (!googleConfigured()) return res.status(400).json({ error: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env first' }); res.json({ url: authUrl(T(req)) }); }));
api.post('/google/disconnect', h(async (req, res) => { await db.$executeRaw`UPDATE "Tenant" SET "googleTokens" = NULL WHERE id = ${T(req)}`; res.json({ ok: true }); }));

// ---------- Dashboard ----------
api.get('/dashboard', h(async (req, res) => {
  const t = T(req);
  const [k, r, fc, pending, runs, briefing] = await Promise.all([kpis(t), roi(t), forecastFor(t), db.approval.count({ where: { tenantId: t, status: 'pending' } }),
    db.agentRun.findMany({ where: { tenantId: t }, orderBy: { startedAt: 'desc' }, take: 8 }), db.auditLog.findFirst({ where: { tenantId: t, action: 'owner_notification' }, orderBy: { createdAt: 'desc' } })]);
  res.json({ kpis: k, roi: r, forecast: { weeks: fc.weeks, totals: fc.totals }, pendingApprovals: pending, recentRuns: runs, briefing });
}));
api.get('/forecast', h(async (req, res) => {
  const t = T(req), cid = String(req.query.customerId ?? ''), days = Number(req.query.days ?? 0);
  if (cid && days) return res.json({ ...(await forecastFor(t, { [cid]: days })), whatIf: await whatIf(t, cid, days) });
  res.json(await forecastFor(t));
}));
api.get('/roi', h(async (req, res) => res.json(await roi(T(req)))));
api.get('/fx', h(async (_req, res) => res.json(await rates())));

// ---------- Customers ----------
api.get('/customers', h(async (req, res) => {
  const t = T(req), today = startOfDay(new Date());
  await ensureFx();
  const base = (await db.tenant.findUniqueOrThrow({ where: { id: t } })).baseCurrency;
  const cs = await db.customer.findMany({ where: { tenantId: t }, include: { invoices: { where: { status: { notIn: ['paid', 'written_off'] } } } }, orderBy: { riskScore: 'desc' } });
  const due = (i: { amountCents: number; paidCents: number; currency: string }) => toBase(i.amountCents - i.paidCents, i.currency, base);
  res.json(cs.map(({ invoices, ...c }) => ({ ...c, openInvoices: invoices.length, outstandingCents: invoices.reduce((s, i) => s + due(i), 0), overdueCents: invoices.filter((i) => i.dueDate < today).reduce((s, i) => s + due(i), 0) })));
}));
api.post('/customers', h(async (req, res) => {
  const b = z.object({ name: z.string().min(2), contactName: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional(), language: z.enum(['en', 'am']).default('en'), creditLimit: z.number().nonnegative().default(0), termsDays: z.number().int().min(0).max(180).default(30) }).parse(req.body);
  const c = await db.customer.create({ data: { tenantId: T(req), name: b.name, contactName: b.contactName, email: b.email?.toLowerCase(), phone: b.phone, language: b.language, creditLimitCents: Math.round(b.creditLimit * 100), termsDays: b.termsDays, telegramLinkCode: Math.random().toString(36).slice(2, 10) } });
  await audit(T(req), req.user.email, 'customer_created', 'Customer', c.id);
  res.json(c);
}));
api.get('/customers/:id', h(async (req, res) => {
  const t = T(req), id = req.params.id;
  const acc = await loadAccount(t, id);
  const [invoices, interactions, proofs, disputes, payments, advice, memories, bot] = await Promise.all([
    db.invoice.findMany({ where: { tenantId: t, customerId: id }, orderBy: { dueDate: 'desc' }, include: { lines: true } }),
    db.interaction.findMany({ where: { tenantId: t, customerId: id }, orderBy: { createdAt: 'desc' }, take: 80 }),
    db.paymentProof.findMany({ where: { tenantId: t, customerId: id }, orderBy: { createdAt: 'desc' } }),
    db.dispute.findMany({ where: { tenantId: t, customerId: id }, orderBy: { createdAt: 'desc' } }),
    db.payment.findMany({ where: { tenantId: t, customerId: id }, orderBy: { date: 'desc' }, take: 20, include: { allocations: { include: { invoice: { select: { number: true } } } } } }),
    limitAdvice(t, id), db.memory.findMany({ where: { tenantId: t, customerId: id }, orderBy: { createdAt: 'desc' }, take: 12, select: { id: true, text: true, kind: true, createdAt: true } }), botUsername(),
  ]);
  const nba = await nextBestAction(t, acc);
  res.json({ customer: acc.customer, totals: { due: acc.totalDueCents, overdue: acc.overdueCents, collectible: acc.collectibleCents, maxDpd: acc.maxDpd }, invoices, interactions, promises: acc.promises, plans: acc.plans, disputes, proofs, payments, memories,
    nextBestAction: { type: nba.type, reason: nba.reason, expectedValueCents: nba.expectedValueCents, tone: nba.tone, channel: nba.channel, window: nba.window, candidates: nba.selection?.candidates },
    creditLimitAdvice: advice, portalLink: portalLink(t, id), telegramLink: bot && acc.customer.telegramLinkCode ? `https://t.me/${bot}?start=${acc.customer.telegramLinkCode}` : null });
}));
api.patch('/customers/:id', h(async (req, res) => {
  const b = z.object({ contactName: z.string().nullish(), email: z.string().email().nullish(), phone: z.string().nullish(), language: z.enum(['en', 'am']).optional(), preferredChannel: z.enum(['email', 'telegram']).optional(), creditLimitCents: z.number().int().nonnegative().optional(), optOut: z.boolean().optional(), creditHold: z.boolean().optional(), telegramChatId: z.string().nullish() }).parse(req.body);
  const r = await db.customer.updateMany({ where: { id: req.params.id, tenantId: T(req) }, data: { ...b, email: b.email?.toLowerCase() } });
  if (!r.count) return res.status(404).json({ error: 'Not found' });
  await audit(T(req), req.user.email, 'customer_updated', 'Customer', req.params.id, b);
  res.json(await db.customer.findUnique({ where: { id: req.params.id } }));
}));
// Demo helper: act as the customer. Runs the same code path as a real Telegram / email message.
api.post('/customers/:id/simulate-message', h(async (req, res) => {
  const b = z.object({ text: z.string().min(1).max(2000), channel: z.enum(['email', 'telegram']).default('telegram') }).parse(req.body);
  await db.customer.findFirstOrThrow({ where: { id: req.params.id, tenantId: T(req) } });
  res.json(await inboundMessage(T(req), { customerId: req.params.id, channel: b.channel, text: b.text }));
}));
api.post('/customers/:id/simulate-proof', upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach an image' });
  await db.customer.findFirstOrThrow({ where: { id: req.params.id, tenantId: T(req) } });
  const { handleProof } = await import('../agents/reconciler.js');
  res.json(await traced(T(req), 'event: proof of payment (telegram)', { customerId: req.params.id }, async (tr) => { const p = await handleProof(T(req), req.params.id, { data: req.file!.buffer, mimeType: req.file!.mimetype, name: req.file!.originalname }, 'telegram', tr); return { summary: `Proof of payment ${p.status}`, result: p }; }));
}));
api.post('/customers/:id/work', h(async (req, res) => {
  const t = T(req);
  res.json(await traced(t, 'manual: work account', { customerId: req.params.id }, async (tr) => { await refreshAll(t, tr); const r = await workAccount(t, req.params.id, await getPolicy(t), tr, { immediate: true }); return { summary: `${r.customer}: ${r.action}`, result: r }; }));
}));
api.post('/customers/:id/offer-plan', h(async (req, res) => {
  const t = T(req);
  res.json(await traced(t, 'manual: offer plan', { customerId: req.params.id }, async (tr) => { const r = await offerPlans(t, await loadAccount(t, req.params.id), await getPolicy(t), tr, { approved: true }); return { summary: r.detail, result: r }; }));
}));
api.get('/customers/:id/recall', h(async (req, res) => res.json(await recall(T(req), req.params.id, String(req.query.q ?? 'payment'), 5))));

// ---------- Invoices and documents ----------
api.get('/invoices', h(async (req, res) => {
  const status = String(req.query.status ?? 'open');
  const where: any = { tenantId: T(req) };
  if (status === 'open') where.status = { notIn: ['paid', 'written_off'] }; else if (status !== 'all') where.status = status;
  res.json(await db.invoice.findMany({ where, include: { customer: { select: { name: true, segment: true, riskScore: true } } }, orderBy: { dueDate: 'asc' }, take: 500 }));
}));
api.post('/invoices', h(async (req, res) => {
  const b = z.object({ customerId: z.string(), number: z.string().min(1), issueDate: z.string(), dueDate: z.string(), amount: z.number().positive(), currency: z.string().length(3).optional(), lines: z.array(z.object({ description: z.string(), quantity: z.number(), unitPrice: z.number(), total: z.number() })).optional(), source: z.string().optional() }).parse(req.body);
  const t = T(req);
  const [c, tenant] = await Promise.all([db.customer.findFirstOrThrow({ where: { id: b.customerId, tenantId: t } }), db.tenant.findUniqueOrThrow({ where: { id: t } })]);
  const issue = parseDateLoose(b.issueDate), due = parseDateLoose(b.dueDate);
  if (!issue || !due) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  if (await db.invoice.findUnique({ where: { tenantId_number: { tenantId: t, number: b.number } } })) return res.status(409).json({ error: `Invoice ${b.number} already exists` });
  const inv = await db.invoice.create({ data: { tenantId: t, customerId: c.id, number: b.number, issueDate: issue, dueDate: due, amountCents: Math.round(b.amount * 100), currency: (b.currency ?? tenant.baseCurrency).toUpperCase(), source: b.source ?? 'manual',
    lines: b.lines?.length ? { create: b.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitCents: Math.round(l.unitPrice * 100), totalCents: Math.round(l.total * 100) })) } : undefined } });
  await audit(t, req.user.email, 'invoice_created', 'Invoice', inv.id, { source: inv.source });
  res.json(inv);
}));
api.post('/invoices/import-csv', upload.single('file'), h(async (req, res) => {
  const csv = req.file ? req.file.buffer.toString('utf8') : String(req.body.csv ?? '');
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: T(req) } });
  const { rows, errors } = parseInvoiceCsv(csv, tenant.baseCurrency);
  const r = await saveInvoices(T(req), rows, 'csv');
  await audit(T(req), req.user.email, 'invoices_imported', undefined, undefined, { ...r, errors: errors.length });
  await refreshAll(T(req));
  res.json({ ...r, errors });
}));
api.post('/invoices/import-sheet', h(async (req, res) => {
  const b = z.object({ spreadsheetId: z.string().min(10), range: z.string().default('A1:Z1000') }).parse(req.body);
  const id = b.spreadsheetId.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? b.spreadsheetId;
  const values = await sheetsRead(T(req), id, b.range);
  if (!values) return res.status(400).json({ error: 'Connect Google in Settings first' });
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: T(req) } });
  const { rows, errors } = parseInvoiceSheet(values, tenant.baseCurrency);
  const r = await saveInvoices(T(req), rows, 'sheet');
  await refreshAll(T(req));
  res.json({ ...r, errors });
}));
api.post('/documents/extract', upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a PDF or photo' });
  const filePath = await saveUpload(T(req), { data: req.file.buffer, mimeType: req.file.mimetype, name: req.file.originalname }, 'invoice');
  const r = await extractInvoice(T(req), req.file.buffer, req.file.mimetype);
  const doc = await db.document.create({ data: { tenantId: T(req), kind: 'invoice', filePath, mimeType: req.file.mimetype, extracted: (r.ok ? r.fields : null) as any, status: r.ok ? 'extracted' : 'new' } });
  res.json({ ...r, documentId: doc.id, filePath });
}));

// Uploaded files (proofs, evidence, invoices). Tenant-checked: files live under uploads/<tenantId>/.
api.get('/files', h(async (req, res) => {
  const rel = String(req.query.path ?? '');
  const base = path.resolve(cfg.uploadDir, T(req)), full = path.resolve(rel);
  if (!full.startsWith(base + path.sep)) return res.status(403).json({ error: 'Forbidden' });
  await fs.access(full);
  res.sendFile(full);
}));

// ---------- Payments and reconciliation ----------
api.get('/payments', h(async (req, res) => res.json(await db.payment.findMany({ where: { tenantId: T(req) }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 300, include: { customer: { select: { name: true } }, allocations: { include: { invoice: { select: { number: true } } } } } }))));
api.post('/reconciliation/statement', upload.single('file'), h(async (req, res) => {
  const csv = req.file ? req.file.buffer.toString('utf8') : String(req.body.csv ?? '');
  if (!csv.trim()) return res.status(400).json({ error: 'Attach a CSV bank statement' });
  const t = T(req);
  res.json(await traced(t, 'event: bank statement uploaded', {}, async (tr) => { const s = await importStatement(t, csv, tr); await refreshAll(t); return { summary: `${s.imported} payments: ${s.matched} applied, ${s.suggested} suggested, ${s.unmatched} unmatched, ${s.duplicates} duplicates skipped`, result: s }; }));
}));
api.post('/payments/manual', h(async (req, res) => {
  const b = z.object({ customerId: z.string().optional(), amount: z.number().positive(), date: z.string(), reference: z.string().optional(), narration: z.string().optional() }).parse(req.body);
  const t = T(req);
  const p = await db.payment.create({ data: { tenantId: t, customerId: b.customerId, amountCents: Math.round(b.amount * 100), date: parseDateLoose(b.date) ?? startOfDay(new Date()), reference: b.reference, narration: b.narration, source: 'manual' } });
  res.json(await traced(t, 'manual: payment recorded', { customerId: b.customerId }, async (tr) => { const s = await processPayment(t, p.id, await getPolicy(t), tr); await refreshAll(t); return { summary: `Payment ${s}`, result: { status: s, paymentId: p.id } }; }));
}));
api.post('/payments/:id/apply', h(async (req, res) => {
  const b = z.object({ allocations: z.array(z.object({ invoiceId: z.string(), amountCents: z.number().int().positive() })).min(1) }).parse(req.body);
  const t = T(req);
  await traced(t, 'manual: payment match confirmed', {}, async (tr) => { await tr.step('Human', 'confirm_match', { input: { by: req.user.email, allocations: b.allocations.length } }); await applyPayment(t, req.params.id, b.allocations, { actor: req.user.email, reason: 'Confirmed by a person' }, tr); await refreshAll(t); return { summary: 'Payment applied after human confirmation', result: null }; });
  res.json({ ok: true });
}));
api.get('/proofs', h(async (req, res) => {
  const proofs = await db.paymentProof.findMany({ where: { tenantId: T(req) }, orderBy: { createdAt: 'desc' }, take: 100 });
  const cs = await db.customer.findMany({ where: { id: { in: proofs.map((p) => p.customerId) } }, select: { id: true, name: true } });
  const inv = await db.invoice.findMany({ where: { id: { in: proofs.map((p) => p.invoiceId).filter(Boolean) as string[] } }, select: { id: true, number: true } });
  res.json(proofs.map((p) => ({ ...p, customerName: cs.find((c) => c.id === p.customerId)?.name, invoiceNumber: inv.find((i) => i.id === p.invoiceId)?.number })));
}));
api.post('/proofs/:id/accept', h(async (req, res) => { const t = T(req); await traced(t, 'manual: proof accepted', {}, async (tr) => { await acceptProof(t, req.params.id, 'portal', tr); return { summary: 'Proof accepted by a person', result: null }; }); res.json({ ok: true }); }));
api.post('/proofs/:id/reject', h(async (req, res) => {
  const p = await db.paymentProof.findFirstOrThrow({ where: { id: req.params.id, tenantId: T(req) } });
  await db.paymentProof.update({ where: { id: p.id }, data: { status: 'rejected' } });
  if (p.invoiceId) { const inv = await db.invoice.findUnique({ where: { id: p.invoiceId } }); if (inv?.status === 'claimed') await db.invoice.update({ where: { id: inv.id }, data: { status: inv.paidCents > 0 ? 'partial' : 'open', pausedUntil: null } }); }
  await audit(T(req), req.user.email, 'proof_rejected', 'PaymentProof', p.id);
  res.json({ ok: true });
}));

// ---------- Plans, promises, disputes, credit ----------
api.get('/plans', h(async (req, res) => res.json(await db.paymentPlan.findMany({ where: { tenantId: T(req), status: { not: 'cancelled' } }, include: { instalments: { orderBy: { seq: 'asc' } }, customer: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }))));
api.get('/promises', h(async (req, res) => res.json(await db.promiseToPay.findMany({ where: { tenantId: T(req) }, include: { customer: { select: { name: true } } }, orderBy: { dueDate: 'desc' }, take: 200 }))));
api.get('/disputes', h(async (req, res) => {
  const ds = await db.dispute.findMany({ where: { tenantId: T(req) }, include: { customer: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
  const inv = await db.invoice.findMany({ where: { id: { in: ds.map((d) => d.invoiceId) } }, select: { id: true, number: true, currency: true, amountCents: true } });
  const notes = await db.creditNote.findMany({ where: { tenantId: T(req) } });
  res.json(ds.map((d) => ({ ...d, invoice: inv.find((i) => i.id === d.invoiceId), creditNote: notes.find((n) => n.id === d.creditNoteId) ?? null })));
}));
api.post('/disputes', h(async (req, res) => {
  const b = z.object({ customerId: z.string(), invoiceId: z.string(), category: z.string(), text: z.string().min(3), amount: z.number().positive().optional() }).parse(req.body);
  const t = T(req);
  res.json(await traced(t, 'manual: dispute logged', { customerId: b.customerId, invoiceId: b.invoiceId }, async (tr) => { const r = await openDispute(t, await loadAccount(t, b.customerId), b, await getPolicy(t), tr); return { summary: r.detail, result: r.dispute }; }));
}));
api.post('/disputes/:id/evidence', upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a file' });
  const t = T(req);
  const filePath = await saveUpload(t, { data: req.file.buffer, mimeType: req.file.mimetype, name: req.file.originalname }, 'evidence');
  await traced(t, 'manual: evidence added', {}, async (tr) => { await addEvidence(t, req.params.id, { filePath, mimeType: req.file!.mimetype }, tr); return { summary: 'Evidence attached', result: null }; });
  res.json({ ok: true });
}));
api.post('/disputes/:id/propose', h(async (req, res) => { const t = T(req); res.json(await traced(t, 'manual: re-assess dispute', {}, async (tr) => ({ summary: 'Resolution re-assessed', result: await proposeResolution(t, req.params.id, await getPolicy(t), tr) }))); }));
api.post('/credit-check', h(async (req, res) => {
  const b = z.object({ customerId: z.string(), orderAmount: z.number().positive() }).parse(req.body);
  await db.customer.findFirstOrThrow({ where: { id: b.customerId, tenantId: T(req) } });
  const r = await runCreditCheck(T(req), b.customerId, Math.round(b.orderAmount * 100));
  await audit(T(req), req.user.email, 'credit_check', 'Customer', b.customerId, { order: b.orderAmount, decision: r.decision });
  res.json({ ...r, limitAdvice: await limitAdvice(T(req), b.customerId) });
}));

// ---------- Agents: copilot, commands, runs ----------
api.post('/copilot', h(async (req, res) => {
  const b = z.object({ history: z.array(z.object({ role: z.enum(['user', 'model']), text: z.string().max(4000) })).min(1).max(20) }).parse(req.body);
  res.json(await copilot(T(req), b.history));
}));
api.post('/agent/execute', h(async (req, res) => {
  const b = z.object({ steps: z.array(z.object({ action: z.string(), label: z.string(), params: z.record(z.string(), z.any()) })).min(1).max(5) }).parse(req.body);
  const t = T(req), out: { label: string; result: string }[] = [];
  for (const s of b.steps as PlanStep[]) {
    const cid = String(s.params.customerId ?? '');
    if (cid) await db.customer.findFirstOrThrow({ where: { id: cid, tenantId: t } });
    let result = 'done';
    switch (s.action) {
      case 'run_daily_cycle': result = (await dailyCycle(t, { immediate: true })).briefing[1]; break;
      case 'work_account': result = await traced(t, 'command: work account', { customerId: cid }, async (tr) => { const r = await workAccount(t, cid, await getPolicy(t), tr, { immediate: true }); return { summary: `${r.customer}: ${r.action}`, result: `${r.action}: ${r.detail ?? ''}` }; }); break;
      case 'offer_plan': result = await traced(t, 'command: offer plan', { customerId: cid }, async (tr) => { const r = await offerPlans(t, await loadAccount(t, cid), await getPolicy(t), tr, { approved: true }); return { summary: r.detail, result: r.detail }; }); break;
      case 'place_credit_hold': case 'release_credit_hold': await db.customer.update({ where: { id: cid }, data: { creditHold: s.action === 'place_credit_hold' } }); break;
      case 'sync_inbox': { const r = await inboxSync(t); result = r.connected ? `${r.replies} replies, ${r.payments} payment emails` : 'Gmail is not connected'; break; }
      case 'send_weekly_report': result = (await weeklyReport(t)).status; break;
      default: result = 'unknown action';
    }
    await audit(t, req.user.email, 'command_executed', undefined, undefined, { action: s.action, params: s.params, result });
    out.push({ label: s.label, result });
  }
  res.json({ results: out });
}));
api.post('/agent/run-daily', h(async (req, res) => res.json(await dailyCycle(T(req), { immediate: true }))));
api.post('/agent/sync-inbox', h(async (req, res) => res.json(await inboxSync(T(req)))));
api.post('/agent/weekly-report', h(async (req, res) => res.json(await weeklyReport(T(req)))));
api.post('/agent/refresh', h(async (req, res) => res.json(await refreshAll(T(req)))));

// ---------- Human control: approvals, policy, trace, strategy, audit ----------
api.get('/approvals', h(async (req, res) => {
  const status = String(req.query.status ?? 'pending');
  const aps = await db.approval.findMany({ where: { tenantId: T(req), ...(status === 'all' ? {} : status === 'history' ? { status: { in: ['executed', 'rejected'] } } : { status: { in: ['pending', 'shadow'] } }) }, orderBy: { createdAt: 'desc' }, take: 100 });
  const cs = await db.customer.findMany({ where: { id: { in: aps.map((a) => a.customerId).filter(Boolean) as string[] } }, select: { id: true, name: true, riskScore: true, segment: true } });
  res.json(aps.map((a) => ({ ...a, customer: cs.find((c) => c.id === a.customerId) ?? null })));
}));
api.post('/approvals/:id/approve', h(async (req, res) => { const b = z.object({ subject: z.string().max(200).optional(), body: z.string().max(5000).optional() }).parse(req.body ?? {}); await executeApproval(T(req), req.params.id, req.user.email, b); res.json({ ok: true }); }));
api.post('/approvals/:id/reject', h(async (req, res) => { await rejectApproval(T(req), req.params.id, req.user.email, req.body?.note); res.json({ ok: true }); }));

api.get('/policy', h(async (req, res) => res.json({ policy: await getPolicy(T(req)), actionTypes: ACTION_TYPES })));
api.put('/policy', h(async (req, res) => {
  const level = z.enum(['shadow', 'assisted', 'autonomous']);
  const b = z.object({ autonomy: z.record(z.string(), level).optional(), maxInstalments: z.number().int().min(1).max(12).optional(), minUpfrontPct: z.number().int().min(0).max(100).optional(), maxPlanDays: z.number().int().min(7).max(180).optional(),
    earlyPayDiscountPct: z.number().min(0).max(20).optional(), maxDiscountPct: z.number().min(0).max(20).optional(), maxContactsPerDay: z.number().int().min(1).max(5).optional(), quietStartHour: z.number().int().min(0).max(23).optional(), quietEndHour: z.number().int().min(0).max(23).optional(),
    creditHoldRisk: z.number().int().min(10).max(100).optional(), creditHoldDaysOverdue: z.number().int().min(1).max(365).optional(), autoMatchConfidence: z.number().min(0.5).max(1).optional(), minIntentConfidence: z.number().min(0.3).max(1).optional(), timezone: z.string().optional() }).parse(req.body);
  await getPolicy(T(req));
  const p = await db.policy.update({ where: { tenantId: T(req) }, data: b });
  await audit(T(req), req.user.email, 'policy_updated', 'Policy', p.id, b);
  res.json({ policy: p, actionTypes: ACTION_TYPES });
}));

api.get('/trace', h(async (req, res) => {
  const where: any = { tenantId: T(req) }; if (req.query.customerId) where.customerId = String(req.query.customerId);
  const runs = await db.agentRun.findMany({ where, orderBy: { startedAt: 'desc' }, take: 60, include: { _count: { select: { steps: true } } } });
  const cs = await db.customer.findMany({ where: { id: { in: runs.map((r) => r.customerId).filter(Boolean) as string[] } }, select: { id: true, name: true } });
  res.json(runs.map((r) => ({ ...r, customerName: cs.find((c) => c.id === r.customerId)?.name ?? null })));
}));
api.get('/trace/:id', h(async (req, res) => res.json(await db.agentRun.findFirstOrThrow({ where: { id: req.params.id, tenantId: T(req) }, include: { steps: { orderBy: { seq: 'asc' } } } }))));

api.get('/strategy', h(async (req, res) => {
  const stats = await db.strategyArm.findMany({ where: { tenantId: T(req) } });
  res.json(SEGMENTS.map((segment) => {
    const arms = allArms().map((a) => { const s = stats.find((x) => x.segment === segment && armKey(x) === armKey(a)); return { key: armKey(a), tone: a.tone, channel: a.channel, window: a.window, pulls: s?.pulls ?? 0, rewards: s?.rewards ?? 0, rate: s?.pulls ? Math.round((s.rewards / s.pulls) * 100) : null }; });
    const tried = arms.filter((a) => a.pulls > 0).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
    return { segment, pulls: arms.reduce((s, a) => s + a.pulls, 0), best: tried[0] ?? null, arms };
  }));
}));
api.get('/audit', h(async (req, res) => res.json(await db.auditLog.findMany({ where: { tenantId: T(req) }, orderBy: { createdAt: 'desc' }, take: 150 }))));

api.post('/eval/run', h(async (req, res) => { const { runEval } = await import('../eval/run.js'); res.json(await runEval({ useModel: !!req.body?.useModel })); }));

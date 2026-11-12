// Outbound delivery to customers. Enforces the demo allow-list, falls back between channels, and records every message.
import type { Customer } from '@prisma/client';
import { cfg } from './config.js';
import { db } from './db.js';
import { gmailSend, googleConnected } from './integrations/google.js';
import { telegramConfigured, telegramSend } from './integrations/telegram.js';
import { startOfDay } from './util.js';
import type { Trace } from './trace.js';

export interface Outbound {
  tenantId: string; customer: Customer; channel: 'email' | 'telegram'; subject?: string; body: string;
  kind: string; tone?: string; invoiceId?: string | null; armKey?: string | null; meta?: Record<string, unknown>; trace?: Trace;
}

export async function contactsToday(customerId: string) {
  return db.interaction.count({ where: { customerId, direction: 'out', kind: { in: ['reminder', 'final_notice'] }, status: { in: ['sent', 'simulated'] }, createdAt: { gte: startOfDay(new Date()) } } });
}

export async function deliver(o: Outbound) {
  const c = o.customer;
  let channel = o.channel;
  if (channel === 'telegram' && !c.telegramChatId) channel = 'email';
  if (channel === 'email' && !c.email && c.telegramChatId) channel = 'telegram';

  let status = 'simulated', externalId: string | null = null, note = '';
  try {
    if (channel === 'telegram') {
      const chat = c.telegramChatId;
      if (!chat) { status = 'failed'; note = 'No contact details on file'; }
      else if (!telegramConfigured()) note = 'Telegram is not configured: recorded only';
      else if (cfg.demoMode && !cfg.allowedChats.includes(chat)) note = 'Demo mode: chat is not on the allow-list, recorded only';
      else { externalId = await telegramSend(chat, o.body); status = 'sent'; }
    } else {
      const to = c.email?.toLowerCase();
      if (!to) { status = 'failed'; note = 'No contact details on file'; }
      else if (!(await googleConnected(o.tenantId))) note = 'Gmail is not connected: recorded only';
      else if (cfg.demoMode && !cfg.allowedEmails.includes(to)) note = 'Demo mode: address is not on the allow-list, recorded only';
      else { const r = await gmailSend(o.tenantId, to, o.subject ?? 'Your account', o.body); externalId = r?.threadId ?? null; status = 'sent'; }
    }
  } catch (e: any) { status = 'failed'; note = String(e?.message ?? e).slice(0, 200); }

  const it = await db.interaction.create({ data: {
    tenantId: o.tenantId, customerId: c.id, invoiceId: o.invoiceId ?? null, direction: 'out', channel, kind: o.kind, subject: o.subject, body: o.body,
    tone: o.tone, status, armKey: o.armKey ?? null, externalId, meta: { ...(o.meta ?? {}), ...(note ? { note } : {}) } as any,
  } });
  if (status !== 'failed') await db.customer.update({ where: { id: c.id }, data: { lastContactedAt: new Date() } });
  await o.trace?.step('Communicator', 'deliver', { tool: channel === 'telegram' ? 'Telegram Bot API' : 'Gmail API', input: { channel, kind: o.kind, tone: o.tone }, output: { status, note: note || undefined, interactionId: it.id } });
  return it;
}

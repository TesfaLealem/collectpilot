// Shared services: policy loading, autonomy gate, approvals, portal links, owner notifications.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cfg } from './config.js';
import { db, audit } from './db.js';
import { autonomyFor, defaultAutonomy, type Autonomy } from './engines/policy.js';
import { telegramSend } from './integrations/telegram.js';
import type { Trace } from './trace.js';

export async function getPolicy(tenantId: string) {
  return (await db.policy.findUnique({ where: { tenantId } })) ?? (await db.policy.create({ data: { tenantId, autonomy: defaultAutonomy() } }));
}
export type Policy = Awaited<ReturnType<typeof getPolicy>>;

/** Signed, single-customer, expiring portal link (no login). Short enough for a chat message: <customerId>.<expiry>.<HMAC>. */
const sign = (cid: string, exp: string) => createHmac('sha256', cfg.jwtSecret).update(`portal:${cid}:${exp}`).digest('base64url').slice(0, 22);
export function portalLink(_tenantId: string, customerId: string, days = 14) {
  const exp = Math.floor(Date.now() / 1000 + days * 86400).toString(36);
  return `${cfg.publicUrl}/portal/${customerId}.${exp}.${sign(customerId, exp)}`;
}
export async function verifyPortal(token: string): Promise<{ tid: string; cid: string } | null> {
  const [cid, exp, sig] = token.split('.');
  if (!cid || !exp || !sig) return null;
  const want = Buffer.from(sign(cid, exp)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (parseInt(exp, 36) * 1000 < Date.now()) return null;
  const c = await db.customer.findUnique({ where: { id: cid }, select: { tenantId: true } });
  return c ? { tid: c.tenantId, cid } : null;
}

export interface Proposal {
  agent: string; actionType: string; title: string; reason: string;
  customerId?: string | null; invoiceId?: string | null; payload: Record<string, unknown>;
}

/**
 * Autonomy gate. Every side-effecting agent action passes through here:
 *  - autonomous: the action runs now (returns 'execute')
 *  - assisted:   an approval is queued for a human (returns 'queued')
 *  - shadow:     the suggestion is recorded only (returns 'shadow')
 * `force` lets a caller demand human approval regardless (e.g. a plan outside policy).
 */
export async function gate(tenantId: string, policy: Policy, p: Proposal, trace?: Trace, force?: Autonomy): Promise<'execute' | 'queued' | 'shadow'> {
  const level = force ?? autonomyFor(policy, p.actionType);
  if (level === 'autonomous') {
    await trace?.step('Policy engine', 'autonomy_check', { input: { actionType: p.actionType }, output: { level, decision: 'execute' }, reasoning: `"${p.actionType}" is set to autonomous: the agent acts and the owner is informed.` });
    return 'execute';
  }
  const status = level === 'assisted' ? 'pending' : 'shadow';
  await db.approval.create({ data: { tenantId, agent: p.agent, actionType: p.actionType, title: p.title, reason: p.reason, customerId: p.customerId ?? null, invoiceId: p.invoiceId ?? null, payload: p.payload as any, status, agentRunId: trace?.runId } });
  await trace?.step('Policy engine', 'autonomy_check', { input: { actionType: p.actionType }, output: { level, decision: level === 'assisted' ? 'queued for approval' : 'suggestion only' },
    reasoning: level === 'assisted' ? `"${p.actionType}" needs human approval; queued in the action centre.` : `"${p.actionType}" is in shadow mode; recorded as a suggestion, nothing was sent.` });
  return level === 'assisted' ? 'queued' : 'shadow';
}

export async function notifyOwner(tenantId: string, title: string, text: string) {
  await audit(tenantId, 'agent', 'owner_notification', undefined, undefined, { title, text });
  if (cfg.ownerChatId) await telegramSend(cfg.ownerChatId, `${title}\n\n${text}`).catch((e) => console.warn('[notifyOwner]', String(e?.message ?? e)));
}

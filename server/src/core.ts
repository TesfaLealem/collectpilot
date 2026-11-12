// Shared services: policy loading, autonomy gate, approvals, portal links, owner notifications.
import jwt from 'jsonwebtoken';
import { cfg } from './config.js';
import { db, audit } from './db.js';
import { autonomyFor, defaultAutonomy, type Autonomy } from './engines/policy.js';
import { telegramSend } from './integrations/telegram.js';
import type { Trace } from './trace.js';

export async function getPolicy(tenantId: string) {
  return (await db.policy.findUnique({ where: { tenantId } })) ?? (await db.policy.create({ data: { tenantId, autonomy: defaultAutonomy() } }));
}
export type Policy = Awaited<ReturnType<typeof getPolicy>>;

/** Signed, single-customer, expiring portal link (no login). */
export function portalLink(tenantId: string, customerId: string, days = 14) {
  const token = jwt.sign({ tid: tenantId, cid: customerId, p: 1 }, cfg.jwtSecret, { expiresIn: `${days}d` });
  return `${cfg.publicUrl}/portal/${token}`;
}
export function verifyPortal(token: string): { tid: string; cid: string } | null {
  try { const p = jwt.verify(token, cfg.jwtSecret) as any; return p?.p === 1 ? { tid: p.tid, cid: p.cid } : null; } catch { return null; }
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

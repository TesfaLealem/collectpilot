// Agent trace: every run records the inputs, a reasoning summary, the tool used, and the result of each step.
import { db } from './db.js';

export class Trace {
  private seq = 0;
  private last = Date.now();
  constructor(public runId: string, public tenantId: string) {}

  async step(agent: string, action: string, d: { input?: unknown; reasoning?: string; output?: unknown; tool?: string } = {}) {
    const now = Date.now();
    await db.agentStep.create({ data: { runId: this.runId, seq: ++this.seq, agent, action, input: d.input as any, reasoning: d.reasoning, output: d.output as any, tool: d.tool, ms: now - this.last } });
    this.last = now;
  }

  async finish(summary: string, status: 'done' | 'failed' = 'done') {
    await db.agentRun.update({ where: { id: this.runId }, data: { summary, status, finishedAt: new Date() } });
  }
}

export async function startRun(tenantId: string, trigger: string, ctx: { customerId?: string | null; invoiceId?: string | null } = {}) {
  const run = await db.agentRun.create({ data: { tenantId, trigger, customerId: ctx.customerId ?? null, invoiceId: ctx.invoiceId ?? null } });
  return new Trace(run.id, tenantId);
}

/** Run `fn` inside a traced agent run; failures are recorded on the run and re-thrown. */
export async function traced<T>(tenantId: string, trigger: string, ctx: { customerId?: string | null; invoiceId?: string | null }, fn: (t: Trace) => Promise<{ summary: string; result: T }>): Promise<T> {
  const t = await startRun(tenantId, trigger, ctx);
  try { const { summary, result } = await fn(t); await t.finish(summary); return result; }
  catch (e: any) { await t.step('Orchestrator', 'error', { output: { message: String(e?.message ?? e) } }); await t.finish(`Failed: ${String(e?.message ?? e).slice(0, 200)}`, 'failed'); throw e; }
}

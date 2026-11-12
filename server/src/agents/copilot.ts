// Owner copilot: questions over live data (function calling), what-if simulation, and natural-language
// commands that return a plan preview. Nothing is executed until the owner confirms the plan.
import { db } from '../db.js';
import { getPolicy } from '../core.js';
import { genWithTools, llmAvailable, S, type ToolDecl } from '../llm/gemini.js';
import { creditCheck } from '../engines/policy.js';
import { nameSimilarity } from '../engines/matching.js';
import { forecastFor, kpis, loadTenant, riskInputFor, roi } from './analyst.js';
import { loadAccount, nextBestAction } from './strategist.js';
import { iso, money, startOfDay } from '../util.js';

export interface PlanStep { action: string; label: string; params: Record<string, unknown> }

async function findCustomer(tenantId: string, name: string) {
  const all = await db.customer.findMany({ where: { tenantId } });
  const scored = all.map((c) => ({ c, s: Math.max(nameSimilarity(name, c.name), c.name.toLowerCase().includes(name.toLowerCase()) ? 0.8 : 0) })).sort((a, b) => b.s - a.s);
  return scored[0] && scored[0].s >= 0.4 ? scored[0].c : null;
}

export async function whatIf(tenantId: string, customerId: string, days: number) {
  const [base, sim, c] = await Promise.all([forecastFor(tenantId), forecastFor(tenantId, { [customerId]: days }), db.customer.findFirstOrThrow({ where: { id: customerId, tenantId } })]);
  const n4 = (w: typeof base.weeks) => w.slice(0, 4).reduce((s, x) => s + x.expected, 0);
  return { customer: c.name, delayDays: days, next4WeeksBaseCents: n4(base.weeks), next4WeeksSimCents: n4(sim.weeks), shortfallCents: n4(base.weeks) - n4(sim.weeks),
    weeks: base.weeks.map((w, i) => ({ index: w.index, start: w.start, base: w.expected, simulated: sim.weeks[i].expected })) };
}

const tools = (tenantId: string, pending: PlanStep[]): Record<string, { decl: ToolDecl; run: (a: any) => Promise<unknown> }> => ({
  get_kpis: { decl: { name: 'get_kpis', description: 'Current receivables KPIs: outstanding, overdue, DSO and its 9-week trend, aging buckets, collected this month, promise-kept rate.', parameters: S.obj({}, []) },
    run: async () => { const k = await kpis(tenantId); return { outstanding: money(k.outstanding), overdue: money(k.overdue), disputed: money(k.disputed), dsoDays: k.dso, dsoTrend: k.dsoTrend, aging: k.aging.map((a) => ({ bucket: a.label, amount: money(a.cents) })), collectedThisMonth: money(k.collectedMonth), promiseKeptRatePct: k.promiseKeptRate, customersOnHold: k.customersOnHold }; } },
  list_customers: { decl: { name: 'list_customers', description: 'Customers with open balances, sorted by risk score or by overdue amount, with the top risk drivers.', parameters: S.obj({ sortBy: S.str('risk or overdue', ['risk', 'overdue']), limit: S.num('How many, max 15') }, []) },
    run: async (a) => {
      const d = await loadTenant(tenantId); const t = startOfDay(new Date());
      const rows = d.customers.map((c) => { const inv = d.invoices.filter((i) => i.customerId === c.id && i.amountCents - i.paidCents > 0); const od = inv.filter((i) => i.dueDate < t).reduce((s, i) => s + i.amountCents - i.paidCents, 0);
        return { name: c.name, riskScore: c.riskScore, segment: c.segment, creditHold: c.creditHold, overdueCents: od, outstanding: money(inv.reduce((s, i) => s + i.amountCents - i.paidCents, 0)), overdue: money(od), topDrivers: ((c.riskDrivers as any[]) ?? []).filter((x) => x.points > 0).sort((x, y) => y.points - x.points).slice(0, 3).map((x) => `${x.label}: ${x.detail} (+${x.points})`) }; })
        .filter((r) => r.outstanding !== money(0)).sort((x, y) => (a?.sortBy === 'overdue' ? y.overdueCents - x.overdueCents : y.riskScore - x.riskScore));
      return rows.slice(0, Math.min(15, a?.limit ?? 5)).map(({ overdueCents, ...r }) => r);
    } },
  get_customer: { decl: { name: 'get_customer', description: 'Full picture of one customer: invoices, risk drivers, promises, plan, disputes, recent conversation, and the next best action.', parameters: S.obj({ name: S.str('Customer name (partial is fine)') }) },
    run: async (a) => {
      const c = await findCustomer(tenantId, a.name); if (!c) return { error: `No customer matching "${a.name}"` };
      const acc = await loadAccount(tenantId, c.id); const nba = await nextBestAction(tenantId, acc);
      const recent = await db.interaction.findMany({ where: { customerId: c.id, channel: { in: ['email', 'telegram', 'portal'] } }, orderBy: { createdAt: 'desc' }, take: 5 });
      return { name: c.name, segment: c.segment, riskScore: c.riskScore, creditHold: c.creditHold, riskDrivers: (c.riskDrivers as any[])?.map((x) => `${x.label}: ${x.detail} (+${x.points}/${x.max})`), outstanding: money(acc.totalDueCents), overdue: money(acc.overdueCents),
        invoices: acc.open.map((i) => ({ number: i.number, due: iso(i.dueDate), balance: money(i.amountCents - i.paidCents, i.currency), status: i.status, predictedPayDate: i.predictedPayDate ? iso(i.predictedPayDate) : null })),
        promises: acc.promises.slice(0, 5).map((p) => ({ amount: money(p.amountCents), due: iso(p.dueDate), status: p.status })), plan: acc.activePlan ? { label: acc.activePlan.label, instalments: acc.activePlan.instalments.map((i) => ({ due: iso(i.dueDate), amount: money(i.amountCents), status: i.status })) } : null,
        openDisputes: acc.disputes.map((d) => ({ category: d.category, amount: money(d.disputedCents), stage: d.stage })), recentConversation: recent.reverse().map((r) => `${iso(r.createdAt)} ${r.direction} ${r.channel}: ${r.body.replace(/\s+/g, ' ').slice(0, 140)}`),
        nextBestAction: { action: nba.type, reason: nba.reason, expectedValue: money(nba.expectedValueCents) } };
    } },
  get_forecast: { decl: { name: 'get_forecast', description: '13-week cash-flow forecast with best, expected and worst cases per week.', parameters: S.obj({}, []) },
    run: async () => { const f = await forecastFor(tenantId); return { totals: { best: money(f.totals.best), expected: money(f.totals.expected), worst: money(f.totals.worst) }, weeks: f.weeks.map((w) => ({ week: w.index, starts: w.start, expected: money(w.expected), best: money(w.best), worst: money(w.worst), largest: w.items.sort((a, b) => b.cents - a.cents).slice(0, 2).map((i) => `${i.customerName} ${i.number}`) })) }; } },
  simulate_late_payment: { decl: { name: 'simulate_late_payment', description: 'What-if: how the cash forecast changes if a customer pays N days later than predicted.', parameters: S.obj({ customerName: S.str(), days: S.num('Days later than predicted') }) },
    run: async (a) => { const c = await findCustomer(tenantId, a.customerName); if (!c) return { error: `No customer matching "${a.customerName}"` }; const w = await whatIf(tenantId, c.id, Math.round(a.days)); return { customer: w.customer, delayDays: w.delayDays, next4WeeksExpected: money(w.next4WeeksBaseCents), next4WeeksIfLate: money(w.next4WeeksSimCents), shortfallNext4Weeks: money(w.shortfallCents), changedWeeks: w.weeks.filter((x) => x.base !== x.simulated).map((x) => ({ week: x.index, starts: x.start, before: money(x.base), after: money(x.simulated) })) }; } },
  explain_dso: { decl: { name: 'explain_dso', description: 'Why DSO moved: the trend plus the invoices and customers contributing most to overdue receivables.', parameters: S.obj({}, []) },
    run: async () => {
      const k = await kpis(tenantId); const t = startOfDay(new Date());
      const inv = await db.invoice.findMany({ where: { tenantId, status: { notIn: ['paid', 'written_off'] }, dueDate: { lt: t } }, include: { customer: { select: { name: true } } } });
      const by = new Map<string, number>(); for (const i of inv) by.set(i.customer.name, (by.get(i.customer.name) ?? 0) + i.amountCents - i.paidCents);
      return { dsoNow: k.dso, trend: k.dsoTrend, change9Weeks: k.dso - (k.dsoTrend[0]?.dso ?? k.dso), overdueTotal: money(k.overdue), biggestOverdueCustomers: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, c]) => ({ name, overdue: money(c), shareOfOverduePct: Math.round((c / Math.max(1, k.overdue)) * 100) })), aging: k.aging.map((a) => ({ bucket: a.label, amount: money(a.cents) })) };
    } },
  get_roi: { decl: { name: 'get_roi', description: 'What the agents achieved in the last 30 days: cash collected after agent actions, hours saved, messages, matches.', parameters: S.obj({}, []) },
    run: async () => { const r = await roi(tenantId); return { ...r, collected: money(r.collectedCents), collectedAfterAgentAction: money(r.collectedAfterAgentCents) }; } },
  credit_check: { decl: { name: 'credit_check', description: 'Should a new order from a customer be accepted on credit? Returns approve, approve_with_deposit, or hold with reasons.', parameters: S.obj({ customerName: S.str(), orderAmount: S.num('Order value') }) },
    run: async (a) => { const c = await findCustomer(tenantId, a.customerName); if (!c) return { error: `No customer matching "${a.customerName}"` }; const r = await runCreditCheck(tenantId, c.id, Math.round(a.orderAmount * 100)); return { customer: c.name, decision: r.decision, deposit: money(r.depositCents), reasons: r.reasons }; } },
  propose_action: { decl: { name: 'propose_action', description: 'Prepare (not execute) an action the owner asked for. The owner sees a plan preview and must confirm. Actions: run_daily_cycle, work_account (run the agents on one customer now), offer_plan, place_credit_hold, release_credit_hold, sync_inbox, send_weekly_report.', parameters: S.obj({ action: S.str('Action', ['run_daily_cycle', 'work_account', 'offer_plan', 'place_credit_hold', 'release_credit_hold', 'sync_inbox', 'send_weekly_report']), customerName: S.nullable(S.str('Customer, when the action is about one account')) }, ['action']) },
    run: async (a) => {
      const c = a.customerName ? await findCustomer(tenantId, a.customerName) : null;
      const needs = ['work_account', 'offer_plan', 'place_credit_hold', 'release_credit_hold'].includes(a.action);
      if (needs && !c) return { error: `Which customer? No match for "${a.customerName ?? ''}"` };
      const labels: Record<string, string> = { run_daily_cycle: 'Run the full daily cycle for all accounts now', work_account: `Run the agents on ${c?.name} now (next best action)`, offer_plan: `Offer ${c?.name} payment plan options within policy`, place_credit_hold: `Place ${c?.name} on credit hold`, release_credit_hold: `Release the credit hold on ${c?.name}`, sync_inbox: 'Read the mailbox for replies and payment notifications', send_weekly_report: 'Generate and send the weekly report' };
      const step: PlanStep = { action: a.action, label: labels[a.action], params: c ? { customerId: c.id } : {} };
      pending.push(step);
      return { prepared: step.label, note: 'Shown to the owner as a plan preview; it runs only after they confirm.' };
    } },
});

export async function runCreditCheck(tenantId: string, customerId: string, orderCents: number) {
  const d = await loadTenant(tenantId); const policy = await getPolicy(tenantId);
  const c = d.customers.find((x) => x.id === customerId)!; const input = riskInputFor(d, customerId, startOfDay(new Date()));
  return creditCheck(policy, { riskScore: c.riskScore, maxDaysPastDue: input.maxDpd, exposureCents: input.openInvoices.reduce((s, i) => s + i.dueCents, 0), creditLimitCents: c.creditLimitCents, orderCents, onHold: c.creditHold, brokenPromises: input.brokenPromises });
}

const SYSTEM = `You are the copilot for the owner of a B2B distributor using CollectPilot, an accounts-receivable agent system.
Answer questions about receivables using the tools; never invent numbers. Quote amounts exactly as the tools return them.
When the owner asks you to DO something, call propose_action; it only prepares a plan preview that the owner must confirm, so say what will happen and that it awaits confirmation.
Be concise: a direct answer first, then at most five short bullet points of evidence. Plain text, no markdown tables.`;

export async function copilot(tenantId: string, history: { role: 'user' | 'model'; text: string }[]) {
  const pending: PlanStep[] = [];
  const T = tools(tenantId, pending);
  const question = history[history.length - 1]?.text ?? '';
  if (llmAvailable()) {
    const r = await genWithTools({ system: SYSTEM, history: history.slice(-8), tools: Object.values(T).map((t) => t.decl), exec: (name, args) => T[name]?.run(args) ?? Promise.resolve({ error: 'unknown tool' }) });
    if (r) return { answer: r.text, calls: r.calls.map((c) => ({ name: c.name, args: c.args })), plan: pending, source: 'gemini' };
  }
  // Fallback router when the model is unavailable: map the question to one tool and print its result.
  const q = question.toLowerCase();
  const custs = await db.customer.findMany({ where: { tenantId } });
  const named = custs.find((c) => q.includes(c.name.toLowerCase().split(' ')[0]));
  const days = Number(q.match(/(\d+)\s*days?/)?.[1] ?? 30);
  let name = 'get_kpis', args: any = {};
  if (/what.?if|what happens|pays? .*late|delay/.test(q) && named) { name = 'simulate_late_payment'; args = { customerName: named.name, days }; }
  else if (/run .*(daily|cycle)|chase everyone/.test(q)) { name = 'propose_action'; args = { action: 'run_daily_cycle' }; }
  else if (/payment plan|offer .*plan/.test(q) && named) { name = 'propose_action'; args = { action: 'offer_plan', customerName: named.name }; }
  else if (/credit hold|put .*hold/.test(q) && named) { name = 'propose_action'; args = { action: /release|remove|lift/.test(q) ? 'release_credit_hold' : 'place_credit_hold', customerName: named.name }; }
  else if (/order|credit check/.test(q) && named) { name = 'credit_check'; args = { customerName: named.name, orderAmount: Number(q.match(/([\d,]{4,})/)?.[1]?.replace(/,/g, '') ?? 0) }; }
  else if (/dso/.test(q)) name = 'explain_dso';
  else if (/forecast|cash ?flow|next (week|month)/.test(q)) name = 'get_forecast';
  else if (/risk|riskiest|worst|who owes|overdue customers/.test(q)) { name = 'list_customers'; args = { sortBy: /owe|overdue/.test(q) ? 'overdue' : 'risk', limit: 5 }; }
  else if (/roi|saved|value|worth/.test(q)) name = 'get_roi';
  else if (named) { name = 'get_customer'; args = { name: named.name }; }
  const result = await T[name].run(args);
  return { answer: `(Gemini is not configured, so this is the raw result of "${name}".)\n\n${JSON.stringify(result, null, 2)}`, calls: [{ name, args }], plan: pending, source: 'rules' };
}

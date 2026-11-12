// Payment-to-invoice matching engine. Deterministic; Gemini is only consulted (by the Reconciler) for ambiguous narrations.

export interface OpenInvoice { id: string; number: string; customerId: string; customerName: string; dueCents: number; dueDate: Date }
export interface IncomingPayment { amountCents: number; reference?: string | null; narration?: string | null; payerName?: string | null; customerId?: string | null }
export interface Alloc { invoiceId: string; amountCents: number }
export interface MatchResult {
  status: 'matched' | 'suggested' | 'unmatched';
  confidence: number;
  customerId: string | null;
  allocations: Alloc[];
  unappliedCents: number;
  reason: string;
  ambiguous?: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\b(plc|pvt|ltd|llc|sc|s c|trading|general|co|company|and|the|enterprise|import|export)\b/g, ' ').replace(/\s+/g, ' ').trim();

export function nameSimilarity(a: string, b: string): number {
  const A = new Set(norm(a).split(' ').filter(Boolean)), B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const jacc = inter / (A.size + B.size - inter);
  const contain = inter / Math.min(A.size, B.size);
  return Math.max(jacc, contain * 0.9);
}

const digits = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '');

/** Find invoice numbers mentioned in free text ("pmt inv 1042 & part 1047"). */
export function extractInvoiceRefs(text: string, invoices: OpenInvoice[]): OpenInvoice[] {
  const t = text.toLowerCase();
  const tokens = new Set((t.match(/\d{3,}/g) ?? []).map((x) => x.replace(/^0+/, '')));
  const found: OpenInvoice[] = [];
  for (const inv of invoices) {
    const full = inv.number.toLowerCase();
    const d = digits(inv.number);
    if (t.includes(full) || (d.length >= 3 && tokens.has(d))) found.push(inv);
  }
  return found;
}

export function allocateOldestFirst(amountCents: number, invoices: OpenInvoice[]): { allocations: Alloc[]; unappliedCents: number } {
  let left = amountCents;
  const allocations: Alloc[] = [];
  for (const inv of [...invoices].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())) {
    if (left <= 0) break;
    const a = Math.min(left, inv.dueCents);
    if (a > 0) { allocations.push({ invoiceId: inv.id, amountCents: a }); left -= a; }
  }
  return { allocations, unappliedCents: left };
}

export function matchPayment(p: IncomingPayment, open: OpenInvoice[]): MatchResult {
  const text = `${p.reference ?? ''} ${p.narration ?? ''}`.trim();
  const none: MatchResult = { status: 'unmatched', confidence: 0, customerId: null, allocations: [], unappliedCents: p.amountCents, reason: 'No invoice reference, payer, or amount match found' };
  if (p.amountCents <= 0) return none;

  // 1. Invoice references in the reference / narration
  const pool = p.customerId ? open.filter((i) => i.customerId === p.customerId) : open;
  const refs = extractInvoiceRefs(text, pool);
  if (refs.length) {
    const customers = new Set(refs.map((r) => r.customerId));
    const sum = refs.reduce((s, r) => s + r.dueCents, 0);
    const customerId = customers.size === 1 ? refs[0].customerId : null;
    const list = refs.map((r) => r.number).join(', ');
    if (customers.size > 1) {
      return { status: 'suggested', confidence: 0.5, customerId: null, allocations: [], unappliedCents: p.amountCents, reason: `References invoices of different customers (${list})`, ambiguous: true };
    }
    if (sum === p.amountCents) {
      return { status: 'matched', confidence: refs.length === 1 ? 0.99 : 0.97, customerId, allocations: refs.map((r) => ({ invoiceId: r.id, amountCents: r.dueCents })), unappliedCents: 0,
        reason: `Reference ${list} and amount match exactly` };
    }
    if (p.amountCents < sum) {
      const { allocations } = allocateOldestFirst(p.amountCents, refs);
      const partialWord = /part|partial|balance|bal\b|adv/i.test(text);
      return { status: refs.length === 1 || partialWord ? 'matched' : 'suggested', confidence: refs.length === 1 ? 0.92 : partialWord ? 0.9 : 0.75, customerId, allocations, unappliedCents: 0,
        reason: `Reference ${list}; partial payment allocated oldest first`, ambiguous: refs.length > 1 };
    }
    const { allocations, unappliedCents } = allocateOldestFirst(p.amountCents, refs);
    return { status: 'suggested', confidence: 0.8, customerId, allocations, unappliedCents, reason: `Reference ${list}; payment exceeds the invoice total, the remainder is unapplied` };
  }

  // 2. Payer name → customer
  const payer = p.payerName || p.narration || '';
  const byCustomer = new Map<string, OpenInvoice[]>();
  for (const inv of open) byCustomer.set(inv.customerId, [...(byCustomer.get(inv.customerId) ?? []), inv]);
  let best: { id: string; sim: number } | null = null, second = 0;
  if (p.customerId) best = { id: p.customerId, sim: 1 };
  else for (const [id, invs] of byCustomer) {
    const sim = nameSimilarity(payer, invs[0].customerName);
    if (!best || sim > best.sim) { second = best?.sim ?? 0; best = { id, sim }; } else if (sim > second) second = sim;
  }
  if (best && best.sim >= 0.5 && best.sim - second >= 0.15) {
    const invs = byCustomer.get(best.id) ?? [];
    const name = invs[0]?.customerName ?? 'customer';
    const exact = invs.filter((i) => i.dueCents === p.amountCents);
    const total = invs.reduce((s, i) => s + i.dueCents, 0);
    if (exact.length === 1) {
      return { status: 'matched', confidence: Math.min(0.95, 0.82 + best.sim * 0.12), customerId: best.id, allocations: [{ invoiceId: exact[0].id, amountCents: p.amountCents }], unappliedCents: 0,
        reason: `Payer "${payer.trim()}" matches ${name}; amount equals invoice ${exact[0].number}` };
    }
    if (total === p.amountCents && invs.length > 1) {
      return { status: 'matched', confidence: Math.min(0.93, 0.8 + best.sim * 0.12), customerId: best.id, allocations: invs.map((i) => ({ invoiceId: i.id, amountCents: i.dueCents })), unappliedCents: 0,
        reason: `Payer matches ${name}; amount equals all ${invs.length} open invoices` };
    }
    if (invs.length) {
      const { allocations, unappliedCents } = allocateOldestFirst(p.amountCents, invs);
      return { status: 'suggested', confidence: 0.55 + best.sim * 0.2, customerId: best.id, allocations, unappliedCents,
        reason: `Payer matches ${name}; no exact amount, allocated oldest first`, ambiguous: true };
    }
  }

  // 3. Amount-only: a unique open invoice with exactly this amount
  const sameAmount = open.filter((i) => i.dueCents === p.amountCents);
  if (sameAmount.length === 1) {
    return { status: 'suggested', confidence: 0.6, customerId: sameAmount[0].customerId, allocations: [{ invoiceId: sameAmount[0].id, amountCents: p.amountCents }], unappliedCents: 0,
      reason: `Only invoice ${sameAmount[0].number} (${sameAmount[0].customerName}) has exactly this amount`, ambiguous: true };
  }
  return { ...none, ambiguous: text.length > 0 };
}

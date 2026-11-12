// Demo data: a fictional distributor with 14 customers covering every behavioural segment.
// All names are invented. All history (payments, reminders, strategy statistics) is SYNTHETIC and generated
// from a fixed random seed so the demo is reproducible. Run: npm run seed  (this wipes the database first).
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { defaultAutonomy } from './engines/policy.js';
import { allArms } from './engines/bandit.js';
import { addDays, startOfDay, iso } from './util.js';
import { refreshAll } from './agents/analyst.js';

let seedState = 20261112;
const rnd = () => { seedState |= 0; seedState = (seedState + 0x6d2b79f5) | 0; let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (a: number, b: number) => Math.round(a + rnd() * (b - a));
const today = startOfDay(new Date());
const D = (n: number) => addDays(today, n);

const PRODUCTS = [['Cooking oil 5L (carton of 4)', 3200], ['Rice 25kg bag', 2850], ['Sugar 50kg bag', 5400], ['Wheat flour 50kg bag', 4100], ['Pasta 500g (carton of 20)', 1450], ['Laundry soap (carton of 48)', 1980], ['Bottled water 0.5L (pack of 24)', 420], ['Tomato paste 400g (carton of 24)', 2300], ['Tea 100g (carton of 50)', 3600], ['Biscuits assorted (carton)', 1250]] as const;

interface Profile {
  name: string; contact: string; email: string; phone: string; language?: string; channel?: string; limit: number; terms?: number;
  late: [number, number]; paidCount: number; // history: range of days late, number of paid invoices
  open: { number: string; amount: number; dueIn: number; stage?: number; currency?: string }[];
}

const CUSTOMERS: Profile[] = [
  { name: 'Abebe Trading PLC', contact: 'Abebe Kebede', email: 'accounts@abebe-trading.example.com', phone: '+251 911 000 101', channel: 'telegram', limit: 800_000, late: [10, 22], paidCount: 6, open: [{ number: 'INV-1042', amount: 250_000, dueIn: -40, stage: 2 }, { number: 'INV-1047', amount: 180_000, dueIn: -10, stage: 1 }] },
  { name: 'Selam Pharmacy', contact: 'Selamawit Tesfaye', email: 'finance@selam-pharmacy.example.com', phone: '+251 911 000 102', limit: 400_000, late: [-3, 1], paidCount: 8, open: [{ number: 'INV-1051', amount: 75_000, dueIn: 5 }, { number: 'INV-1068', amount: 64_500, dueIn: 21 }] },
  { name: 'Hawassa Building Materials', contact: 'Dawit Lemma', email: 'dawit@hawassa-bm.example.com', phone: '+251 911 000 103', limit: 600_000, late: [32, 58], paidCount: 4, open: [{ number: 'INV-1019', amount: 310_000, dueIn: -72, stage: 3 }, { number: 'INV-1028', amount: 145_000, dueIn: -55, stage: 3 }, { number: 'INV-1044', amount: 98_000, dueIn: -30, stage: 2 }] },
  { name: 'Tana Supermarket', contact: 'Hiwot Alemu', email: 'ap@tana-supermarket.example.com', phone: '+251 911 000 104', channel: 'telegram', limit: 500_000, late: [3, 8], paidCount: 7, open: [{ number: 'INV-1060', amount: 75_000, dueIn: -4 }, { number: 'INV-1066', amount: 112_300, dueIn: 2 }] },
  { name: 'Meskel Mini Market', contact: 'Yonas Girma', email: 'yonas@meskel-market.example.com', phone: '+251 911 000 105', language: 'am', channel: 'telegram', limit: 250_000, late: [12, 28], paidCount: 5, open: [{ number: 'INV-1039', amount: 160_000, dueIn: -26, stage: 2 }] },
  { name: 'Lalibela Hardware', contact: 'Mekdes Haile', email: 'mekdes@lalibela-hardware.example.com', phone: '+251 911 000 106', limit: 450_000, late: [4, 12], paidCount: 5, open: [{ number: 'INV-1049', amount: 220_000, dueIn: -14, stage: 1 }] },
  { name: 'Sheger Electronics', contact: 'Robel Tadesse', email: 'robel@sheger-electronics.example.com', phone: '+251 911 000 107', limit: 700_000, late: [-2, 2], paidCount: 7, open: [{ number: 'INV-1053', amount: 198_000, dueIn: -12 }] },
  { name: 'Bole Stationery', contact: 'Tigist Worku', email: 'tigist@bole-stationery.example.com', phone: '+251 911 000 108', language: 'am', limit: 200_000, late: [4, 9], paidCount: 6, open: [{ number: 'INV-1056', amount: 48_750, dueIn: -9, stage: 1 }] },
  { name: 'Entoto Pharmacy', contact: 'Samuel Bekele', email: 'samuel@entoto-pharmacy.example.com', phone: '+251 911 000 109', limit: 350_000, late: [6, 15], paidCount: 5, open: [{ number: 'INV-1050', amount: 132_000, dueIn: -16, stage: 1 }] },
  { name: 'Awash Cafe and Restaurant', contact: 'Liya Solomon', email: 'liya@awash-cafe.example.com', phone: '+251 911 000 110', channel: 'telegram', limit: 220_000, late: [14, 30], paidCount: 4, open: [{ number: 'INV-1046', amount: 89_400, dueIn: -21, stage: 2 }] },
  { name: 'Gondar Agro Supplies', contact: 'Fikru Mengistu', email: 'fikru@gondar-agro.example.com', phone: '+251 911 000 111', limit: 900_000, late: [12, 24], paidCount: 6, open: [{ number: 'INV-1048', amount: 276_000, dueIn: -18, stage: 1 }, { number: 'INV-1065', amount: 340_000, dueIn: 10 }] },
  { name: 'Dire Wholesale', contact: 'Hanna Yusuf', email: 'hanna@dire-wholesale.example.com', phone: '+251 911 000 112', limit: 1_500_000, late: [0, 6], paidCount: 6, open: [{ number: 'INV-1062', amount: 420_000, dueIn: 6 }, { number: 'INV-1063', amount: 3_200, dueIn: -3, currency: 'USD' }] },
  { name: 'Addis Home Decor', contact: 'Bethlehem Assefa', email: 'beth@addis-homedecor.example.com', phone: '+251 911 000 113', limit: 300_000, late: [-4, 0], paidCount: 6, open: [] },
  { name: 'Rift Valley Contractors', contact: 'Kaleb Negash', email: 'kaleb@riftvalley-contractors.example.com', phone: '+251 911 000 114', limit: 500_000, late: [18, 34], paidCount: 4, open: [{ number: 'INV-1041', amount: 205_000, dueIn: -35, stage: 2 }] },
];

function lines(totalCents: number) {
  const out: { description: string; quantity: number; unitCents: number; totalCents: number }[] = [];
  let left = totalCents;
  for (let k = 0; k < 3 && left > 0; k++) {
    const [description, price] = PRODUCTS[between(0, PRODUCTS.length - 1)];
    const unitCents = price * 100;
    const qty = k === 2 ? 0 : Math.floor((left * (0.3 + rnd() * 0.3)) / unitCents);
    if (qty > 0) { out.push({ description, quantity: qty, unitCents, totalCents: qty * unitCents }); left -= qty * unitCents; }
  }
  if (left > 0) out.push({ description: 'Mixed goods and delivery', quantity: 1, unitCents: left, totalCents: left });
  return out;
}

async function main() {
  console.log('Wiping database...');
  for (const t of ['AgentStep', 'AgentRun', 'Allocation', 'Payment', 'PaymentProof', 'Instalment', 'PaymentPlan', 'PromiseToPay', 'Dispute', 'CreditNote', 'Interaction', 'Document', 'Approval', 'StrategyArm', 'AuditLog', 'ForecastSnapshot', 'Job', 'Memory', 'PortalToken', 'KV', 'InvoiceLine', 'Invoice', 'Customer', 'Policy', 'User', 'Tenant'])
    await db.$executeRawUnsafe(`TRUNCATE TABLE "${t}" CASCADE`);

  const tenant = await db.tenant.create({ data: { name: 'Blue Nile Distributors', baseCurrency: 'ETB' } });
  const tid = tenant.id;
  const pw = await bcrypt.hash(process.env.SEED_PASSWORD ?? 'demo1234', 10);
  await db.user.createMany({ data: [
    { tenantId: tid, email: 'owner@bluenile.example.com', name: 'Owner (demo)', role: 'owner', passwordHash: pw },
    { tenantId: tid, email: 'clerk@bluenile.example.com', name: 'AR clerk (demo)', role: 'clerk', passwordHash: pw },
    { tenantId: tid, email: 'viewer@bluenile.example.com', name: 'Read-only (demo)', role: 'readonly', passwordHash: pw },
  ] });
  await db.policy.create({ data: { tenantId: tid, autonomy: defaultAutonomy() } });

  // Optional: point one customer at your own test mailbox / Telegram chat so real messages can be delivered.
  const testEmail = process.env.DEMO_CUSTOMER_EMAIL?.toLowerCase(), testChat = process.env.DEMO_CUSTOMER_CHAT_ID;
  let invSeq = 900, paySeq = 1;
  const ids: Record<string, string> = {};

  for (const [ci, p] of CUSTOMERS.entries()) {
    const c = await db.customer.create({ data: { tenantId: tid, name: p.name, contactName: p.contact, email: ci === 0 && testEmail ? testEmail : p.email, phone: p.phone, language: p.language ?? 'en', preferredChannel: p.channel ?? 'email',
      telegramChatId: ci === 0 && testChat ? testChat : p.channel === 'telegram' ? `demo-${ci + 1}` : null, telegramLinkCode: `link${String(ci + 1).padStart(3, '0')}${between(1000, 9999)}`, creditLimitCents: p.limit * 100, termsDays: p.terms ?? 30 } });
    ids[p.name] = c.id;

    // Paid history over the last ~6 months.
    for (let k = 0; k < p.paidCount; k++) {
      const due = D(-between(25, 170));
      const amountCents = between(40, 320) * 1000 * 100;
      const late = between(p.late[0], p.late[1]);
      let paidAt = addDays(due, late);
      if (paidAt >= today) paidAt = D(-between(1, 6));
      const number = `INV-${invSeq++}`;
      const inv = await db.invoice.create({ data: { tenantId: tid, customerId: c.id, number, issueDate: addDays(due, -(p.terms ?? 30)), dueDate: due, amountCents, paidCents: amountCents, status: 'paid', paidAt, source: 'seed', reminderStage: late > 5 ? 1 : 0, lines: { create: lines(amountCents) } } });
      const pay = await db.payment.create({ data: { tenantId: tid, customerId: c.id, date: paidAt, amountCents, reference: `FT${240000 + paySeq++}`, narration: `Payment ${number}`, payerName: p.name.toUpperCase(), source: 'statement', status: 'matched', matchConfidence: 0.99, matchReason: `Reference ${number} and amount match exactly` } });
      await db.allocation.create({ data: { paymentId: pay.id, invoiceId: inv.id, amountCents, createdAt: paidAt } });
      if (late > 5) await db.interaction.create({ data: { tenantId: tid, customerId: c.id, invoiceId: inv.id, direction: 'out', channel: p.channel ?? 'email', kind: 'reminder', subject: `Payment reminder: invoice ${number}`, body: `Reminder for invoice ${number} (synthetic history).`, tone: 'friendly', status: 'simulated', createdAt: addDays(paidAt, -between(2, 5)), rewarded: true } });
    }

    // Open invoices.
    for (const o of p.open) {
      const due = D(o.dueIn), cents = o.amount * 100;
      const inv = await db.invoice.create({ data: { tenantId: tid, customerId: c.id, number: o.number, issueDate: addDays(due, -(p.terms ?? 30)), dueDate: due, amountCents: cents, currency: o.currency ?? 'ETB', source: 'seed', reminderStage: o.stage ?? 0, lastReminderAt: o.stage ? D(-between(3, 8)) : null, lines: { create: lines(cents) } } });
      for (let s = 0; s < (o.stage ?? 0); s++) await db.interaction.create({ data: { tenantId: tid, customerId: c.id, invoiceId: inv.id, direction: 'out', channel: p.channel ?? 'email', kind: 'reminder', subject: `Payment reminder: invoice ${o.number}`, body: `Hello ${p.contact},\n\nOur records show invoice ${o.number} is overdue. Please arrange payment or tell us when to expect it.\n\nBlue Nile Distributors`, tone: s === 0 ? 'friendly' : s === 1 ? 'neutral' : 'firm', status: 'simulated', createdAt: D(-(3 + ((o.stage ?? 0) - s) * 7)) } });
    }
  }

  const inv = async (n: string) => db.invoice.findUniqueOrThrow({ where: { tenantId_number: { tenantId: tid, number: n } } });
  const inbound = (customer: string, body: string, daysAgo: number, intent: string, channel = 'email') => db.interaction.create({ data: { tenantId: tid, customerId: ids[customer], direction: 'in', channel, kind: 'message', body, intent, status: 'received', createdAt: D(-daysAgo) } });

  // Hawassa: two broken promises (chronic).
  for (const [ago, due] of [[40, 30], [22, 12]] as const) {
    await inbound('Hawassa Building Materials', 'We will settle the old invoices by the end of next week, there has been a delay on a project payment.', ago, 'promise_to_pay');
    await db.promiseToPay.create({ data: { tenantId: tid, customerId: ids['Hawassa Building Materials'], amountCents: 31_000_000, dueDate: D(-due), status: 'broken', createdAt: D(-ago), resolvedAt: D(-due + 1) } });
  }
  await db.memory.create({ data: { tenantId: tid, customerId: ids['Hawassa Building Materials'], kind: 'conversation', text: 'Says payments depend on a delayed government construction project. Has twice promised payment "next week" and missed it.' } });

  // Entoto: an open promise three days from now (the agents wait).
  const entoto = await inv('INV-1050');
  await inbound('Entoto Pharmacy', 'Apologies for the delay. We will pay the full amount on ' + iso(D(3)) + '.', 2, 'promise_to_pay');
  await db.promiseToPay.create({ data: { tenantId: tid, customerId: ids['Entoto Pharmacy'], invoiceId: entoto.id, amountCents: entoto.amountCents, dueDate: D(3), status: 'open', createdAt: D(-2) } });
  await db.invoice.update({ where: { id: entoto.id }, data: { pausedUntil: D(4) } });
  // Entoto also kept an earlier promise.
  await db.promiseToPay.create({ data: { tenantId: tid, customerId: ids['Entoto Pharmacy'], amountCents: 9_800_000, dueDate: D(-50), status: 'kept', createdAt: D(-58), resolvedAt: D(-51) } });

  // Awash: one broken promise, no plan yet (the Strategist will offer one).
  await inbound('Awash Cafe and Restaurant', 'Business has been slow this month. I will try to pay by Friday.', 16, 'promise_to_pay', 'telegram');
  await db.promiseToPay.create({ data: { tenantId: tid, customerId: ids['Awash Cafe and Restaurant'], amountCents: 8_940_000, dueDate: D(-10), status: 'broken', createdAt: D(-16), resolvedAt: D(-9) } });
  await db.memory.create({ data: { tenantId: tid, customerId: ids['Awash Cafe and Restaurant'], kind: 'conversation', text: 'Owner Liya said business is slow and cash is tight; prefers short messages on Telegram in the morning.' } });

  // Meskel: an active payment plan, first instalment paid, second due tomorrow.
  const meskel = await inv('INV-1039');
  await inbound('Meskel Mini Market', 'በአንድ ጊዜ መክፈል አልችልም። በክፍል መክፈል እችላለሁ?', 9, 'request_plan', 'telegram');
  const plan = await db.paymentPlan.create({ data: { tenantId: tid, customerId: ids['Meskel Mini Market'], invoiceIds: [meskel.id], totalCents: meskel.amountCents, label: '4 instalments, every two weeks', status: 'active', acceptedAt: D(-8), createdAt: D(-9),
    instalments: { create: [{ seq: 1, dueDate: D(-8), amountCents: 4_000_000, paidCents: 4_000_000, status: 'paid' }, { seq: 2, dueDate: D(1), amountCents: 4_000_000 }, { seq: 3, dueDate: D(15), amountCents: 4_000_000 }, { seq: 4, dueDate: D(29), amountCents: 4_000_000 }] } } });
  const mp = await db.payment.create({ data: { tenantId: tid, customerId: ids['Meskel Mini Market'], date: D(-8), amountCents: 4_000_000, reference: 'FT249901', narration: 'INV-1039 instalment 1', payerName: 'MESKEL MINI MARKET', status: 'matched', matchConfidence: 0.92, matchReason: 'Reference INV-1039; partial payment allocated oldest first' } });
  await db.allocation.create({ data: { paymentId: mp.id, invoiceId: meskel.id, amountCents: 4_000_000, createdAt: D(-8) } });
  await db.invoice.update({ where: { id: meskel.id }, data: { paidCents: 4_000_000, status: 'partial', pausedUntil: D(30) } });
  void plan;

  // Lalibela: an open quantity dispute on part of an invoice.
  const lal = await inv('INV-1049');
  await inbound('Lalibela Hardware', 'Invoice INV-1049 bills 60 cartons but only 48 were delivered. We will not pay for the 12 missing cartons.', 6, 'dispute');
  await db.dispute.create({ data: { tenantId: tid, customerId: ids['Lalibela Hardware'], invoiceId: lal.id, category: 'quantity', description: 'Invoice INV-1049 bills 60 cartons but only 48 were delivered. We will not pay for the 12 missing cartons.', disputedCents: 4_400_000, stage: 'opened', createdAt: D(-6),
    proposal: { resolution: 'need_evidence', creditCents: 0, explanation: 'Claim cannot be assessed without the signed delivery note; evidence has been requested.', source: 'rules' } } });
  await db.invoice.update({ where: { id: lal.id }, data: { disputedCents: 4_400_000 } });

  // Rift Valley: three unanswered messages (unresponsive).
  // (reminders were created above; no inbound exists, so responsiveness scores as silent)

  // Strategy statistics: synthetic history so the bandit has something to exploit. True rates differ by segment.
  const truth: Record<string, (a: { tone: string; channel: string; window: string }) => number> = {
    reliable: (a) => 0.55 + (a.tone === 'friendly' ? 0.2 : 0) + (a.channel === 'email' ? 0.05 : 0),
    forgetful: (a) => 0.35 + (a.tone === 'friendly' ? 0.15 : 0) + (a.channel === 'telegram' ? 0.2 : 0) + (a.window === 'morning' ? 0.1 : 0),
    'slow-but-sure': (a) => 0.25 + (a.tone === 'neutral' ? 0.15 : 0) + (a.window === 'midday' ? 0.08 : 0),
    'cash-constrained': (a) => 0.15 + (a.tone === 'neutral' ? 0.1 : a.tone === 'firm' ? -0.05 : 0.05) + (a.channel === 'telegram' ? 0.1 : 0),
    disputing: (a) => 0.1 + (a.tone === 'neutral' ? 0.08 : 0),
    chronic: (a) => 0.06 + (a.tone === 'firm' ? 0.14 : 0) + (a.channel === 'telegram' ? 0.05 : 0) + (a.window === 'afternoon' ? 0.04 : 0),
  };
  for (const [segment, f] of Object.entries(truth)) for (const a of allArms()) {
    if (rnd() < 0.3) continue; // some arms are still untested
    const pulls = between(4, 22); let rewards = 0;
    for (let k = 0; k < pulls; k++) if (rnd() < f(a)) rewards++;
    await db.strategyArm.create({ data: { tenantId: tid, segment, tone: a.tone, channel: a.channel, window: a.window, pulls, rewards } });
  }

  const r = await refreshAll(tid);
  console.log(`Seeded ${CUSTOMERS.length} customers. Risk refresh: ${r.changes.length} scored, ${r.holdsPlaced} on credit hold.`);
  console.log('Sign in as owner@bluenile.example.com (password: SEED_PASSWORD, default in README).');
}

main().then(() => db.$disconnect()).catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });

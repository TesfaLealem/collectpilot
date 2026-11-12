import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, day, money, when } from '../api';
import { Badge, Btn, Card, Empty, Err, Field, inputCls, Loading, Page, Risk, Status, Table, Tabs, useAction, useData } from '../ui';

export function Customers() {
  const { data, error, loading } = useData(() => api.get('/customers'));
  const [q, setQ] = useState('');
  if (loading && !data) return <Loading />;
  const rows = (data ?? []).filter((c: any) => c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Page title="Customers" subtitle="Sorted by risk. Scores come from transparent rules, shown on each customer page." actions={<input className={`${inputCls} w-56`} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <Err msg={error} />
      <Card>
        <Table head={['Customer', 'Segment', 'Risk', 'Outstanding', 'Overdue', 'Open inv.', 'Channel', 'Flags']}
          rows={rows.map((c: any) => [
            <Link to={`/customers/${c.id}`} className="font-medium text-brand hover:underline">{c.name}</Link>, <Badge>{c.segment}</Badge>, <Risk score={c.riskScore} />,
            <span className="tabular">{money(c.outstandingCents)}</span>, <span className={`tabular ${c.overdueCents ? 'text-red-700' : ''}`}>{money(c.overdueCents)}</span>, c.openInvoices,
            `${c.preferredChannel}${c.language === 'am' ? ' · Amharic' : ''}`, <div className="flex gap-1">{c.creditHold && <Badge tone="red">credit hold</Badge>}{c.optOut && <Badge tone="violet">opted out</Badge>}</div>,
          ])} />
      </Card>
    </Page>
  );
}

const NBA_LABEL: Record<string, string> = { wait: 'Wait', remind: 'Send reminder', final_notice: 'Final notice', offer_plan: 'Offer payment plan', call_task: 'Human call' };

export function Customer360() {
  const { id } = useParams();
  const { data, error, loading, reload } = useData(() => api.get(`/customers/${id}`), [id]);
  const act = useAction();
  const [tab, setTab] = useState('timeline');
  const [msg, setMsg] = useState('');
  const [channel, setChannel] = useState('telegram');
  const [result, setResult] = useState<any>(null);
  const [order, setOrder] = useState('');
  const [credit, setCredit] = useState<any>(null);
  const file = useRef<HTMLInputElement>(null);
  if (loading && !data) return <Loading />;
  if (!data) return <Page title="Customer"><Err msg={error} /></Page>;
  const c = data.customer, nba = data.nextBestAction;
  const send = () => act.run('sim', async () => { setResult(await api.post(`/customers/${id}/simulate-message`, { text: msg, channel })); setMsg(''); await reload(); });
  const proof = (f: File) => act.run('proof', async () => { const fd = new FormData(); fd.append('file', f); const p = await api.post(`/customers/${id}/simulate-proof`, fd); setResult({ intent: 'proof of payment', outcome: p.status, detail: p.amountCents ? money(p.amountCents) : 'could not be read automatically' }); await reload(); });

  return (
    <Page title={c.name} subtitle={<span>{c.contactName} · {c.email ?? 'no email'} · {c.phone ?? ''} · <Link to="/customers" className="text-brand hover:underline">all customers</Link></span>}
      actions={<><Btn busy={act.busy === 'work'} onClick={() => act.run('work', async () => { setResult((await api.post(`/customers/${id}/work`))); await reload(); })}>Run agents on this account</Btn>
        <Btn onClick={() => act.run('hold', async () => { await api.patch(`/customers/${id}`, { creditHold: !c.creditHold }); await reload(); })}>{c.creditHold ? 'Release credit hold' : 'Place credit hold'}</Btn></>}>
      <Err msg={error || act.error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Account">
          <div className="mb-3 flex flex-wrap gap-1.5"><Badge>{c.segment}</Badge><Risk score={c.riskScore} />{c.creditHold && <Badge tone="red">credit hold</Badge>}{c.optOut && <Badge tone="violet">opted out</Badge>}<Badge tone="blue">{c.preferredChannel}</Badge><Badge>{c.language === 'am' ? 'Amharic' : 'English'}</Badge></div>
          <KV k="Outstanding" v={money(data.totals.due)} /><KV k="Overdue (collectible)" v={money(data.totals.overdue)} /><KV k="Oldest overdue" v={`${data.totals.maxDpd} days`} /><KV k="Credit limit" v={money(c.creditLimitCents)} />
          {data.creditLimitAdvice && data.creditLimitAdvice.change !== 'keep' && <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">Advice: {data.creditLimitAdvice.change} limit to {money(data.creditLimitAdvice.toCents)}. {data.creditLimitAdvice.reason}.</p>}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <a className="text-brand hover:underline" href={data.portalLink} target="_blank" rel="noreferrer">Open customer portal ↗</a>
            {data.telegramLink && <a className="text-brand hover:underline" href={data.telegramLink} target="_blank" rel="noreferrer">Telegram link for customer ↗</a>}
            <button className="text-brand hover:underline" onClick={() => act.run('lang', async () => { await api.patch(`/customers/${id}`, { language: c.language === 'am' ? 'en' : 'am' }); await reload(); })}>Switch to {c.language === 'am' ? 'English' : 'Amharic'}</button>
          </div>
        </Card>
        <Card title="Why this risk score">
          <div className="space-y-2">
            {(c.riskDrivers ?? []).map((d: any) => (
              <div key={d.key}>
                <div className="flex justify-between text-xs"><span>{d.label}</span><span className="tabular text-ink-2">{d.points} / {d.max}</span></div>
                <div className="mt-0.5 h-1.5 rounded bg-neutral-100"><div className="h-1.5 rounded bg-series-1" style={{ width: `${(d.points / d.max) * 100}%` }} /></div>
                <div className="text-[11px] text-ink-3">{d.detail}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Next best action">
          <div className="text-lg font-semibold">{NBA_LABEL[nba.type] ?? nba.type}</div>
          <p className="mt-1 text-[13px] text-ink-2">{nba.reason}</p>
          {nba.type !== 'wait' && <div className="mt-2 flex flex-wrap gap-1.5">{nba.tone && <Badge tone="blue">tone: {nba.tone}</Badge>}{nba.channel && <Badge tone="blue">{nba.channel}</Badge>}{nba.window && <Badge tone="blue">{nba.window}</Badge>}<Badge tone="green">expected value {money(nba.expectedValueCents)}</Badge></div>}
          {!!nba.candidates?.length && <details className="mt-2"><summary className="cursor-pointer text-xs text-brand">Approaches considered</summary><Table head={['Tone | channel | window', 'Success', 'Tries']} rows={nba.candidates.map((x: any) => [x.key, `${Math.round(x.mean * 100)}%`, x.pulls])} /></details>}
          <div className="mt-3 border-t border-line pt-3">
            <div className="mb-1 text-xs font-medium text-ink-2">Credit check for a new order</div>
            <div className="flex gap-2"><input className={inputCls} placeholder="Order amount" value={order} onChange={(e) => setOrder(e.target.value)} /><Btn busy={act.busy === 'cc'} onClick={() => act.run('cc', async () => setCredit(await api.post('/credit-check', { customerId: id, orderAmount: Number(order) })))}>Check</Btn></div>
            {credit && <div className="mt-2 text-[13px]"><Status value={credit.decision} />{credit.depositCents > 0 && <span className="ml-2">deposit {money(credit.depositCents)}</span>}<ul className="mt-1 list-disc pl-5 text-xs text-ink-2">{credit.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul></div>}
          </div>
        </Card>
      </div>

      <Card className="mt-4" title="Act as this customer (demo)">
        <p className="mb-2 text-xs text-ink-3">Sends a message through the same pipeline as a real Telegram message or email reply. With Telegram and Gmail connected, real messages arrive the same way.</p>
        <div className="flex flex-wrap gap-2">
          <select className={`${inputCls} w-28`} value={channel} onChange={(e) => setChannel(e.target.value)}><option value="telegram">Telegram</option><option value="email">Email</option></select>
          <input className={`${inputCls} min-w-[240px] flex-1`} placeholder='e.g. "Cash is tight, can we pay in instalments?"' value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && msg && send()} />
          <Btn kind="primary" busy={act.busy === 'sim'} disabled={!msg} onClick={send}>Send as customer</Btn>
          <input ref={file} type="file" accept="image/*,application/pdf" hidden onChange={(e) => e.target.files?.[0] && proof(e.target.files[0])} />
          <Btn busy={act.busy === 'proof'} onClick={() => file.current?.click()}>Send transfer-slip photo</Btn>
        </div>
        {result && <div className="mt-2 rounded-md border border-line bg-neutral-50 px-3 py-2 text-[13px]">Agents: <b>{result.intent ?? result.action}</b>{result.outcome ? <> → <b>{String(result.outcome).replace(/_/g, ' ')}</b></> : null}{result.detail ? `: ${result.detail}` : ''} <Link className="text-brand hover:underline" to={`/trace?customerId=${id}`}>see trace</Link></div>}
      </Card>

      <div className="mt-4">
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'timeline', label: 'Conversation' }, { key: 'invoices', label: `Invoices (${data.invoices.length})` }, { key: 'plans', label: 'Plans & promises' }, { key: 'payments', label: 'Payments & proofs' }, { key: 'disputes', label: `Disputes (${data.disputes.length})` }, { key: 'memory', label: 'Memory' }]} />
        {tab === 'timeline' && <Card>{data.interactions.length ? <div className="space-y-2">{data.interactions.map((i: any) => (
          <div key={i.id} className={`max-w-[85%] rounded-lg border px-3 py-2 ${i.direction === 'in' ? 'border-line bg-white' : i.direction === 'out' ? 'ml-auto border-brand/20 bg-brand-soft' : 'mx-auto border-dashed border-line bg-neutral-50 text-ink-2'}`}>
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3"><span>{when(i.createdAt)}</span><Badge>{i.direction === 'in' ? 'customer' : i.direction === 'out' ? 'agent' : 'system'} · {i.channel}</Badge><Badge>{i.kind.replace(/_/g, ' ')}</Badge>{i.tone && <Badge tone="blue">{i.tone}</Badge>}{i.intent && <Badge tone="violet">{i.intent.replace(/_/g, ' ')}</Badge>}{i.direction === 'out' && <Status value={i.status} />}</div>
            {i.subject && <div className="text-[13px] font-medium">{i.subject}</div>}
            <pre className="text-[13px] leading-relaxed">{i.body}</pre>
            {i.meta?.note && <div className="mt-1 text-[11px] text-ink-3">{i.meta.note}</div>}
          </div>))}</div> : <Empty>No conversation yet.</Empty>}</Card>}
        {tab === 'invoices' && <Card><Table head={['Invoice', 'Issued', 'Due', 'Amount', 'Balance', 'Status', 'Reminders', 'Predicted payment']} rows={data.invoices.map((i: any) => [i.number, day(i.issueDate), day(i.dueDate), money(i.amountCents, i.currency), money(i.amountCents - i.paidCents, i.currency), <span className="flex gap-1"><Status value={i.status} />{i.disputedCents > 0 && <Badge tone="violet">disputed {money(i.disputedCents, i.currency)}</Badge>}{i.pausedUntil && new Date(i.pausedUntil) > new Date() && <Badge>paused to {day(i.pausedUntil)}</Badge>}</span>, i.reminderStage, i.status === 'paid' ? `paid ${day(i.paidAt)}` : day(i.predictedPayDate)])} /></Card>}
        {tab === 'plans' && <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Payment plans">{data.plans.filter((p: any) => p.status !== 'cancelled').length ? data.plans.filter((p: any) => p.status !== 'cancelled').map((p: any) => <div key={p.id} className="mb-3 last:mb-0"><div className="flex items-center justify-between"><span className="font-medium">{p.label}</span><Status value={p.status} /></div><Table head={['#', 'Due', 'Amount', 'Status']} rows={p.instalments.map((x: any) => [x.seq, day(x.dueDate), money(x.amountCents), <Status value={x.status} />])} /></div>) : <Empty>No plans.</Empty>}</Card>
          <Card title="Promises to pay"><Table head={['Made', 'Amount', 'Due', 'Source', 'Status']} rows={data.promises.map((p: any) => [day(p.createdAt), money(p.amountCents), day(p.dueDate), p.source, <Status value={p.status} />])} empty="No promises." /></Card>
        </div>}
        {tab === 'payments' && <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Payments"><Table head={['Date', 'Amount', 'Reference', 'Applied to', 'Status']} rows={data.payments.map((p: any) => [day(p.date), money(p.amountCents, p.currency), p.reference ?? '–', p.allocations.map((a: any) => a.invoice.number).join(', ') || '–', <Status value={p.status} />])} empty="No payments." /></Card>
          <Card title="Proofs of payment"><Table head={['Received', 'Amount', 'Reference', 'Confidence', 'Status']} rows={data.proofs.map((p: any) => [day(p.createdAt), money(p.amountCents), p.reference ?? '–', p.confidence != null ? `${Math.round(p.confidence * 100)}%` : '–', <Status value={p.status} />])} empty="No proofs." /></Card>
        </div>}
        {tab === 'disputes' && <Card><Table head={['Opened', 'Category', 'Amount', 'Stage', 'Statement']} rows={data.disputes.map((d: any) => [day(d.createdAt), d.category, money(d.disputedCents), <Status value={d.stage} />, <span className="text-ink-2">{d.description}</span>])} empty="No disputes." /></Card>}
        {tab === 'memory' && <Card title="What the agents remember about this customer">{data.memories.length ? <ul className="space-y-1.5">{data.memories.map((m: any) => <li key={m.id} className="text-[13px]"><Badge>{m.kind}</Badge> <span className="text-ink-2">{m.text}</span></li>)}</ul> : <Empty>Nothing remembered yet.</Empty>}<p className="mt-3 text-[11px] text-ink-3">Notes are retrieved by meaning (embeddings in pgvector) when the agents write to this customer. Without Gemini the most recent notes are used.</p></Card>}
      </div>
    </Page>
  );
}

const KV = ({ k, v }: { k: string; v: string }) => <div className="flex justify-between border-b border-line/60 py-1 last:border-0"><span className="text-ink-2">{k}</span><span className="tabular font-medium">{v}</span></div>;

export { Field };

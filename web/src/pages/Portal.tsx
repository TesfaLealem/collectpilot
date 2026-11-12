// Customer self-service portal: mobile-first, no login. The signed link identifies one customer.
import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, money } from '../api';
import { Badge, Btn, Err, Field, inputCls, Status, useAction, useData } from '../ui';

const T = {
  en: { statement: 'Your statement', due: 'Total outstanding', overdue: 'Overdue', invoice: 'Invoice', dueDate: 'Due', balance: 'Balance', daysOver: 'days overdue', promise: 'Tell us when you will pay', promiseBtn: 'Confirm date', plan: 'Payment plan', askPlan: 'Ask for payment plan options', choose: 'Choose this plan', proof: 'Upload proof of payment', proofHint: 'A photo of the transfer slip or the bank confirmation.', upload: 'Upload', dispute: 'Something wrong with an invoice?', disputeBtn: 'Submit', message: 'Send us a message', send: 'Send', thanks: 'Thank you. We have received it.', promised: 'You promised to pay', by: 'by', active: 'Your payment plan', nothing: 'Nothing outstanding. Thank you!', category: 'What is wrong', details: 'Describe the problem', amount: 'Disputed amount (optional)', photos: 'Photos (optional)', paid: 'Recently paid' },
  am: { statement: 'የሂሳብ መግለጫዎ', due: 'ጠቅላላ ቀሪ', overdue: 'ጊዜው ያለፈ', invoice: 'ደረሰኝ', dueDate: 'የክፍያ ቀን', balance: 'ቀሪ', daysOver: 'ቀናት አልፏል', promise: 'መቼ እንደሚከፍሉ ያሳውቁን', promiseBtn: 'ቀኑን አረጋግጥ', plan: 'የክፍያ ዕቅድ', askPlan: 'የክፍያ ዕቅድ አማራጮችን ጠይቅ', choose: 'ይህን ዕቅድ ምረጥ', proof: 'የክፍያ ማረጋገጫ ይጫኑ', proofHint: 'የዝውውር ደረሰኝ ፎቶ ወይም የባንክ ማረጋገጫ።', upload: 'ጫን', dispute: 'በደረሰኙ ላይ ችግር አለ?', disputeBtn: 'ላክ', message: 'መልዕክት ይላኩልን', send: 'ላክ', thanks: 'እናመሰግናለን። ደርሶናል።', promised: 'ለመክፈል ቃል የገቡት', by: 'እስከ', active: 'የክፍያ ዕቅድዎ', nothing: 'ምንም ቀሪ ክፍያ የለም። እናመሰግናለን!', category: 'ችግሩ ምንድን ነው', details: 'ችግሩን ይግለጹ', amount: 'የተከራከሩበት መጠን (አማራጭ)', photos: 'ፎቶዎች (አማራጭ)', paid: 'በቅርቡ የተከፈሉ' },
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="rounded-lg border border-line bg-white p-4"><h2 className="mb-2 font-semibold">{title}</h2>{children}</section>;

export default function Portal() {
  const { token = '' } = useParams();
  const { data, error, loading, reload } = useData(() => api.portal.get(token), [token]);
  const act = useAction();
  const [lang, setLang] = useState<'en' | 'am' | ''>('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [d, setD] = useState({ invoiceId: '', category: 'quantity', text: '', amount: '' });
  const proof = useRef<HTMLInputElement>(null), photos = useRef<HTMLInputElement>(null);
  if (loading && !data) return <div className="p-6 text-center text-ink-3">Loading…</div>;
  if (!data) return <div className="mx-auto max-w-md p-6"><Err msg={error || 'This link is invalid or has expired.'} /></div>;
  const L = T[(lang || data.customer.language || 'en') as 'en' | 'am'] ?? T.en;
  const cur = data.currency;
  const done = async (text?: string) => { setNote(text ?? L.thanks); await reload(); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-5">
      <header className="flex items-start justify-between gap-3">
        <div><div className="text-lg font-semibold text-brand">{data.business}</div><div className="text-ink-2">{data.customer.name}</div></div>
        <button className="rounded-md border border-line bg-white px-2 py-1 text-xs" onClick={() => setLang(L === T.en ? 'am' : 'en')}>{L === T.en ? 'አማርኛ' : 'English'}</button>
      </header>
      {note && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900">{note}</div>}
      <Err msg={act.error} />

      <Section title={L.statement}>
        <div className="mb-3 grid grid-cols-2 gap-3">
          <div className="rounded-md bg-neutral-50 p-3"><div className="text-xs text-ink-2">{L.due}</div><div className="tabular text-lg font-semibold">{money(data.totals.due, cur)}</div></div>
          <div className="rounded-md bg-neutral-50 p-3"><div className="text-xs text-ink-2">{L.overdue}</div><div className="tabular text-lg font-semibold text-red-700">{money(data.totals.overdue, cur)}</div></div>
        </div>
        {data.invoices.length ? data.invoices.map((i: any) => (
          <div key={i.id} className="flex items-center justify-between gap-2 border-t border-line py-2">
            <div><div className="font-medium">{L.invoice} {i.number}</div><div className="text-xs text-ink-2">{L.dueDate} {i.dueDate}{i.daysOverdue > 0 && <span className="text-red-700"> · {i.daysOverdue} {L.daysOver}</span>}</div></div>
            <div className="text-right"><div className="tabular font-medium">{money(i.amountCents - i.paidCents, i.currency)}</div><div className="flex justify-end gap-1">{i.status !== 'open' && <Status value={i.status} />}{i.disputedCents > 0 && <Badge tone="violet">disputed</Badge>}</div></div>
          </div>)) : <p className="text-ink-2">{L.nothing}</p>}
        {!!data.recentlyPaid.length && <p className="mt-2 border-t border-line pt-2 text-xs text-ink-3">{L.paid}: {data.recentlyPaid.map((p: any) => `${p.number} (${p.paidAt})`).join(', ')}</p>}
      </Section>

      {data.activePlan && <Section title={L.active}>
        <div className="mb-1 text-[13px] text-ink-2">{data.activePlan.label}</div>
        {data.activePlan.instalments.map((i: any) => <div key={i.seq} className="flex items-center justify-between border-t border-line py-1.5"><span>{i.seq}. {i.dueDate}</span><span className="flex items-center gap-2"><span className="tabular">{money(i.amountCents, cur)}</span><Status value={i.status} /></span></div>)}
      </Section>}

      {data.invoices.length > 0 && !data.activePlan && <>
        <Section title={L.promise}>
          {data.promise && <p className="mb-2 text-[13px] text-ink-2">{L.promised} {money(data.promise.amountCents, cur)} {L.by} {data.promise.dueDate}.</p>}
          <div className="flex gap-2"><input type="date" className={inputCls} value={date} max={data.limits.latestPromiseDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
            <Btn kind="primary" busy={act.busy === 'promise'} disabled={!date} onClick={() => act.run('promise', async () => { await api.portal.post(token, '/promise', { date }); setDate(''); await done(); })}>{L.promiseBtn}</Btn></div>
        </Section>
        <Section title={L.plan}>
          {data.offeredPlans.length ? <div className="space-y-3">{data.offeredPlans.map((p: any, k: number) => (
            <div key={p.id} className="rounded-md border border-line p-3">
              <div className="font-medium">{k + 1}. {p.label}</div>
              <ul className="my-1.5 text-[13px] text-ink-2">{p.instalments.map((i: any) => <li key={i.seq} className="tabular">{i.dueDate}: {money(i.amountCents, cur)}</li>)}</ul>
              <Btn kind="primary" busy={act.busy === p.id} onClick={() => act.run(p.id, async () => { await api.portal.post(token, '/plan', { planId: p.id }); await done(); })}>{L.choose}</Btn>
            </div>))}</div>
            : <Btn busy={act.busy === 'ask'} onClick={() => act.run('ask', async () => { await api.portal.post(token, '/request-plan'); await done(' '); setNote(''); })}>{L.askPlan}</Btn>}
        </Section>
      </>}

      {data.invoices.length > 0 && <Section title={L.proof}>
        <p className="mb-2 text-xs text-ink-3">{L.proofHint}</p>
        <input ref={proof} type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) act.run('proof', async () => { const fd = new FormData(); fd.append('file', f); await api.portal.post(token, '/proof', fd); await done(); }); }} />
        <Btn kind="primary" busy={act.busy === 'proof'} onClick={() => proof.current?.click()}>{L.upload}</Btn>
        {data.proofs.map((p: any) => <div key={p.id} className="mt-2 flex items-center justify-between text-[13px] text-ink-2"><span>{p.createdAt} · {money(p.amountCents, cur)}</span><Status value={p.status === 'review' ? 'received' : p.status} /></div>)}
      </Section>}

      {data.invoices.length > 0 && <Section title={L.dispute}>
        <div className="space-y-2.5">
          <Field label={L.invoice}><select className={inputCls} value={d.invoiceId} onChange={(e) => setD({ ...d, invoiceId: e.target.value })}><option value="">–</option>{data.invoices.map((i: any) => <option key={i.id} value={i.id}>{i.number}</option>)}</select></Field>
          <Field label={L.category}><select className={inputCls} value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}>{data.limits.disputeCategories.map((c: string) => <option key={c}>{c}</option>)}</select></Field>
          <Field label={L.details}><textarea className={`${inputCls} h-20`} value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} /></Field>
          <Field label={L.amount}><input className={inputCls} inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} /></Field>
          <Field label={L.photos}><input ref={photos} type="file" accept="image/*,application/pdf" multiple className="text-[13px]" /></Field>
          <Btn kind="primary" busy={act.busy === 'dispute'} disabled={!d.invoiceId || d.text.length < 5} onClick={() => act.run('dispute', async () => {
            const fd = new FormData(); fd.append('invoiceId', d.invoiceId); fd.append('category', d.category); fd.append('text', d.text); if (d.amount) fd.append('amount', d.amount);
            for (const f of Array.from(photos.current?.files ?? []).slice(0, 3)) fd.append('files', f);
            await api.portal.post(token, '/dispute', fd); setD({ invoiceId: '', category: 'quantity', text: '', amount: '' }); await done();
          })}>{L.disputeBtn}</Btn>
        </div>
        {data.disputes.map((x: any) => <div key={x.id} className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[13px] text-ink-2"><span>{x.createdAt} · {x.category} · {money(x.disputedCents, cur)}</span><Status value={x.stage} /></div>)}
      </Section>}

      <Section title={L.message}>
        <div className="flex gap-2"><input className={inputCls} value={msg} onChange={(e) => setMsg(e.target.value)} /><Btn busy={act.busy === 'msg'} disabled={msg.length < 2} onClick={() => act.run('msg', async () => { await api.portal.post(token, '/message', { text: msg }); setMsg(''); await done(); })}>{L.send}</Btn></div>
      </Section>
      <p className="pb-6 text-center text-[11px] text-ink-3">Secure link for {data.customer.name} only. Powered by CollectPilot.</p>
    </div>
  );
}

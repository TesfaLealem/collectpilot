import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, day, getSession, money } from '../api';
import { Badge, Btn, Card, Empty, Err, Loading, Page, Status, Table, Tabs, useAction, useData } from '../ui';

/** Uploaded files need the session header, so they are fetched and shown from an object URL. */
export function AuthFile({ path, mime }: { path: string; mime?: string | null }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let u = '';
    fetch(`/api/files?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${getSession()?.token ?? ''}` } }).then((r) => (r.ok ? r.blob() : Promise.reject())).then((b) => { u = URL.createObjectURL(b); setUrl(u); }).catch(() => setUrl(''));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [path]);
  if (!url) return <div className="flex h-40 items-center justify-center rounded-md border border-line bg-neutral-50 text-xs text-ink-3">File preview unavailable</div>;
  return mime?.includes('pdf') ? <a className="text-brand hover:underline" href={url} target="_blank" rel="noreferrer">Open PDF ↗</a> : <img src={url} alt="Uploaded document" className="max-h-80 w-full rounded-md border border-line object-contain" />;
}

export default function Reconciliation() {
  const pays = useData(() => api.get('/payments'));
  const proofs = useData(() => api.get('/proofs'));
  const invoices = useData(() => api.get('/invoices?status=open'));
  const act = useAction();
  const [tab, setTab] = useState('suggested');
  const [summary, setSummary] = useState<any>(null);
  const file = useRef<HTMLInputElement>(null);
  const reload = async () => { await pays.reload(); await proofs.reload(); await invoices.reload(); };
  const upload = (f: File) => act.run('stmt', async () => { const fd = new FormData(); fd.append('file', f); setSummary(await api.post('/reconciliation/statement', fd)); await reload(); });
  if (pays.loading && !pays.data) return <Loading />;
  const all: any[] = pays.data ?? [];
  const by = (s: string[]) => all.filter((p) => s.includes(p.status));
  const invNo = (id: string) => (invoices.data ?? []).find((i: any) => i.id === id)?.number ?? 'invoice';
  const review = (proofs.data ?? []).filter((p: any) => ['review', 'claimed'].includes(p.status));

  return (
    <Page title="Reconciliation" subtitle="Bank statements, payment emails, and transfer slips matched to invoices."
      actions={<><input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /><Btn kind="primary" busy={act.busy === 'stmt'} onClick={() => file.current?.click()}>Upload bank statement (CSV)</Btn></>}>
      <Err msg={pays.error || act.error} />
      {summary && <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900">{summary.imported} payments read: <b>{summary.matched} applied automatically</b>, {summary.suggested} need confirmation, {summary.unmatched} unmatched, {summary.duplicates} duplicates skipped.</div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'suggested', label: `Suggested (${by(['suggested']).length})` }, { key: 'unmatched', label: `Unapplied cash (${by(['unmatched', 'unapplied']).length})` }, { key: 'matched', label: `Applied (${by(['matched']).length})` }, { key: 'proofs', label: `Proofs of payment (${review.length})` }]} />

      {tab === 'suggested' && <div className="space-y-3">{by(['suggested']).length ? by(['suggested']).map((p) => (
        <Card key={p.id}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-medium tabular">{money(p.amountCents, p.currency)} <span className="font-normal text-ink-2">on {day(p.date)}</span></div>
              <div className="text-xs text-ink-2">{[p.reference, p.narration, p.payerName].filter(Boolean).join(' · ')}</div>
              <div className="mt-1.5 text-[13px]"><Badge tone="amber">confidence {Math.round((p.matchConfidence ?? 0) * 100)}%</Badge> <span className="text-ink-2">{p.matchReason}</span></div>
              {p.customer && <div className="mt-1 text-[13px]">Customer: <Link className="text-brand hover:underline" to={`/customers/${p.customerId}`}>{p.customer.name}</Link></div>}
              <ul className="mt-1 list-disc pl-5 text-[13px]">{(p.suggestion?.allocations ?? []).map((a: any) => <li key={a.invoiceId}>{money(a.amountCents, p.currency)} → {invNo(a.invoiceId)}</li>)}{p.suggestion?.unappliedCents > 0 && <li>{money(p.suggestion.unappliedCents, p.currency)} left unapplied</li>}</ul>
            </div>
            <Btn kind="primary" busy={act.busy === p.id} disabled={!p.suggestion?.allocations?.length} onClick={() => act.run(p.id, async () => { await api.post(`/payments/${p.id}/apply`, { allocations: p.suggestion.allocations }); await reload(); })}>Confirm and apply</Btn>
          </div>
        </Card>)) : <Card><Empty>No suggestions waiting. Matches above the confidence threshold are applied automatically.</Empty></Card>}</div>}

      {tab === 'unmatched' && <Card><Table head={['Date', 'Amount', 'Reference', 'Narration', 'Payer', 'Why']} rows={by(['unmatched', 'unapplied']).map((p) => [day(p.date), <span className="tabular">{money(p.unappliedCents || p.amountCents, p.currency)}</span>, p.reference ?? '–', p.narration ?? '–', p.payerName ?? '–', <span className="text-ink-2">{p.matchReason}</span>])} empty="No unapplied cash." /></Card>}
      {tab === 'matched' && <Card><Table head={['Date', 'Amount', 'Customer', 'Applied to', 'Source', 'Confidence', 'How it was matched']} rows={by(['matched']).slice(0, 80).map((p) => [day(p.date), <span className="tabular">{money(p.amountCents, p.currency)}</span>, p.customer?.name ?? '–', p.allocations.map((a: any) => a.invoice.number).join(', '), p.source, p.matchConfidence != null ? `${Math.round(p.matchConfidence * 100)}%` : '–', <span className="text-ink-2">{p.matchReason}</span>])} /></Card>}

      {tab === 'proofs' && <div className="grid gap-4 md:grid-cols-2">{review.length ? review.map((p: any) => (
        <Card key={p.id} title={<span>{p.customerName} <Status value={p.status} /></span>}>
          <div className="grid gap-3 sm:grid-cols-2">
            {p.filePath ? <AuthFile path={p.filePath} mime={p.mimeType} /> : <div />}
            <div className="text-[13px]">
              <div className="mb-1 text-xs font-medium text-ink-2">Read from the slip</div>
              <div>Amount: <b>{money(p.amountCents)}</b></div><div>Date: {day(p.date)}</div><div>Reference: {p.reference ?? '–'}</div><div>Bank: {p.bank ?? '–'}</div><div>For: {p.invoiceNumber ?? '–'}</div>
              <div>Reading confidence: {p.confidence != null ? `${Math.round(p.confidence * 100)}%` : 'not read'}</div>
              {(p.raw?.flags ?? []).map((f: string) => <div key={f} className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{f}</div>)}
              <div className="mt-3 flex gap-2">
                {p.status === 'review' && <Btn small kind="primary" busy={act.busy === p.id} onClick={() => act.run(p.id, async () => { await api.post(`/proofs/${p.id}/accept`); await reload(); })}>Accept (pause reminders)</Btn>}
                <Btn small kind="danger" onClick={() => act.run(p.id, async () => { await api.post(`/proofs/${p.id}/reject`); await reload(); })}>Reject</Btn>
              </div>
              <p className="mt-2 text-[11px] text-ink-3">A proof never marks an invoice paid. It becomes "payment claimed" and is confirmed only when the bank line arrives.</p>
            </div>
          </div>
        </Card>)) : <Card className="md:col-span-2"><Empty>No proofs waiting.</Empty></Card>}</div>}
    </Page>
  );
}

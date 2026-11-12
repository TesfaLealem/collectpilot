import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, day, money } from '../api';
import { Badge, Btn, Card, Err, Field, inputCls, Loading, Modal, Page, Status, Table, Tabs, useAction, useData } from '../ui';

export default function Invoices() {
  const [status, setStatus] = useState('open');
  const { data, error, loading, reload } = useData(() => api.get(`/invoices?status=${status}`), [status]);
  const customers = useData(() => api.get('/customers'));
  const act = useAction();
  const csv = useRef<HTMLInputElement>(null), doc = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [ex, setEx] = useState<any>(null); // extracted invoice awaiting confirmation
  const [sheet, setSheet] = useState('');
  const today = new Date();

  const importCsv = (f: File) => act.run('csv', async () => { const fd = new FormData(); fd.append('file', f); const r = await api.post('/invoices/import-csv', fd); setNote(`Imported ${r.created} invoices (${r.newCustomers} new customers, ${r.skipped} already existed${r.errors.length ? `, ${r.errors.length} rows rejected: ${r.errors.slice(0, 3).join('; ')}` : ''}).`); await reload(); });
  const extract = (f: File) => act.run('doc', async () => {
    const fd = new FormData(); fd.append('file', f);
    const r = await api.post('/documents/extract', fd);
    if (!r.ok) throw new Error(r.error);
    const x = r.fields;
    setEx({ warnings: r.warnings, customerId: r.matchedCustomer?.id ?? '', customerName: x.customerName ?? '', number: x.invoiceNumber ?? '', issueDate: x.issueDate ?? '', dueDate: x.dueDate ?? '', amount: x.total ?? 0, currency: x.currency ?? '', lines: x.lines ?? [], confidence: x.confidence });
  });
  const confirm = () => act.run('confirm', async () => {
    let customerId = ex.customerId;
    if (!customerId) customerId = (await api.post('/customers', { name: ex.customerName })).id;
    const due = ex.dueDate || new Date(new Date(ex.issueDate).getTime() + 30 * 86400000).toISOString().slice(0, 10);
    await api.post('/invoices', { customerId, number: ex.number, issueDate: ex.issueDate || due, dueDate: due, amount: Number(ex.amount), currency: ex.currency || undefined, lines: ex.lines, source: 'extraction' });
    setEx(null); setNote(`Invoice ${ex.number} saved from the document.`); await reload(); await customers.reload();
  });

  return (
    <Page title="Invoices" subtitle="Import from a sheet or CSV, or read an invoice PDF or phone photo."
      actions={<>
        <input ref={csv} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
        <input ref={doc} type="file" accept="image/*,application/pdf" hidden onChange={(e) => e.target.files?.[0] && extract(e.target.files[0])} />
        <Btn busy={act.busy === 'csv'} onClick={() => csv.current?.click()}>Import CSV</Btn>
        <Btn kind="primary" busy={act.busy === 'doc'} onClick={() => doc.current?.click()}>Read invoice photo / PDF</Btn>
      </>}>
      <Err msg={error || act.error} />
      {note && <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900">{note}</div>}
      <Card className="mb-4" title="Import from Google Sheets">
        <div className="flex flex-wrap gap-2"><input className={`${inputCls} min-w-[260px] flex-1`} placeholder="Paste the Google Sheet link (columns: customer, invoice, amount, date, due date)" value={sheet} onChange={(e) => setSheet(e.target.value)} />
          <Btn busy={act.busy === 'sheet'} disabled={!sheet} onClick={() => act.run('sheet', async () => { const r = await api.post('/invoices/import-sheet', { spreadsheetId: sheet }); setNote(`Imported ${r.created} invoices from the sheet (${r.skipped} already existed).`); await reload(); })}>Import sheet</Btn></div>
        <p className="mt-1 text-[11px] text-ink-3">Needs Google connected in Policy & settings. A sample CSV is in the repository under samples/.</p>
      </Card>
      <Tabs value={status} onChange={setStatus} tabs={[{ key: 'open', label: 'Open' }, { key: 'paid', label: 'Paid' }, { key: 'all', label: 'All' }]} />
      <Card>{loading && !data ? <Loading /> : <Table head={['Invoice', 'Customer', 'Due', 'Days overdue', 'Amount', 'Balance', 'Status', 'Predicted payment', 'Source']}
        rows={(data ?? []).map((i: any) => { const dpd = Math.round((today.getTime() - new Date(i.dueDate).getTime()) / 86400000); return [
          i.number, <Link className="text-brand hover:underline" to={`/customers/${i.customerId}`}>{i.customer.name}</Link>, day(i.dueDate), i.status !== 'paid' && dpd > 0 ? <span className="text-red-700">{dpd}</span> : '–',
          <span className="tabular">{money(i.amountCents, i.currency)}</span>, <span className="tabular">{money(i.amountCents - i.paidCents, i.currency)}</span>,
          <span className="flex gap-1"><Status value={i.status} />{i.disputedCents > 0 && <Badge tone="violet">disputed</Badge>}</span>, i.status === 'paid' ? '–' : day(i.predictedPayDate), i.source]; })} />}</Card>

      {ex && (
        <Modal title="Confirm the invoice read from the document" onClose={() => setEx(null)} wide>
          {ex.warnings.map((w: string) => <div key={w} className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-[13px] text-amber-900">{w}</div>)}
          <p className="mb-3 text-xs text-ink-3">Read by Gemini vision with {Math.round((ex.confidence ?? 0) * 100)}% confidence. Nothing is saved until you confirm.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Customer"><select className={inputCls} value={ex.customerId} onChange={(e) => setEx({ ...ex, customerId: e.target.value })}><option value="">New customer: {ex.customerName || '(enter name)'}</option>{(customers.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            {!ex.customerId && <Field label="New customer name"><input className={inputCls} value={ex.customerName} onChange={(e) => setEx({ ...ex, customerName: e.target.value })} /></Field>}
            <Field label="Invoice number"><input className={inputCls} value={ex.number} onChange={(e) => setEx({ ...ex, number: e.target.value })} /></Field>
            <Field label="Total"><input className={inputCls} value={ex.amount} onChange={(e) => setEx({ ...ex, amount: e.target.value })} /></Field>
            <Field label="Currency"><input className={inputCls} value={ex.currency} onChange={(e) => setEx({ ...ex, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Invoice date"><input type="date" className={inputCls} value={ex.issueDate} onChange={(e) => setEx({ ...ex, issueDate: e.target.value })} /></Field>
            <Field label="Due date"><input type="date" className={inputCls} value={ex.dueDate} onChange={(e) => setEx({ ...ex, dueDate: e.target.value })} /></Field>
          </div>
          {!!ex.lines.length && <div className="mt-3"><Table head={['Line', 'Qty', 'Unit price', 'Total']} rows={ex.lines.map((l: any) => [l.description, l.quantity, l.unitPrice, l.total])} /></div>}
          <div className="mt-4 flex justify-end gap-2"><Btn onClick={() => setEx(null)}>Discard</Btn><Btn kind="primary" busy={act.busy === 'confirm'} disabled={!ex.number || !ex.amount || (!ex.customerId && !ex.customerName) || !(ex.issueDate || ex.dueDate)} onClick={confirm}>Confirm and save</Btn></div>
        </Modal>
      )}
    </Page>
  );
}

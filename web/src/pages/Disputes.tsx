import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, day, money } from '../api';
import { Badge, Btn, Card, Empty, Err, Loading, Modal, Page, Status, useAction, useData } from '../ui';
import { AuthFile } from './Reconciliation';

const STAGES = [['opened', 'Opened'], ['evidence', 'Evidence'], ['proposed', 'Resolution proposed'], ['resolved', 'Resolved'], ['rejected', 'Rejected']] as const;

export default function Disputes() {
  const { data, error, loading, reload } = useData(() => api.get('/disputes'));
  const act = useAction();
  const [open, setOpen] = useState<any>(null);
  if (loading && !data) return <Loading />;
  const list: any[] = data ?? [];
  return (
    <Page title="Disputes" subtitle="The disputed amount is set aside; the rest of the invoice stays in collection. Resolutions wait for approval in the action centre.">
      <Err msg={error || act.error} />
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
        {STAGES.map(([key, label]) => {
          const items = list.filter((d) => d.stage === key);
          return (
            <div key={key} className="rounded-lg border border-line bg-neutral-50 p-2">
              <div className="mb-2 flex items-center justify-between px-1 text-xs font-semibold text-ink-2">{label}<span>{items.length}</span></div>
              <div className="space-y-2">
                {items.map((d) => (
                  <button key={d.id} onClick={() => setOpen(d)} className="block w-full rounded-md border border-line bg-white p-2.5 text-left hover:border-brand">
                    <div className="text-[13px] font-medium">{d.customer.name}</div>
                    <div className="text-xs text-ink-2">{d.invoice?.number} · {d.category}</div>
                    <div className="tabular mt-1 text-[13px]">{money(d.disputedCents, d.invoice?.currency)}</div>
                    <div className="mt-1 text-[11px] text-ink-3">{day(d.createdAt)} · {(d.evidence ?? []).length} evidence file(s)</div>
                  </button>
                ))}
                {!items.length && <div className="px-1 py-3 text-center text-xs text-ink-3">None</div>}
              </div>
            </div>
          );
        })}
      </div>
      {!list.length && <Card className="mt-4"><Empty>No disputes yet.</Empty></Card>}
      {open && (
        <Modal title={`${open.customer.name}: ${open.invoice?.number}`} onClose={() => setOpen(null)} wide>
          <div className="mb-2 flex flex-wrap gap-1.5"><Status value={open.stage} /><Badge>{open.category}</Badge><Badge tone="violet">disputed {money(open.disputedCents, open.invoice?.currency)}</Badge><Link className="text-xs text-brand hover:underline" to={`/customers/${open.customerId}`}>customer page</Link></div>
          <div className="text-xs font-medium text-ink-2">Customer statement</div>
          <pre className="mb-3 rounded-md border border-line bg-neutral-50 p-2 text-[13px]">{open.description}</pre>
          {open.proposal && <><div className="text-xs font-medium text-ink-2">Dispute agent proposal <Badge tone="blue">{open.proposal.source === 'gemini' ? 'Gemini' : 'rules'}</Badge></div>
            <div className="mb-3 rounded-md border border-line bg-brand-soft p-2 text-[13px]"><b>{String(open.proposal.resolution).replace(/_/g, ' ')}</b>{open.proposal.creditCents > 0 && <> for {money(open.proposal.creditCents, open.invoice?.currency)}</>}. {open.proposal.explanation}</div></>}
          {open.creditNote && <p className="mb-3 text-[13px]">Credit note <b>{open.creditNote.number}</b> issued for {money(open.creditNote.amountCents, open.invoice?.currency)}.</p>}
          {!!(open.evidence ?? []).length && <><div className="mb-1 text-xs font-medium text-ink-2">Evidence</div><div className="mb-3 grid gap-2 sm:grid-cols-2">{open.evidence.map((e: any, i: number) => <AuthFile key={i} path={e.filePath} mime={e.mimeType} />)}</div></>}
          {!['resolved', 'rejected'].includes(open.stage) && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <label className="inline-flex cursor-pointer items-center rounded-md border border-line bg-white px-3 py-1.5 text-[13px] font-medium hover:bg-neutral-50">Add evidence<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) act.run('ev', async () => { const fd = new FormData(); fd.append('file', f); await api.post(`/disputes/${open.id}/evidence`, fd); setOpen(null); await reload(); }); }} /></label>
              <Btn busy={act.busy === 'prop'} onClick={() => act.run('prop', async () => { await api.post(`/disputes/${open.id}/propose`); setOpen(null); await reload(); })}>Re-assess</Btn>
              <Link to="/actions" className="text-[13px] text-brand hover:underline">Approve or reject the resolution in the action centre →</Link>
            </div>
          )}
        </Modal>
      )}
    </Page>
  );
}

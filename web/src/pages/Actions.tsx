import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, when } from '../api';
import { Badge, Btn, Card, Empty, Err, Field, inputCls, Loading, Modal, Page, Status, Table, Tabs, useAction, useData } from '../ui';

export default function Actions() {
  const [tab, setTab] = useState('pending');
  const ap = useData(() => api.get(`/approvals?status=${tab === 'history' ? 'history' : 'pending'}`), [tab]);
  const runs = useData(() => api.get('/trace'));
  const act = useAction();
  const [edit, setEdit] = useState<any>(null);
  const decide = (id: string, ok: boolean, body?: { subject?: string; body?: string }) => act.run(id, async () => { await api.post(`/approvals/${id}/${ok ? 'approve' : 'reject'}`, body ?? {}); setEdit(null); await ap.reload(); await runs.reload(); });
  const list: any[] = ap.data ?? [];
  const pending = list.filter((a) => a.status === 'pending'), shadow = list.filter((a) => a.status === 'shadow');

  const Item = ({ a }: { a: any }) => (
    <div className="rounded-lg border border-line bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">{a.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-2"><Badge tone="blue">{a.agent}</Badge><Badge>{a.actionType.replace(/_/g, ' ')}</Badge>{a.status === 'shadow' && <Badge tone="violet">shadow suggestion</Badge>}{a.customer && <Link className="text-brand hover:underline" to={`/customers/${a.customer.id}`}>{a.customer.name}</Link>}<span>{when(a.createdAt)}</span></div>
        </div>
        {tab === 'pending' ? (
          <div className="flex gap-1.5">
            <Btn small kind="primary" busy={act.busy === a.id} onClick={() => decide(a.id, true)}>{a.actionType === 'call_task' ? 'Mark done' : 'Approve'}</Btn>
            {a.payload?.body && <Btn small onClick={() => setEdit({ ...a, subject: a.payload.subject ?? '', body: a.payload.body })}>Edit</Btn>}
            <Btn small kind="danger" onClick={() => decide(a.id, false)}>Reject</Btn>
          </div>
        ) : <div className="flex items-center gap-2 text-xs text-ink-2"><Status value={a.status} />{a.decidedBy}</div>}
      </div>
      <p className="mt-2 text-[13px] text-ink-2"><b className="text-ink">Why:</b> {a.reason}</p>
      {a.payload?.customerMessage && <div className="mt-2 rounded-md border border-line bg-neutral-50 p-2 text-[13px]"><span className="text-xs text-ink-3">Customer wrote:</span><pre>{a.payload.customerMessage}</pre></div>}
      {(a.payload?.body || a.payload?.brief) && <details className="mt-2"><summary className="cursor-pointer text-xs text-brand">{a.payload.brief ? 'Call brief' : `Draft message (${a.payload.channel})`}</summary><pre className="mt-1 rounded-md border border-line bg-neutral-50 p-2 text-[13px]">{a.payload.subject ? `Subject: ${a.payload.subject}\n\n` : ''}{a.payload.body ?? a.payload.brief}</pre></details>}
    </div>
  );

  return (
    <Page title="Action centre" subtitle="What the agents did, what they plan, and what needs you.">
      <Err msg={ap.error || act.error} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'pending', label: `Needs approval${tab === 'pending' && pending.length ? ` (${pending.length})` : ''}` }, { key: 'history', label: 'Decided' }, { key: 'activity', label: 'Agent activity' }]} />
      {tab === 'activity' ? (
        <Card><Table head={['When', 'Trigger', 'Customer', 'Outcome', 'Steps', '']} rows={(runs.data ?? []).map((r: any) => [<span className="whitespace-nowrap text-ink-2">{when(r.startedAt)}</span>, r.trigger, r.customerName ?? '–', <span className="text-ink-2">{r.summary}</span>, r._count.steps, <Link className="text-brand hover:underline" to={`/trace?run=${r.id}`}>Trace</Link>])} /></Card>
      ) : ap.loading && !ap.data ? <Loading /> : (
        <div className="space-y-3">
          {tab === 'pending' && !pending.length && !shadow.length && <Card><Empty>Nothing is waiting for you. The agents are working inside the limits you set.</Empty></Card>}
          {(tab === 'pending' ? pending : list).map((a) => <Item key={a.id} a={a} />)}
          {tab === 'pending' && !!shadow.length && <><h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Shadow-mode suggestions (nothing was sent)</h3>{shadow.map((a) => <Item key={a.id} a={a} />)}</>}
        </div>
      )}
      {edit && (
        <Modal title="Edit before sending" onClose={() => setEdit(null)} wide>
          <div className="space-y-3">
            <Field label="Subject"><input className={inputCls} value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></Field>
            <Field label="Message"><textarea className={`${inputCls} h-64`} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
            <div className="flex justify-end gap-2"><Btn onClick={() => setEdit(null)}>Cancel</Btn><Btn kind="primary" busy={act.busy === edit.id} onClick={() => decide(edit.id, true, { subject: edit.subject, body: edit.body })}>Approve and send</Btn></div>
          </div>
        </Modal>
      )}
    </Page>
  );
}

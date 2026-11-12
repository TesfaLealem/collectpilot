import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, when } from '../api';
import { Badge, Card, Empty, Err, Loading, Page, Status, useData } from '../ui';

const AGENT_TONE: Record<string, string> = { Analyst: 'blue', Strategist: 'violet', Communicator: 'green', Negotiator: 'amber', Reconciler: 'blue', 'Dispute agent': 'red', 'Policy engine': 'gray', Human: 'gray', Orchestrator: 'gray' };
const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export default function Trace() {
  const [params, setParams] = useSearchParams();
  const customerId = params.get('customerId') ?? '';
  const runs = useData(() => api.get(`/trace${customerId ? `?customerId=${customerId}` : ''}`), [customerId]);
  const [sel, setSel] = useState(params.get('run') ?? '');
  const [run, setRun] = useState<any>(null);
  useEffect(() => { if (!sel && runs.data?.length) setSel(runs.data[0].id); }, [runs.data, sel]);
  useEffect(() => { if (sel) api.get(`/trace/${sel}`).then(setRun).catch(() => setRun(null)); }, [sel]);
  if (runs.loading && !runs.data) return <Loading />;
  return (
    <Page title="Agent trace" subtitle="Every decision: what the agent saw, why it acted, which tool it used, and the result."
      actions={customerId ? <button className="text-[13px] text-brand hover:underline" onClick={() => setParams({})}>Show all customers</button> : undefined}>
      <Err msg={runs.error} />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card title="Runs" className="max-h-[75vh] overflow-y-auto">
          {(runs.data ?? []).length ? (runs.data ?? []).map((r: any) => (
            <button key={r.id} onClick={() => setSel(r.id)} className={`mb-1.5 block w-full rounded-md border px-2.5 py-2 text-left ${sel === r.id ? 'border-brand bg-brand-soft' : 'border-line bg-white hover:bg-neutral-50'}`}>
              <div className="flex items-center justify-between gap-2 text-[11px] text-ink-3"><span>{when(r.startedAt)}</span><Status value={r.status} /></div>
              <div className="text-[13px] font-medium">{r.trigger}</div>
              {r.customerName && <div className="text-xs text-ink-2">{r.customerName}</div>}
              <div className="mt-0.5 line-clamp-2 text-xs text-ink-2">{r.summary}</div>
            </button>)) : <Empty>No runs yet.</Empty>}
        </Card>
        <Card title={run ? `${run.trigger}: ${run.steps.length} steps` : 'Select a run'}>
          {run ? <ol className="space-y-3">
            {run.steps.map((s: any) => (
              <li key={s.id} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-1.5"><span className="tabular text-xs text-ink-3">{s.seq}</span><Badge tone={AGENT_TONE[s.agent] ?? 'gray'}>{s.agent}</Badge><span className="text-[13px] font-medium">{s.action.replace(/_/g, ' ')}</span>{s.tool && <Badge>tool: {s.tool}</Badge>}<span className="ml-auto text-[11px] text-ink-3">{s.ms} ms</span></div>
                {s.reasoning && <p className="mt-1.5 text-[13px] text-ink-2">{s.reasoning}</p>}
                <div className="mt-1.5 grid gap-2 md:grid-cols-2">
                  {s.input != null && <div><div className="text-[11px] font-medium text-ink-3">Input</div><pre className="max-h-48 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[11px]">{json(s.input)}</pre></div>}
                  {s.output != null && <div><div className="text-[11px] font-medium text-ink-3">Result</div><pre className="max-h-48 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[11px]">{json(s.output)}</pre></div>}
                </div>
              </li>))}
            <li className="text-[13px] text-ink-2"><b className="text-ink">Outcome:</b> {run.summary}</li>
          </ol> : <Empty>Pick a run on the left.</Empty>}
        </Card>
      </div>
    </Page>
  );
}

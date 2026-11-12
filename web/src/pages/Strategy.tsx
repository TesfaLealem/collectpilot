import { useState } from 'react';
import { api } from '../api';
import { Badge, Card, Err, Loading, Page, Table, Tabs, useData } from '../ui';

export default function Strategy() {
  const { data, error, loading } = useData(() => api.get('/strategy'));
  const [seg, setSeg] = useState('forgetful');
  if (loading && !data) return <Loading />;
  const s = (data ?? []).find((x: any) => x.segment === seg);
  return (
    <Page title="Strategy learning" subtitle="A multi-armed bandit (UCB) learns which tone, channel, and send window gets each customer segment to pay.">
      <Err msg={error} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(data ?? []).map((x: any) => (
          <button key={x.segment} onClick={() => setSeg(x.segment)} className={`rounded-lg border bg-white p-3 text-left ${seg === x.segment ? 'border-brand' : 'border-line'}`}>
            <div className="flex items-center justify-between"><span className="font-medium">{x.segment}</span><span className="text-xs text-ink-3">{x.pulls} messages</span></div>
            <div className="mt-1 text-[13px] text-ink-2">{x.best ? <>Best so far: <b className="text-ink">{x.best.tone}, {x.best.channel}, {x.best.window}</b> ({x.best.rate}% over {x.best.pulls})</> : 'No data yet'}</div>
          </button>
        ))}
      </div>
      <Tabs value={seg} onChange={setSeg} tabs={(data ?? []).map((x: any) => ({ key: x.segment, label: x.segment }))} />
      {s && <Card title={`Approaches for "${s.segment}" customers`}>
        <Table head={['Tone', 'Channel', 'Send window', 'Messages', 'Paid or promised within 7 days', 'Success rate']}
          rows={[...s.arms].sort((a: any, b: any) => (b.rate ?? -1) - (a.rate ?? -1)).map((a: any) => [a.tone, a.channel, a.window, a.pulls, a.rewards,
            a.rate == null ? <Badge>untested: will be explored</Badge> : <div className="flex items-center gap-2"><div className="h-1.5 w-28 rounded bg-neutral-100"><div className="h-1.5 rounded bg-series-1" style={{ width: `${a.rate}%` }} /></div><span className="tabular">{a.rate}%</span></div>])} />
        <p className="mt-3 text-[11px] text-ink-3">Reward: a payment within 7 days counts 1, a promise or accepted plan counts 0.5. Exploration is limited by policy: a firm tone is never tried before an invoice is 15 days overdue. In this demo the starting statistics are synthetic seed data; they update with every message the agents send.</p>
      </Card>}
    </Page>
  );
}

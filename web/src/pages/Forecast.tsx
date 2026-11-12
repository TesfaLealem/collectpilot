import { useState } from 'react';
import { api, money } from '../api';
import { ForecastChart } from '../charts';
import { Btn, Card, Err, Field, inputCls, Loading, Page, Stat, Table, useAction, useData } from '../ui';

export default function Forecast() {
  const base = useData(() => api.get('/forecast'));
  const customers = useData(() => api.get('/customers'));
  const act = useAction();
  const [cid, setCid] = useState('');
  const [days, setDays] = useState(30);
  const [sim, setSim] = useState<any>(null);
  if (base.loading && !base.data) return <Loading />;
  if (!base.data) return <Page title="Forecast"><Err msg={base.error} /></Page>;
  const f = base.data;
  const run = () => act.run('sim', async () => setSim((await api.get(`/forecast?customerId=${cid}&days=${days}`)).whatIf));
  return (
    <Page title="Cash forecast" subtitle="13 weeks, built from a payment-date prediction for every open invoice.">
      <Err msg={act.error} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Expected (13 weeks)" value={money(f.totals.expected)} /><Stat label="Best case" value={money(f.totals.best)} tone="green" /><Stat label="Worst case" value={money(f.totals.worst)} tone="red" />
      </div>
      <Card className="mt-4" title={sim ? `What if ${sim.customer} pays ${sim.delayDays} days late` : 'Expected, best, and worst case by week'}>
        <ForecastChart weeks={f.weeks} compare={sim?.weeks} />
      </Card>
      <Card className="mt-4" title="What-if simulation">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Customer"><select className={`${inputCls} w-64`} value={cid} onChange={(e) => setCid(e.target.value)}><option value="">Choose…</option>{(customers.data ?? []).filter((c: any) => c.outstandingCents > 0).map((c: any) => <option key={c.id} value={c.id}>{c.name} ({money(c.outstandingCents)})</option>)}</select></Field>
          <Field label="Pays later by (days)"><input type="number" min={1} max={120} className={`${inputCls} w-28`} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
          <Btn kind="primary" busy={act.busy === 'sim'} disabled={!cid || !days} onClick={run}>Simulate</Btn>
          {sim && <Btn onClick={() => setSim(null)}>Clear</Btn>}
        </div>
        {sim && <p className="mt-3 text-[13px]">Expected cash in the next 4 weeks falls from <b>{money(sim.next4WeeksBaseCents)}</b> to <b>{money(sim.next4WeeksSimCents)}</b>, a shortfall of <b className="text-red-700">{money(sim.shortfallCents)}</b>.</p>}
      </Card>
      <Card className="mt-4" title="Prediction for each open invoice">
        <Table head={['Customer', 'Invoice', 'Collectible', 'Expected', 'Best', 'Worst', 'Probability', 'Basis']} rows={f.items.map((i: any) => [i.customerName, i.number, <span className="tabular">{money(i.dueCents)}</span>, i.prediction.expected, i.prediction.best, i.prediction.worst, `${Math.round(i.prediction.probability * 100)}%`, <span className="text-ink-2">{i.prediction.basis}</span>])} />
      </Card>
    </Page>
  );
}

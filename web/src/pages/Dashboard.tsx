import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, when } from '../api';
import { AgingChart, DsoChart, ForecastChart } from '../charts';
import { Badge, Btn, Card, Err, Loading, Page, Risk, Stat, Status, Table, useAction, useData } from '../ui';

export default function Dashboard() {
  const { data, error, loading, reload } = useData(() => api.get('/dashboard'));
  const act = useAction();
  const [table, setTable] = useState(false);
  if (loading && !data) return <Loading />;
  if (!data) return <Page title="Dashboard"><Err msg={error} /></Page>;
  const { kpis: k, roi: r, forecast: f } = data;
  const next4 = f.weeks.slice(0, 4).reduce((s: number, w: any) => s + w.expected, 0);
  const briefing: string | undefined = data.briefing?.detail?.text;
  return (
    <Page title="Dashboard" subtitle="What is owed, what will arrive, and what the agents are doing about it."
      actions={<Btn kind="primary" busy={act.busy === 'run'} onClick={() => act.run('run', async () => { await api.post('/agent/run-daily'); await reload(); })}>Run daily cycle now</Btn>}>
      <Err msg={error || act.error} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Outstanding" value={money(k.outstanding)} hint={`${money(k.disputed)} disputed`} />
        <Stat label="Overdue" value={money(k.overdue)} hint={`${k.overdueCount} invoices`} tone="red" />
        <Stat label="DSO" value={`${k.dso} days`} hint="Days sales outstanding" />
        <Stat label="Expected next 4 weeks" value={money(next4)} hint="From the forecast" />
        <Stat label="Needs your approval" value={<Link to="/actions" className="text-brand hover:underline">{data.pendingApprovals}</Link>} hint={`${k.customersOnHold} on credit hold`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="13-week cash forecast" action={<div className="flex items-center gap-2"><Btn small kind="ghost" onClick={() => setTable(!table)}>{table ? 'Chart' : 'Table'}</Btn><Link to="/forecast" className="text-xs text-brand hover:underline">What-if →</Link></div>}>
          {table
            ? <Table head={['Week', 'Starts', 'Expected', 'Best', 'Worst']} rows={f.weeks.map((w: any) => [`W${w.index}`, w.start, money(w.expected), money(w.best), money(w.worst)])} />
            : <ForecastChart weeks={f.weeks} />}
          <p className="mt-2 text-xs text-ink-3">Each open invoice is placed in the week it is predicted to be paid, weighted by its probability of collection. Totals: expected {money(f.totals.expected)}, best {money(f.totals.best)}, worst {money(f.totals.worst)}.</p>
        </Card>
        <Card title="What the agents delivered (30 days)">
          <div className="space-y-2.5">
            <Row label="Cash collected after an agent action" value={money(r.collectedAfterAgentCents)} />
            <Row label="All cash collected" value={money(r.collectedCents)} />
            <Row label="Messages sent / replies handled" value={`${r.messagesSent} / ${r.repliesHandled}`} />
            <Row label="Payments matched / proofs read" value={`${r.paymentsMatched} / ${r.proofsRead}`} />
            <Row label="Promises kept" value={r.promiseKeptRate == null ? 'n/a' : `${r.promiseKeptRate}%`} />
            <Row label="Estimated hours saved" value={`${r.hoursSaved} h`} />
          </div>
          <p className="mt-3 text-[11px] text-ink-3">{r.assumptions} "After an agent action" means payment arrived within 14 days of an agent message to that customer.</p>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Aging of receivables"><AgingChart aging={k.aging} /></Card>
        <Card title="DSO trend (9 weeks)"><DsoChart trend={k.dsoTrend} /></Card>
        <Card title="Latest briefing">
          {briefing ? <pre className="text-[13px] leading-relaxed text-ink-2">{briefing}</pre> : <p className="text-ink-3">No briefing yet. Run the daily cycle to produce one.</p>}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Top risks and why" action={<Link to="/customers" className="text-xs text-brand hover:underline">All customers →</Link>}>
          <div className="space-y-3">
            {k.topRisks.map((c: any) => (
              <div key={c.id} className="border-b border-line/70 pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link to={`/customers/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                  <div className="flex items-center gap-1.5"><Badge>{c.segment}</Badge>{c.creditHold && <Badge tone="red">credit hold</Badge>}<Risk score={c.riskScore} /></div>
                </div>
                <div className="mt-1 text-xs text-ink-2">Overdue {money(c.overdueCents)}. {c.drivers.map((d: any) => `${d.detail} (+${d.points})`).join('; ')}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Recent agent activity" action={<Link to="/trace" className="text-xs text-brand hover:underline">Full trace →</Link>}>
          <Table head={['When', 'Trigger', 'Outcome', '']} rows={data.recentRuns.map((x: any) => [<span className="whitespace-nowrap text-ink-2">{when(x.startedAt)}</span>, x.trigger, <span className="text-ink-2">{x.summary}</span>, <Status value={x.status} />])} />
        </Card>
      </div>
    </Page>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => <div className="flex items-baseline justify-between gap-3"><span className="text-ink-2">{label}</span><span className="tabular font-semibold">{value}</span></div>;

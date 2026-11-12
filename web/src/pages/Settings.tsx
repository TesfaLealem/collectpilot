import { useEffect, useState } from 'react';
import { api, when } from '../api';
import { Badge, Btn, Card, Err, Field, inputCls, Loading, Page, Table, Tabs, useAction, useData } from '../ui';

const LEVELS = [['shadow', 'Shadow', 'Agent only suggests'], ['assisted', 'Assisted', 'Agent drafts, you approve'], ['autonomous', 'Autonomous', 'Agent acts, you are informed']] as const;
const NUM: [string, string, string][] = [
  ['maxInstalments', 'Maximum instalments', 'Payment plans'], ['minUpfrontPct', 'Minimum first payment (%)', 'Payment plans'], ['maxPlanDays', 'Latest plan / promise date (days from today)', 'Payment plans'],
  ['earlyPayDiscountPct', 'Early-payment discount offered (%)', 'Payment plans'], ['maxDiscountPct', 'Discount cap (%)', 'Payment plans'],
  ['maxContactsPerDay', 'Reminders per customer per day', 'Contact rules'], ['quietStartHour', 'Quiet hours start (hour)', 'Contact rules'], ['quietEndHour', 'Quiet hours end (hour)', 'Contact rules'],
  ['creditHoldRisk', 'Credit hold at risk score', 'Credit control'], ['creditHoldDaysOverdue', 'Credit hold at days overdue', 'Credit control'],
  ['autoMatchConfidence', 'Auto-apply payments at confidence (0–1)', 'Confidence thresholds'], ['minIntentConfidence', 'Act on replies at confidence (0–1)', 'Confidence thresholds'],
];

export default function Settings() {
  const [tab, setTab] = useState('autonomy');
  const pol = useData(() => api.get('/policy'));
  const status = useData(() => api.get('/status'));
  const auditLog = useData(() => api.get('/audit'));
  const act = useAction();
  const [p, setP] = useState<any>(null);
  const [saved, setSaved] = useState('');
  const [ev, setEv] = useState<any>(null);
  useEffect(() => { if (pol.data) setP(pol.data.policy); }, [pol.data]);
  if (!p) return pol.error ? <Page title="Policy & settings"><Err msg={pol.error} /></Page> : <Loading />;
  const save = (patch: any) => act.run('save', async () => { const r = await api.put('/policy', patch); setP(r.policy); setSaved('Saved.'); setTimeout(() => setSaved(''), 2500); });
  const st = status.data;

  return (
    <Page title="Policy & settings" subtitle="You set the limits. The agents cannot cross them." actions={saved ? <Badge tone="green">{saved}</Badge> : undefined}>
      <Err msg={act.error} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'autonomy', label: 'Autonomy levels' }, { key: 'limits', label: 'Policy limits' }, { key: 'integrations', label: 'Integrations' }, { key: 'eval', label: 'Evaluation' }, { key: 'audit', label: 'Audit log' }]} />

      {tab === 'autonomy' && <Card title="How much each action is left to the agents">
        <Table head={['Action', 'Agent', ...LEVELS.map((l) => <span title={l[2]}>{l[1]}</span>)]}
          rows={pol.data.actionTypes.map((a: any) => [a.label, <Badge tone="blue">{a.agent}</Badge>, ...LEVELS.map(([k, , hint]) => (
            <label className="flex cursor-pointer items-center gap-1.5" title={hint}><input type="radio" name={a.key} checked={(p.autonomy?.[a.key] ?? a.default) === k} onChange={() => save({ autonomy: { ...p.autonomy, [a.key]: k } })} /><span className="text-xs text-ink-2">{hint}</span></label>))])} />
        <p className="mt-3 text-[11px] text-ink-3">Only the owner can change this. Every change is written to the audit log.</p>
      </Card>}

      {tab === 'limits' && <div className="grid gap-4 md:grid-cols-2">
        {['Payment plans', 'Contact rules', 'Credit control', 'Confidence thresholds'].map((g) => (
          <Card key={g} title={g}><div className="space-y-3">
            {NUM.filter((n) => n[2] === g).map(([k, label]) => <Field key={k} label={label}><input type="number" step="any" className={inputCls} value={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.value })} onBlur={(e) => e.target.value !== '' && save({ [k]: Number(e.target.value) })} /></Field>)}
            {g === 'Contact rules' && <Field label="Timezone"><input className={inputCls} value={p.timezone} onChange={(e) => setP({ ...p, timezone: e.target.value })} onBlur={(e) => save({ timezone: e.target.value })} /></Field>}
          </div></Card>))}
      </div>}

      {tab === 'integrations' && (st ? <div className="grid gap-4 md:grid-cols-2">
        <Card title="Gemini (Google AI Studio)"><Line ok={st.gemini.configured} on={`Model ${st.gemini.model}. ${st.gemini.calls} calls this session, ${st.gemini.failures} failed.`} off="Not configured: the agents use rule-based understanding and templates. Add GEMINI_API_KEY to server/.env and restart." />{st.gemini.lastError && <p className="mt-1 text-xs text-red-700">Last error: {st.gemini.lastError}</p>}</Card>
        <Card title="Google Workspace (Gmail, Calendar, Sheets, Drive)">
          <Line ok={st.google.connected} on="Connected. Emails are sent from and read in this account; promise checks go to its calendar." off={st.google.configured ? 'OAuth client is configured. Connect the business Google account.' : 'Not configured: emails and calendar events are recorded but not sent. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to server/.env and restart.'} />
          <div className="mt-2 flex gap-2">{st.google.configured && !st.google.connected && <Btn kind="primary" onClick={() => act.run('g', async () => { location.href = (await api.get('/google/auth-url')).url; })}>Connect Google</Btn>}
            {st.google.connected && <><Btn busy={act.busy === 'sync'} onClick={() => act.run('sync', async () => { const r = await api.post('/agent/sync-inbox'); setSaved(`Inbox read: ${r.replies} replies, ${r.payments} payment emails`); })}>Read inbox now</Btn><Btn kind="danger" onClick={() => act.run('gd', async () => { await api.post('/google/disconnect'); await status.reload(); })}>Disconnect</Btn></>}</div>
        </Card>
        <Card title="Telegram bot"><Line ok={st.telegram.configured} on={`Bot @${st.telegram.bot ?? '?'} is running. Owner briefings: ${st.telegram.ownerChat ? 'on' : 'set OWNER_TELEGRAM_CHAT_ID'}.`} off="Not configured: Telegram messages are recorded but not sent. Add TELEGRAM_BOT_TOKEN to server/.env and restart." /></Card>
        <Card title="Safety and scheduling">
          <Line ok={st.demoMode} on={`Demo mode is on: only ${st.allowedEmails} allow-listed email(s) and ${st.allowedChats} Telegram chat(s) receive real messages. Everything else is recorded as "simulated".`} off="Demo mode is OFF: real customers will be contacted." />
          <p className="mt-2 text-xs text-ink-2">Exchange rates: {st.fx.live ? 'live' : 'fallback'} (1 USD = {st.fx.ETB?.toFixed?.(2)} ETB), as of {String(st.fx.asOf).slice(0, 10)}. Jobs queued: {st.jobs.queued}, failed: {st.jobs.failed}.</p>
          <div className="mt-2"><Btn busy={act.busy === 'wr'} onClick={() => act.run('wr', async () => { const r = await api.post('/agent/weekly-report'); setSaved(`Weekly report ${r.status}`); await auditLog.reload(); })}>Generate weekly report</Btn></div>
        </Card>
      </div> : <Loading />)}

      {tab === 'eval' && <Card title="Evaluation suite" action={<div className="flex gap-2"><Btn busy={act.busy === 'ev0'} onClick={() => act.run('ev0', async () => setEv(await api.post('/eval/run', { useModel: false })))}>Run (rules only)</Btn><Btn kind="primary" busy={act.busy === 'ev1'} onClick={() => act.run('ev1', async () => setEv(await api.post('/eval/run', { useModel: true })))}>Run with Gemini</Btn></div>}>
        <p className="text-[13px] text-ink-2">A labelled set of customer replies (including Amharic and prompt-injection attempts) and bank narrations. It is small and hand-written, so treat the numbers as a regression check, not a benchmark. Running with Gemini makes one call per reply and takes about a minute.</p>
        {ev && <div className="mt-3 grid gap-4 md:grid-cols-3">
          {([['Rule-based understanding', ev.understanding.rules], ['Gemini understanding', ev.understanding.gemini]] as const).map(([label, r]) => (
            <div key={label} className="rounded-md border border-line p-3"><div className="mb-1 font-medium">{label}</div>{r ? <><KV k={`Intent accuracy (${ev.replies} replies)`} v={`${r.intentAccuracy}%`} /><KV k="Date extraction" v={`${r.dateAccuracy}%`} /><KV k="Injection attempts flagged" v={r.injectionFlagged} />
              {!!r.misses.length && <details className="mt-1"><summary className="cursor-pointer text-xs text-brand">{r.misses.length} miss(es)</summary>{r.misses.map((m: any) => <div key={m.text} className="mt-1 text-xs text-ink-2">"{m.text}": expected {m.expected}{m.expectedDate ? ` ${m.expectedDate}` : ''}, got {m.got}{m.gotDate ? ` ${m.gotDate}` : ''}</div>)}</details>}</> : <p className="text-xs text-ink-3">{ev.understanding.geminiSkipped}</p>}</div>))}
          <div className="rounded-md border border-line p-3"><div className="mb-1 font-medium">Payment matching engine</div><KV k={`Accuracy (${ev.payments} payments)`} v={`${ev.matching.accuracy}%`} /><KV k="Wrongly auto-applied" v={ev.matching.wronglyAutoApplied} /><KV k="Arithmetic errors" v={ev.matching.arithmeticErrors} /></div>
        </div>}
      </Card>}

      {tab === 'audit' && <Card><Table head={['When', 'Who', 'Action', 'Detail']} rows={(auditLog.data ?? []).map((a: any) => [<span className="whitespace-nowrap text-ink-2">{when(a.createdAt)}</span>, a.actor, a.action.replace(/_/g, ' '), <span className="line-clamp-2 font-mono text-[11px] text-ink-2">{a.detail ? JSON.stringify(a.detail).slice(0, 220) : ''}</span>])} /></Card>}
    </Page>
  );
}

const Line = ({ ok, on, off }: { ok: boolean; on: string; off: string }) => <div className="flex items-start gap-2"><Badge tone={ok ? 'green' : 'gray'}>{ok ? 'on' : 'off'}</Badge><p className="text-[13px] text-ink-2">{ok ? on : off}</p></div>;
const KV = ({ k, v }: { k: string; v: any }) => <div className="flex justify-between py-0.5 text-[13px]"><span className="text-ink-2">{k}</span><span className="tabular font-semibold">{v}</span></div>;

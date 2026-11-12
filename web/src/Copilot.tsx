import { useRef, useState } from 'react';
import { api } from './api';
import { Badge, Btn, Err } from './ui';

interface Msg { role: 'user' | 'model'; text: string; calls?: { name: string }[]; plan?: { action: string; label: string; params: any }[]; results?: { label: string; result: string }[]; source?: string }

const SUGGESTIONS = ['Why did DSO change this month?', 'Who are my five riskiest customers and why?', 'What happens to cash next month if Abebe Trading pays 30 days late?', 'Should I accept a 300,000 order from Hawassa Building Materials?', 'Offer Rift Valley Contractors a payment plan'];

export default function Copilot({ onClose }: { onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const scroll = () => setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50);

  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    const history = [...msgs, { role: 'user' as const, text: q }];
    setMsgs(history); setText(''); setBusy(true); setError(''); scroll();
    try {
      const r = await api.post('/copilot', { history: history.map((m) => ({ role: m.role, text: m.text })) });
      setMsgs([...history, { role: 'model', text: r.answer, calls: r.calls, plan: r.plan, source: r.source }]);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); scroll(); }
  };
  const confirm = async (i: number) => {
    const m = msgs[i]; if (!m.plan) return;
    setBusy(true); setError('');
    try { const r = await api.post('/agent/execute', { steps: m.plan }); setMsgs(msgs.map((x, k) => (k === i ? { ...x, plan: undefined, results: r.results } : x))); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); scroll(); }
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-line bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div><div className="font-semibold">Copilot</div><div className="text-xs text-ink-3">Answers from live data. Actions need your confirmation.</div></div>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">✕</button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {!msgs.length && <div className="space-y-2"><div className="text-xs text-ink-3">Try:</div>{SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="block w-full rounded-md border border-line px-3 py-2 text-left text-[13px] hover:bg-neutral-50">{s}</button>)}</div>}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'ml-8 rounded-lg bg-brand px-3 py-2 text-white' : 'mr-4 rounded-lg border border-line bg-neutral-50 px-3 py-2'}>
            <pre className="text-[13px] leading-relaxed">{m.text}</pre>
            {!!m.calls?.length && <div className="mt-2 flex flex-wrap gap-1">{m.calls.map((c, k) => <Badge key={k} tone="blue">tool: {c.name}</Badge>)}{m.source === 'rules' && <Badge>no model</Badge>}</div>}
            {!!m.plan?.length && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2">
                <div className="mb-1 text-xs font-semibold text-amber-900">Plan preview: nothing has run yet</div>
                <ol className="mb-2 list-decimal pl-5 text-[13px]">{m.plan.map((p, k) => <li key={k}>{p.label}</li>)}</ol>
                <div className="flex gap-2"><Btn small kind="primary" busy={busy} onClick={() => confirm(i)}>Confirm and run</Btn><Btn small onClick={() => setMsgs(msgs.map((x, k) => (k === i ? { ...x, plan: undefined } : x)))}>Cancel</Btn></div>
              </div>
            )}
            {!!m.results?.length && <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-[13px]">{m.results.map((r, k) => <div key={k}><b>{r.label}:</b> {r.result}</div>)}</div>}
          </div>
        ))}
        {busy && <div className="text-xs text-ink-3">Working…</div>}
        <Err msg={error} />
        <div ref={end} />
      </div>
      <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
        <input className="flex-1 rounded-md border border-line px-3 py-2 text-[13px] outline-none focus:border-brand" placeholder="Ask about receivables, or tell the agents what to do" value={text} onChange={(e) => setText(e.target.value)} />
        <Btn type="submit" kind="primary" busy={busy}>Send</Btn>
      </form>
    </div>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from 'react';

export function useData<T = any>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await load()); setError(''); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload };
}

/** Run an async action with busy / error state. */
export function useAction() {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };
  return { busy, error, run, setError };
}

export const Card = ({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`rounded-lg border border-line bg-surface ${className}`}>
    {(title || action) && <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5"><h2 className="text-[13px] font-semibold text-ink">{title}</h2>{action}</header>}
    <div className="p-4">{children}</div>
  </section>
);

export const Page = ({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) => (
  <div className="mx-auto max-w-[1280px] px-4 py-5 md:px-6">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-xl font-semibold">{title}</h1>{subtitle && <p className="mt-0.5 text-ink-2">{subtitle}</p>}</div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
    {children}
  </div>
);

export function Btn({ children, onClick, kind = 'default', busy, disabled, type = 'button', small }: { children: ReactNode; onClick?: () => void; kind?: 'default' | 'primary' | 'danger' | 'ghost'; busy?: boolean; disabled?: boolean; type?: 'button' | 'submit'; small?: boolean }) {
  const k = { default: 'border-line bg-white text-ink hover:bg-neutral-50', primary: 'border-brand bg-brand text-white hover:opacity-90', danger: 'border-red-200 bg-white text-red-700 hover:bg-red-50', ghost: 'border-transparent text-ink-2 hover:bg-neutral-100' }[kind];
  return <button type={type} onClick={onClick} disabled={disabled || busy} className={`inline-flex items-center justify-center gap-1.5 rounded-md border font-medium ${small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-[13px]'} ${k}`}>{busy ? 'Working…' : children}</button>;
}

const TONES: Record<string, string> = {
  gray: 'bg-neutral-100 text-neutral-700', blue: 'bg-brand-soft text-brand', green: 'bg-emerald-50 text-emerald-800', amber: 'bg-amber-50 text-amber-800', red: 'bg-red-50 text-red-800', violet: 'bg-violet-50 text-violet-800',
};
export const Badge = ({ children, tone = 'gray' }: { children: ReactNode; tone?: keyof typeof TONES | string }) => <span className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone] ?? TONES.gray}`}>{children}</span>;

const STATUS_TONE: Record<string, string> = {
  paid: 'green', kept: 'green', matched: 'green', resolved: 'green', completed: 'green', executed: 'green', sent: 'green', confirmed: 'green', done: 'green', approve: 'green', active: 'blue', open: 'blue', offered: 'blue', suggested: 'amber', partial: 'amber', claimed: 'amber', pending: 'amber', simulated: 'gray', proposed: 'amber', evidence: 'amber', review: 'amber', opened: 'amber', due: 'blue', approve_with_deposit: 'amber',
  broken: 'red', missed: 'red', defaulted: 'red', failed: 'red', rejected: 'red', unmatched: 'red', hold: 'red', disputed: 'violet', shadow: 'violet', received: 'blue', cancelled: 'gray', draft: 'gray',
};
export const Status = ({ value }: { value: string }) => <Badge tone={STATUS_TONE[value] ?? 'gray'}>{value.replace(/_/g, ' ')}</Badge>;

export function Risk({ score }: { score: number }) {
  const tone = score >= 70 ? 'red' : score >= 40 ? 'amber' : 'green';
  const label = score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low';
  return <Badge tone={tone}>{label} {score}</Badge>;
}

export const Err = ({ msg }: { msg?: string }) => (msg ? <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">{msg}</div> : null);
export const Loading = () => <div className="p-6 text-ink-3">Loading…</div>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="py-6 text-center text-ink-3">{children}</div>;

export const Stat = ({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'red' | 'green' }) => (
  <div className="rounded-lg border border-line bg-surface px-4 py-3">
    <div className="text-xs text-ink-2">{label}</div>
    <div className={`tabular mt-1 text-[22px] font-semibold leading-tight ${tone === 'red' ? 'text-red-700' : tone === 'green' ? 'text-emerald-700' : ''}`}>{value}</div>
    {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
  </div>
);

export function Table({ head, rows, empty = 'Nothing here yet.' }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead><tr className="border-b border-line text-xs text-ink-2">{head.map((h, i) => <th key={i} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-line/70 last:border-0 hover:bg-neutral-50">{r.map((c, j) => <td key={j} className="px-2 py-2 align-top">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="block"><span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>{children}{hint && <span className="mt-0.5 block text-[11px] text-ink-3">{hint}</span>}</label>
);
export const inputCls = 'w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-brand';

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (k: string) => void }) {
  return <div className="mb-3 flex flex-wrap gap-1 border-b border-line">{tabs.map((t) => <button key={t.key} onClick={() => onChange(t.key)} className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${value === t.key ? 'border-brand text-brand' : 'border-transparent text-ink-2 hover:text-ink'}`}>{t.label}</button>)}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4" onClick={onClose}>
      <div className={`mt-10 w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-lg border border-line bg-white shadow-xl`} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3"><h3 className="font-semibold">{title}</h3><button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">✕</button></header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

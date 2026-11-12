import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, getSession, setSession } from './api';
import { Badge, Btn, Err, Field, inputCls } from './ui';
import Dashboard from './pages/Dashboard';
import Actions from './pages/Actions';
import { Customers, Customer360 } from './pages/Customers';
import Invoices from './pages/Invoices';
import Reconciliation from './pages/Reconciliation';
import Disputes from './pages/Disputes';
import Forecast from './pages/Forecast';
import Strategy from './pages/Strategy';
import Trace from './pages/Trace';
import Settings from './pages/Settings';
import Portal from './pages/Portal';
import Copilot from './Copilot';

const NAV = [
  ['/', 'Dashboard'], ['/actions', 'Action centre'], ['/customers', 'Customers'], ['/invoices', 'Invoices'], ['/reconciliation', 'Reconciliation'],
  ['/disputes', 'Disputes'], ['/forecast', 'Forecast'], ['/strategy', 'Strategy learning'], ['/trace', 'Agent trace'], ['/settings', 'Policy & settings'],
] as const;

function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState('owner@bluenile.example.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { setSession(await api.login(email, password)); nav('/'); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-line bg-white p-6">
        <div className="mb-1 text-2xl font-semibold text-brand">CollectPilot</div>
        <p className="mb-5 text-ink-2">An autonomous accounts receivable and collections team.</p>
        <Err msg={error} />
        <div className="space-y-3">
          <Field label="Email"><input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
          <Field label="Password" hint="Demo accounts and the seed password are listed in the README."><input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></Field>
          <Btn type="submit" kind="primary" busy={busy}>Sign in</Btn>
        </div>
      </form>
    </div>
  );
}

function Shell() {
  const s = getSession();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  const [copilot, setCopilot] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [pending, setPending] = useState(0);
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  useEffect(() => {
    api.get('/status').then(setStatus).catch(() => undefined);
    const tick = () => api.get('/approvals').then((a) => setPending(a.filter((x: any) => x.status === 'pending').length)).catch(() => undefined);
    tick(); const id = setInterval(tick, 15000); return () => clearInterval(id);
  }, []);
  if (!s) return <Navigate to="/login" replace />;
  return (
    <div className="flex min-h-full">
      <aside className={`${menu ? 'block' : 'hidden'} fixed inset-y-0 left-0 z-30 w-56 shrink-0 border-r border-line bg-white md:static md:block`}>
        <div className="px-4 py-4"><div className="text-lg font-semibold text-brand">CollectPilot</div><div className="text-xs text-ink-3">{s.tenant.name}</div></div>
        <nav className="px-2">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `mb-0.5 flex items-center justify-between rounded-md px-3 py-1.5 text-[13px] ${isActive ? 'bg-brand-soft font-medium text-brand' : 'text-ink-2 hover:bg-neutral-100'}`}>
              {label}{to === '/actions' && pending > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">{pending}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 space-y-1 border-t border-line px-4 py-3 text-xs text-ink-2">
          <div className="flex items-center justify-between">Gemini <Badge tone={status?.gemini.configured ? 'green' : 'gray'}>{status?.gemini.configured ? 'on' : 'fallback'}</Badge></div>
          <div className="flex items-center justify-between">Gmail / Calendar <Badge tone={status?.google.connected ? 'green' : 'gray'}>{status?.google.connected ? 'connected' : 'simulated'}</Badge></div>
          <div className="flex items-center justify-between">Telegram <Badge tone={status?.telegram.configured ? 'green' : 'gray'}>{status?.telegram.configured ? 'on' : 'simulated'}</Badge></div>
          {status?.demoMode && <div className="pt-1 text-[11px] text-ink-3">Demo mode: only allow-listed contacts receive real messages.</div>}
        </div>
        <div className="border-t border-line px-4 py-3 text-xs">
          <div className="font-medium">{s.user.name}</div><div className="text-ink-3">{s.user.role}</div>
          <button className="mt-1 text-brand hover:underline" onClick={() => { setSession(null); location.href = '/login'; }}>Sign out</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-white/90 px-4 py-2 backdrop-blur md:justify-end">
          <button className="rounded-md border border-line px-2 py-1 md:hidden" onClick={() => setMenu(!menu)} aria-label="Menu">☰</button>
          <Btn kind="primary" onClick={() => setCopilot(true)}>Ask copilot</Btn>
        </div>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/actions" element={<Actions />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:id" element={<Customer360 />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/reconciliation" element={<Reconciliation />} />
          <Route path="/disputes" element={<Disputes />} />
          <Route path="/forecast" element={<Forecast />} />
          <Route path="/strategy" element={<Strategy />} />
          <Route path="/trace" element={<Trace />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {copilot && <Copilot onClose={() => setCopilot(false)} />}
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/portal/:token" element={<Portal />} />
      <Route path="/*" element={<Shell />} />
    </Routes>
  );
}

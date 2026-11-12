const KEY = 'cp_session';

export interface Session { token: string; user: { name: string; email: string; role: string }; tenant: { name: string; baseCurrency: string } }
export const getSession = (): Session | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } };
export const setSession = (s: Session | null) => { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* storage blocked */ } };

async function req<T = any>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body && !(init.body instanceof FormData)) headers['content-type'] = 'application/json';
  const s = getSession();
  if (auth && s) headers.authorization = `Bearer ${s.token}`;
  const res = await fetch(`/api${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth) { setSession(null); if (!location.pathname.startsWith('/login')) location.href = '/login'; }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => req<T>(p),
  post: <T = any>(p: string, body?: unknown) => req<T>(p, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  put: <T = any>(p: string, body: unknown) => req<T>(p, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T = any>(p: string, body: unknown) => req<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  login: (email: string, password: string) => req<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }, false),
  portal: {
    get: <T = any>(token: string, p = '') => req<T>(`/portal/${token}${p}`, {}, false),
    post: <T = any>(token: string, p: string, body?: unknown) => req<T>(`/portal/${token}${p}`, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }, false),
  },
};

export const money = (cents: number | null | undefined, cur = getSession()?.tenant.baseCurrency ?? 'ETB') =>
  cents == null ? '–' : `${cur} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const compact = (cents: number) => { const v = cents / 100; return Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : v.toFixed(0); };
export const day = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '–');
export const when = (d: string | Date) => { const x = new Date(d); return `${x.toISOString().slice(0, 10)} ${x.toTimeString().slice(0, 5)}`; };

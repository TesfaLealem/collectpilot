// Open exchange-rate API (free, no key). Cached in the database for 12 hours; falls back to the last known rates.
import { db } from '../db.js';

const KEY = 'fx:USD';
const FALLBACK: Record<string, number> = { USD: 1, ETB: 155, EUR: 0.92, GBP: 0.79, KES: 129 };

export async function rates(): Promise<{ rates: Record<string, number>; asOf: string; live: boolean }> {
  const row = await db.kV.findUnique({ where: { key: KEY } });
  const cached = row?.value as { rates: Record<string, number>; at: number } | undefined;
  if (cached && Date.now() - cached.at < 12 * 3600_000) return { rates: cached.rates, asOf: new Date(cached.at).toISOString(), live: true };
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
    const j: any = await res.json();
    if (j?.result === 'success' && j.rates) {
      const value = { rates: j.rates as Record<string, number>, at: Date.now() };
      await db.kV.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
      return { rates: value.rates, asOf: new Date(value.at).toISOString(), live: true };
    }
  } catch { /* fall through */ }
  if (cached) return { rates: cached.rates, asOf: new Date(cached.at).toISOString(), live: false };
  return { rates: FALLBACK, asOf: 'fallback', live: false };
}

export async function convertCents(cents: number, from: string, to: string) {
  if (from === to) return cents;
  const r = (await rates()).rates;
  if (!r[from] || !r[to]) return cents;
  return Math.round((cents / r[from]) * r[to]);
}

let cache: Record<string, number> = FALLBACK;
export async function ensureFx() { cache = (await rates()).rates; return cache; }
/** Convert to the tenant base currency using the cached rates (call ensureFx() first). */
export function toBase(cents: number, from: string, base: string) {
  if (from === base || !cache[from] || !cache[base]) return cents;
  return Math.round((cents / cache[from]) * cache[base]);
}

// Google Workspace: Gmail (send + read), Calendar (promise / instalment checks), Sheets (invoice import), Drive (documents).
// One OAuth consent per tenant; tokens are stored on the Tenant row. Everything degrades to "simulated" when not connected.
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import { cfg } from '../config.js';
import { db } from '../db.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

export const googleConfigured = () => !!(cfg.googleClientId && cfg.googleClientSecret);
const oauth = () => new google.auth.OAuth2(cfg.googleClientId, cfg.googleClientSecret, cfg.googleRedirect);

export function authUrl(tenantId: string) {
  const state = jwt.sign({ tid: tenantId }, cfg.jwtSecret, { expiresIn: '15m' });
  return oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
}

export async function handleCallback(code: string, state: string) {
  const { tid } = jwt.verify(state, cfg.jwtSecret) as { tid: string };
  const { tokens } = await oauth().getToken(code);
  await db.tenant.update({ where: { id: tid }, data: { googleTokens: tokens as any } });
  return tid;
}

export async function googleConnected(tenantId: string) {
  if (!googleConfigured()) return false;
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { googleTokens: true } });
  return !!t?.googleTokens;
}

async function authed(tenantId: string) {
  if (!googleConfigured()) return null;
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { googleTokens: true } });
  if (!t?.googleTokens) return null;
  const c = oauth();
  c.setCredentials(t.googleTokens as any);
  c.on('tokens', async (tok) => {
    await db.tenant.update({ where: { id: tenantId }, data: { googleTokens: { ...(t.googleTokens as object), ...tok } as any } }).catch(() => undefined);
  });
  return c;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeHeader = (s: string) => (/^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

export async function gmailSend(tenantId: string, to: string, subject: string, body: string, threadId?: string) {
  const auth = await authed(tenantId);
  if (!auth) return null;
  const mime = [`To: ${to}`, `Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64')].join('\r\n');
  const res = await google.gmail({ version: 'v1', auth }).users.messages.send({ userId: 'me', requestBody: { raw: b64url(mime), threadId } });
  return { id: res.data.id ?? '', threadId: res.data.threadId ?? '' };
}

function bodyText(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  for (const p of payload.parts ?? []) { const t = bodyText(p); if (t) return t; }
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ');
  return '';
}

export interface InboundEmail { id: string; threadId: string; from: string; fromEmail: string; subject: string; text: string; date: Date }

/** Recent inbox messages (replies and payment notifications). The caller de-duplicates by message id. */
export async function gmailInbound(tenantId: string, query = 'in:inbox newer_than:2d', max = 25): Promise<InboundEmail[] | null> {
  const auth = await authed(tenantId);
  if (!auth) return null;
  const gmail = google.gmail({ version: 'v1', auth });
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max });
  const out: InboundEmail[] = [];
  for (const m of list.data.messages ?? []) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'full' });
    const h = (n: string) => msg.data.payload?.headers?.find((x) => x.name?.toLowerCase() === n)?.value ?? '';
    const from = h('from');
    const text = bodyText(msg.data.payload).split(/\r?\nOn .{10,80} wrote:|\r?\n>/)[0].trim(); // drop quoted history
    out.push({ id: m.id!, threadId: msg.data.threadId ?? '', from, fromEmail: (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase(), subject: h('subject'), text: text.slice(0, 4000), date: new Date(Number(msg.data.internalDate ?? Date.now())) });
  }
  return out;
}

export async function calendarCreate(tenantId: string, ev: { summary: string; description: string; date: Date }) {
  const auth = await authed(tenantId);
  if (!auth) return null;
  const day = ev.date.toISOString().slice(0, 10);
  const next = new Date(ev.date.getTime() + 86_400_000).toISOString().slice(0, 10);
  const res = await google.calendar({ version: 'v3', auth }).events.insert({ calendarId: 'primary', requestBody: { summary: ev.summary, description: ev.description, start: { date: day }, end: { date: next } } });
  return res.data.id ?? null;
}

export async function sheetsRead(tenantId: string, spreadsheetId: string, range = 'A1:Z1000') {
  const auth = await authed(tenantId);
  if (!auth) return null;
  const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId, range });
  return (res.data.values ?? []) as string[][];
}

export async function driveUpload(tenantId: string, name: string, mimeType: string, data: Buffer) {
  const auth = await authed(tenantId);
  if (!auth) return null;
  const res = await google.drive({ version: 'v3', auth }).files.create({ requestBody: { name }, media: { mimeType, body: Readable.from(data) }, fields: 'id,webViewLink' });
  return { id: res.data.id ?? '', link: res.data.webViewLink ?? '' };
}

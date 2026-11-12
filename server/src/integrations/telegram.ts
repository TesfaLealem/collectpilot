// Telegram Bot API: customer chat (text, photos, voice notes) and owner briefings.
// Uses a webhook when PUBLIC_API_URL is set, otherwise long polling (works on localhost).
import { cfg } from '../config.js';
import { db } from '../db.js';

export const telegramConfigured = () => !!cfg.telegramToken;
const api = (method: string) => `https://api.telegram.org/bot${cfg.telegramToken}/${method}`;

async function tg<T = any>(method: string, body?: object): Promise<T> {
  const res = await fetch(api(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const j: any = await res.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result as T;
}

export async function telegramSend(chatId: string, text: string) {
  if (!telegramConfigured()) return null;
  const r = await tg<{ message_id: number }>('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  return String(r.message_id);
}

export async function telegramDownload(fileId: string): Promise<{ data: Buffer; path: string }> {
  const f = await tg<{ file_path: string }>('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.telegramToken}/${f.file_path}`);
  return { data: Buffer.from(await res.arrayBuffer()), path: f.file_path };
}

export async function botUsername(): Promise<string | null> {
  if (!telegramConfigured()) return null;
  try { return (await tg<{ username: string }>('getMe')).username; } catch { return null; }
}

export interface TgInbound { chatId: string; fromName: string; text?: string; photoFileId?: string; voiceFileId?: string; voiceMime?: string; documentFileId?: string; documentMime?: string; messageId: string }
export type TgHandler = (m: TgInbound) => Promise<void>;

export function parseUpdate(u: any): TgInbound | null {
  const m = u?.message;
  if (!m?.chat?.id) return null;
  const photo = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1].file_id : undefined;
  return {
    chatId: String(m.chat.id), fromName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' '),
    text: m.text ?? m.caption, photoFileId: photo, voiceFileId: m.voice?.file_id ?? m.audio?.file_id, voiceMime: m.voice?.mime_type ?? m.audio?.mime_type,
    documentFileId: m.document?.file_id, documentMime: m.document?.mime_type, messageId: `tg:${m.chat.id}:${m.message_id}`,
  };
}

let polling = false;
export async function startPolling(handler: TgHandler) {
  if (!telegramConfigured() || polling) return;
  polling = true;
  await tg('deleteWebhook', {}).catch(() => undefined);
  const kv = await db.kV.findUnique({ where: { key: 'tg:offset' } });
  let offset = Number((kv?.value as any)?.offset ?? 0);
  console.log('[telegram] long polling started');
  (async () => {
    while (polling) {
      try {
        const updates = await tg<any[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = parseUpdate(u);
          if (m) await handler(m).catch((e) => console.error('[telegram] handler error', e));
        }
        if (updates.length) await db.kV.upsert({ where: { key: 'tg:offset' }, create: { key: 'tg:offset', value: { offset } }, update: { value: { offset } } });
      } catch (e: any) {
        console.warn('[telegram] polling error:', String(e?.message ?? e).slice(0, 160));
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}

export async function setWebhook(url: string) {
  return tg('setWebhook', { url, allowed_updates: ['message'], secret_token: cfg.jobSecret.replace(/[^A-Za-z0-9_-]/g, '') });
}

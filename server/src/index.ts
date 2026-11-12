import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { cfg } from './config.js';
import { db } from './db.js';
import { api } from './routes/api.js';
import { portal } from './routes/portal.js';
import { h } from './auth.js';
import { enqueue, onTelegram, startWorker } from './orchestrator.js';
import { parseUpdate, startPolling, telegramConfigured } from './integrations/telegram.js';
import { llmAvailable } from './llm/gemini.js';
import { googleConfigured } from './integrations/google.js';

const app = express();
app.use(cors({ origin: [cfg.publicUrl, 'http://localhost:5173'], credentials: false }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Scheduler triggers (Cloud Scheduler or GitHub Actions cron). Protected by a shared secret.
const jobAuth: express.RequestHandler = (req, res, next) => (req.headers['x-job-secret'] === cfg.jobSecret ? next() : res.status(401).json({ error: 'Bad job secret' }));
const forAllTenants = (type: string, bucket: () => string) => h(async (_req, res) => {
  const tenants = await db.tenant.findMany({ select: { id: true } });
  for (const t of tenants) await enqueue(t.id, type, {}, { dedupeKey: `${type}:${t.id}:${bucket()}` });
  res.json({ queued: tenants.length, type });
});
const day = () => new Date().toISOString().slice(0, 10);
app.post('/jobs/daily', jobAuth, forAllTenants('daily.run', day));
app.post('/jobs/hourly', jobAuth, forAllTenants('inbox.sync', () => new Date().toISOString().slice(0, 13)));
app.post('/jobs/weekly', jobAuth, forAllTenants('weekly.report', day));

// Telegram webhook (used when deployed; long polling is used locally).
app.post('/webhooks/telegram', h(async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== cfg.jobSecret.replace(/[^A-Za-z0-9_-]/g, '')) return res.status(401).json({ error: 'Bad secret' });
  const m = parseUpdate(req.body);
  if (m) await onTelegram(m);
  res.json({ ok: true });
}));

app.use('/api/portal', portal);
app.use('/api', api);

// Serve the built frontend when present (single-service deployment).
const dist = path.resolve('../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/jobs|\/webhooks).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: String(err?.message ?? err).slice(0, 200) });
});

app.listen(cfg.port, async () => {
  console.log(`CollectPilot API on http://localhost:${cfg.port}`);
  console.log(`  Gemini: ${llmAvailable() ? cfg.geminiModel : 'not configured (rule-based fallback)'}`);
  console.log(`  Google: ${googleConfigured() ? 'OAuth client configured' : 'not configured (email and calendar simulated)'}`);
  console.log(`  Telegram: ${telegramConfigured() ? 'bot configured' : 'not configured'}`);
  console.log(`  Demo mode: ${cfg.demoMode ? `on (allow-list: ${cfg.allowedEmails.length} emails, ${cfg.allowedChats.length} chats)` : 'OFF: real customers will be contacted'}`);
  startWorker();
  if (telegramConfigured() && !process.env.TELEGRAM_WEBHOOK) await startPolling(onTelegram);
});

import 'dotenv/config';

const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  jobSecret: process.env.JOB_SECRET ?? 'dev-job-secret',
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5173').replace(/\/$/, ''),
  geminiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  ownerChatId: process.env.OWNER_TELEGRAM_CHAT_ID ?? '',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRedirect: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:4000/api/google/callback',
  demoMode: (process.env.DEMO_MODE ?? 'true') !== 'false',
  allowedEmails: list(process.env.ALLOWED_EMAILS).map((e) => e.toLowerCase()),
  allowedChats: list(process.env.ALLOWED_TELEGRAM_CHAT_IDS),
  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
};

// Thin Gemini wrapper: structured output, vision/audio parts, function calling, embeddings.
// Calls are serialised with a minimum gap and retried on rate limits; every caller has a non-LLM fallback.
import { GoogleGenAI } from '@google/genai';
import { cfg } from '../config.js';

let client: GoogleGenAI | null = null;
const ai = () => (client ??= new GoogleGenAI({ apiKey: cfg.geminiKey }));
export const llmAvailable = () => !!cfg.geminiKey;

export const llmStats = { calls: 0, failures: 0, lastError: '' };

let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;
const GAP_MS = Number(process.env.GEMINI_MIN_GAP_MS ?? 1500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      try { llmStats.calls++; return await fn(); } catch (e: any) {
        const msg = String(e?.message ?? e);
        const retryable = /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded/i.test(msg);
        if (!retryable || attempt >= 2) { llmStats.failures++; llmStats.lastError = msg.slice(0, 300); throw e; }
        await sleep(8000 * (attempt + 1));
      }
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
export const filePart = (buf: Buffer, mimeType: string): Part => ({ inlineData: { mimeType, data: buf.toString('base64') } });

export interface GenOpts { system?: string; prompt: string; parts?: Part[]; temperature?: number }

/** Structured output against a schema. Returns null when the model is unavailable or the call fails. */
export async function genJSON<T>(opts: GenOpts & { schema: object }): Promise<T | null> {
  if (!llmAvailable()) return null;
  try {
    const res = await queued(() => ai().models.generateContent({
      model: cfg.geminiModel,
      contents: [{ role: 'user', parts: [...(opts.parts ?? []), { text: opts.prompt }] as any }],
      config: { systemInstruction: opts.system, temperature: opts.temperature ?? 0.2, responseMimeType: 'application/json', responseSchema: opts.schema as any },
    }));
    return JSON.parse(res.text ?? 'null') as T;
  } catch (e) { console.warn('[gemini] genJSON failed:', String((e as any)?.message ?? e).slice(0, 200)); return null; }
}

export async function genText(opts: GenOpts): Promise<string | null> {
  if (!llmAvailable()) return null;
  try {
    const res = await queued(() => ai().models.generateContent({
      model: cfg.geminiModel,
      contents: [{ role: 'user', parts: [...(opts.parts ?? []), { text: opts.prompt }] as any }],
      config: { systemInstruction: opts.system, temperature: opts.temperature ?? 0.4 },
    }));
    return res.text ?? null;
  } catch (e) { console.warn('[gemini] genText failed:', String((e as any)?.message ?? e).slice(0, 200)); return null; }
}

export interface ToolDecl { name: string; description: string; parameters: object }

/** Function-calling loop: the model may call tools; `exec` runs them; returns the final text and the calls made. */
export async function genWithTools(opts: { system: string; history: { role: 'user' | 'model'; text: string }[]; tools: ToolDecl[]; exec: (name: string, args: any) => Promise<unknown>; maxSteps?: number }) {
  if (!llmAvailable()) return null;
  const contents: any[] = opts.history.map((h) => ({ role: h.role, parts: [{ text: h.text }] }));
  const calls: { name: string; args: any; result: unknown }[] = [];
  try {
    for (let step = 0; step < (opts.maxSteps ?? 6); step++) {
      const res = await queued(() => ai().models.generateContent({
        model: cfg.geminiModel, contents,
        config: { systemInstruction: opts.system, temperature: 0.2, tools: [{ functionDeclarations: opts.tools as any }] },
      }));
      const fcs = res.functionCalls ?? [];
      if (!fcs.length) return { text: res.text ?? '', calls };
      contents.push({ role: 'model', parts: fcs.map((fc) => ({ functionCall: { name: fc.name, args: fc.args } })) });
      const responses: any[] = [];
      for (const fc of fcs) {
        let result: unknown;
        try { result = await opts.exec(fc.name!, fc.args ?? {}); } catch (e: any) { result = { error: String(e?.message ?? e) }; }
        calls.push({ name: fc.name!, args: fc.args, result });
        responses.push({ functionResponse: { name: fc.name, response: { result } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return { text: 'I could not complete that within the step limit.', calls };
  } catch (e) { console.warn('[gemini] genWithTools failed:', String((e as any)?.message ?? e).slice(0, 200)); return null; }
}

export async function embed(text: string): Promise<number[] | null> {
  if (!llmAvailable()) return null;
  try {
    const res = await queued(() => ai().models.embedContent({ model: 'gemini-embedding-001', contents: text, config: { outputDimensionality: 768 } }));
    return res.embeddings?.[0]?.values ?? null;
  } catch (e) { console.warn('[gemini] embed failed:', String((e as any)?.message ?? e).slice(0, 200)); return null; }
}

// Schema helpers (Gemini schema dialect)
export const S = {
  obj: (properties: Record<string, object>, required: string[] = Object.keys(properties)) => ({ type: 'OBJECT', properties, required }),
  str: (description?: string, enumValues?: string[]) => ({ type: 'STRING', ...(description ? { description } : {}), ...(enumValues ? { enum: enumValues } : {}) }),
  num: (description?: string) => ({ type: 'NUMBER', ...(description ? { description } : {}) }),
  bool: (description?: string) => ({ type: 'BOOLEAN', ...(description ? { description } : {}) }),
  arr: (items: object, description?: string) => ({ type: 'ARRAY', items, ...(description ? { description } : {}) }),
  nullable: (s: object) => ({ ...s, nullable: true }),
};

// Customer memory: short notes about what each customer said or prefers, retrieved by embedding similarity (pgvector).
// Without an embedding model the most recent notes are used instead.
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { embed } from '../llm/gemini.js';

const vec = (v: number[]) => `[${v.join(',')}]`;

export async function remember(tenantId: string, customerId: string, text: string, kind = 'note') {
  const e = await embed(text);
  const id = randomUUID();
  if (e) await db.$executeRawUnsafe('INSERT INTO "Memory" (id, "tenantId", "customerId", text, kind, embedding, "createdAt") VALUES ($1, $2, $3, $4, $5, $6::vector, now())', id, tenantId, customerId, text, kind, vec(e));
  else await db.memory.create({ data: { id, tenantId, customerId, text, kind } });
  return id;
}

export async function recall(tenantId: string, customerId: string, query: string, k = 4): Promise<string[]> {
  const e = await embed(query);
  if (e) {
    const rows = await db.$queryRawUnsafe<{ text: string }[]>('SELECT text FROM "Memory" WHERE "tenantId" = $1 AND "customerId" = $2 AND embedding IS NOT NULL ORDER BY embedding <=> $3::vector LIMIT $4', tenantId, customerId, vec(e), k);
    if (rows.length) return rows.map((r) => r.text);
  }
  const rows = await db.memory.findMany({ where: { tenantId, customerId }, orderBy: { createdAt: 'desc' }, take: k, select: { text: true } });
  return rows.map((r) => r.text);
}

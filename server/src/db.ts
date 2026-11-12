import { PrismaClient } from '@prisma/client';

export const db = new PrismaClient();

export async function audit(tenantId: string, actor: string, action: string, entity?: string, entityId?: string, detail?: unknown) {
  await db.auditLog.create({ data: { tenantId, actor, action, entity, entityId, detail: (detail ?? undefined) as any } });
}

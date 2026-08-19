import { desc } from "drizzle-orm";
import { createDb } from "../db";
import { auditLog } from "../db/schema";
import type { Bindings } from "../env";

/**
 * Admin audit trail. One row per meaningful write; `detail` MUST NEVER
 * contain secrets — rotating a node token records that it happened, never
 * the token itself. Recording is best-effort: a failed audit write is logged
 * and swallowed, never propagated into the admin response.
 */
export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string | number;
  detail?: string;
}

export async function recordAudit(env: Bindings, entry: AuditEntry): Promise<void> {
  try {
    await createDb(env.DB)
      .insert(auditLog)
      .values({
        ts: new Date().toISOString(),
        actor: env.ADMIN_USERNAME,
        action: entry.action,
        target_type: entry.targetType ?? "",
        target_id: entry.targetId === undefined ? "" : String(entry.targetId),
        detail: entry.detail ?? "",
      });
  } catch (err) {
    console.error("audit write failed", err);
  }
}

/** Latest audit rows, newest first. */
export async function listAudit(env: Bindings, limit: number) {
  return createDb(env.DB).select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
}

import { setupSchema, UserStatus } from "@tyz/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db";
import { appSettings, users } from "../db/schema";
import type { Bindings, Variables } from "../env";
import { issueSessionCookie } from "../middleware/adminAuth";
import { recordAudit } from "../services/audit";
import { hashPassword, randomHex } from "../utils/crypto";

/**
 * First-run setup (public, unauthenticated by design):
 *   GET  /api/setup/status — { initialized, schema_ready } so the panel can route
 *                           the browser to /setup before any admin exists;
 *   POST /api/setup        — create the FIRST admin account (one-shot: 409 once any
 *                           role='admin' row exists). Also generates the session
 *                           secret and logs the caller straight in.
 * The users table being missing (migrations not run) is reported via schema_ready
 * instead of a 500 — the panel shows deploy-command guidance instead of a dead form.
 */
export const setupRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function hasAdminAccount(env: Bindings): Promise<boolean> {
  const row = await createDb(env.DB).select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1).get();
  return row !== undefined;
}

setupRoutes.get("/status", async (c) => {
  try {
    return c.json({ initialized: await hasAdminAccount(c.env), schema_ready: true });
  } catch {
    // "no such table: users" — migrations have not been applied yet.
    return c.json({ initialized: false, schema_ready: false });
  }
});

setupRoutes.post("/", async (c) => {
  const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "无效的初始化参数", detail: parsed.error.flatten() }, 400);
  }
  const db = createDb(c.env.DB);
  if (await hasAdminAccount(c.env)) {
    return c.json({ error: "管理员账号已存在，请直接登录" }, 409);
  }
  const ts = new Date().toISOString();
  const [row] = await db
    .insert(users)
    .values({
      name: parsed.data.username,
      status: UserStatus.ACTIVE,
      role: "admin",
      password_hash: await hashPassword(parsed.data.password),
      created_at: ts,
      updated_at: ts,
    })
    .returning({ id: users.id, name: users.name });
  // Session HMAC secret, independent of any admin password (survives future
  // password changes). onConflictDoNothing: SESSION_SECRET env still wins when set.
  await db
    .insert(appSettings)
    .values({ key: "session_secret", value: randomHex(32) })
    .onConflictDoNothing();
  await recordAudit(c.env, {
    actor: row.name,
    action: "setup.admin_create",
    targetType: "user",
    targetId: row.id,
    detail: "first-run wizard",
  });
  await issueSessionCookie(c, row.name);
  return c.json({ ok: true, username: row.name }, 201);
});

import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createDb } from "../db";
import { appSettings, users } from "../db/schema";
import type { Bindings, Variables } from "../env";
import { hmacHex, randomHex, timingSafeEqual, verifyPasswordHash } from "../utils/crypto";

const COOKIE_NAME = "tyz_admin";
const SESSION_TTL_S = 7 * 24 * 60 * 60; // 7 days
const SESSION_SECRET_KEY = "session_secret";

let secretCache: { value: string; at: number } | null = null;

/**
 * Admin auth is DB-account only: a users row with role='admin' (created via the
 * first-run /setup wizard; multiple admins allowed). The historical Worker-secrets
 * login (ADMIN_USERNAME/ADMIN_PASSWORD/ADMIN_PASSWORD_SHA256) was removed with it.
 */

/** True once any role='admin' user exists — the gate the /setup wizard checks. */
export async function hasAdminAccount(env: Bindings): Promise<boolean> {
  const row = await createDb(env.DB).select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1).get();
  return row !== undefined;
}

export async function verifyAdminCredentials(env: Bindings, username: string, password: string): Promise<boolean> {
  const row = await createDb(env.DB)
    .select({ password_hash: users.password_hash })
    .from(users)
    // Auth matches role+name+password only; `status` is a business toggle and must
    // never be able to lock the operator out of the panel.
    .where(and(eq(users.role, "admin"), eq(users.name, username)))
    .get();
  if (!row?.password_hash) return false;
  return verifyPasswordHash(row.password_hash, password);
}

/**
 * Session HMAC key: SESSION_SECRET when set, otherwise the random secret stored in
 * app_settings by /setup (per-isolate 60s cache — like nodeAuth's token cache, keeps
 * the D1 read off the hot path). Self-heals when the row is missing (e.g. the local
 * seed script wipes app_settings): generate + insert-once + re-read, so the insert
 * race resolves to one winner. Null is never returned after an admin exists.
 */
async function sessionSecret(env: Bindings): Promise<string | null> {
  if (env.SESSION_SECRET) {
    return env.SESSION_SECRET;
  }
  if (secretCache && Date.now() - secretCache.at < 60_000) {
    return secretCache.value;
  }
  const db = createDb(env.DB);
  const read = async () => db.select().from(appSettings).where(eq(appSettings.key, SESSION_SECRET_KEY)).get();
  let row = await read();
  if (!row) {
    await db
      .insert(appSettings)
      .values({ key: SESSION_SECRET_KEY, value: randomHex(32) })
      .onConflictDoNothing();
    row = await read();
    if (!row) return null;
  }
  secretCache = { value: row.value, at: Date.now() };
  return row.value;
}

/**
 * Secure flag only over https. Browsers reject Secure cookies served over
 * plain http (except localhost), which would break logins when the dev
 * server is reached via e.g. the WSL IP from the Windows host.
 */
function cookieOptions(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  const isHttps = new URL(c.req.url).protocol === "https:";
  return {
    httpOnly: true,
    secure: isHttps,
    sameSite: "Lax",
    path: "/",
  } as const;
}

/** Session cookie value is "expiry.username.hmac(sessionSecret, expiry.username)". */
export async function issueSessionCookie(c: Context<{ Bindings: Bindings; Variables: Variables }>, username: string) {
  const secret = await sessionSecret(c.env);
  if (secret === null) {
    throw new Error("cannot issue session before setup generated a session secret");
  }
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const signature = await hmacHex(secret, `${expiry}.${username}`);
  setCookie(c, COOKIE_NAME, `${expiry}.${username}.${signature}`, {
    ...cookieOptions(c),
    maxAge: SESSION_TTL_S,
  });
}

export function clearSessionCookie(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  setCookie(c, COOKIE_NAME, "", {
    ...cookieOptions(c),
    maxAge: 0,
  });
}

export function adminAuth(): MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> {
  return async (c, next) => {
    const cookie = getCookie(c, COOKIE_NAME);
    const [expiryRaw, username, signature] = (cookie ?? "").split(".");
    const expiry = Number.parseInt(expiryRaw ?? "", 10);
    if (!cookie || !username || !signature || Number.isNaN(expiry) || expiry < Math.floor(Date.now() / 1000)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const secret = await sessionSecret(c.env);
    if (secret === null) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const expected = await hmacHex(secret, `${expiryRaw}.${username}`);
    if (!timingSafeEqual(signature, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("adminName", username);
    await next();
  };
}

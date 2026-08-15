import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Bindings } from "../env";
import { hashAdminPassword, hmacHex, timingSafeEqual } from "../utils/crypto";

const COOKIE_NAME = "tyz_admin";
const SESSION_TTL_S = 7 * 24 * 60 * 60; // 7 days

export async function verifyAdminCredentials(env: Bindings, username: string, password: string) {
  const actualHash = await hashAdminPassword(env.TOKEN_SALT, password);
  return username === env.ADMIN_USERNAME && timingSafeEqual(actualHash, env.ADMIN_PASSWORD_SHA256);
}

/** Session cookie value is "expiry.hmac(SESSION_SECRET, expiry)". */
/**
 * Secure flag only over https. Browsers reject Secure cookies served over
 * plain http (except localhost), which would break logins when the dev
 * server is reached via e.g. the WSL IP from the Windows host.
 */
function cookieOptions(c: Context<{ Bindings: Bindings }>) {
  const isHttps = new URL(c.req.url).protocol === "https:";
  return {
    httpOnly: true,
    secure: isHttps,
    sameSite: "Lax",
    path: "/",
  } as const;
}

export async function issueSessionCookie(c: Context<{ Bindings: Bindings }>) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const signature = await hmacHex(c.env.SESSION_SECRET, String(expiry));
  setCookie(c, COOKIE_NAME, `${expiry}.${signature}`, {
    ...cookieOptions(c),
    maxAge: SESSION_TTL_S,
  });
}

export function clearSessionCookie(c: Context<{ Bindings: Bindings }>) {
  setCookie(c, COOKIE_NAME, "", {
    ...cookieOptions(c),
    maxAge: 0,
  });
}

export function adminAuth(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const cookie = getCookie(c, COOKIE_NAME);
    const [expiryRaw, signature] = (cookie ?? "").split(".");
    const expiry = Number.parseInt(expiryRaw ?? "", 10);
    if (!cookie || !signature || Number.isNaN(expiry) || expiry < Math.floor(Date.now() / 1000)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const expected = await hmacHex(c.env.SESSION_SECRET, expiryRaw);
    if (!timingSafeEqual(signature, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

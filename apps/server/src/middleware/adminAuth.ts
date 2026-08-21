import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Bindings } from "../env";
import { hashAdminPassword, hmacHex, sha256Hex, timingSafeEqual } from "../utils/crypto";

const COOKIE_NAME = "tyz_admin";
const SESSION_TTL_S = 7 * 24 * 60 * 60; // 7 days

/** True when either ADMIN_PASSWORD (preferred) or the legacy hash pair is present. */
export function isAdminAuthConfigured(env: Bindings): boolean {
  return env.ADMIN_PASSWORD !== undefined || (env.ADMIN_PASSWORD_SHA256 !== undefined && env.TOKEN_SALT !== undefined);
}

export async function verifyAdminCredentials(env: Bindings, username: string, password: string) {
  if (username !== env.ADMIN_USERNAME) {
    return false;
  }
  if (env.ADMIN_PASSWORD !== undefined) {
    return timingSafeEqual(password, env.ADMIN_PASSWORD);
  }
  if (env.ADMIN_PASSWORD_SHA256 !== undefined && env.TOKEN_SALT !== undefined) {
    // Legacy deployments configured a pre-hashed password instead of the plaintext secret.
    const actualHash = await hashAdminPassword(env.TOKEN_SALT, password);
    return timingSafeEqual(actualHash, env.ADMIN_PASSWORD_SHA256);
  }
  return false;
}

/**
 * Session HMAC key: SESSION_SECRET when set, otherwise derived from the admin credential
 * so a minimal deployment only needs ADMIN_USERNAME + ADMIN_PASSWORD. Rotating the
 * credential (or switching the login scheme) invalidates existing sessions once.
 */
async function sessionSecret(env: Bindings): Promise<string> {
  if (env.SESSION_SECRET) {
    return env.SESSION_SECRET;
  }
  const basis = env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD_SHA256 ?? env.ADMIN_USERNAME;
  return sha256Hex(`tyz-session:${basis}`);
}

/** Session cookie value is "expiry.hmac(sessionSecret, expiry)". */
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
  const signature = await hmacHex(await sessionSecret(c.env), String(expiry));
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
    const expected = await hmacHex(await sessionSecret(c.env), expiryRaw);
    if (!timingSafeEqual(signature, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

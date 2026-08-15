import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { createDb } from "../db";
import { relayNodes } from "../db/schema";
import type { Bindings, Variables } from "../env";
import { hashNodeToken } from "../utils/crypto";

type CachedNode = { id: number; name: string; expiresAt: number };

// Best-effort per-isolate cache to avoid a D1 lookup on every poll.
const tokenCache = new Map<string, CachedNode>();
const CACHE_TTL_MS = 60_000;

export function nodeAuth(): MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "missing bearer token" }, 401);
    }
    const token = header.slice(7).trim();
    if (token.length === 0) {
      return c.json({ error: "empty bearer token" }, 401);
    }

    const tokenHash = await hashNodeToken(c.env.TOKEN_SALT, token);

    const cached = tokenCache.get(tokenHash);
    if (cached && cached.expiresAt > Date.now()) {
      c.set("node", { id: cached.id, name: cached.name });
      await next();
      return;
    }

    const row = await createDb(c.env.DB)
      .select({ id: relayNodes.id, name: relayNodes.name })
      .from(relayNodes)
      .where(eq(relayNodes.token_hash, tokenHash))
      .get();
    if (!row) {
      return c.json({ error: "invalid node token" }, 401);
    }

    tokenCache.set(tokenHash, { id: row.id, name: row.name, expiresAt: Date.now() + CACHE_TTL_MS });
    c.set("node", { id: row.id, name: row.name });
    await next();
  };
}

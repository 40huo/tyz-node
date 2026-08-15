import { lt } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "./db";
import { gostStats } from "./db/schema";
import { NodePushDO } from "./do/nodePush";
import type { Bindings, Variables } from "./env";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agent";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.get("/api/healthz", (c) => c.json({ ok: true }));

app.route("/api/agent", agentRoutes);
app.route("/api/admin", adminRoutes);

app.notFound(async (c) => {
  // SPA fallback: browser navigations to client-side routes get index.html;
  // API-ish requests (curl, fetch) still get JSON.
  const accepts = c.req.header("Accept") ?? "";
  if (c.req.method === "GET" && accepts.includes("text/html") && !c.req.path.startsWith("/api")) {
    return c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
  }
  return c.json({ error: "not found" }, 404);
});

app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "internal error" }, 500);
});

const STATS_RETENTION_DAYS = 30;

export { NodePushDO };

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings) {
    const cutoff = new Date(Date.now() - STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await createDb(env.DB).delete(gostStats).where(lt(gostStats.reported_at, cutoff));
  },
};

export type AppType = typeof app;

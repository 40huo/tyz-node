import { lt } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "./db";
import { recomputeNodeConfig } from "./db/repo";
import { auditLog, gostStats, relayNodes, serviceMetricsHourly } from "./db/schema";
import { NodePushDO } from "./do/nodePush";
import type { Bindings, Variables } from "./env";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agent";
import { notifyConfigChanged } from "./services/notify";

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
const AUDIT_RETENTION_DAYS = 180;
const METRICS_RETENTION_DAYS = 7;

export { NodePushDO };

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings) {
    const db = createDb(env.DB);
    const cutoff = new Date(Date.now() - STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db.delete(gostStats).where(lt(gostStats.reported_at, cutoff));
    // The hourly traffic ledger is deliberately NOT pruned (permanent
    // packages compute over unbounded windows) — only raw snapshots and old
    // audit rows are.
    const auditCutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db.delete(auditLog).where(lt(auditLog.ts, auditCutoff));
    const metricsCutoff = new Date(Date.now() - METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db.delete(serviceMetricsHourly).where(lt(serviceMetricsHourly.hour_ts, metricsCutoff));

    // Daily quota sweep: recompute every node so expired subscriptions and
    // drained allowances hard-stop their rules, and remaining-allowance quotas
    // get refreshed. Unchanged configs skip the version bump (no agent churn).
    const changed: number[] = [];
    for (const { id } of await db.select({ id: relayNodes.id }).from(relayNodes)) {
      const res = await recomputeNodeConfig(db, id);
      if (res.changed) changed.push(id);
    }
    if (changed.length > 0) {
      await notifyConfigChanged(env, changed);
    }
  },
};

export type AppType = typeof app;

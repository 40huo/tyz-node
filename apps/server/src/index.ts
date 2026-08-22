import { eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "./db";
import { recomputeNodeConfig } from "./db/repo";
import { auditLog, chains, gostStats, relayNodes, serviceMetricsHourly, tunnels } from "./db/schema";
import { NodePushDO } from "./do/nodePush";
import type { Bindings, Variables } from "./env";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agent";
import { setupRoutes } from "./routes/setup";
import { notifyConfigChanged } from "./services/notify";
import { renewTlsMaterial } from "./services/tls";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.get("/api/healthz", (c) => c.json({ ok: true }));

app.route("/api/agent", agentRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/setup", setupRoutes);

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
    // A node whose recompute fails (e.g. TLS domain unset for a TLS tunnel)
    // keeps serving its last applied config — log and continue with the rest.
    const changed: number[] = [];
    for (const { id } of await db.select({ id: relayNodes.id }).from(relayNodes)) {
      try {
        const res = await recomputeNodeConfig(db, id);
        if (res.changed) changed.push(id);
      } catch (err) {
        console.error(`cron: recompute failed for node ${id}`, err);
      }
    }

    // Link TLS renewal: re-issue leaves within 30d of expiry (whole set when
    // the CA drops below 90d). The sweep above already ran, so renewed PEMs
    // trigger one extra recompute pass for the TLS-enabled nodes only.
    try {
      if (await renewTlsMaterial(db)) {
        const rows = await db
          .selectDistinct({ node_id: chains.node_id })
          .from(chains)
          .innerJoin(tunnels, eq(tunnels.id, chains.tunnel_id))
          .where(eq(tunnels.tls_enabled, true));
        const renewed: number[] = [];
        for (const { node_id } of rows) {
          try {
            const res = await recomputeNodeConfig(db, node_id);
            if (res.changed) renewed.push(node_id);
          } catch (err) {
            console.error(`cron: TLS recompute failed for node ${node_id}`, err);
          }
        }
        if (renewed.length > 0) {
          await notifyConfigChanged(env, renewed);
        }
      }
    } catch (err) {
      console.error("cron: tls renewal failed", err);
    }

    if (changed.length > 0) {
      await notifyConfigChanged(env, changed);
    }
  },
};

export type AppType = typeof app;

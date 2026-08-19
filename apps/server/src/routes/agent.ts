import { agentStatsBatchSchema } from "@tyz/shared";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db";
import { getNodeConfigSnapshot, recomputeNodeConfig } from "../db/repo";
import { gostStats, serviceHealth } from "../db/schema";
import type { Bindings, Variables } from "../env";
import { nodeAuth } from "../middleware/nodeAuth";
import { ingestTraffic } from "../services/traffic";

export const agentRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

agentRoutes.use("*", nodeAuth());

/**
 * Poll endpoint: GET /api/agent/config?version=N
 * Returns 304 when the node's config version has not advanced past N,
 * otherwise 200 with { version, config }.
 */
agentRoutes.get("/config", async (c) => {
  const rawVersion = c.req.query("version");
  let currentVersion = 0;
  if (rawVersion !== undefined) {
    currentVersion = Number.parseInt(rawVersion, 10);
    if (Number.isNaN(currentVersion) || currentVersion < 0) {
      return c.json({ error: "version must be a non-negative integer" }, 400);
    }
  }

  const nodeId = c.get("node").id;
  const db = createDb(c.env.DB);

  let snapshot = await getNodeConfigSnapshot(db, nodeId);
  if (!snapshot) {
    // A node created before any config was materialized: aggregate on demand.
    await recomputeNodeConfig(db, nodeId);
    snapshot = await getNodeConfigSnapshot(db, nodeId);
  }
  if (!snapshot) {
    return c.json({ error: "node not found" }, 404);
  }

  if (snapshot.version <= currentVersion) {
    return c.body(null, 304);
  }
  return c.json({ version: snapshot.version, config: JSON.parse(snapshot.configJson) });
});

/**
 * WebSocket push channel: GET /api/agent/ws (Upgrade: websocket)
 * Authenticated like every /api/agent route; the upgrade request is forwarded to
 * this node's NodePushDO, which keeps the connection and broadcasts
 * {"type":"config_changed"} whenever an admin write recomputes the node.
 */
agentRoutes.get("/ws", (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected websocket upgrade" }, 426);
  }
  const nodeId = c.get("node").id;
  const stub = c.env.CONFIG_PUSH.get(c.env.CONFIG_PUSH.idFromName(String(nodeId)));
  return stub.fetch(c.req.raw);
});

/** Batched stats upload from agents (samples and/or service health snapshot). */
agentRoutes.post("/stats", async (c) => {
  const parsed = agentStatsBatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid stats payload", detail: parsed.error.flatten() }, 400);
  }

  const nodeId = c.get("node").id;
  const reportedAt = new Date().toISOString();
  const db = createDb(c.env.DB);

  if (parsed.data.samples.length > 0) {
    await db.insert(gostStats).values(
      parsed.data.samples.map((sample) => ({
        node_id: nodeId,
        service: sample.service,
        stats: sample,
        reported_at: reportedAt,
      })),
    );
    // Fold the samples into the hourly ledger (billing source of truth).
    // Best effort: a failed ingest must not fail the stats upload.
    await ingestTraffic(db, nodeId, parsed.data.samples).catch((err) =>
      console.error("traffic ledger ingest failed", err),
    );
  }

  // The health array is a full snapshot of the node's services: upsert every
  // entry and drop rows for services no longer present (config removals).
  if (parsed.data.health.length > 0) {
    await db
      .insert(serviceHealth)
      .values(
        parsed.data.health.map((h) => ({
          node_id: nodeId,
          service: h.service,
          state: h.state,
          error: h.error ?? null,
          reported_at: reportedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [serviceHealth.node_id, serviceHealth.service],
        set: {
          state: sql`excluded.state`,
          error: sql`excluded.error`,
          reported_at: sql`excluded.reported_at`,
        },
      });
    await db.delete(serviceHealth).where(
      and(
        eq(serviceHealth.node_id, nodeId),
        notInArray(
          serviceHealth.service,
          parsed.data.health.map((h) => h.service),
        ),
      ),
    );
  }

  return c.json({ ok: true, inserted: parsed.data.samples.length });
});

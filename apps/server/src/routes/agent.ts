import { agentStatsBatchSchema } from "@tyz/shared";
import { Hono } from "hono";
import { createDb } from "../db";
import { getNodeConfigSnapshot, recomputeNodeConfig } from "../db/repo";
import { gostStats } from "../db/schema";
import type { Bindings, Variables } from "../env";
import { nodeAuth } from "../middleware/nodeAuth";

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

/** Batched stats upload from agents. */
agentRoutes.post("/stats", async (c) => {
  const parsed = agentStatsBatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid stats payload", detail: parsed.error.flatten() }, 400);
  }

  const nodeId = c.get("node").id;
  const reportedAt = new Date().toISOString();

  if (parsed.data.samples.length > 0) {
    await createDb(c.env.DB)
      .insert(gostStats)
      .values(
        parsed.data.samples.map((sample) => ({
          node_id: nodeId,
          service: sample.service,
          stats: sample,
          reported_at: reportedAt,
        })),
      );
  }

  return c.json({ ok: true, inserted: parsed.data.samples.length });
});

import type { Chain, RelayRule, Tunnel } from "@tyz/shared";
import {
  createChainSchema,
  createNodeSchema,
  createRuleSchema,
  createTunnelSchema,
  loginSchema,
  type NodeWithMeta,
  updateChainSchema,
  updateNodeSchema,
  updateRuleSchema,
  updateTunnelSchema,
} from "@tyz/shared";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, type Database } from "../db";
import { nodeEntityColumns, recomputeNodeConfig, toRelayNode, toRelayRule, toTunnel } from "../db/repo";
import { chains, gostStats, nodeConfigs, relayNodes, relayRules, tunnels } from "../db/schema";
import type { Bindings } from "../env";
import { adminAuth, clearSessionCookie, issueSessionCookie, verifyAdminCredentials } from "../middleware/adminAuth";
import { notifyConfigChanged } from "../services/notify";
import { hashNodeToken } from "../utils/crypto";

export const adminRoutes = new Hono<{ Bindings: Bindings }>();

// ---- Auth ----

adminRoutes.post("/login", async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid login payload" }, 400);
  }
  if (!(await verifyAdminCredentials(c.env, parsed.data.username, parsed.data.password))) {
    return c.json({ error: "invalid credentials" }, 401);
  }
  await issueSessionCookie(c);
  return c.json({ ok: true, username: c.env.ADMIN_USERNAME });
});

adminRoutes.use("*", adminAuth());

adminRoutes.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

adminRoutes.get("/me", (c) => c.json({ username: c.env.ADMIN_USERNAME }));

// ---- Helpers ----

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => null);
}

function now(): string {
  return new Date().toISOString();
}

function generateNodeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Recompute one node's snapshot and push a change notification to its agent. */
async function recomputeAndNotify(env: Bindings, nodeId: number): Promise<boolean> {
  const changed = await recomputeNodeConfig(createDb(env.DB), nodeId);
  if (changed) {
    await notifyConfigChanged(env, [nodeId]);
  }
  return changed;
}

/** Recompute config snapshots for every node that has a chain in the tunnel, then notify them. */
async function recomputeTunnelNodes(env: Bindings, tunnelId: number): Promise<void> {
  const db = createDb(env.DB);
  const rows = await db.selectDistinct({ node_id: chains.node_id }).from(chains).where(eq(chains.tunnel_id, tunnelId));
  const nodeIds = rows.map((r) => r.node_id);
  for (const nodeId of nodeIds) {
    await recomputeNodeConfig(db, nodeId);
  }
  if (nodeIds.length > 0) {
    await notifyConfigChanged(env, nodeIds);
  }
}

async function nodeWithMeta(db: Database, id: number): Promise<NodeWithMeta | null> {
  const row = await db
    .select({ ...nodeEntityColumns, token_hint: relayNodes.token_hint, config_version: nodeConfigs.version })
    .from(relayNodes)
    .leftJoin(nodeConfigs, eq(nodeConfigs.node_id, relayNodes.id))
    .where(eq(relayNodes.id, id))
    .get();
  if (!row) return null;
  return {
    ...toRelayNode(row),
    config_version: row.config_version,
    token_hint: row.token_hint,
  };
}

// ---- Nodes ----

adminRoutes.get("/nodes", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({ ...nodeEntityColumns, token_hint: relayNodes.token_hint, config_version: nodeConfigs.version })
    .from(relayNodes)
    .leftJoin(nodeConfigs, eq(nodeConfigs.node_id, relayNodes.id))
    .orderBy(relayNodes.id);
  const nodes = rows.map((row) => ({
    ...toRelayNode(row),
    config_version: row.config_version,
    token_hint: row.token_hint,
  }));
  return c.json({ nodes });
});

adminRoutes.post("/nodes", async (c) => {
  const parsed = createNodeSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid node payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const token = generateNodeToken();
  const tokenHash = await hashNodeToken(c.env.TOKEN_SALT, token);
  const ts = now();

  const [inserted] = await createDb(c.env.DB)
    .insert(relayNodes)
    .values({
      name: input.name,
      description: input.description ?? null,
      address: input.address,
      display_address: input.display_address ?? null,
      token_hash: tokenHash,
      token_hint: token.slice(-4),
      version: input.version ?? null,
      level: input.level,
      is_public: input.is_public,
      ports: input.ports,
      traffic_limit: input.traffic_limit,
      enlarge_scale: input.enlarge_scale,
      custom_cfg: input.custom_cfg ?? null,
      tls_config: input.tls_config ?? null,
      created_at: ts,
      updated_at: ts,
    })
    .returning({ id: relayNodes.id });

  await recomputeAndNotify(c.env, inserted.id);
  const node = await nodeWithMeta(createDb(c.env.DB), inserted.id);
  return c.json({ node, token }, 201);
});

adminRoutes.get("/nodes/:id", async (c) => {
  const node = await nodeWithMeta(createDb(c.env.DB), Number(c.req.param("id")));
  if (!node) return c.json({ error: "node not found" }, 404);
  return c.json({ node });
});

adminRoutes.put("/nodes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateNodeSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid node payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;

  const patch: Partial<typeof relayNodes.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.address !== undefined) patch.address = input.address;
  if (input.display_address !== undefined) patch.display_address = input.display_address;
  if (input.version !== undefined) patch.version = input.version;
  if (input.level !== undefined) patch.level = input.level;
  if (input.is_public !== undefined) patch.is_public = input.is_public;
  if (input.ports !== undefined) patch.ports = input.ports;
  if (input.traffic_limit !== undefined) patch.traffic_limit = input.traffic_limit;
  if (input.enlarge_scale !== undefined) patch.enlarge_scale = input.enlarge_scale;
  if (input.custom_cfg !== undefined) patch.custom_cfg = input.custom_cfg;
  if (input.tls_config !== undefined) patch.tls_config = input.tls_config;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();

  await createDb(c.env.DB).update(relayNodes).set(patch).where(eq(relayNodes.id, id)).run();

  await recomputeAndNotify(c.env, id);
  const node = await nodeWithMeta(createDb(c.env.DB), id);
  if (!node) return c.json({ error: "node not found" }, 404);
  return c.json({ node });
});

adminRoutes.delete("/nodes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const tunnelRows = await db
    .selectDistinct({ tunnel_id: chains.tunnel_id })
    .from(chains)
    .where(eq(chains.node_id, id));

  const deleted = await db.delete(relayNodes).where(eq(relayNodes.id, id)).returning({ id: relayNodes.id });
  if (deleted.length === 0) {
    return c.json({ error: "node not found" }, 404);
  }
  for (const { tunnel_id } of tunnelRows) {
    await recomputeTunnelNodes(c.env, tunnel_id);
  }
  return c.json({ ok: true });
});

adminRoutes.post("/nodes/:id/recompute", async (c) => {
  const id = Number(c.req.param("id"));
  const changed = await recomputeAndNotify(c.env, id);
  if (!changed) return c.json({ error: "node not found" }, 404);
  return c.json({ ok: true });
});

adminRoutes.post("/nodes/:id/rotate-token", async (c) => {
  const id = Number(c.req.param("id"));
  const token = generateNodeToken();
  const tokenHash = await hashNodeToken(c.env.TOKEN_SALT, token);
  const updated = await createDb(c.env.DB)
    .update(relayNodes)
    .set({ token_hash: tokenHash, token_hint: token.slice(-4), updated_at: now() })
    .where(eq(relayNodes.id, id))
    .returning({ id: relayNodes.id });
  if (updated.length === 0) {
    return c.json({ error: "node not found" }, 404);
  }
  return c.json({ id, token });
});

adminRoutes.get("/nodes/:id/stats", async (c) => {
  const id = Number(c.req.param("id"));
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 500);
  const rows = await createDb(c.env.DB)
    .select({
      id: gostStats.id,
      service: gostStats.service,
      stats: gostStats.stats,
      reported_at: gostStats.reported_at,
    })
    .from(gostStats)
    .where(eq(gostStats.node_id, id))
    .orderBy(desc(gostStats.id))
    .limit(limit);
  return c.json({ rows });
});

// ---- Tunnels ----

adminRoutes.get("/tunnels", async (c) => {
  const rows = await createDb(c.env.DB).select().from(tunnels).orderBy(tunnels.id);
  const list: Tunnel[] = rows.map(toTunnel);
  return c.json({ tunnels: list });
});

adminRoutes.post("/tunnels", async (c) => {
  const parsed = createTunnelSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid tunnel payload", detail: parsed.error.flatten() }, 400);
  }
  const ts = now();
  const [tunnel] = await createDb(c.env.DB)
    .insert(tunnels)
    .values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      ingress_display_address: parsed.data.ingress_display_address ?? null,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  return c.json({ tunnel: toTunnel(tunnel) }, 201);
});

adminRoutes.put("/tunnels/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateTunnelSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid tunnel payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const patch: Partial<typeof tunnels.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.ingress_display_address !== undefined) patch.ingress_display_address = input.ingress_display_address;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();

  const updated = await createDb(c.env.DB)
    .update(tunnels)
    .set(patch)
    .where(eq(tunnels.id, id))
    .returning({ id: tunnels.id });
  if (updated.length === 0) {
    return c.json({ error: "tunnel not found" }, 404);
  }
  await recomputeTunnelNodes(c.env, id);
  const [tunnel] = await createDb(c.env.DB).select().from(tunnels).where(eq(tunnels.id, id));
  return c.json({ tunnel: tunnel ? toTunnel(tunnel) : null });
});

adminRoutes.delete("/tunnels/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const nodeRows = await db.selectDistinct({ node_id: chains.node_id }).from(chains).where(eq(chains.tunnel_id, id));

  const deleted = await db.delete(tunnels).where(eq(tunnels.id, id)).returning({ id: tunnels.id });
  if (deleted.length === 0) {
    return c.json({ error: "tunnel not found" }, 404);
  }
  // Chains cascade-deleted; the remaining nodes' snapshots must drop them.
  for (const { node_id } of nodeRows) {
    await recomputeAndNotify(c.env, node_id);
  }
  return c.json({ ok: true });
});

// ---- Chains ----

adminRoutes.get("/tunnels/:id/chains", async (c) => {
  const rows = await createDb(c.env.DB)
    .select()
    .from(chains)
    .where(eq(chains.tunnel_id, Number(c.req.param("id"))))
    .orderBy(chains.index);
  const list: Chain[] = rows;
  return c.json({ chains: list });
});

adminRoutes.post("/chains", async (c) => {
  const parsed = createChainSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid chain payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const ts = now();
  const [chain] = await createDb(c.env.DB)
    .insert(chains)
    .values({
      tunnel_id: input.tunnel_id,
      node_id: input.node_id,
      chain_type: input.chain_type,
      transport: input.transport,
      index: input.index,
      strategy: input.strategy,
      port: input.port,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  await recomputeTunnelNodes(c.env, input.tunnel_id);
  return c.json({ chain }, 201);
});

adminRoutes.put("/chains/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateChainSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid chain payload", detail: parsed.error.flatten() }, 400);
  }
  const db = createDb(c.env.DB);
  const existing = await db.select({ tunnel_id: chains.tunnel_id }).from(chains).where(eq(chains.id, id)).get();
  if (!existing) {
    return c.json({ error: "chain not found" }, 404);
  }

  const input = parsed.data;
  const patch: Partial<typeof chains.$inferInsert> = {};
  if (input.tunnel_id !== undefined) patch.tunnel_id = input.tunnel_id;
  if (input.node_id !== undefined) patch.node_id = input.node_id;
  if (input.chain_type !== undefined) patch.chain_type = input.chain_type;
  if (input.transport !== undefined) patch.transport = input.transport;
  if (input.index !== undefined) patch.index = input.index;
  if (input.strategy !== undefined) patch.strategy = input.strategy;
  if (input.port !== undefined) patch.port = input.port;
  patch.updated_at = now();

  const updated = await db.update(chains).set(patch).where(eq(chains.id, id)).returning({ id: chains.id });
  if (updated.length === 0) {
    return c.json({ error: "chain not found" }, 404);
  }

  await recomputeTunnelNodes(c.env, existing.tunnel_id);
  if (input.tunnel_id !== undefined && input.tunnel_id !== existing.tunnel_id) {
    await recomputeTunnelNodes(c.env, input.tunnel_id);
  }
  const [chain] = await db.select().from(chains).where(eq(chains.id, id));
  return c.json({ chain: chain ?? null });
});

adminRoutes.delete("/chains/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const existing = await db.select({ tunnel_id: chains.tunnel_id }).from(chains).where(eq(chains.id, id)).get();
  if (!existing) {
    return c.json({ error: "chain not found" }, 404);
  }
  await db.delete(chains).where(eq(chains.id, id)).run();
  await recomputeTunnelNodes(c.env, existing.tunnel_id);
  return c.json({ ok: true });
});

// ---- Relay rules ----

adminRoutes.get("/rules", async (c) => {
  const rows = await createDb(c.env.DB).select().from(relayRules).orderBy(relayRules.id);
  const rules: RelayRule[] = rows.map(toRelayRule);
  return c.json({ rules });
});

adminRoutes.post("/rules", async (c) => {
  const parsed = createRuleSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid rule payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const ts = now();
  const [rule] = await createDb(c.env.DB)
    .insert(relayRules)
    .values({
      name: input.name,
      description: input.description ?? null,
      listen_port: input.listen_port,
      tunnel_id: input.tunnel_id ?? null,
      targets: input.targets,
      status: input.status,
      limit: input.limit ?? null,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  if (input.tunnel_id) {
    await recomputeTunnelNodes(c.env, input.tunnel_id);
  }
  return c.json({ rule: toRelayRule(rule) }, 201);
});

adminRoutes.put("/rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateRuleSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid rule payload", detail: parsed.error.flatten() }, 400);
  }
  const db = createDb(c.env.DB);
  const existing = await db
    .select({ tunnel_id: relayRules.tunnel_id })
    .from(relayRules)
    .where(eq(relayRules.id, id))
    .get();
  if (!existing) {
    return c.json({ error: "rule not found" }, 404);
  }

  const input = parsed.data;
  const patch: Partial<typeof relayRules.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.listen_port !== undefined) patch.listen_port = input.listen_port;
  if (input.tunnel_id !== undefined) patch.tunnel_id = input.tunnel_id;
  if (input.targets !== undefined) patch.targets = input.targets;
  if (input.status !== undefined) patch.status = input.status;
  if (input.limit !== undefined) patch.limit = input.limit;
  patch.updated_at = now();

  const updated = await db.update(relayRules).set(patch).where(eq(relayRules.id, id)).returning({ id: relayRules.id });
  if (updated.length === 0) {
    return c.json({ error: "rule not found" }, 404);
  }

  const affected = new Set<number>();
  if (existing.tunnel_id) affected.add(existing.tunnel_id);
  if (input.tunnel_id) affected.add(input.tunnel_id);
  for (const tunnelId of affected) {
    await recomputeTunnelNodes(c.env, tunnelId);
  }

  const [row] = await db.select().from(relayRules).where(eq(relayRules.id, id));
  return c.json({ rule: row ? toRelayRule(row) : null });
});

adminRoutes.delete("/rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const existing = await db
    .select({ tunnel_id: relayRules.tunnel_id })
    .from(relayRules)
    .where(eq(relayRules.id, id))
    .get();
  if (!existing) {
    return c.json({ error: "rule not found" }, 404);
  }
  await db.delete(relayRules).where(eq(relayRules.id, id)).run();
  if (existing.tunnel_id) {
    await recomputeTunnelNodes(c.env, existing.tunnel_id);
  }
  return c.json({ ok: true });
});

import type { AdminRuleRow, Chain, Package, RelayRule, Tunnel, User, UserSubscription } from "@tyz/shared";
import {
  createChainSchema,
  createNodeSchema,
  createPackageSchema,
  createRuleSchema,
  createTunnelSchema,
  createUserSchema,
  loginSchema,
  type NodeWithMeta,
  subscribeSchema,
  updateChainSchema,
  updateNodeSchema,
  updatePackageSchema,
  updateRuleSchema,
  updateTunnelSchema,
  updateUserSchema,
} from "@tyz/shared";
import { and, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, type Database } from "../db";
import { nodeEntityColumns, recomputeNodeConfig, toRelayNode, toRelayRule, toTunnel } from "../db/repo";
import {
  chains,
  gostStats,
  nodeConfigs,
  packages,
  relayNodes,
  relayRules,
  serviceHealth,
  serviceMetricsHourly,
  tunnels,
  userPackages,
  users,
} from "../db/schema";
import type { Bindings } from "../env";
import { adminAuth, clearSessionCookie, issueSessionCookie, verifyAdminCredentials } from "../middleware/adminAuth";
import { listAudit, recordAudit } from "../services/audit";
import { broadcastNodeMessage, notifyConfigChanged } from "../services/notify";
import { getActiveSubscriptions, quotaDecisionsForUsers, userQuotaSummary } from "../services/quota";
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
  const res = await recomputeNodeConfig(createDb(env.DB), nodeId);
  if (res.changed) {
    await notifyConfigChanged(env, [nodeId]);
  }
  return res.ok;
}

/** Recompute config snapshots for every node that has a chain in the tunnel, then notify them. */
async function recomputeTunnelNodes(env: Bindings, tunnelId: number): Promise<void> {
  const db = createDb(env.DB);
  const rows = await db.selectDistinct({ node_id: chains.node_id }).from(chains).where(eq(chains.tunnel_id, tunnelId));
  const changed: number[] = [];
  for (const { node_id } of rows) {
    const res = await recomputeNodeConfig(db, node_id);
    if (res.changed) changed.push(node_id);
  }
  if (changed.length > 0) {
    await notifyConfigChanged(env, changed);
  }
}

/** Recompute every node serving one user's rules (ownership/quota changes). */
async function recomputeUserNodes(env: Bindings, userId: number): Promise<void> {
  const db = createDb(env.DB);
  const rows = await db
    .selectDistinct({ tunnel_id: relayRules.tunnel_id })
    .from(relayRules)
    .where(eq(relayRules.user_id, userId));
  for (const { tunnel_id } of rows) {
    if (tunnel_id !== null) {
      await recomputeTunnelNodes(env, tunnel_id);
    }
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
      rate: input.rate,
      custom_cfg: input.custom_cfg ?? null,
      tls_config: input.tls_config ?? null,
      created_at: ts,
      updated_at: ts,
    })
    .returning({ id: relayNodes.id });

  await recordAudit(c.env, { action: "node.create", targetType: "node", targetId: inserted.id, detail: input.name });
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
  if (input.rate !== undefined) patch.rate = input.rate;
  if (input.custom_cfg !== undefined) patch.custom_cfg = input.custom_cfg;
  if (input.tls_config !== undefined) patch.tls_config = input.tls_config;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();

  await createDb(c.env.DB).update(relayNodes).set(patch).where(eq(relayNodes.id, id)).run();
  await recordAudit(c.env, { action: "node.update", targetType: "node", targetId: id, detail: input.name ?? "" });

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
  await recordAudit(c.env, { action: "node.delete", targetType: "node", targetId: id });
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
  await recordAudit(c.env, { action: "node.rotate_token", targetType: "node", targetId: id });
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

/** Hourly per-service connection rollup (avg via sum/samples, plus peak). */
adminRoutes.get("/nodes/:id/metrics", async (c) => {
  const id = Number(c.req.param("id"));
  const hours = Math.min(Number(c.req.query("hours") ?? 24), 168);
  const since = `${new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 13)}:00:00.000Z`;
  const rows = await createDb(c.env.DB)
    .select()
    .from(serviceMetricsHourly)
    .where(and(eq(serviceMetricsHourly.node_id, id), gte(serviceMetricsHourly.hour_ts, since)))
    .orderBy(serviceMetricsHourly.hour_ts);
  return c.json({ rows });
});

/** Latest runtime state per service on a node, as reported with stats batches. */
adminRoutes.get("/nodes/:id/health", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await createDb(c.env.DB).select().from(serviceHealth).where(eq(serviceHealth.node_id, id));
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

/**
 * Validate a user-owned rule against its owner's package: subscription state,
 * tunnel/node access rights, and the rule-count limit. Returns an error
 * message, or null when the write is allowed. Admin-owned rules (no user_id)
 * are never gated.
 */
async function validateRuleOwnership(
  db: Database,
  userId: number,
  tunnelId: number | null,
  excludeRuleId?: number,
): Promise<string | null> {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return `user ${userId} not found`;
  if (user.status !== "active") return `user ${userId} is disabled`;
  const sub = (await getActiveSubscriptions(db, [userId])).get(userId);
  if (!sub) return `user ${userId} has no active subscription`;
  if (sub.expired) return `subscription of user ${userId} (package ${sub.pkg.name}) has expired`;

  if (tunnelId !== null) {
    if (sub.pkg.tunnel_ids !== null && !sub.pkg.tunnel_ids.includes(tunnelId)) {
      return `package ${sub.pkg.name} does not grant access to tunnel ${tunnelId}`;
    }
    if (sub.pkg.node_ids !== null) {
      const chainRows = await db
        .selectDistinct({ node_id: chains.node_id })
        .from(chains)
        .where(eq(chains.tunnel_id, tunnelId));
      const missing = chainRows.map((r) => r.node_id).filter((id) => !sub.pkg.node_ids?.includes(id));
      if (missing.length > 0) {
        return `package ${sub.pkg.name} does not grant access to node(s) ${missing.join(", ")} of tunnel ${tunnelId}`;
      }
    }
  }

  if (sub.pkg.max_rules > 0) {
    const owned = await db.select({ id: relayRules.id }).from(relayRules).where(eq(relayRules.user_id, userId));
    const count = owned.filter((r) => r.id !== excludeRuleId).length;
    if (count >= sub.pkg.max_rules) {
      return `package ${sub.pkg.name} allows at most ${sub.pkg.max_rules} rules (user ${userId} already has ${count})`;
    }
  }
  return null;
}

adminRoutes.get("/rules", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(relayRules).orderBy(relayRules.id);
  const rules: AdminRuleRow[] = rows.map(toRelayRule);
  // Attach the derived quota state so the panel can show WHY a user-owned
  // rule is not being served (paused vs quota-stopped are different states).
  const userIds = [...new Set(rules.map((r) => r.user_id).filter((id): id is number => id !== undefined))];
  const decisions = await quotaDecisionsForUsers(db, userIds);
  for (const rule of rules) {
    if (rule.user_id === undefined) continue;
    const decision = decisions.get(rule.user_id);
    if (decision?.stopped) {
      rule.quota_stopped = true;
      rule.quota_reason = decision.reason;
    }
  }
  return c.json({ rules });
});

adminRoutes.post("/rules", async (c) => {
  const parsed = createRuleSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid rule payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  if (input.user_id) {
    const problem = await validateRuleOwnership(createDb(c.env.DB), input.user_id, input.tunnel_id ?? null);
    if (problem) return c.json({ error: problem }, 400);
  }
  const ts = now();
  const [rule] = await createDb(c.env.DB)
    .insert(relayRules)
    .values({
      name: input.name,
      description: input.description ?? null,
      listen_port: input.listen_port,
      tunnel_id: input.tunnel_id ?? null,
      user_id: input.user_id ?? null,
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
  await recordAudit(c.env, { action: "rule.create", targetType: "rule", targetId: rule.id, detail: rule.name });
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
    .select({ tunnel_id: relayRules.tunnel_id, user_id: relayRules.user_id })
    .from(relayRules)
    .where(eq(relayRules.id, id))
    .get();
  if (!existing) {
    return c.json({ error: "rule not found" }, 404);
  }

  const input = parsed.data;
  const finalUserId = input.user_id !== undefined ? input.user_id : existing.user_id;
  const finalTunnelId = input.tunnel_id !== undefined ? input.tunnel_id : existing.tunnel_id;
  if (finalUserId) {
    const problem = await validateRuleOwnership(db, finalUserId, finalTunnelId ?? null, id);
    if (problem) return c.json({ error: problem }, 400);
  }

  const patch: Partial<typeof relayRules.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.listen_port !== undefined) patch.listen_port = input.listen_port;
  if (input.tunnel_id !== undefined) patch.tunnel_id = input.tunnel_id;
  if (input.user_id !== undefined) patch.user_id = input.user_id;
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
  await recordAudit(c.env, { action: "rule.update", targetType: "rule", targetId: id, detail: input.name ?? "" });

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
  await recordAudit(c.env, { action: "rule.delete", targetType: "rule", targetId: id });
  return c.json({ ok: true });
});

/**
 * Manual rule restart (C2): a PURE restart, not a state transition. Broadcasts
 * a restart_service directive to every node of the rule's tunnel; the entry
 * node holding service-{id} rebuilds it from its last applied config (dropping
 * live connections), other nodes no-op. A rule without a tunnel is not
 * deployed anywhere — nothing to restart.
 */
adminRoutes.post("/rules/:id/restart", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const rule = await db
    .select({ name: relayRules.name, tunnel_id: relayRules.tunnel_id })
    .from(relayRules)
    .where(eq(relayRules.id, id))
    .get();
  if (!rule) return c.json({ error: "rule not found" }, 404);
  if (rule.tunnel_id === null) return c.json({ error: "rule is not deployed on any tunnel" }, 400);

  const rows = await db
    .selectDistinct({ node_id: chains.node_id })
    .from(chains)
    .where(eq(chains.tunnel_id, rule.tunnel_id));
  const nodeIds = rows.map((r) => r.node_id);
  await broadcastNodeMessage(c.env, nodeIds, { type: "restart_service", service: `service-${id}` });
  await recordAudit(c.env, { action: "rule.restart", targetType: "rule", targetId: id, detail: rule.name });
  return c.json({ ok: true, nodes: nodeIds.length });
});

// ---- Users (tenants) ----

function toUser(row: typeof users.$inferSelect): User {
  return { ...row, note: row.note ?? undefined };
}

function toPackage(row: typeof packages.$inferSelect): Package {
  return {
    ...row,
    note: row.note ?? undefined,
    node_ids: row.node_ids ?? null,
    tunnel_ids: row.tunnel_ids ?? null,
  };
}

adminRoutes.get("/users", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(users).orderBy(users.id);
  const subs = await getActiveSubscriptions(
    db,
    rows.map((r) => r.id),
  );
  return c.json({
    users: rows.map((row) => {
      const sub = subs.get(row.id);
      return {
        ...toUser(row),
        subscription: sub ? { package_id: sub.pkg.id, package_name: sub.pkg.name, expired: sub.expired } : null,
      };
    }),
  });
});

adminRoutes.post("/users", async (c) => {
  const parsed = createUserSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid user payload", detail: parsed.error.flatten() }, 400);
  }
  const ts = now();
  const [row] = await createDb(c.env.DB)
    .insert(users)
    .values({
      name: parsed.data.name,
      note: parsed.data.note ?? null,
      status: parsed.data.status,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  await recordAudit(c.env, { action: "user.create", targetType: "user", targetId: row.id, detail: row.name });
  return c.json({ user: toUser(row) }, 201);
});

/** User detail incl. its rules' quota status (used/remaining/stopped reasons). */
adminRoutes.get("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const row = await db.select().from(users).where(eq(users.id, id)).get();
  if (!row) return c.json({ error: "user not found" }, 404);
  const owned = await db.select().from(relayRules).where(eq(relayRules.user_id, id));
  const summary = await userQuotaSummary(db, toUser(row), owned.map(toRelayRule));
  return c.json({ user: toUser(row), ...summary });
});

adminRoutes.put("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateUserSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid user payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.note !== undefined) patch.note = input.note;
  if (input.status !== undefined) patch.status = input.status;
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();

  const updated = await createDb(c.env.DB).update(users).set(patch).where(eq(users.id, id)).returning();
  if (updated.length === 0) {
    return c.json({ error: "user not found" }, 404);
  }
  if (input.status !== undefined) {
    // Disabling/reactivating changes whether the user's rules are served.
    await recomputeUserNodes(c.env, id);
  }
  await recordAudit(c.env, {
    action: "user.update",
    targetType: "user",
    targetId: id,
    detail: input.status !== undefined ? `status=${input.status}` : (input.name ?? ""),
  });
  return c.json({ user: toUser(updated[0]) });
});

adminRoutes.delete("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  // Collect affected tunnels BEFORE the delete: the FK then sets rules.user_id
  // to NULL (rules become admin-managed), so they can no longer be found via
  // the user — the affected nodes must drop their quota objects.
  const tunnelsOf = await db
    .selectDistinct({ tunnel_id: relayRules.tunnel_id })
    .from(relayRules)
    .where(eq(relayRules.user_id, id));
  const deleted = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
  if (deleted.length === 0) {
    return c.json({ error: "user not found" }, 404);
  }
  for (const { tunnel_id } of tunnelsOf) {
    if (tunnel_id !== null) {
      await recomputeTunnelNodes(c.env, tunnel_id);
    }
  }
  await recordAudit(c.env, { action: "user.delete", targetType: "user", targetId: id });
  return c.json({ ok: true });
});

/**
 * Activate/switch/renew a user's subscription (换购/续费). Replaces the row
 * with a fresh activated_at: the usage window restarts, so historically used
 * traffic clears on the ledger AND on the agent-side quota counter.
 */
adminRoutes.post("/users/:id/subscribe", async (c) => {
  const userId = Number(c.req.param("id"));
  const parsed = subscribeSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid subscribe payload", detail: parsed.error.flatten() }, 400);
  }
  const db = createDb(c.env.DB);
  const user = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!user) return c.json({ error: "user not found" }, 404);
  const pkg = await db.select().from(packages).where(eq(packages.id, parsed.data.package_id)).get();
  if (!pkg) return c.json({ error: "package not found" }, 404);

  const ts = now();
  const expiresAt =
    pkg.period_days > 0 ? new Date(Date.now() + pkg.period_days * 24 * 60 * 60 * 1000).toISOString() : null;
  const [sub] = await db
    .insert(userPackages)
    .values({
      user_id: userId,
      package_id: pkg.id,
      package_name: pkg.name, // snapshot frozen at subscribe time
      traffic_bytes: pkg.traffic_bytes,
      activated_at: ts,
      expires_at: expiresAt,
      created_at: ts,
      updated_at: ts,
    })
    .onConflictDoUpdate({
      target: userPackages.user_id,
      set: {
        package_id: pkg.id,
        package_name: pkg.name,
        traffic_bytes: pkg.traffic_bytes,
        activated_at: ts,
        expires_at: expiresAt,
        updated_at: ts,
      },
    })
    .returning();

  await recomputeUserNodes(c.env, userId);
  await recordAudit(c.env, {
    action: "subscribe",
    targetType: "user",
    targetId: userId,
    detail: `package ${pkg.name} (#${pkg.id}), expires ${expiresAt ?? "never"}`,
  });
  const subscription: UserSubscription = { ...sub, expires_at: sub.expires_at ?? null };
  return c.json({ subscription });
});

// ---- Packages (plans) ----

/** Admin audit trail, newest first. */
adminRoutes.get("/audit", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  return c.json({ rows: await listAudit(c.env, limit) });
});

adminRoutes.get("/packages", async (c) => {
  const rows = await createDb(c.env.DB).select().from(packages).orderBy(packages.id);
  return c.json({ packages: rows.map(toPackage) });
});

adminRoutes.post("/packages", async (c) => {
  const parsed = createPackageSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid package payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const ts = now();
  const [row] = await createDb(c.env.DB)
    .insert(packages)
    .values({
      name: input.name,
      note: input.note ?? null,
      traffic_bytes: input.traffic_bytes,
      period_days: input.period_days,
      node_ids: input.node_ids ?? null,
      tunnel_ids: input.tunnel_ids ?? null,
      max_rules: input.max_rules,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  await recordAudit(c.env, { action: "package.create", targetType: "package", targetId: row.id, detail: row.name });
  return c.json({ package: toPackage(row) }, 201);
});

adminRoutes.put("/packages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updatePackageSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid package payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const patch: Partial<typeof packages.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.note !== undefined) patch.note = input.note;
  if (input.traffic_bytes !== undefined) patch.traffic_bytes = input.traffic_bytes;
  if (input.period_days !== undefined) patch.period_days = input.period_days;
  if (input.node_ids !== undefined) patch.node_ids = input.node_ids;
  if (input.tunnel_ids !== undefined) patch.tunnel_ids = input.tunnel_ids;
  if (input.max_rules !== undefined) patch.max_rules = input.max_rules;
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();

  const db = createDb(c.env.DB);
  const updated = await db.update(packages).set(patch).where(eq(packages.id, id)).returning();
  if (updated.length === 0) {
    return c.json({ error: "package not found" }, 404);
  }

  // Allowance/access changes propagate to every subscriber's nodes.
  const subs = await db
    .selectDistinct({ user_id: userPackages.user_id })
    .from(userPackages)
    .where(eq(userPackages.package_id, id));
  for (const { user_id } of subs) {
    await recomputeUserNodes(c.env, user_id);
  }
  await recordAudit(c.env, { action: "package.update", targetType: "package", targetId: id, detail: updated[0].name });
  return c.json({ package: toPackage(updated[0]) });
});

adminRoutes.delete("/packages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const subs = await db.select({ id: userPackages.id }).from(userPackages).where(eq(userPackages.package_id, id));
  if (subs.length > 0) {
    return c.json({ error: "package is in use by an active subscription" }, 409);
  }
  const deleted = await db.delete(packages).where(eq(packages.id, id)).returning({ id: packages.id });
  if (deleted.length === 0) {
    return c.json({ error: "package not found" }, 404);
  }
  await recordAudit(c.env, { action: "package.delete", targetType: "package", targetId: id });
  return c.json({ ok: true });
});

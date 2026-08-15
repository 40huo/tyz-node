import type { Chain, NodeConfigData, RelayNode, RelayRule, TlsConfig, Tunnel } from "@tyz/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./index";
import { chains, nodeConfigs, relayNodes, relayRules, tunnels } from "./schema";

/**
 * Data access layer on Drizzle. Column typing (boolean/json modes, enum-ish
 * $type casts, the chains.idx -> index alias) comes from schema.ts; the small
 * `to*` helpers below only fold nullable columns to the `field?: T` shape the
 * shared entity types (and existing API responses) use.
 */

function opt<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

type NodeRow = typeof relayNodes.$inferSelect;
type TunnelRow = typeof tunnels.$inferSelect;
type RuleRow = typeof relayRules.$inferSelect;

export function toRelayNode<T extends Omit<NodeRow, "token_hash" | "tls_config" | "token_hint">>(row: T): RelayNode {
  return {
    ...row,
    description: opt(row.description),
    display_address: opt(row.display_address),
    version: opt(row.version),
    custom_cfg: opt(row.custom_cfg),
  };
}

export function toTunnel(row: TunnelRow): Tunnel {
  return {
    ...row,
    description: opt(row.description),
    ingress_display_address: opt(row.ingress_display_address),
  };
}

export function toRelayRule(row: RuleRow): RelayRule {
  return {
    ...row,
    description: opt(row.description),
    tunnel_id: opt(row.tunnel_id),
    limit: opt(row.limit),
  };
}

// ---- Queries used by the config aggregator ----

/**
 * Columns of relay_nodes that map onto the public RelayNode entity.
 * NEVER select token_hash/tls_config into API responses — the old row mappers
 * were an implicit allowlist; this explicit column list replaces them.
 */
export const nodeEntityColumns = {
  id: relayNodes.id,
  name: relayNodes.name,
  description: relayNodes.description,
  address: relayNodes.address,
  display_address: relayNodes.display_address,
  level: relayNodes.level,
  is_public: relayNodes.is_public,
  version: relayNodes.version,
  egress_traffic: relayNodes.egress_traffic,
  ingress_traffic: relayNodes.ingress_traffic,
  traffic_limit: relayNodes.traffic_limit,
  enlarge_scale: relayNodes.enlarge_scale,
  ports: relayNodes.ports,
  custom_cfg: relayNodes.custom_cfg,
  created_at: relayNodes.created_at,
  updated_at: relayNodes.updated_at,
};

export async function getNode(db: Database, id: number): Promise<RelayNode | null> {
  const row = await db.select(nodeEntityColumns).from(relayNodes).where(eq(relayNodes.id, id)).get();
  return row ? toRelayNode(row) : null;
}

export async function getNodesByIds(db: Database, ids: number[]): Promise<RelayNode[]> {
  if (ids.length === 0) return [];
  const rows = await db.select(nodeEntityColumns).from(relayNodes).where(inArray(relayNodes.id, ids)).all();
  return rows.map(toRelayNode);
}

export async function getChainsForNode(db: Database, nodeId: number): Promise<Chain[]> {
  const rows = await db.select().from(chains).where(eq(chains.node_id, nodeId)).all();
  return rows;
}

export async function getTunnelsByIds(db: Database, ids: number[]): Promise<Tunnel[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(tunnels).where(inArray(tunnels.id, ids)).all();
  return rows.map(toTunnel);
}

export async function getChainsForTunnels(db: Database, tunnelIds: number[]): Promise<Chain[]> {
  if (tunnelIds.length === 0) return [];
  const rows = await db.select().from(chains).where(inArray(chains.tunnel_id, tunnelIds)).orderBy(chains.index).all();
  return rows;
}

export async function getRulesForTunnels(db: Database, tunnelIds: number[]): Promise<RelayRule[]> {
  if (tunnelIds.length === 0) return [];
  const rows = await db.select().from(relayRules).where(inArray(relayRules.tunnel_id, tunnelIds)).all();
  return rows.map(toRelayRule);
}

export async function getNodeTlsConfig(db: Database, nodeId: number): Promise<TlsConfig | undefined> {
  const row = await db
    .select({ tls_config: relayNodes.tls_config })
    .from(relayNodes)
    .where(eq(relayNodes.id, nodeId))
    .get();
  return opt(row?.tls_config);
}

// ---- node_configs snapshot ----

export async function getNodeConfigSnapshot(
  db: Database,
  nodeId: number,
): Promise<{ version: number; configJson: string } | null> {
  const row = await db
    .select({ version: nodeConfigs.version, configJson: nodeConfigs.config_json })
    .from(nodeConfigs)
    .where(eq(nodeConfigs.node_id, nodeId))
    .get();
  return row ?? null;
}

export async function upsertNodeConfigSnapshot(
  db: Database,
  nodeId: number,
  configJson: string,
  now: string,
): Promise<void> {
  // Version = epoch seconds baseline, bumped past any existing row. This stays
  // monotonic even if the snapshot row was deleted (recreate yields a fresh,
  // larger epoch) so agents never miss a regenerated config via a stale 304.
  // Kept as raw SQL: the CASE-on-conflict upsert is clearer verbatim.
  await db.run(sql`
    INSERT INTO node_configs (node_id, version, config_json, updated_at)
    VALUES (${nodeId}, ${Math.floor(Date.now() / 1000)}, ${configJson}, ${now})
    ON CONFLICT(node_id) DO UPDATE SET
      version = CASE WHEN node_configs.version >= excluded.version THEN node_configs.version + 1 ELSE excluded.version END,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `);
}

export async function deleteNodeConfigSnapshot(db: Database, nodeId: number): Promise<void> {
  await db.delete(nodeConfigs).where(eq(nodeConfigs.node_id, nodeId)).run();
}

// ---- Aggregation ----

/**
 * Build the NodeConfigData for one node:
 * node -> chains touching this node -> tunnels -> rules attached to those tunnels
 *         + every chain of those tunnels (the full relay path), ordered by index.
 */
export async function aggregateNodeConfig(db: Database, nodeId: number): Promise<NodeConfigData | null> {
  const node = await getNode(db, nodeId);
  if (!node) return null;

  const nodeChains = await getChainsForNode(db, nodeId);
  const tunnelIds = [...new Set(nodeChains.map((c) => c.tunnel_id))];
  const tunnelsOf = await getTunnelsByIds(db, tunnelIds);
  const rules = await getRulesForTunnels(db, tunnelIds);
  const allChains = await getChainsForTunnels(db, tunnelIds);
  // Node records for every node the chains reference, so agents can resolve
  // dial addresses per hop (each chain row's node_id -> address + port range).
  const chainNodes = await getNodesByIds(db, [...new Set(allChains.map((c) => c.node_id))]);

  const config: NodeConfigData = {
    node,
    nodes: chainNodes,
    rules,
    tunnels: tunnelsOf,
    chains: allChains,
    tls: await getNodeTlsConfig(db, nodeId),
  };
  return config;
}

/** Recompute and persist the config snapshot for a node. */
export async function recomputeNodeConfig(db: Database, nodeId: number): Promise<boolean> {
  const config = await aggregateNodeConfig(db, nodeId);
  const now = new Date().toISOString();
  if (!config) {
    await deleteNodeConfigSnapshot(db, nodeId);
    return false;
  }
  await upsertNodeConfigSnapshot(db, nodeId, JSON.stringify(config), now);
  return true;
}

import type {
  Chain,
  ForwardMode,
  NodeConfigData,
  RelayNode,
  RelayRule,
  TlsConfig,
  Tunnel,
  TunnelPayload,
} from "@tyz/shared";
import { ChainType, ForwardMode as ForwardModeEnum, Transport } from "@tyz/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { applyRuleQuotas } from "../services/quota";
import { ensureTlsMaterial } from "../services/tls";
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
export type TunnelRow = typeof tunnels.$inferSelect;
type RuleRow = typeof relayRules.$inferSelect;

export function toRelayNode<T extends Omit<NodeRow, "token" | "tls_config" | "token_hint">>(row: T): RelayNode {
  return {
    ...row,
    description: opt(row.description),
    display_address: opt(row.display_address),
    version: opt(row.version),
    custom_cfg: opt(row.custom_cfg),
  };
}

/**
 * Admin-facing Tunnel entity. relay_auth_user/relay_auth_pass are stripped —
 * the credentials travel only inside the agent payload (toTunnelPayload).
 */
export function toTunnel(row: TunnelRow): Tunnel {
  const { relay_auth_user: _u, relay_auth_pass: _p, ...entity } = row;
  return {
    ...entity,
    description: opt(entity.description),
    ingress_display_address: opt(entity.ingress_display_address),
  };
}

/** Agent payload shape: entity + relay link credentials. */
export function toTunnelPayload(row: TunnelRow): TunnelPayload {
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
    user_id: opt(row.user_id),
    endpoint_id: opt(row.endpoint_id),
    limit: opt(row.limit),
  };
}

// ---- Queries used by the config aggregator ----

/**
 * Columns of relay_nodes that map onto the public RelayNode entity.
 * NEVER select token/tls_config here — this list feeds BOTH admin responses and
 * the agent config snapshot (config_json); the token is revealed only through
 * the dedicated GET /nodes/:id/token endpoint.
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
  rate: relayNodes.rate,
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

export async function getTunnelsByIds(db: Database, ids: number[]): Promise<TunnelRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(tunnels).where(inArray(tunnels.id, ids)).all();
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

function randomHex(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Relay link credentials for tunnels created before the columns existed (or
 * wiped): generate once and persist, so both link ends see the same values on
 * every subsequent aggregation.
 */
async function ensureTunnelRelayAuth(db: Database, rows: TunnelRow[]): Promise<void> {
  for (const row of rows) {
    if (row.relay_auth_user && row.relay_auth_pass) continue;
    const user = `relay-${row.id}-${randomHex(4)}`;
    const pass = randomHex(16);
    await db.update(tunnels).set({ relay_auth_user: user, relay_auth_pass: pass }).where(eq(tunnels.id, row.id));
    row.relay_auth_user = user;
    row.relay_auth_pass = pass;
  }
}

/**
 * Normalize a tunnel's mode flags against its actual chain shape. The admin
 * API rejects invalid combinations on write; this guard keeps a hand-edited or
 * racy DB state from reaching agents as a config the builder cannot render
 * consistently on both ends:
 * - raw is valid for the single-node shape (one `in` chain — direct forward,
 *   no exit port pairs) and the two-hop shape (one `in` + one `out`); anything
 *   else degrades to relay (which handles 1/2/3+ hops);
 * - tls_enabled requires the 2-hop shape with the out transport grpc|tls,
 *   otherwise the link stays plaintext (consistent on both ends).
 */
export function normalizeTunnelMode(
  row: TunnelRow,
  tunnelChains: Chain[],
): { forward_mode: ForwardMode; tls_enabled: boolean } {
  const outs = tunnelChains.filter((c) => c.chain_type === ChainType.OUT);
  const ins = tunnelChains.filter((c) => c.chain_type === ChainType.IN);
  const twoHop = tunnelChains.length === 2 && ins.length === 1 && outs.length === 1;
  const singleNode = tunnelChains.length === 1 && ins.length === 1;
  const forward_mode: ForwardMode =
    row.forward_mode === ForwardModeEnum.RAW && (twoHop || singleNode) ? ForwardModeEnum.RAW : ForwardModeEnum.RELAY;
  const tls_enabled =
    row.tls_enabled &&
    forward_mode === "relay" &&
    twoHop &&
    (outs[0]?.transport === Transport.GRPC || outs[0]?.transport === Transport.TLS);
  return { forward_mode, tls_enabled };
}

/**
 * Build the NodeConfigData for one node:
 * node -> chains touching this node -> tunnels -> rules attached to those tunnels
 *         + every chain of those tunnels (the full relay path), ordered by index.
 * Rules owned by tenants are quota-filtered/enriched (see services/quota.ts):
 * hard-stopped rules drop out of the payload entirely.
 */
export async function aggregateNodeConfig(db: Database, nodeId: number): Promise<NodeConfigData | null> {
  const node = await getNode(db, nodeId);
  if (!node) return null;

  const nodeChains = await getChainsForNode(db, nodeId);
  const tunnelIds = [...new Set(nodeChains.map((c) => c.tunnel_id))];
  const tunnelRows = await getTunnelsByIds(db, tunnelIds);
  await ensureTunnelRelayAuth(db, tunnelRows);
  const rules = await applyRuleQuotas(db, await getRulesForTunnels(db, tunnelIds));
  const allChains = await getChainsForTunnels(db, tunnelIds);
  // Node records for every node the chains reference, so agents can resolve
  // dial addresses per hop (each chain row's node_id -> address + port range).
  const chainNodes = await getNodesByIds(db, [...new Set(allChains.map((c) => c.node_id))]);

  const chainsOf = (tunnelId: number) => allChains.filter((c) => c.tunnel_id === tunnelId);
  const tunnelsOf: TunnelPayload[] = tunnelRows.map((row) => ({
    ...toTunnelPayload(row),
    ...normalizeTunnelMode(row, chainsOf(row.id)),
  }));

  let tlsMaterial: NodeConfigData["tls_material"];
  if (tunnelsOf.some((t) => t.tls_enabled)) {
    // Generates on first use (and after domain change); the snapshot content
    // diff turns any PEM change into a config version bump + WS push.
    tlsMaterial = await ensureTlsMaterial(db);
  }

  const config: NodeConfigData = {
    node,
    nodes: chainNodes,
    rules,
    tunnels: tunnelsOf,
    chains: allChains,
    tls: await getNodeTlsConfig(db, nodeId),
    ...(tlsMaterial ? { tls_material: tlsMaterial } : {}),
  };
  return config;
}

export interface RecomputeResult {
  /** false when the node does not exist (snapshot deleted). */
  ok: boolean;
  /** false when the recomputed content is identical — version is NOT bumped. */
  changed: boolean;
}

/**
 * Recompute and persist the config snapshot for a node. An unchanged config
 * skips the version bump entirely, so periodic sweeps (daily cron) cannot
 * force every agent into a pointless full refetch.
 */
export async function recomputeNodeConfig(db: Database, nodeId: number): Promise<RecomputeResult> {
  const config = await aggregateNodeConfig(db, nodeId);
  const now = new Date().toISOString();
  if (!config) {
    await deleteNodeConfigSnapshot(db, nodeId);
    return { ok: false, changed: false };
  }
  const configJson = JSON.stringify(config);
  const prev = await getNodeConfigSnapshot(db, nodeId);
  if (prev && prev.configJson === configJson) {
    return { ok: true, changed: false };
  }
  await upsertNodeConfigSnapshot(db, nodeId, configJson, now);
  return { ok: true, changed: true };
}

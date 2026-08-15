import type { ChainType, GostStatsSample, LimiterConfig, TlsConfig, Transport } from "@tyz/shared";
import { RelayRuleStatus } from "@tyz/shared";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Drizzle schema mirroring migrations/0001_init.sql exactly.
 *
 * Property names deliberately keep the DB's snake_case (matching the entity
 * types in @tyz/shared) so query results satisfy the API shapes without a
 * renaming layer. The one historical mismatch — chains.idx <-> entity `index` —
 * is mapped via the column alias.
 */

const createdAt = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const relayNodes = sqliteTable("relay_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  address: text("address").notNull(),
  display_address: text("display_address"),
  /** sha256(TOKEN_SALT + token), hex; the raw token is only shown once at creation. */
  token_hash: text("token_hash").notNull().unique(),
  /** Last 4 chars of the token, for display. */
  token_hint: text("token_hint").notNull().default(""),
  level: integer("level").notNull().default(0),
  is_public: integer("is_public", { mode: "boolean" }).notNull().default(false),
  version: text("version"),
  egress_traffic: integer("egress_traffic").notNull().default(0),
  ingress_traffic: integer("ingress_traffic").notNull().default(0),
  traffic_limit: integer("traffic_limit").notNull().default(0),
  enlarge_scale: integer("enlarge_scale").notNull().default(1),
  ports: text("ports").notNull().default("10000-20000"),
  custom_cfg: text("custom_cfg", { mode: "json" }).$type<unknown>(),
  tls_config: text("tls_config", { mode: "json" }).$type<TlsConfig>(),
  created_at: text("created_at").notNull().default(createdAt),
  updated_at: text("updated_at").notNull().default(createdAt),
});

export const tunnels = sqliteTable("tunnels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  ingress_display_address: text("ingress_display_address"),
  created_at: text("created_at").notNull().default(createdAt),
  updated_at: text("updated_at").notNull().default(createdAt),
});

export const chains = sqliteTable(
  "chains",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tunnel_id: integer("tunnel_id")
      .notNull()
      .references(() => tunnels.id, { onDelete: "cascade" }),
    node_id: integer("node_id")
      .notNull()
      .references(() => relayNodes.id, { onDelete: "cascade" }),
    chain_type: text("chain_type").$type<ChainType>().notNull(),
    transport: text("transport").$type<Transport>().notNull(),
    /** DB column `idx`; aliased to the entity field name `index`. */
    index: integer("idx").notNull(),
    strategy: text("strategy").notNull().default("round"),
    /** 0 = auto-allocate from the node's port range. */
    port: integer("port").notNull().default(0),
    created_at: text("created_at").notNull().default(createdAt),
    updated_at: text("updated_at").notNull().default(createdAt),
  },
  (table) => [index("idx_chains_tunnel").on(table.tunnel_id, table.index), index("idx_chains_node").on(table.node_id)],
);

export const relayRules = sqliteTable(
  "relay_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    listen_port: integer("listen_port").notNull(),
    tunnel_id: integer("tunnel_id").references(() => tunnels.id, { onDelete: "set null" }),
    targets: text("targets").notNull(),
    status: text("status").$type<RelayRuleStatus>().notNull().default(RelayRuleStatus.CREATED),
    limit: text("limit", { mode: "json" }).$type<LimiterConfig>(),
    upload_traffic: integer("upload_traffic").notNull().default(0),
    download_traffic: integer("download_traffic").notNull().default(0),
    created_at: text("created_at").notNull().default(createdAt),
    updated_at: text("updated_at").notNull().default(createdAt),
  },
  (table) => [index("idx_rules_tunnel").on(table.tunnel_id)],
);

/** Materialized per-node config snapshot; agents poll this with a version number. */
export const nodeConfigs = sqliteTable("node_configs", {
  node_id: integer("node_id")
    .primaryKey()
    .references(() => relayNodes.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  config_json: text("config_json").notNull(),
  updated_at: text("updated_at").notNull().default(createdAt),
});

export const gostStats = sqliteTable(
  "gost_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    node_id: integer("node_id")
      .notNull()
      .references(() => relayNodes.id, { onDelete: "cascade" }),
    service: text("service").notNull(),
    stats: text("stats", { mode: "json" }).$type<GostStatsSample>().notNull(),
    reported_at: text("reported_at").notNull(),
  },
  (table) => [index("idx_stats_node_time").on(table.node_id, table.reported_at)],
);

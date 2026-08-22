import type { ChainType, GostStatsSample, LimiterConfig, ServiceHealthSample, TlsConfig, Transport } from "@tyz/shared";
import { ForwardMode, RelayRuleStatus, UserStatus } from "@tyz/shared";
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Drizzle schema mirroring migrations/ (the squashed 0001 baseline) exactly.
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
  /**
   * Plaintext node token (the panel is the trust domain; rotate on suspicion).
   * NOT NULL + UNIQUE — databases from the pre-plaintext era may still hold an
   * inert legacy sha256 string in this column until rotated.
   */
  token: text("token").notNull().unique(),
  /** Last 4 chars of the token, for masked display. */
  token_hint: text("token_hint").notNull().default(""),
  level: integer("level").notNull().default(0),
  is_public: integer("is_public", { mode: "boolean" }).notNull().default(false),
  version: text("version"),
  egress_traffic: integer("egress_traffic").notNull().default(0),
  ingress_traffic: integer("ingress_traffic").notNull().default(0),
  traffic_limit: integer("traffic_limit").notNull().default(0),
  /** Traffic billing multiplier: users are charged round(real × rate). */
  rate: real("rate").notNull().default(1.0),
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
  /**
   * 'relay' (default): port-multiplexed relay protocol, one exit listener per
   * tunnel. 'raw': plain tcp/tcp forwarding, one dedicated port per rule on
   * BOTH nodes — no relay protocol header on the wire.
   */
  forward_mode: text("forward_mode").$type<ForwardMode>().notNull().default(ForwardMode.RELAY),
  /** TLS-wrapped link (platform certs, mutual verification). relay mode only. */
  tls_enabled: integer("tls_enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * Relay-protocol credentials, auto-generated per tunnel. Stored PLAINTEXT
   * because every recompute re-emits them into agent configs; excluded from
   * all admin responses (only the agent payload carries them).
   */
  relay_auth_user: text("relay_auth_user").notNull().default(""),
  relay_auth_pass: text("relay_auth_pass").notNull().default(""),
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

/**
 * Named forwarding destination a relay rule can reference instead of a
 * manually-entered address. Rules store their own `targets` copy (see below);
 * editing an endpoint's host/port re-syncs referencing rules via the admin API.
 */
export const endpoints = sqliteTable("endpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  note: text("note"),
  created_at: text("created_at").notNull().default(createdAt),
  updated_at: text("updated_at").notNull().default(createdAt),
});

export const relayRules = sqliteTable(
  "relay_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    listen_port: integer("listen_port").notNull(),
    tunnel_id: integer("tunnel_id").references(() => tunnels.id, { onDelete: "set null" }),
    /** Owning tenant; NULL = admin-managed rule (no quota enforcement). */
    user_id: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Stored target endpoint this rule forwards to; NULL = manually-entered targets. */
    endpoint_id: integer("endpoint_id").references(() => endpoints.id, { onDelete: "set null" }),
    targets: text("targets").notNull(),
    status: text("status").$type<RelayRuleStatus>().notNull().default(RelayRuleStatus.CREATED),
    limit: text("limit", { mode: "json" }).$type<LimiterConfig>(),
    /**
     * raw-mode tunnels: the rule's dedicated listening port on the EXIT node.
     * 0 = deterministic auto-allocation from the exit node's port range.
     */
    exit_port: integer("exit_port").notNull().default(0),
    upload_traffic: integer("upload_traffic").notNull().default(0),
    download_traffic: integer("download_traffic").notNull().default(0),
    created_at: text("created_at").notNull().default(createdAt),
    updated_at: text("updated_at").notNull().default(createdAt),
  },
  (table) => [
    index("idx_rules_tunnel").on(table.tunnel_id),
    index("idx_rules_user").on(table.user_id),
    index("idx_rules_endpoint").on(table.endpoint_id),
  ],
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

/**
 * Latest runtime state per (node, service), replaced wholesale on every stats
 * flush — the agent's snapshot is authoritative, so rows for services that
 * disappear from the config are deleted with the same request.
 */
export const serviceHealth = sqliteTable(
  "service_health",
  {
    node_id: integer("node_id")
      .notNull()
      .references(() => relayNodes.id, { onDelete: "cascade" }),
    service: text("service").notNull(),
    state: text("state").$type<ServiceHealthSample["state"]>().notNull(),
    error: text("error"),
    reported_at: text("reported_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.node_id, table.service] })],
);

/** Tenant owning relay rules; quota and access rights come from the subscription. */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  note: text("note"),
  status: text("status").$type<UserStatus>().notNull().default(UserStatus.ACTIVE),
  // role='admin' rows are platform operators (created via /setup); 'user' rows are the
  // panel's business tenants. password_hash is login material — it must never leak
  // into API responses or audit rows (stricter than relay_nodes.token, which
  // the panel may reveal on demand).
  role: text("role").$type<"admin" | "user">().notNull().default("user"),
  password_hash: text("password_hash"),
  created_at: text("created_at").notNull().default(createdAt),
  updated_at: text("updated_at").notNull().default(createdAt),
});

/** Purchasable plan; 0/NULL = unrestricted conventions (see migrations/0001_init.sql). */
export const packages = sqliteTable("packages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  note: text("note"),
  traffic_bytes: integer("traffic_bytes").notNull().default(0),
  period_days: integer("period_days").notNull().default(0),
  node_ids: text("node_ids", { mode: "json" }).$type<number[]>(),
  tunnel_ids: text("tunnel_ids", { mode: "json" }).$type<number[]>(),
  max_rules: integer("max_rules").notNull().default(0),
  created_at: text("created_at").notNull().default(createdAt),
  updated_at: text("updated_at").notNull().default(createdAt),
});

/**
 * One active subscription per user. Switching/renewing replaces the row with a
 * fresh activated_at — the usage window restarts (换购清零). package_name /
 * traffic_bytes are SNAPSHOTS frozen at subscribe time so history stays
 * interpretable after the package is renamed/edited (enforcement still reads
 * the live packages row).
 */
export const userPackages = sqliteTable(
  "user_packages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    package_id: integer("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "restrict" }),
    package_name: text("package_name").notNull().default(""),
    traffic_bytes: integer("traffic_bytes").notNull().default(0),
    activated_at: text("activated_at").notNull(),
    expires_at: text("expires_at"),
    created_at: text("created_at").notNull().default(createdAt),
    updated_at: text("updated_at").notNull().default(createdAt),
  },
  (table) => [uniqueIndex("uq_user_packages_user").on(table.user_id)],
);

/**
 * Last cumulative observer counters per (node, service), used to turn
 * cumulative stat snapshots into per-report deltas at ingest time.
 */
export const trafficCounters = sqliteTable(
  "traffic_counters",
  {
    node_id: integer("node_id")
      .notNull()
      .references(() => relayNodes.id, { onDelete: "cascade" }),
    service: text("service").notNull(),
    upload: integer("upload").notNull().default(0),
    download: integer("download").notNull().default(0),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.node_id, table.service] })],
);

/**
 * Hourly per-rule traffic ledger — the billing source of truth quota
 * remaining is computed from. Deliberately NO foreign keys: deleting a rule
 * or user must not erase usage that already happened. user_id/node_id are
 * ingest-time snapshots (0 = rule already gone). Never pruned (permanent
 * packages need unbounded windows).
 */
export const trafficHourly = sqliteTable(
  "traffic_hourly",
  {
    rule_id: integer("rule_id").notNull(),
    user_id: integer("user_id").notNull().default(0),
    node_id: integer("node_id").notNull().default(0),
    hour_ts: text("hour_ts").notNull(),
    real_upload: integer("real_upload").notNull().default(0),
    real_download: integer("real_download").notNull().default(0),
    /** Charged bytes: round(real × the node's rate), accumulated at ingest. */
    billed_upload: integer("billed_upload").notNull().default(0),
    billed_download: integer("billed_download").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.rule_id, table.hour_ts] })],
);

/**
 * Hourly per-service connection rollup: sum + samples (exact average at read
 * time) and max kept separately — peaks cause stalls, averages flatten them.
 * No FK on node_id: removing a node must not erase the history that explains
 * what it did. Pruned after 7 days.
 */
export const serviceMetricsHourly = sqliteTable(
  "service_metrics_hourly",
  {
    node_id: integer("node_id").notNull(),
    service: text("service").notNull(),
    hour_ts: text("hour_ts").notNull(),
    samples: integer("samples").notNull().default(0),
    conn_sum: integer("conn_sum").notNull().default(0),
    conn_max: integer("conn_max").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.node_id, table.service, table.hour_ts] })],
);

/** Admin audit trail; actor is a snapshot string, detail never holds secrets. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(),
    actor: text("actor").notNull().default(""),
    action: text("action").notNull(),
    target_type: text("target_type").notNull().default(""),
    target_id: text("target_id").notNull().default(""),
    detail: text("detail").notNull().default(""),
  },
  (table) => [index("idx_audit_ts").on(table.ts), index("idx_audit_action").on(table.action, table.ts)],
);

/** Platform-wide settings (key/value). v1 key: tls_domain (link disguise domain). */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: text("updated_at").notNull().default(createdAt),
});

/**
 * Platform TLS material as PEM text, kind ∈ {'ca','server','client'} (see
 * migrations/0001_init.sql). cert/key PEMs are delivered to agents exclusively through
 * the authenticated config payload; never selected into admin responses.
 */
export const tlsMaterial = sqliteTable("tls_material", {
  kind: text("kind").primaryKey(),
  cert_pem: text("cert_pem").notNull(),
  key_pem: text("key_pem").notNull(),
  not_after: text("not_after").notNull(),
  updated_at: text("updated_at").notNull().default(createdAt),
});

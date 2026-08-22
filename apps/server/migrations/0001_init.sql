-- TYZ control plane schema (D1 / SQLite) — consolidated single baseline.
--
-- This file is the COMPLETE current schema. History note: it squashes the
-- original incremental migrations (init / service health / quota packages /
-- traffic ledger + audit / rate + metrics / relay modes + link TLS / target
-- endpoints) and the later numbered steps (user roles + login credentials /
-- plaintext node tokens / enlarge_scale column drop / in-chain port zeroing —
-- the last was data-only and dissolves into a fresh baseline). Apply on a
-- FRESH database; environments that already applied any earlier numbered
-- chain are already at this final state and must NOT re-apply this file
-- (wrangler tracks by filename).

CREATE TABLE relay_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  address TEXT NOT NULL,
  display_address TEXT,
  -- Plaintext node token (the panel is the trust domain; rotate on suspicion)
  -- + last 4 chars for masked display. Databases from the pre-plaintext era
  -- may hold inert legacy sha256 strings in this column until rotated.
  token TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  egress_traffic INTEGER NOT NULL DEFAULT 0,
  ingress_traffic INTEGER NOT NULL DEFAULT 0,
  traffic_limit INTEGER NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 1.0, -- line billing multiplier: users are charged round(real x rate)
  ports TEXT NOT NULL DEFAULT '10000-20000',
  custom_cfg TEXT, -- JSON
  tls_config TEXT, -- JSON { commonName, organization }
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Tenants owning relay rules; quota and access rights come from the subscription.
-- role/password_hash sit AFTER updated_at to keep column order identical with
-- databases that received them via ALTER TABLE ADD COLUMN.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Platform operators are role='admin' rows created via the first-run /setup
  -- wizard (multiple allowed); business tenants are role='user'. password_hash
  -- (salted single-step sha256, NULL = cannot log in) NEVER appears in API
  -- responses or audit rows.
  role TEXT NOT NULL DEFAULT 'user',
  password_hash TEXT
);

CREATE TABLE tunnels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  ingress_display_address TEXT,
  -- forward_mode: 'relay' (default, port-multiplexed relay protocol) or 'raw'
  -- (plain tcp/tcp forwarding with per-rule ports on BOTH nodes — no relay
  -- protocol header on the wire). Valid shapes: single-node (one `in` chain,
  -- direct forward) or two-node (one `in` + one `out`); tls_enabled requires
  -- the 2-hop relay shape. Enforced at the admin API, guarded at aggregation.
  forward_mode TEXT NOT NULL DEFAULT 'relay' CHECK (forward_mode IN ('relay', 'raw')),
  -- tls_enabled wraps the entry<->exit relay link in TLS (mutual verification
  -- with platform-issued certs; see tls_material below). Only valid for 2-hop
  -- tunnels whose out-chain transport is grpc or tls.
  tls_enabled INTEGER NOT NULL DEFAULT 0,
  -- Relay-protocol credentials, auto-generated per tunnel, PLAINTEXT: every
  -- recompute must re-emit them into agent configs (GOST AuthConfig carries
  -- cleartext), so they cannot be stored hashed. NEVER selected into admin
  -- responses — they ride only the agent config channel (same trust domain as
  -- the node token and tls_material PEMs).
  relay_auth_user TEXT NOT NULL DEFAULT '',
  relay_auth_pass TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tunnel_id INTEGER NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES relay_nodes(id) ON DELETE CASCADE,
  chain_type TEXT NOT NULL CHECK (chain_type IN ('in', 'chain', 'out')),
  transport TEXT NOT NULL CHECK (transport IN ('raw', 'ws', 'tls', 'grpc', 'wss', 'mtls', 'mwss')),
  idx INTEGER NOT NULL, -- order in the chain (maps to entity field `index`)
  strategy TEXT NOT NULL DEFAULT 'round',
  -- Port of this row's node-side listener / dial target. IN rows never carry
  -- a port (0): entry services listen on each rule's listen_port. The admin
  -- API forces 0 on in-row writes.
  port INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_chains_tunnel ON chains(tunnel_id, idx);
CREATE INDEX idx_chains_node ON chains(node_id);

-- Named forwarding destinations (host:port) relay rules can reference
-- instead of a manually-entered address. Rules keep their own `targets` copy
-- (the config pipeline never joins endpoints); the admin API re-syncs
-- referencing rules whenever an endpoint's host/port change and refuses to
-- delete an endpoint that is still referenced. ON DELETE SET NULL is only a
-- backstop for direct DB writes.
CREATE TABLE endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE relay_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  listen_port INTEGER NOT NULL,
  tunnel_id INTEGER REFERENCES tunnels(id) ON DELETE SET NULL,
  -- Owning tenant; NULL = admin-managed rule (no quota enforcement).
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Stored target endpoint; NULL = manually-entered targets. While set,
  -- `targets` mirrors endpointAddress(endpoint) (host:port, IPv6 bracketed).
  endpoint_id INTEGER REFERENCES endpoints(id) ON DELETE SET NULL,
  targets TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paused', 'running', 'error')),
  "limit" TEXT, -- JSON LimiterConfig
  -- raw-mode tunnels: the rule's dedicated listening port on the EXIT node.
  -- 0 = deterministic auto-allocation from the exit node's port range
  -- (start + ((rule_id * 31 + node_id) % range)) — the entry dials the same
  -- formula from the node record, so both sides agree without coordination.
  -- Collisions surface as apply_failed service health and are fixed by setting
  -- an explicit port.
  exit_port INTEGER NOT NULL DEFAULT 0,
  upload_traffic INTEGER NOT NULL DEFAULT 0,
  download_traffic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_rules_tunnel ON relay_rules(tunnel_id);
CREATE INDEX idx_rules_user ON relay_rules(user_id);
CREATE INDEX idx_rules_endpoint ON relay_rules(endpoint_id);

-- Materialized per-node config snapshot; agents poll this with a version number.
CREATE TABLE node_configs (
  node_id INTEGER PRIMARY KEY REFERENCES relay_nodes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE gost_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES relay_nodes(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  stats TEXT NOT NULL, -- JSON GostObserverStats
  reported_at TEXT NOT NULL
);
CREATE INDEX idx_stats_node_time ON gost_stats(node_id, reported_at);
-- Service-level usage aggregation for quotas (gost_stats rows are cumulative
-- snapshots; the ledger query reads one service's range within a window).
CREATE INDEX idx_stats_service_time ON gost_stats(service, reported_at);

-- Latest runtime state per (node, service), reported by the agent alongside
-- stats batches. Replaced wholesale on each flush; no history is kept.
CREATE TABLE service_health (
  node_id INTEGER NOT NULL REFERENCES relay_nodes(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  state TEXT NOT NULL, -- x/service.State: running|ready|failed|closed
  error TEXT,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (node_id, service)
);

-- Purchasable plan: traffic_bytes 0 = unlimited traffic; period_days 0 =
-- permanent (no expiry); node_ids/tunnel_ids NULL = unrestricted; max_rules
-- 0 = unlimited.
CREATE TABLE packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  traffic_bytes INTEGER NOT NULL DEFAULT 0,
  period_days INTEGER NOT NULL DEFAULT 0,
  node_ids TEXT,   -- JSON array of node ids, NULL = unrestricted
  tunnel_ids TEXT, -- JSON array of tunnel ids, NULL = unrestricted
  max_rules INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One active subscription per user (UNIQUE). Switching/renewing replaces the
-- row with a fresh activated_at: the usage window restarts, clearing
-- historically used traffic both on the ledger and on the agent-side quota
-- counter (restored only for an identical window). package_name /
-- traffic_bytes are SNAPSHOTS frozen at subscribe time so the purchase
-- history stays interpretable after the package is renamed or its allowance
-- edited (the live package row remains the enforcement source).
CREATE TABLE user_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  package_name TEXT NOT NULL DEFAULT '',
  traffic_bytes INTEGER NOT NULL DEFAULT 0,
  activated_at TEXT NOT NULL,
  expires_at TEXT, -- NULL = permanent package
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id)
);

-- Per-(node, service) last cumulative counters, used to turn the observer's
-- cumulative snapshots into per-report deltas at ingest time.
CREATE TABLE traffic_counters (
  node_id INTEGER NOT NULL,
  service TEXT NOT NULL,
  upload INTEGER NOT NULL DEFAULT 0,    -- last cumulative inputBytes
  download INTEGER NOT NULL DEFAULT 0,  -- last cumulative outputBytes
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, service)
);

-- Hourly per-rule traffic. This is the LEDGER quota remaining is computed
-- from — ingest-time UPSERT accumulation, one row per (rule, hour), so the
-- quota query is a primary-key range scan instead of a MAX-MIN over raw
-- snapshot rows. real_* keep actual bytes; billed_* accumulate
-- round(real x the node's rate) — quota remaining is computed from BILLED.
--
-- DELIBERATELY no foreign keys: deleting a rule or a user must not erase
-- usage that already happened — a cascade would make a subscription's used
-- bytes quietly shrink. user_id / node_id are SNAPSHOTS taken at ingest
-- (0 = rule already gone).
--
-- NOT pruned by the daily cron on purpose: permanent (non-expiring) packages
-- compute usage over an unbounded window. Volume is one row per rule-hour
-- (~8.8k rows/rule/year); if this ever matters, add a monthly rollup table
-- instead of truncating billing history.
CREATE TABLE traffic_hourly (
  rule_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER NOT NULL DEFAULT 0,
  hour_ts TEXT NOT NULL,               -- 'YYYY-MM-DDTHH:00:00.000Z' UTC
  real_upload INTEGER NOT NULL DEFAULT 0,
  real_download INTEGER NOT NULL DEFAULT 0,
  billed_upload INTEGER NOT NULL DEFAULT 0,
  billed_download INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rule_id, hour_ts)
);
CREATE INDEX idx_traffic_hourly_user ON traffic_hourly(user_id, hour_ts);
CREATE INDEX idx_traffic_hourly_hour ON traffic_hourly(hour_ts);

-- Admin audit trail. actor is a SNAPSHOT (deleting the admin must not erase
-- who did what); detail MUST NEVER contain secrets — rotating a node token
-- records that it happened, never the token itself.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_action ON audit_log(action, ts);

-- Hourly per-service connection rollup: sum + samples (exact average at read
-- time) and max kept separately — peaks cause stalls, averages flatten them.
-- No FK on node_id: removing a node must not erase the history that explains
-- what it did. Pruned after 7 days by the daily cron.
CREATE TABLE service_metrics_hourly (
  node_id INTEGER NOT NULL,
  service TEXT NOT NULL,
  hour_ts TEXT NOT NULL,               -- 'YYYY-MM-DDTHH:00:00.000Z' UTC
  samples INTEGER NOT NULL DEFAULT 0,
  conn_sum INTEGER NOT NULL DEFAULT 0,
  conn_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, service, hour_ts)
);
CREATE INDEX idx_service_metrics_hour ON service_metrics_hourly(hour_ts);

-- Platform-wide settings (key/value). v1 key: tls_domain — the single
-- disguise domain used as SNI / serverName / certificate SAN for every
-- TLS-enabled tunnel link.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Platform TLS material as PEM text, kind IN {'ca','server','client'}.
-- ca: self-signed ECDSA P-256 CA (10y) — verifies exit servers (dialer side)
--      and entry clients (listener side, RequireAndVerifyClientCert).
-- server: SAN = tls_domain, EKU serverAuth (1y) — the exit relay listener.
-- client: EKU clientAuth (1y) — the entry dialer.
-- Private keys are secrets of the same trust domain as node tokens: they are
-- delivered exclusively through the authenticated agent config payload and
-- never appear in admin responses or the audit log.
CREATE TABLE tls_material (
  kind TEXT PRIMARY KEY,
  cert_pem TEXT NOT NULL,
  key_pem TEXT NOT NULL,
  not_after TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

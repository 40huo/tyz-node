-- TYZ control plane initial schema (D1 / SQLite)

CREATE TABLE relay_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  address TEXT NOT NULL,
  display_address TEXT,
  -- sha256(TOKEN_SALT + token), hex encoded; the raw token is only shown once at creation
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL DEFAULT '', -- last 4 chars of the token, for display
  level INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  egress_traffic INTEGER NOT NULL DEFAULT 0,
  ingress_traffic INTEGER NOT NULL DEFAULT 0,
  traffic_limit INTEGER NOT NULL DEFAULT 0,
  enlarge_scale INTEGER NOT NULL DEFAULT 1,
  ports TEXT NOT NULL DEFAULT '10000-20000',
  custom_cfg TEXT, -- JSON
  tls_config TEXT, -- JSON { commonName, organization }
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE tunnels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  ingress_display_address TEXT,
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
  port INTEGER NOT NULL DEFAULT 0, -- 0 = auto-allocate from the node's port range
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_chains_tunnel ON chains(tunnel_id, idx);
CREATE INDEX idx_chains_node ON chains(node_id);

CREATE TABLE relay_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  listen_port INTEGER NOT NULL,
  tunnel_id INTEGER REFERENCES tunnels(id) ON DELETE SET NULL,
  targets TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paused', 'running', 'error')),
  "limit" TEXT, -- JSON LimiterConfig
  upload_traffic INTEGER NOT NULL DEFAULT 0,
  download_traffic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_rules_tunnel ON relay_rules(tunnel_id);

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

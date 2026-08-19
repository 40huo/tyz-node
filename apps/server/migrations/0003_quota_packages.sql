-- Tenant packages: traffic quotas, access rights, rule-count limits.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
-- counter (restored only for an identical window).
CREATE TABLE user_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  activated_at TEXT NOT NULL,
  expires_at TEXT, -- NULL = permanent package
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id)
);

ALTER TABLE relay_rules ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Service-level usage aggregation for quotas (gost_stats rows are cumulative
-- snapshots; the ledger query reads one service's range within a window).
CREATE INDEX idx_stats_service_time ON gost_stats(service, reported_at);

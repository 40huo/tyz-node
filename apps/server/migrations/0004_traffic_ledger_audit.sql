-- Hourly traffic ledger (billing source of truth) + subscription snapshots
-- + admin audit trail.

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
-- snapshot rows.
--
-- DELIBERATELY no foreign keys (same reasoning as relay-panel's traffic_
-- history): deleting a rule or a user must not erase usage that already
-- happened — a cascade would make a subscription's used bytes quietly shrink.
-- user_id / node_id are SNAPSHOTS taken at ingest (0 = rule already gone).
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
  PRIMARY KEY (rule_id, hour_ts)
);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_user ON traffic_hourly(user_id, hour_ts);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_hour ON traffic_hourly(hour_ts);

-- One-time backfill from retained gost_stats rows (cumulative snapshots →
-- per-hour MAX-MIN deltas), so subscriptions activated before this migration
-- keep their usage. Negative deltas (counter resets inside an hour) clamp to 0.
INSERT INTO traffic_hourly (rule_id, user_id, node_id, hour_ts, real_upload, real_download)
SELECT rule_id, IFNULL(owner, 0), node_id, hour_ts, up, down FROM (
  SELECT rule_id, hour_ts, MAX(node_id) AS node_id,
         SUM(MAX(up, 0)) AS up, SUM(MAX(down, 0)) AS down,
         (SELECT user_id FROM relay_rules r WHERE r.id = rule_id) AS owner
  FROM (
    SELECT node_id,
           CAST(SUBSTR(service, 9) AS INTEGER) AS rule_id,
           strftime('%Y-%m-%dT%H:00:00.000Z', reported_at) AS hour_ts,
           MAX(json_extract(stats, '$.inputBytes')) - MIN(json_extract(stats, '$.inputBytes')) AS up,
           MAX(json_extract(stats, '$.outputBytes')) - MIN(json_extract(stats, '$.outputBytes')) AS down
    FROM gost_stats
    WHERE json_extract(stats, '$.client') IS NULL
      AND service LIKE 'service-%'
      AND CAST(SUBSTR(service, 9) AS INTEGER) > 0
    GROUP BY node_id, service, hour_ts
  ) GROUP BY rule_id, hour_ts
) WHERE rule_id > 0;

-- Seed the counters from the highest observed cumulative values so the first
-- post-migration report deltas against a sane baseline.
INSERT INTO traffic_counters (node_id, service, upload, download, updated_at)
SELECT node_id, service,
       MAX(json_extract(stats, '$.inputBytes')),
       MAX(json_extract(stats, '$.outputBytes')),
       MAX(reported_at)
FROM gost_stats
WHERE json_extract(stats, '$.client') IS NULL
GROUP BY node_id, service
ON CONFLICT(node_id, service) DO NOTHING;

-- v: subscription snapshots. plan_name/traffic are frozen at subscribe time so
-- the purchase history stays interpretable after the package is renamed or
-- its allowance edited (the live package row remains the enforcement source).
ALTER TABLE user_packages ADD COLUMN package_name TEXT NOT NULL DEFAULT '';
ALTER TABLE user_packages ADD COLUMN traffic_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE user_packages SET
  package_name = (SELECT name FROM packages WHERE packages.id = user_packages.package_id),
  traffic_bytes = COALESCE((SELECT traffic_bytes FROM packages WHERE packages.id = user_packages.package_id), 0);

-- Admin audit trail. actor_name is a SNAPSHOT (deleting the admin must not
-- erase who did what); detail MUST NEVER contain secrets — rotating a node
-- token records that it happened, never the token itself.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts);

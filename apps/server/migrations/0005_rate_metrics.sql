-- Line billing rate + billed ledger columns + hourly service metrics.

-- v B2: traffic billing multiplier for this line. Real bytes stay in
-- traffic_hourly.real_*; users are CHARGED round(real × rate), accumulated in
-- billed_*. 1.0 = bill what you use. Range 0.1..=100 enforced at the API.
ALTER TABLE relay_nodes ADD COLUMN rate REAL NOT NULL DEFAULT 1.0;

-- Billed columns on the ledger; backfilled from each row's node rate so the
-- transition is seamless (existing usage keeps counting at the new rates).
ALTER TABLE traffic_hourly ADD COLUMN billed_upload INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_hourly ADD COLUMN billed_download INTEGER NOT NULL DEFAULT 0;
UPDATE traffic_hourly SET
  billed_upload = CAST(ROUND(real_upload * COALESCE(
    (SELECT rate FROM relay_nodes WHERE relay_nodes.id = traffic_hourly.node_id), 1.0)) AS INTEGER),
  billed_download = CAST(ROUND(real_download * COALESCE(
    (SELECT rate FROM relay_nodes WHERE relay_nodes.id = traffic_hourly.node_id), 1.0)) AS INTEGER);

-- B6: hourly per-service connection rollup ("why was it slow last night").
-- sum + samples (exact average at read time) AND max kept separately — stalls
-- are caused by peaks, which an hourly average flattens. Retention 7 days
-- (pruned by the daily cron). No FK on node_id by design: removing a node
-- must not erase the history that explains what it did.
CREATE TABLE service_metrics_hourly (
  node_id INTEGER NOT NULL,
  service TEXT NOT NULL,
  hour_ts TEXT NOT NULL,               -- 'YYYY-MM-DDTHH:00:00.000Z' UTC
  samples INTEGER NOT NULL DEFAULT 0,
  conn_sum INTEGER NOT NULL DEFAULT 0,
  conn_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, service, hour_ts)
);
CREATE INDEX IF NOT EXISTS idx_service_metrics_hour ON service_metrics_hourly(hour_ts);

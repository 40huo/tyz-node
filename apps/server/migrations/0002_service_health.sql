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

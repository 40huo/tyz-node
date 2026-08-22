-- Local development seed data (run against the LOCAL D1 only):
--   bun run db:seed:local    # at the repo root (= wrangler d1 execute DB --local --file apps/server/scripts/seed-local.sql)
--
-- Seeded node tokens use TOKEN_SALT=dev-token-salt:
--   node-1 -> dev-token-1  sha256("dev-token-salt:node:dev-token-1")
--   node-2 -> dev-token-2  sha256("dev-token-salt:node:dev-token-2")
--
-- Topology:
--   tunnel-1  single-hop: node-1 entry forwards straight to the target
--   tunnel-2  two-node relay: node-1 entry (two rules share the tunnel),
--             node-2 exit with a single relay listener on :16900
--   tunnel-3  two-node RAW forward: no relay protocol — every rule gets a
--             dedicated tcp port pair (entry :16556/:16557 -> exit :26556/:26557)
--   tunnel-4  two-node relay + TLS (grpc): shared exit listener :16901 wrapped
--             in TLS1.3/h2 with platform certs (domain relay.local.test),
--             mutual verification, relay auth and an entry-IP admission
--
-- endpoint-1 is the stored target for rule-1 (same address the rule already
-- forwards to) — demonstrates the endpoint <-> rule association.

DELETE FROM gost_stats;
DELETE FROM node_configs;
DELETE FROM relay_rules;
DELETE FROM endpoints;
DELETE FROM chains;
DELETE FROM tunnels;
DELETE FROM relay_nodes;
DELETE FROM app_settings;
-- Dropped so every reseed issues fresh platform certs (agents pick them up
-- via the ordinary config version bump).
DELETE FROM tls_material;

INSERT INTO relay_nodes (id, name, address, display_address, token_hash, token_hint, ports, is_public)
VALUES
  (1, 'node-1', '127.0.0.1', 'relay1.example.com',
   '5ad1ecaa68b3cc59b696da3cf1df6fd5dcd81cced1fc2fa9a1aa2576708504cb', 'e-1', '10000-20000', 1),
  (2, 'node-2', '127.0.0.1', NULL,
   '1aa0290b2ce15b72926007dd779e17882c38ae960983ad57693cf142583d9965', 'e-2', '20000-30000', 0);

INSERT INTO app_settings (key, value) VALUES ('tls_domain', 'relay.local.test');

INSERT INTO tunnels (id, name, ingress_display_address, forward_mode, tls_enabled, relay_auth_user, relay_auth_pass)
VALUES
  (1, 'tunnel-1', 'entry.example.com:80', 'raw', 0, 'seed-1', 'seed-pass-1'),
  (2, 'tunnel-2', 'entry.example.com:16535', 'relay', 0, 'seed-2', 'seed-pass-2'),
  (3, 'tunnel-3', 'entry.example.com:16556', 'raw', 0, 'seed-3', 'seed-pass-3'),
  (4, 'tunnel-4', 'entry.example.com:16558', 'relay', 1, 'seed-4', 'seed-pass-4');

INSERT INTO chains (id, tunnel_id, node_id, chain_type, transport, idx, strategy, port)
VALUES
  (1, 1, 1, 'in',  'raw',  0, 'round', 0),
  (2, 2, 1, 'in',  'raw',  0, 'round', 0),
  (3, 2, 2, 'out', 'raw',  1, 'round', 16900),
  (4, 3, 1, 'in',  'raw',  0, 'round', 0),
  (5, 3, 2, 'out', 'raw',  1, 'round', 0),
  (6, 4, 1, 'in',  'grpc', 0, 'round', 0),
  (7, 4, 2, 'out', 'grpc', 1, 'round', 16901);

INSERT INTO endpoints (id, name, host, port, note)
VALUES
  (1, '示例端点', 'example.com', 80, 'seed 演示：被 rule-1 引用');

INSERT INTO relay_rules (id, name, listen_port, tunnel_id, endpoint_id, targets, status, exit_port)
VALUES
  (1, 'rule-1', 8080,   1, 1, 'example.com:80', 'running', 0),
  (2, 'rule-2', 16535,  2, NULL, '127.0.0.1:19180', 'running', 0),
  (3, 'rule-3', 16548,  2, NULL, '127.0.0.1:19181', 'running', 0),
  (4, 'rule-4', 16556,  3, NULL, '127.0.0.1:19180', 'running', 26556),
  (5, 'rule-5', 16557,  3, NULL, '127.0.0.1:19181', 'running', 26557),
  (6, 'rule-6', 16558,  4, NULL, '127.0.0.1:19180', 'running', 0),
  (7, 'rule-7', 16559,  4, NULL, '127.0.0.1:19181', 'running', 0);

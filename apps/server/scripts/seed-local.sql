-- Local development seed data (run against the LOCAL D1 only):
--   cd apps/server && bunx wrangler d1 execute DB --local --file scripts/seed-local.sql
--
-- The seeded node token is "dev-token-1" with TOKEN_SALT=dev-token-salt:
--   sha256("dev-token-salt:node:dev-token-1")

DELETE FROM gost_stats;
DELETE FROM node_configs;
DELETE FROM relay_rules;
DELETE FROM chains;
DELETE FROM tunnels;
DELETE FROM relay_nodes;

INSERT INTO relay_nodes (id, name, address, display_address, token_hash, token_hint, ports, is_public)
VALUES
  (1, 'node-1', '10.0.0.1', 'relay1.example.com',
   '5ad1ecaa68b3cc59b696da3cf1df6fd5dcd81cced1fc2fa9a1aa2576708504cb', 'e-1', '10000-20000', 1),
  (2, 'node-2', '10.0.0.2', NULL,
   '0000000000000000000000000000000000000000000000000000000000000000', 'd-2', '20000-30000', 0);

INSERT INTO tunnels (id, name, ingress_display_address)
VALUES (1, 'tunnel-1', 'entry.example.com:80');

-- Single-hop tunnel: node-1 is the entry, rule forwards directly to the target.
INSERT INTO chains (id, tunnel_id, node_id, chain_type, transport, idx, strategy, port)
VALUES (1, 1, 1, 'in', 'raw', 0, 'round', 0);

INSERT INTO relay_rules (id, name, listen_port, tunnel_id, targets, status)
VALUES (1, 'rule-1', 8080, 1, 'example.com:80', 'running');

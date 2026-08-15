-- Local development seed data (run against the LOCAL D1 only):
--   cd apps/server && bunx wrangler d1 execute DB --local --file scripts/seed-local.sql
--
-- Seeded node tokens use TOKEN_SALT=dev-token-salt:
--   node-1 -> dev-token-1  sha256("dev-token-salt:node:dev-token-1")
--   node-2 -> dev-token-2  sha256("dev-token-salt:node:dev-token-2")
--
-- Topology:
--   tunnel-1  single-hop: node-1 entry forwards straight to the target
--   tunnel-2  two-node relay: node-1 entry (two rules share the tunnel),
--             node-2 exit with a single relay listener on :16900

DELETE FROM gost_stats;
DELETE FROM node_configs;
DELETE FROM relay_rules;
DELETE FROM chains;
DELETE FROM tunnels;
DELETE FROM relay_nodes;

INSERT INTO relay_nodes (id, name, address, display_address, token_hash, token_hint, ports, is_public)
VALUES
  (1, 'node-1', '127.0.0.1', 'relay1.example.com',
   '5ad1ecaa68b3cc59b696da3cf1df6fd5dcd81cced1fc2fa9a1aa2576708504cb', 'e-1', '10000-20000', 1),
  (2, 'node-2', '127.0.0.1', NULL,
   '1aa0290b2ce15b72926007dd779e17882c38ae960983ad57693cf142583d9965', 'e-2', '20000-30000', 0);

INSERT INTO tunnels (id, name, ingress_display_address)
VALUES
  (1, 'tunnel-1', 'entry.example.com:80'),
  (2, 'tunnel-2', 'entry.example.com:16535');

INSERT INTO chains (id, tunnel_id, node_id, chain_type, transport, idx, strategy, port)
VALUES
  (1, 1, 1, 'in',  'raw', 0, 'round', 0),
  (2, 2, 1, 'in',  'raw', 0, 'round', 0),
  (3, 2, 2, 'out', 'raw', 1, 'round', 16900);

INSERT INTO relay_rules (id, name, listen_port, tunnel_id, targets, status)
VALUES
  (1, 'rule-1', 8080,   1, 'example.com:80', 'running'),
  (2, 'rule-2', 16535,  2, '127.0.0.1:19180', 'running'),
  (3, 'rule-3', 16548,  2, '127.0.0.1:19181', 'running');

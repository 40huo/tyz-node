-- Plaintext node tokens: the panel is the trust domain and tokens are
-- low-sensitivity credentials (rotate on suspicion).
--
-- The hash column is RENAMED rather than dropped (SQLite cannot DROP a
-- UNIQUE-constrained column, and a table rebuild is unsafe under the four
-- FK-referencing tables). Legacy sha256 values remain as inert strings: a
-- stored hash can never equal a presented bearer token, so nodes created
-- before this migration simply authenticate again after a rotate — fresh
-- deployments are unaffected.

ALTER TABLE relay_nodes RENAME COLUMN token_hash TO token;
